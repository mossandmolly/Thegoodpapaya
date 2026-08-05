// Supabase Edge Function — sync-customers
// Pulls active customer contacts from Zoho Books → customers table. Also
// derives each customer's society/community name (see deriveSocietyDetailed
// below — the core matching rule mirrors ops-dashboard/parser.html and
// create-order, keep all three in sync if it ever changes) and upserts it
// into `communities`. Since this pulls the FULL active contact list from
// Zoho every run (not incremental), this is what backfills communities for
// every customer already synced, not just ones who happen to place a new
// order — and, uniquely to this function, it's also the only place with
// enough of the full picture to frequency-correct typos in unlisted
// community names (see clusterAndCorrect below).
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

function cleanCustomerName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
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

// Same normalization customer_instructions is keyed by (see migration 048)
// and canonicalCustomerKey in ops-dashboard/parser.html — mirrors it here,
// keep both in sync if the rule ever changes.
function customerCanonicalKey(s: string): string {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

type SocietyLookup = { displayByKey: Record<string, string>; keysByLength: string[] };

// The `communities` table is the sole source of truth for known society
// names — no hardcoded fallback list. Built fresh per request from
// whatever's currently in the table (backfilled by this very function, or
// added via create-order/Config). Longest key first so a shorter entry
// can't shadow a more specific one that starts the same way. Anything not
// yet in `communities` falls through to the raw-text extraction below.
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
//
// `matched` tells the caller whether this came from an existing community
// (already guaranteed consistent) or the raw fallback guess (still
// vulnerable to a handful of customers typo-ing a name that isn't in
// `communities` at all) — only the latter needs the frequency-based
// clustering below, since re-clustering already-known societies risks
// accidentally merging two genuinely different ones that happen to look
// similar.
function deriveSocietyDetailed(customerName: string, lookup: SocietyLookup): { name: string; matched: boolean } {
  const name = (customerName || '').trim();
  if (!name) return { name, matched: false };

  const canonicalName = communityCanonicalKey(name);
  for (const key of lookup.keysByLength) {
    if (canonicalName.startsWith(key)) return { name: lookup.displayByKey[key], matched: true };
  }

  const tokens = name.split(/\s+/);
  const lastIdx = tokens.length - 1;
  const hasDoorTail = lastIdx > 0 && /\d/.test(tokens[lastIdx]);
  const raw = hasDoorTail ? tokens.slice(0, lastIdx).join(' ') : name;

  const fuzzyKey = fuzzySocietyMatch(communityCanonicalKey(raw), lookup);
  if (fuzzyKey) return { name: lookup.displayByKey[fuzzyKey], matched: true };

  return { name: formatCommunityName(raw), matched: false };
}

// For communities not already known at all: cluster the
// distinct derived names by edit distance (single-linkage via union-find),
// then within each cluster pick whichever exact spelling occurred most
// often among customers as canonical, remapping the rest to it. This is
// only reliable with the full customer list in view (this function
// re-pulls it every run), unlike per-order derivation elsewhere which only
// ever sees one small batch at a time.
function clusterAndCorrect(counts: Map<string, number>): Map<string, string> {
  const names = [...counts.keys()];
  const parent = new Map<string, string>(names.map(n => [n, n]));
  function find(n: string): string {
    while (parent.get(n) !== n) { parent.set(n, parent.get(parent.get(n)!)!); n = parent.get(n)!; }
    return n;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      const keyA = communityCanonicalKey(a), keyB = communityCanonicalKey(b);
      const threshold = fuzzyThreshold(Math.max(keyA.length, keyB.length));
      if (threshold && levenshtein(keyA, keyB) <= threshold) union(a, b);
    }
  }
  const clusters = new Map<string, string[]>();
  for (const n of names) {
    const root = find(n);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(n);
  }
  const remap = new Map<string, string>();
  for (const members of clusters.values()) {
    const canonical = members.reduce((best, n) => (counts.get(n)! > counts.get(best)! ? n : best), members[0]);
    for (const n of members) remap.set(n, canonical);
  }
  return remap;
}

