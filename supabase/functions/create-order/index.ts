// Supabase Edge Function — create order header rows using the service role
//
// The `orders` table's RLS locks writes to service-role only (it carries
// real Zoho invoice / Razorpay payment state), so the parser can't upsert
// it directly with the public anon key. This function is the write path.
//
// Also derives the society/community name from each customer_name (see
// deriveSociety below — mirrors the identical function in
// ops-dashboard/parser.html, keep both in sync if the rule ever changes)
// and upserts it into `communities` — grows that reference table from real
// order data instead of maintaining a static list.
//
// Input:  { headers: [{ sales_order_id, customer_name, source?, payment_method?, invoice_status? }] }
// Output: { created: <count submitted> }
//
// Existing rows are left untouched (ignore-duplicates on sales_order_id) —
// this never overwrites an order that already has real invoice/payment data.
//
// Required env vars (auto-provided by the Supabase Edge Function runtime):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function sbHeaders() {
  return {
    'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey':        env('SUPABASE_SERVICE_ROLE_KEY'),
    'Content-Type':  'application/json',
  };
}

// Known society names that contain digits themselves (e.g. "77degree") —
// without this list those would get misread as already being the door
// number, leaving nothing valid before it.
const SOCIETIES = ["Kew","Rohan","77degree","77 degree","Ferns","Summerfield","Krishvigavakshi","Meda","Sunnyside","Assetz","Dhavala","Espana","UberPhase1","UberPhase2","Uber","Iris","Sobha Iris","Silversun","Ascentia","Ahad","Eternia","Sobha Eternia","Kethana","SJR","SJR Redwood","Silverdale","Oak","Oak Garden","Akme","Saroj","Regalia","Jade","Ivy","SLS","SLS Sunflower","SLS Signature","80 Trees","80trees","Lakefront","Vars","Suncity","Bhuvi","Palmera","Vajram","Vaswani","DSR Parkway","DSRParkway","Sunshine Signature","SunshineSignature","Iksha","Pristine","Villa","Lotus","T4","T3","Tower","Towers"];

// Community identity must be agnostic of case AND special characters — "77
// degree", "77degree" and "77-degree" are all the same place and must
// always resolve to exactly one community, never three. Matching and
// deduping happen on a canonical key (lowercase, letters/digits only);
// display casing is always "first letter capital, everything else
// lowercase" — mirrors the identical logic in ops-dashboard/parser.html,
// keep both in sync if this rule ever changes.
function communityCanonicalKey(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function formatCommunityName(s: string): string {
  const t = (s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
}

// Built once from SOCIETIES — groups synonym spellings ("77degree" / "77
// degree") under one canonical key, each mapped to a single display name,
// so every variant a customer might have typed always derives to the exact
// same community. Longest key first so a shorter entry can't shadow a more
// specific one that starts the same way.
const SOCIETY_DISPLAY_BY_KEY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const soc of SOCIETIES) {
    const key = communityCanonicalKey(soc);
    if (key && !map[key]) map[key] = formatCommunityName(soc);
  }
  return map;
})();
const SOCIETY_KEYS_BY_LENGTH = Object.keys(SOCIETY_DISPLAY_BY_KEY).sort((a, b) => b.length - a.length);

// Society name = everything before the door number, not just the first
// word. Checks the known SOCIETIES list first (via canonical-key prefix
// match, handles names that contain digits themselves), then falls back to
// every leading purely-alphabetic word up to the first word containing a
// digit.
function deriveSociety(customerName: string): string {
  const name = (customerName || '').trim();
  if (!name) return name;

  const canonicalName = communityCanonicalKey(name);
  for (const key of SOCIETY_KEYS_BY_LENGTH) {
    if (canonicalName.startsWith(key)) return SOCIETY_DISPLAY_BY_KEY[key];
  }

  const tokens = name.split(/\s+/);
  const doorIdx = tokens.findIndex(t => /\d/.test(t));
  const raw = doorIdx === -1 ? name : (doorIdx === 0 ? tokens[0] : tokens.slice(0, doorIdx).join(' '));
  return formatCommunityName(raw);
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { headers } = await req.json();

    if (!headers?.length) {
      return new Response(
        JSON.stringify({ error: 'No headers provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const rows = (headers as any[]).map(h => ({
      sales_order_id: h.sales_order_id,
      customer_name:  h.customer_name,
      source:         h.source ?? 'manual',
      payment_method: h.payment_method ?? 'cod',
      invoice_status: h.invoice_status ?? 'pending',
    }));

    const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/orders?on_conflict=sales_order_id`, {
      method:  'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body:    JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(await res.text());

    // Best-effort: grow the communities table from these customer names.
    // Never fails the request — a name-check pattern miss shouldn't block order creation.
    try {
      const societies = [...new Set(
        rows.map(r => deriveSociety(r.customer_name)).filter(Boolean),
      )].map(name => ({ name }));

      if (societies.length) {
        await fetch(`${env('SUPABASE_URL')}/rest/v1/communities?on_conflict=name`, {
          method:  'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body:    JSON.stringify(societies),
        });
      }
    } catch (_e) {
      // swallow — communities is a nice-to-have, not load-bearing for this request
    }

    return new Response(
      JSON.stringify({ created: rows.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
