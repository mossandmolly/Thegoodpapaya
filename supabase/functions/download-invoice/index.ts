// Supabase Edge Function — download-invoice
//
// Streams a Zoho Books invoice PDF back to the caller so the browser can
// download it directly — Zoho's PDF endpoint needs a valid OAuth token,
// which only this function (server-side) has; the frontend can't call
// Zoho directly.
//
// Input:  { sales_order_id: string }
// Output: application/pdf body (the invoice PDF itself) on success,
//         or { error } JSON on failure
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Two-tier cache: an in-memory one (fast path within a warm isolate) backed
// by a shared `zoho_token_cache` row in Postgres — generate-invoice,
// cancel-order, and download-invoice each run as separate functions with
// their OWN isolates, so an in-memory-only cache meant switching between
// actions (e.g. downloading right after generating invoices) still hit
// Zoho's OAuth endpoint fresh from each function, defeating the whole point
// of caching ("You have made too many requests continuously"). The DB row
// lets every function reuse the same token and refresh it only once across
// the whole system.
let cachedToken = '';
let tokenExpiry = 0;

async function getZohoToken(supabase: ReturnType<typeof createClient>): Promise<string> {
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
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho OAuth failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  // Zoho rotates refresh_token on (at least some) refresh calls and
  // invalidates the old one — persist whatever it returns so every
  // function keeps reading a live one instead of the static env secret.
  const { error: cacheErr } = await supabase.from('zoho_token_cache').upsert({
    id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  });
  if (cacheErr) console.error('zoho_token_cache upsert failed:', cacheErr.message);
  return cachedToken;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const { data: order, error } = await supabase
      .from('orders')
      .select('zoho_invoice_id, invoice_number')
      .eq('sales_order_id', sales_order_id)
      .single();
    if (error || !order) throw new Error(`Order ${sales_order_id} not found`);
    if (!order.zoho_invoice_id) throw new Error('No invoice generated for this order yet');

    const token = await getZohoToken(supabase);
    const orgId = env('ZOHO_ORGANIZATION_ID');
    const pdfRes = await fetch(
      `https://www.zohoapis.in/books/v3/invoices/${order.zoho_invoice_id}?organization_id=${orgId}&accept=pdf`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (!pdfRes.ok) throw new Error(`Zoho PDF fetch failed (${pdfRes.status})`);
    const pdfBuffer = await pdfRes.arrayBuffer();

    // Best-effort — the PDF itself already fetched fine, so a hiccup here
    // shouldn't turn a successful download into a failed response.
    await supabase
      .from('orders')
      .update({ invoice_downloaded_at: new Date().toISOString() })
      .eq('sales_order_id', sales_order_id)
      .then(({ error: updateErr }) => {
        if (updateErr) console.error('Could not stamp invoice_downloaded_at:', updateErr.message);
      });

    return new Response(pdfBuffer, {
      headers: {
        ...CORS,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${(order.invoice_number || sales_order_id)}.pdf"`,
      },
    });

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
