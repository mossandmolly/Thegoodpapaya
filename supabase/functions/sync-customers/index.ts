// Supabase Edge Function — sync-customers
// Pulls active customer contacts from Zoho Books → customers table.
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

function cleanCustomerName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

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

async function fetchAllContacts(token: string, orgId: string) {
  let page = 1;
  const all: any[] = [];
  while (true) {
    const res = await fetch(
      `https://www.zohoapis.in/books/v3/contacts?organization_id=${orgId}&contact_type=customer&status=active&page=${page}&per_page=200`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const d = await res.json();
    const contacts = d.contacts || [];
    all.push(...contacts);
    if (!d.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token    = await zohoToken();
    const orgId    = await getOrgId(token);
    const contacts = await fetchAllContacts(token, orgId);

    // Deduplicate by cleaned name — Zoho may have slight name variations
    // that collapse to the same string after cleaning.
    const nameToZohoId = new Map<string, string>();
    for (const c of contacts) {
      const name = cleanCustomerName(c.contact_name as string);
      if (name && !nameToZohoId.has(name)) nameToZohoId.set(name, c.contact_id);
    }

    const allNames = [...nameToZohoId.keys()];
    const now      = new Date().toISOString();

    // Fetch which of these names already exist in the DB.
    const { data: existing, error: fetchErr } = await supabase
      .from('customers')
      .select('customer_name')
      .in('customer_name', allNames);
    if (fetchErr) throw new Error(`Failed to fetch existing customers: ${fetchErr.message}`);

    const existingSet = new Set((existing || []).map((r: any) => r.customer_name));

    // UPDATE existing rows (no insert, so no unique-constraint risk)
    for (const [name, zohoId] of nameToZohoId) {
      if (!existingSet.has(name)) continue;
      const { error } = await supabase
        .from('customers')
        .update({ zoho_contact_id: zohoId, active: true, synced_at: now })
        .eq('customer_name', name);
      if (error) throw new Error(`Update failed for "${name}": ${error.message}`);
    }

    // INSERT new rows (names not yet in DB, deduplicated, so no duplicate risk)
    const newRows = allNames
      .filter(name => !existingSet.has(name))
      .map(name => ({ customer_name: name, zoho_contact_id: nameToZohoId.get(name), active: true, synced_at: now }));

    if (newRows.length) {
      const { error } = await supabase.from('customers').insert(newRows);
      if (error) throw new Error(`Batch insert failed: ${error.message}`);
    }

    return new Response(
      JSON.stringify({ synced: allNames.length, updated: existingSet.size, inserted: newRows.length, org_id: orgId }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
