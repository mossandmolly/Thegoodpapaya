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
    const supabase  = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token     = await zohoToken();
    const orgId     = await getOrgId(token);
    const contacts  = await fetchAllContacts(token, orgId);

    let synced = 0;
    for (const c of contacts) {
      const customerName = cleanCustomerName(c.contact_name as string);
      if (!customerName) continue;

      const { error } = await supabase.from('customers').upsert({
        customer_name:    customerName,
        zoho_contact_id:  c.contact_id,
        active:           true,
        synced_at:        new Date().toISOString(),
      }, { onConflict: 'customer_name' });

      if (error) throw new Error(`Customer upsert failed for "${customerName}": ${error.message}`);
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
