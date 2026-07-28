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

// Known society names that contain digits themselves (e.g. "77degree") —
// without this list those would get misread as already being the door
// number, leaving nothing valid before it.
const SOCIETIES = ["Kew","Rohan","77degree","77 degree","Ferns","Summerfield","Krishvigavakshi","Meda","Sunnyside","Assetz","Dhavala","Espana","UberPhase1","UberPhase2","Uber","Iris","Sobha Iris","Silversun","Ascentia","Ahad","Eternia","Sobha Eternia","Snnraj Eternia","Kethana","SJR","SJR Redwood","Silverdale","Oak","Oak Garden","Akme","Saroj","Regalia","Jade","Ivy","SLS","SLS Sunflower","SLS Signature","80 Trees","80trees","Lakefront","Vars","Suncity","Bhuvi","Palmera","Vajram","Vaswani","DSR Parkway","DSRParkway","Sunshine Signature","SunshineSignature","Iksha","Pristine","Villa","Lotus","T4","T3","Tower","Towers"];

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

// Best-effort fuzzy match against the known SOCIETIES keys — a typo like
// "Krishvigavakhi" (missing the 's') should still resolve to the one
// correctly-spelled "Krishvigavakshi" entry rather than becoming its own
// junk community.
function fuzzySocietyMatch(canonicalKey: string): string | null {
  if (!canonicalKey) return null;
  let best: string | null = null, bestDist = Infinity;
  for (const key of SOCIETY_KEYS_BY_LENGTH) {
    const threshold = fuzzyThreshold(key.length);
    if (!threshold) continue;
    const dist = levenshtein(canonicalKey, key);
    if (dist <= threshold && dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

// Society name = everything before the door number, not just the first
// word. Checks the known SOCIETIES list first (via canonical-key prefix
// match, handles names that contain digits themselves), then falls back to
// every leading purely-alphabetic word up to the first word containing a
// digit — before accepting that fallback, it's checked against the known
// list once more by edit distance in case it's a typo of a real society
// (the exact-prefix check above only catches correctly-spelled names).
//
// `matched` tells the caller whether this came from the known SOCIETIES
// list (already guaranteed consistent) or the raw fallback guess (still
// vulnerable to a handful of customers typo-ing a name that isn't in the
// list at all) — only the latter needs the frequency-based clustering
// below, since re-clustering already-known societies risks accidentally
// merging two genuinely different ones that happen to look similar.
function deriveSocietyDetailed(customerName: string): { name: string; matched: boolean } {
  const name = (customerName || '').trim();
  if (!name) return { name, matched: false };

  const canonicalName = communityCanonicalKey(name);
  for (const key of SOCIETY_KEYS_BY_LENGTH) {
    if (canonicalName.startsWith(key)) return { name: SOCIETY_DISPLAY_BY_KEY[key], matched: true };
  }

  const tokens = name.split(/\s+/);
  const doorIdx = tokens.findIndex(t => /\d/.test(t));
  const raw = doorIdx === -1 ? name : (doorIdx === 0 ? tokens[0] : tokens.slice(0, doorIdx).join(' '));

  const fuzzyKey = fuzzySocietyMatch(communityCanonicalKey(raw));
  if (fuzzyKey) return { name: SOCIETY_DISPLAY_BY_KEY[fuzzyKey], matched: true };

  return { name: formatCommunityName(raw), matched: false };
}

// For communities NOT in the known SOCIETIES list at all: cluster the
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

    // Deduplicate: when two Zoho contacts clean to the same name,
    // keep the one whose original name is already closest to proper casing.
    const seen = new Map<string, { zohoId: string; score: number }>();
    for (const c of contacts) {
      const name  = cleanCustomerName(c.contact_name as string);
      if (!name) continue;
      const score = casingScore(c.contact_name as string, name);
      const prev  = seen.get(name);
      if (!prev || score > prev.score) seen.set(name, { zohoId: c.contact_id, score });
    }

    const rows = [...seen.entries()].map(([customer_name, { zohoId }]) => ({
      customer_name,
      zoho_contact_id: zohoId,
      active:          true,
      synced_at:       new Date().toISOString(),
    }));

    const { error } = await supabase
      .from('customers')
      .upsert(rows, { onConflict: 'customer_name' });

    if (error) throw new Error(`Sync failed: ${error.message}`);

    // Best-effort: backfill communities from every synced customer name.
    // Never fails the sync — a name-pattern miss shouldn't block it.
    let communitiesUpserted = 0;
    try {
      const derived = rows.map(r => deriveSocietyDetailed(r.customer_name));

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
