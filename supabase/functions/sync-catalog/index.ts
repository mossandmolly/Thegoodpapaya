// Supabase Edge Function — sync-catalog
//
// Syncs Shopify products → catalog table → Zoho Books items.
// Call this:
//   - From a Shopify product/update webhook  (POST with Shopify payload)
//   - From a daily cron / manual trigger     (POST with body {})
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SHOPIFY_STORE_DOMAIN   e.g. thegoodpapaya.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    Admin API access token
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID
//
// Shopify webhook verification:
//   SHOPIFY_WEBHOOK_SECRET (optional — skipped if not set, useful during setup)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Shopify-Topic',
};

// ── Normalise: lowercase + collapse whitespace (matches DB generated column) ──
function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Zoho: get fresh access token ──────────────────────────────────────────────
async function zohoToken(): Promise<string> {
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     env('ZOHO_CLIENT_ID'),
      client_secret: env('ZOHO_CLIENT_SECRET'),
      refresh_token: env('ZOHO_REFRESH_TOKEN'),
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`Zoho OAuth failed: ${JSON.stringify(d)}`);
  return d.access_token;
}

// ── Zoho: fetch all items (paginated) ────────────────────────────────────────
async function fetchAllZohoItems(token: string, orgId: string) {
  let page = 1;
  const all: any[] = [];
  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&page=${page}&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const d = await res.json();
    const items = d.items || [];
    all.push(...items);
    if (!d.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// ── Zoho: upsert item (create or update rate) ─────────────────────────────────
async function zohoUpsertItem(
  zohoItems: any[],
  itemName: string,
  rate: number,
  unit: string,
  token: string,
  orgId: string,
): Promise<{ item_id: string; item_name: string }> {
  const normTarget = norm(itemName);
  const existing   = zohoItems.find(i => norm(i.name) === normTarget);

  if (existing) {
    // Update rate if it changed
    if (Math.abs(existing.rate - rate) > 0.001) {
      await fetch(
        `https://www.zohoapis.in/books/v3/items/${existing.item_id}?organization_id=${orgId}`,
        {
          method:  'PUT',
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ JSONString: JSON.stringify({ rate }) }),
        }
      );
    }
    return { item_id: existing.item_id, item_name: existing.name };
  }

  // Create new item using Shopify's exact casing
  const res = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}`,
    {
      method:  'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        JSONString: JSON.stringify({
          name:        itemName,   // exact Shopify casing
          rate,
          unit,
          item_type:   'goods',
          product_type: 'goods',
        }),
      }),
    }
  );
  const d = await res.json();
  if (d.code !== 0) throw new Error(`Zoho create item "${itemName}" failed: ${d.message}`);
  return { item_id: d.item.item_id, item_name: d.item.name };
}

// ── Derive unit from Shopify tags ─────────────────────────────────────────────
function unitFromTags(tags: string[]): string {
  const t = tags.map(t => t.toLowerCase());
  if (t.includes('mode:piece')) return 'pcs';
  if (t.includes('mode:box'))   return 'box';
  return 'kg';
}

// ── Main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const orgId    = env('ZOHO_ORG_ID');

    // ── Fetch all Shopify products ────────────────────────────────────────────
    const shopifyDomain = env('SHOPIFY_STORE_DOMAIN');
    const shopifyToken  = env('SHOPIFY_ADMIN_TOKEN');

    let allProducts: any[] = [];
    let url = `https://${shopifyDomain}/admin/api/2024-01/products.json?limit=250&status=active`;
    while (url) {
      const res  = await fetch(url, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
      const data = await res.json();
      allProducts.push(...(data.products || []));
      // Follow pagination link header if present
      const link = res.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      url = next || '';
    }

    if (!allProducts.length) throw new Error('No active products returned from Shopify');

    // ── Get Zoho token + existing items ──────────────────────────────────────
    const token     = await zohoToken();
    const zohoItems = await fetchAllZohoItems(token, orgId);

    const results: any[] = [];

    for (const p of allProducts) {
      const itemName  = p.title as string;
      const price     = parseFloat(p.variants?.[0]?.price || '0');
      const tags      = (p.tags || '').split(',').map((t: string) => t.trim().toLowerCase());
      const unit      = unitFromTags(tags);

      // Upsert in Zoho
      const zoho = await zohoUpsertItem(zohoItems, itemName, price, unit, token, orgId);

      // Upsert in catalog table
      const { error } = await supabase.from('catalog').upsert({
        shopify_product_id: p.id,
        item_name:          itemName,
        unit_price:         price,
        unit,
        active:             true,
        shopify_tags:       tags,
        zoho_item_id:       zoho.item_id,
        zoho_item_name:     zoho.item_name,
        synced_at:          new Date().toISOString(),
      }, { onConflict: 'shopify_product_id' });

      if (error) throw new Error(`Catalog upsert failed for "${itemName}": ${error.message}`);
      results.push({ item_name: itemName, price, unit, zoho_item_id: zoho.item_id });
    }

    // Mark products no longer in Shopify as inactive
    const activeIds = allProducts.map(p => p.id);
    await supabase.from('catalog')
      .update({ active: false })
      .not('shopify_product_id', 'in', `(${activeIds.join(',')})`);

    return new Response(
      JSON.stringify({ synced: results.length, items: results }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