// How many chars in the original already match the cleaned (proper-cased) version.
// Higher = already closer to correct casing = preferred when names collide.
function casingScore(original: string, cleaned: string): number {
  let score = 0;
  const len = Math.min(original.length, cleaned.length);
  for (let i = 0; i < len; i++) {
    if (original[i] === cleaned[i]) score++;
  }
  return score;
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
    await requireAuth(req);
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token    = await zohoToken();
    const orgId    = await getOrgId(token);
    const contacts = await fetchAllContacts(token, orgId);

    // Deduplicate: grouped by the fully-stripped canonical key (letters/
    // digits only — "Villa-60", "Villa 60" and "Villa60" are all the same
    // customer), not just the loosely-cleaned display string — cleaning
    // alone still left those three as different keys, since it turns "-"
    // into a space rather than removing it, so "Villa-60"/"Villa60" (no
    // space either way) never collided. Within a group, keep whichever
    // original name is already closest to proper casing.
    const seen = new Map<string, { zohoId: string; score: number; name: string }>();
    for (const c of contacts) {
      const name = cleanCustomerName(c.contact_name as string);
      if (!name) continue;
      const key = customerCanonicalKey(name);
      if (!key) continue;
      const score = casingScore(c.contact_name as string, name);
      const prev  = seen.get(key);
      if (!prev || score > prev.score) seen.set(key, { zohoId: c.contact_id, score, name });
    }

    const rows = [...seen.values()].map(({ zohoId, name: customer_name }) => ({
      customer_name,
      zoho_contact_id: zohoId,
      active:          true,
      synced_at:       new Date().toISOString(),
    }));

    const { error } = await supabase
      .from('customers')
      .upsert(rows, { onConflict: 'customer_name' });

    if (error) throw new Error(`Sync failed: ${error.message}`);

    // Standing instructions (customer_instructions, migration 048) are
    // looked up by normalized key at order-creation time, not tied to a
    // specific customers row — so a brand new name variant synced here
    // already gets the same instructions automatically, no copying needed.
    // What IS worth doing: keep display_name pointed at whatever spelling
    // Zoho — the source of truth — currently uses for that customer,
    // instead of possibly-typo'd text from whoever first typed it into the
    // Config panel. Best-effort, never fails the sync.
    let instructionsRelinked = 0;
    try {
      const { data: existingInstructions } = await supabase
        .from('customer_instructions')
        .select('normalized_key, display_name');
      const byKey = new Map((existingInstructions || []).map((r: any) => [r.normalized_key, r.display_name]));
      const relinks = rows
        .map(r => ({ key: customerCanonicalKey(r.customer_name), name: r.customer_name }))
        .filter(r => r.key && byKey.has(r.key) && byKey.get(r.key) !== r.name);
      for (const r of relinks) {
        const { error: relinkErr } = await supabase
          .from('customer_instructions')
          .update({ display_name: r.name })
          .eq('normalized_key', r.key);
        if (!relinkErr) instructionsRelinked++;
      }
    } catch (_e) {
      // swallow — display_name freshness is cosmetic, not load-bearing
    }

    // Best-effort: backfill communities from every synced customer name.
    // Never fails the sync — a name-pattern miss shouldn't block it.
    let communitiesUpserted = 0;
    try {
      // Fetched once, before deriving anything — folds every community
      // already in the table (found by a PREVIOUS run of this same
      // backfill, or by create-order, or entered by hand in Config) into
      // the matching lookup, so a community already known gets the same
      // exact-prefix/typo-correction treatment on every subsequent run.
      const { data: existingCommunities } = await supabase.from('communities').select('name');
      const lookup = buildSocietyLookup((existingCommunities || []).map((c: { name: string }) => c.name));

      const derived = rows.map(r => deriveSocietyDetailed(r.customer_name, lookup));

      // Frequency-correct only the unlisted (fallback-derived) names — if
      // 8 customers in a cluster spell it one way and 2 spell it another,
      // the 2 typos get remapped to the 8's spelling rather than minting
      // their own junk community.
      const unmatchedCounts = new Map<string, number>();
      for (const d of derived) {
        if (d.name && !d.matched) unmatchedCounts.set(d.name, (unmatchedCounts.get(d.name) ?? 0) + 1);
      }
      const remap = clusterAndCorrect(unmatchedCounts);

      const societies = [...new Set(
        derived.map(d => d.name ? (remap.get(d.name) ?? d.name) : d.name).filter(Boolean),
      )].map(name => ({ name }));

      if (societies.length) {
        const { error: commErr } = await supabase
          .from('communities')
          .upsert(societies, { onConflict: 'name', ignoreDuplicates: true });
        if (!commErr) communitiesUpserted = societies.length;
      }
    } catch (_e) {
      // swallow — communities is a nice-to-have, not load-bearing for this sync
    }

    return new Response(
      JSON.stringify({ synced: rows.length, communities: communitiesUpserted, org_id: orgId }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
