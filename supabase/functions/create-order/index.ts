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
// Input:  { headers: [{ sales_order_id, customer_name, source?, payment_method?, invoice_status?, deliver_by?, deliver_after?, phone?, whatsapp_raw_text?, whatsapp_group_name?, society? }] }
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-cron-secret',
};

function sbHeaders() {
  return {
    'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey':        env('SUPABASE_SERVICE_ROLE_KEY'),
    'Content-Type':  'application/json',
  };
}

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

type SocietyLookup = { displayByKey: Record<string, string>; keysByLength: string[] };

// The `communities` table is the sole source of truth for known society
// names — no hardcoded fallback list. Built fresh per request from
// whatever's currently in the table (grown automatically below, or
// entered by hand in Config). Longest key first so a shorter entry can't
// shadow a more specific one that starts the same way. Anything not yet
// in `communities` falls through to the raw-text extraction below.
function buildSocietyLookup(extraNames: string[]): SocietyLookup {
  const displayByKey: Record<string, string> = {};
  for (const name of extraNames) {
    const key = communityCanonicalKey(name);
    if (key && !displayByKey[key]) displayByKey[key] = name;
  }
  const keysByLength = Object.keys(displayByKey).sort((a, b) => b.length - a.length);
  return { displayByKey, keysByLength };
}

// Classic edit-distance DP — used to catch a typo'd society name ("out of
// 10 customers, 8 spell it right and 2 don't") instead of letting each
// misspelling mint its own separate community.
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// A handful of edits tolerated, scaled to the known name's length (skips
// anything under 4 chars — a 1-edit tolerance on "Kew" or "Ivy" would
// swallow unrelated short names).
function fuzzyThreshold(len: number): number {
  return len < 4 ? 0 : Math.max(1, Math.min(3, Math.floor(len * 0.2)));
}

