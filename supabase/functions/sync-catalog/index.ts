// Supabase Edge Function — sync-catalog
// Pulls active items from Zoho Books → catalog table.
// POST {} to trigger manually from admin panel.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
//   ZOHO_ORGANIZATION_ID  (or ZOHO_ORG_ID as fallback)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff.
async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

// In-memory (fast path within a warm isolate) backed by the shared
// zoho_token_cache row (migration 046) — this used to refresh on every
// single click of the "Catalog" sync button, with no caching at all.
let cachedToken = '';
let tokenExpiry = 0;

async function zohoToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const { data: row } = await supabase
    .from('zoho_token_cache').select('access_token,expires_at,refresh_token').eq('id', 1).maybeSingle();
  if (row && new Date(row.expires_at).getTime() > Date.now() + 60_000) {
    cachedToken = row.access_token;
    tokenExpiry = new Date(row.expires_at).getTime();
    return cachedToken;
  }

  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     env('ZOHO_CLIENT_ID'),
      client_secret: env('ZOHO_CLIENT_SECRET'),
      refresh_token: row?.refresh_token || env('ZOHO_REFRESH_TOKEN'),
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`Zoho OAuth failed: ${JSON.stringify(d)}`);
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in ?? 3600) * 1000;
  // Zoho rotates refresh_token on (at least some) refresh calls and
  // invalidates the old one — persist whatever it returns so every
  // function keeps reading a live one instead of the static env secret.
  const { error: cacheErr } = await supabase.from('zoho_token_cache').upsert({
    id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
    ...(d.refresh_token ? { refresh_token: d.refresh_token } : {}),
  });
  if (cacheErr) console.error('zoho_token_cache upsert failed:', cacheErr.message);
  return cachedToken;
}

async function getOrgId(token: string): Promise<string> {
  const envOrgId = (Deno.env.get('ZOHO_ORGANIZATION_ID') || Deno.env.get('ZOHO_ORG_ID'))?.trim();
  if (envOrgId) return envOrgId;
  const res = await fetch('https://www.zohoapis.in/books/v3/organizations', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const d = await res.json();
  const org = d.organizations?.[0];
  if (!org) throw new Error(`No Zoho organizations found: ${JSON.stringify(d)}`);
  return org.organization_id;
}

async function fetchAllItems(token: string, orgId: string) {
  let page = 1;
  const all: any[] = [];
  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&status=active&page=${page}&per_page=200`,
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token  = await zohoToken(supabase);
    const orgId  = await getOrgId(token);
    const items  = await fetchAllItems(token, orgId);

    let synced = 0;
    for (const item of items) {
      // Zoho's own exact casing, verbatim — no re-casing. Zoho item
      // matching/pricing is case-sensitive, so if the catalog (and, via
      // the autocomplete it feeds, every order created manually or
      // through the parser) doesn't carry the exact same casing Zoho
      // uses, an invoice line item can fail to link to the right Zoho
      // item and price incorrectly.
      const itemName = item.name as string;
      const zohoItemId = item.item_id as string;
      const row = {
        item_name:    itemName,
        unit_price:   item.rate ?? 0,
        unit:         item.unit || 'kg',
        active:       true,
        zoho_item_id: zohoItemId,
        synced_at:    new Date().toISOString(),
      };

      // catalog.item_name is independently UNIQUE (see migration 013), and
      // upserting on zoho_item_id alone doesn't know about that — a
      // straight upsert here throws "duplicate key value violates ...
      // catalog_item_name_key" whenever a row already sits at this exact
      // item_name under a different (or no) zoho_item_id, e.g. a stale
      // pre-Zoho-sync manual entry, or a name that only just changed
      // casing to match Zoho exactly (see above). Look the row up by
      // zoho_item_id first (the normal path once synced before); if
      // there's no match, fall back to a case-insensitive item_name match
      // and re-link THAT row instead of inserting a duplicate.
      const { data: byId } = await supabase.from('catalog')
        .select('id').eq('zoho_item_id', zohoItemId).maybeSingle();
      let targetId = byId?.id as string | undefined;
      if (!targetId) {
        const { data: byName } = await supabase.from('catalog')
          .select('id').ilike('item_name', itemName).maybeSingle();
        targetId = byName?.id as string | undefined;
      }

      const { error } = targetId
        ? await supabase.from('catalog').update(row).eq('id', targetId)
        : await supabase.from('catalog').insert(row);

      if (error) throw new Error(`Catalog upsert failed for "${itemName}": ${error.message}`);
      synced++;
    }

    return new Response(
      JSON.stringify({ synced, org_id: orgId }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