// Best-effort fuzzy match against the known communities — a typo like
// "Krishvigavakhi" (missing the 's') should still resolve to the one
// correctly-spelled "Krishvigavakshi" entry rather than becoming its own
// junk community.
function fuzzySocietyMatch(canonicalKey: string, lookup: SocietyLookup): string | null {
  if (!canonicalKey) return null;
  let best: string | null = null, bestDist = Infinity;
  for (const key of lookup.keysByLength) {
    const threshold = fuzzyThreshold(key.length);
    if (!threshold) continue;
    const dist = levenshtein(canonicalKey, key);
    if (dist <= threshold && dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

// Society name = everything before the door number, not just the first
// word. Checks the known communities first (via canonical-key prefix
// match, handles names that contain digits themselves before the token
// split below has a chance to mis-split them), then falls back to
// splitting from the LAST space rather than the first digit: the final
// token is the door number if it contains a digit, everything before it
// is the society name. customer_name is always "society then door" by
// this point, and the door number is always the last token, so scanning
// from the back finds the true boundary even when the society name
// itself starts with a digit ("77 Degree", "80 Trees") — a front-to-back
// "first digit-token" scan would wrongly truncate at those. Before
// accepting that fallback, it's checked against the known communities
// once more by edit distance in case it's a typo of a real society (the
// exact-prefix check above only catches correctly-spelled names).
function deriveSociety(customerName: string, lookup: SocietyLookup): string {
  const name = (customerName || '').trim();
  if (!name) return name;

  const canonicalName = communityCanonicalKey(name);
  for (const key of lookup.keysByLength) {
    if (canonicalName.startsWith(key)) return lookup.displayByKey[key];
  }

  const tokens = name.split(/\s+/);
  const lastIdx = tokens.length - 1;
  const hasDoorTail = lastIdx > 0 && /\d/.test(tokens[lastIdx]);
  const raw = hasDoorTail ? tokens.slice(0, lastIdx).join(' ') : name;

  const fuzzyKey = fuzzySocietyMatch(communityCanonicalKey(raw), lookup);
  if (fuzzyKey) return lookup.displayByKey[fuzzyKey];

  return formatCommunityName(raw);
}

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff.
//
// x-cron-secret is the one exception — whatsapp-create-order calls this
// (for the header-row step only) on behalf of the WhatsApp listener, which
// has no logged-in user session to send, same shared-secret pattern
// generate-invoice/auto-invoice-final-orders already use.
async function requireAuth(req: Request): Promise<void> {
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    if (cronSecret !== env('CRON_SECRET')) throw new Error('Not authorized');
    return;
  }
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
      deliver_by:     h.deliver_by ?? null,
      deliver_after:  h.deliver_after ?? null,
      is_pickup:      !!h.is_pickup,
      // Only set on first insert — ignore-duplicates below means this never
      // overwrites a phone/blurb an existing order already has on file.
      phone:                h.phone ?? null,
      whatsapp_raw_text:    h.whatsapp_raw_text ?? null,
      whatsapp_group_name:  h.whatsapp_group_name ?? null,
      society:              h.society ?? null,
    }));

    const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/orders?on_conflict=sales_order_id`, {
      method:  'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body:    JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(await res.text());

    // ignore-duplicates leaves an already-existing order row completely
    // untouched — including status:'cancelled' from before. This function
    // being called at all means fresh order_items are about to be inserted
    // under these sales_order_ids, so any of them still sitting cancelled
    // need reopening first (same effect as reopen-order, the single-item
    // "Add Item" modal's equivalent path) — otherwise the new items land
    // under a parent order that still reads cancelled.
    try {
      const ids = rows.map(r => r.sales_order_id);
      const cancelledRes = await fetch(
        `${env('SUPABASE_URL')}/rest/v1/orders?sales_order_id=in.(${ids.map(id => `"${id}"`).join(',')})&status=eq.cancelled&select=sales_order_id`,
        { headers: sbHeaders() },
      );
      const cancelled: { sales_order_id: string }[] = cancelledRes.ok ? await cancelledRes.json() : [];
      if (cancelled.length) {
        await fetch(
          `${env('SUPABASE_URL')}/rest/v1/orders?sales_order_id=in.(${cancelled.map(c => `"${c.sales_order_id}"`).join(',')})`,
          {
            method: 'PATCH',
            headers: { ...sbHeaders(), Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'active', invoice_status: 'pending' }),
          },
        );
      }
    } catch (_e) {
      // swallow — best-effort; a failure here shouldn't block the order push,
      // worst case the order just stays cancelled and needs a manual reopen
    }

    // Best-effort: grow the communities table from these customer names.
    // Never fails the request — a name-check pattern miss shouldn't block order creation.
    try {
      // Fetched once, before deriving anything — used both to build the
      // society-matching lookup (so a community discovered from a
      // PREVIOUS order gets the same exact-prefix/typo-correction
      // treatment) and to dedupe the insert below by canonical key rather
      // than on_conflict's exact-string match — a society not yet in
      // `communities` falls through to formatCommunityName(raw), whose
      // output casing/spacing tracks whatever the AI parser happened to
      // extract that particular time (e.g. "Bren Edgewater" vs
      // "Brenedgewater" if a space gets dropped), so exact-string matching
      // alone lets near-duplicates pile up.
      const existingRes = await fetch(`${env('SUPABASE_URL')}/rest/v1/communities?select=name`, {
        headers: sbHeaders(),
      });
      const existing: { name: string }[] = existingRes.ok ? await existingRes.json() : [];
      const lookup = buildSocietyLookup(existing.map(c => c.name));

      const societies = [...new Set(
        rows.map(r => deriveSociety(r.customer_name, lookup)).filter(Boolean),
      )];

      if (societies.length) {
        const existingKeys = new Set(existing.map(c => communityCanonicalKey(c.name)));
        const toInsert = societies
          .filter(name => !existingKeys.has(communityCanonicalKey(name)))
          .map(name => ({ name }));

        if (toInsert.length) {
          await fetch(`${env('SUPABASE_URL')}/rest/v1/communities?on_conflict=name`, {
            method:  'POST',
            headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
            body:    JSON.stringify(toInsert),
          });
        }
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
