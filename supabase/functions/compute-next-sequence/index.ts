// Supabase Edge Function — compute-next-sequence
//
// Replaces manual push-to-queue (migration 119, now retired — see
// migration 120) with an automated scheduler. Triggered every 3 minutes by
// pg_cron (migration 121), same x-cron-secret pattern as sync-catalog/
// auto-invoice-final-orders. Each run looks at EVERY one of today's orders,
// sequenced or not, and either (1) appends each still-unsequenced one to an
// existing, still-open sequence that has room and a matching community, or
// (2) folds it into a brand-new sequence with other newly-arrived orders —
// every order gets sequenced every run, none is ever left waiting (see the
// "late" ranking rule below for how an 11am+ order is handled instead).
// orders.sequence_number/sequenced_at is the only thing the Packer tab's
// "My Sequence" view reads to decide what a given packer sees right now
// (see parser.html's computeMyCurrentSequence).
//
// Precedence: a deliver_by within 90 minutes beats everything (soonest
// first); otherwise Community Priority rank (community_priority.rank),
// then group size (smaller group first), then group name alphabetically,
// then created_at — the same four-tier order parser.html's
// sortGroupsByPriority/orderItemsByQueuePriority use client-side, so a
// listing built from either agrees with what the cron actually did. There
// is no manual override tier here (packer_priority_override, retired in
// migration 122): Somya's manual control happens by dragging a sequence or
// order directly in the Team tab's Sequences board.
//
// An order placed at or after 11:00 IST ("late") is NEVER excluded or left
// unsequenced waiting for a clock to strike — it's sequenced immediately,
// same run, same append-then-new-sequence pipeline as anything else. The
// only difference is rank: EVERY one of today's pre-11 sequences must be
// exhausted (across every community) before a late-only sequence is ever
// picked up. Two things enforce this, deliberately, in two different
// places: (1) appending — a late order can ONLY append into an existing
// sequence that is itself late (built entirely from late orders); it can
// never slot into a pre-11 sequence just because that sequence still has
// room, since doing so would get it packed ahead of OTHER, lower-priority
// pre-11 sequences that haven't been touched yet — that was the actual bug
// behind a 12:45pm Villa order (Villa being high community priority)
// repeatedly jumping ahead of lower-priority pre-11 work; (2) ranking — a
// brand-new sequence built entirely from late orders always sorts after
// every pre-11 sequence (see comparePriority's `late` tier), no matter how
// good its own community rank is. Timeline (tier0) bypasses this cohort
// split entirely in both places — see below. This replaces an earlier
// hold-then-release-at-15:30 design that excluded late orders from every
// run until some condition freed them, which left them invisible until
// release AND let them compete for lineup position on raw rank once
// released; ranking by "late" instead of excluding sidesteps both: always
// sequenced (nothing sits in limbo or shows as held anywhere), and never
// able to outrank pre-11 work regardless of its own community priority.
//
// IMPORTANT — this function DOES revisit already-sequenced orders. Three
// things can happen to one, every single run, independent of whether
// anything new showed up: (a) a new order ADDS to it (append, above); (b)
// if one of its orders newly has a deliver_by within 90 minutes (tier0),
// that ONE order first tries to merge into an EARLIER (better-ranked),
// still-open sequence of its own community or a combinable partner —
// ignoring the late/cohort split entirely, since timeline overrides it —
// and only if nothing earlier can absorb it does the sequence's whole
// position get promoted ahead of other not-yet-reached sequences (see the
// tier0-upgrade and promotion blocks below); (c) otherwise it is NEVER
// reordered, re-balanced, or has its packer assignments touched — so a
// packer already partway through a sequence never has her own already-
// packed items reassigned out from under her, and a manual drag Somya has
// done stays exactly as placed unless a live deadline forces it to jump —
// that's the one case "deliver_by beats everything" was always meant to
// apply in real time, not just at the moment a sequence was first built.
// Promotion (b) never reorders the CURRENT lowest-positioned, not-yet-
// complete sequence out of its slot — packers are actively converging on
// it right now, so bumping anything ahead of it would split it into two
// half-done sequences instead of letting it finish; everything after it is
// fair game. A new order
// can only join an existing sequence that is (a) not yet COMPLETE — still
// has at least one item that's 'open' or 'packed', the same "pending"
// definition parser.html's computeMyCurrentSequence uses, so a sequence
// only looks done here exactly when a packer's own view would also call it
// done — and (b) still has room under the 40-item hard cap. A sequence
// fills from its own community, then from a community Somya has explicitly
// marked combinable with it (community_combinable_groups, Config-curated);
// if neither has an existing OPEN sequence with room, the order falls
// through to being grouped with other newly-arrived orders into a BRAND NEW
// sequence (same community/combinable-group/target/cap rules as before,
// see pickNextCandidate's own comment on why there's no "pad with whatever
// is next" fallback any more), which then gets RANKED INTO today's current
// lineup by the same precedence rule — not just appended at the end — so a
// high-priority community that only just placed an order doesn't end up
// stuck behind everything manually or automatically sequenced earlier.
// Appending and ranking a new sequence in both use a fresh numeric
// sequence_number (fractional, e.g. 2.5 between 2 and 3 — migration 122) so
// neither operation ever needs to renumber anything else.
//
// Once a brand-new sequence's order set is fixed, its items are split
// fruit/veg packer, defaulting to packer_assignments and then actively
// evening out the load (moving items one at a time from the most- to
// least-loaded same-category packer until the gap is at most 1) — see
// balanceCategory() below. An APPENDED order's items only ever get placed
// onto whichever packer currently has the least load in that category
// within the target sequence — see placeNewItems() — deliberately never
// touching an item that was already there.
//
// Agreed expectation: most sequences will have little to no vacancy to
// append into, by design — they're already built up toward the ~30 item
// target/40 cap when formed, so an appended order will often find nowhere
// to fit and fall through to its own brand-new sequence instead. Appending
// is for the real but narrower case of a sequence that's genuinely under
// target (a small community with few orders, or one that stopped early
// because its combinable partners ran out) and a matching order arrives
// later in the day.
//
// Every run also checks packer PACE, independent of whether anything new
// got sequenced: within each category (fruit, veg), if the fastest packer
// is more than one sequence-position ahead of a colleague, half of that
// colleague's still-untouched ('open' only) items in the sequence she
// hasn't started yet move to the fast packer — see the pace-rebalancing
// block near the end, after the main write loop.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cron-secret',
};

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

// Same +330min-shift-then-read-UTC-fields trick every other cron function
// in this app uses for IST (auto-invoice-final-orders' todayIST(), etc).
function istNow(): Date {
  return new Date(Date.now() + 330 * 60 * 1000);
}
function istDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function istMinutesOfDay(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function istMinutesOfDayFromIso(iso: string): number {
  return istMinutesOfDay(new Date(new Date(iso).getTime() + 330 * 60 * 1000));
}
function istDateStrFromIso(iso: string): string {
  return istDateStr(new Date(new Date(iso).getTime() + 330 * 60 * 1000));
}

// deliver_by is stored as a plain "HH:MM" time-of-day string (meant as
// "today, by this time") — same same-day assumption parser.html's own
// minutesToDeadline() makes, deliberately mirrored here rather than
// reinvented.
function deadlineMinutesFromNow(deliverBy: string | null, now: Date): number | null {
  if (!deliverBy) return null;
  const [h, m] = deliverBy.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return (h * 60 + m) - istMinutesOfDay(now);
}

const TIMELINE_BUFFER_MIN = 90;
const LATE_CUTOFF_MIN = 11 * 60; // 11:00 IST — see classify()'s `late` check
const SEQUENCE_TARGET = 30;
const SEQUENCE_HARD_CAP = 40;
const RECENT_SOCIETY_WINDOW = 2;
const MAX_SEQUENCES_PER_RUN = 20;

// Mirrors ops-dashboard/parser.html's own VEGETABLE_ITEM_NAMES — same
// three-copy convention that list's own comment already documents
// (parser.html + whatsapp-listener/index.js), now a fourth. catalog.category
// (migration 087) is the primary source; this is only a gap-filler for any
// item that table hasn't been back-filled for (e.g. added to Zoho after
// that one-time backfill ran — sync-catalog doesn't set category).
const VEGETABLE_ITEM_NAMES = new Set(["cauliflower","cabbage","capsicum green","capsicum yellow","capsicum red","carrot","tomato","ginger","beans","lady's finger","cucumber","coriander","chilli green","potato","onion","ridge gourd","bitter gourd","bottle gourd","brinjal bottle","broccoli","banana leaves","spinach","amaranthus","fenugreek","mangalore cucumber","drumstick","chilli bhajji","coccinia","mint","lettuce","beetroot","zucchini green","zucchini yellow","red cabbage","mushroom","garlic"]);

interface OrderRow {
  sales_order_id: string;
  society: string | null;
  customer_name: string;
  deliver_by: string | null;
  created_at: string;
  is_pickup: boolean;
  sequence_number: number | string | null; // numeric column — PostgREST may return it as a string
  dispatched_at: string | null; // set by dispatch-order the moment a rider's trip actually leaves
}
interface ItemRow {
  id: string;
  sales_order_id: string;
  item_name: string;
  assigned_packer_id: string | null;
  status: string;
}

// PostgREST can return a `numeric` column as a string to avoid precision
// loss — coerce explicitly wherever sequence_number is read as a number.
function toNum(v: number | string | null): number | null {
  if (v == null) return null;
  return typeof v === 'string' ? Number(v) : v;
}
interface CommunityPriority {
  unique_id: string;
  display_name: string;
  rank: number | null;
  default_deliver_by: string | null;
  keywords: string[];
}
interface OrderMeta {
  order: OrderRow;
  itemCount: number;       // non-cancelled items, regardless of pickup
  groupName: string;
  uniqueId: string | null; // community_priority.unique_id, for combinable-group lookup; null if unmatched
  rank: number;            // Infinity if unmatched
  groupSize: number;       // how many of today's eligible orders share this groupName — filled in after classification
  tier0: boolean;
  deadlineMins: number;    // Infinity if not tier0
  createdAtMs: number;
  late: boolean;           // placed today at/after 11:00 IST — see classify()
}

// Plain case-insensitive substring match, longest keyword wins on overlap —
// exactly the rule match_community_priority() (migration 108) documents and
// parser.html's matchCommunityPriority() already implements client-side.
function matchCommunity(text: string | null, priorities: CommunityPriority[]): CommunityPriority | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let best: CommunityPriority | null = null, bestLen = -1;
  for (const c of priorities) {
    for (const kw of c.keywords) {
      if (kw && lower.includes(kw.toLowerCase()) && kw.length > bestLen) { best = c; bestLen = kw.length; }
    }
  }
  return best;
}

// Community rank, then smaller group first, then group name alphabetically,
// then created_at as the final per-order tiebreak within an identical
// group — the same four tiers parser.html's sortGroupsByPriority/
// orderItemsByQueuePriority apply client-side (minus their own timeline
// tier, which is already split out as tier0 before this ever runs).
function compareTier2(a: OrderMeta, b: OrderMeta): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.groupSize !== b.groupSize) return a.groupSize - b.groupSize;
  if (a.groupName !== b.groupName) return a.groupName.localeCompare(b.groupName);
  return a.createdAtMs - b.createdAtMs;
}

// Three-level precedence used both to rank a brand-new sequence into
// today's lineup and to promote an already-sequenced one that's become
// timeline-urgent since it was built (see the promotion block below): a
// sequence with a live timeline order (tier0) always ranks ahead of every
// plain-community-rank sequence, soonest-deadline-first, including
// overdue; when two timeline sequences tie on deadline, "late" (see
// classify()) breaks the tie before rank does, then community rank.
// Outside tier0, a sequence built entirely from "late" orders always
// ranks after every sequence that isn't — regardless of how good its own
// community rank is — so an 11am+ order can never outrank pre-11 work
// just because its community happens to be a priority one.
interface LineupKey { tier0MinDeadline: number; late: boolean; bestRank: number }
function comparePriority(a: LineupKey, b: LineupKey): number {
  const aTier0 = a.tier0MinDeadline !== Infinity, bTier0 = b.tier0MinDeadline !== Infinity;
  if (aTier0 !== bTier0) return aTier0 ? -1 : 1;
  if (aTier0 && a.tier0MinDeadline !== b.tier0MinDeadline) return a.tier0MinDeadline - b.tier0MinDeadline;
  if (a.late !== b.late) return a.late ? 1 : -1;
  return a.bestRank - b.bestRank;
}

// Picks which remaining order starts a brand new sequence: prefers one NOT
// from a just-used society (recentGroups), unless every remaining order is
// (then reuse is forced rather than stalling). A Tier-0 (timeline) order is
// never deferred for this reason — timeline always wins over cycling.
function pickSequenceStart(remaining: OrderMeta[], recentGroups: string[]): number {
  const idx = remaining.findIndex(o => o.tier0 || !recentGroups.includes(o.groupName));
  return idx >= 0 ? idx : 0;
}

// Picks the next order to ADD to a sequence already in progress, in order
// of preference: (1) same society as the sequence's starting order — fills
// a lone timeline order's trip, or just keeps a society together; (2) a
// community Somya has explicitly grouped with the dominant one as
// "combinable" (community_combinable_groups, Config-curated — see
// combinablePartners below). There is deliberately no tier 3 "pad with
// whatever's next in priority order" fallback any more — that used to fire
// whenever a sequence's own community and its combinable partners both ran
// out, bypassing the combinable groups entirely and mixing in communities
// Somya had specifically NOT grouped together (observed combining Rohan,
// Meda and Purva — three different, deliberately separate combinable
// groups — because at the moment that particular sequence was built,
// nothing else was in the pool yet). Per Somya: once a sequence's own
// community and its combinable partners are exhausted, it ships smaller
// than the ~30 item target rather than pad with an unrelated community —
// this function returns -1 and the caller (below) closes the sequence
// there. Both tiers are filtered to orders that actually fit under the
// remaining capacity — an order that doesn't is left in `remaining` for a
// LATER sequence instead of delaying this one (the "23-24 item order"
// case) — and to orders in the SAME late/pre-11 cohort as the sequence's
// dominant order (unless either side is tier0, which bypasses the cohort
// split entirely) — otherwise a late order could pad its way into an
// otherwise-pre-11 brand-new sequence, the same cross-cohort leak the
// append loop guards against.
function cohortOk(o: OrderMeta, dominantLate: boolean, dominantIsTier0: boolean): boolean {
  return dominantIsTier0 || o.tier0 || o.late === dominantLate;
}
function pickNextCandidate(remaining: OrderMeta[], dominantGroup: string, dominantUniqueId: string | null, dominantLate: boolean, dominantIsTier0: boolean, combinablePartners: Map<string, Set<string>>, capacityLeft: number): number {
  let idx = remaining.findIndex(o => o.groupName === dominantGroup && o.itemCount <= capacityLeft && cohortOk(o, dominantLate, dominantIsTier0));
  if (idx >= 0) return idx;

  if (dominantUniqueId) {
    const partners = combinablePartners.get(dominantUniqueId);
    if (partners && partners.size) {
      idx = remaining.findIndex(o => o.uniqueId != null && partners.has(o.uniqueId) && o.itemCount <= capacityLeft && cohortOk(o, dominantLate, dominantIsTier0));
      if (idx >= 0) return idx;
    }
  }

  return -1;
}

// Splits one category's (fruit or veg) items across that category's active
// packers: defaults to packer_assignments, places anything unassigned on
// the least-loaded packer, then actively evens out the load — moving one
// item at a time from the most- to least-loaded packer until the gap is at
// most 1 — rather than only intervening once some ratio threshold is
// crossed. Per Somya: "fruit or vegetable assignment is purely a guideline,
// not to be tightly held" — a fixed item→packer default shouldn't leave one
// packer sitting on meaningfully more work than a same-category colleague
// just because the day's mix of items happened to default that way.
// Returns only the item IDs that actually need a DB write (i.e. differ from
// their current effective packer) — items staying on their default need no
// override row at all.
function balanceCategory(
  items: ItemRow[],
  defaultPackerIdByItem: Map<string, string>,
  packerIds: string[],
): Map<string, string> {
  if (!packerIds.length || !items.length) return new Map();

  const counts = new Map<string, number>(packerIds.map(id => [id, 0]));
  const assignment = new Map<string, string>();
  const unassigned: ItemRow[] = [];

  for (const it of items) {
    const def = defaultPackerIdByItem.get(it.item_name);
    if (def && packerIds.includes(def)) {
      assignment.set(it.id, def);
      counts.set(def, (counts.get(def) || 0) + 1);
    } else {
      unassigned.push(it);
    }
  }

  for (const it of unassigned) {
    const target = packerIds.reduce((a, b) => (counts.get(a)! <= counts.get(b)!) ? a : b);
    assignment.set(it.id, target);
    counts.set(target, counts.get(target)! + 1);
  }

  for (let guard = 0; guard < items.length; guard++) { // bounded — at most one move per item, ever
    const mostLoaded = packerIds.reduce((a, b) => counts.get(a)! >= counts.get(b)! ? a : b);
    const leastLoaded = packerIds.reduce((a, b) => counts.get(a)! <= counts.get(b)! ? a : b);
    if (counts.get(mostLoaded)! - counts.get(leastLoaded)! <= 1) break; // already as even as a whole-item move can make it
    const itemToMove = items.find(it => assignment.get(it.id) === mostLoaded);
    if (!itemToMove) break;
    assignment.set(itemToMove.id, leastLoaded);
    counts.set(mostLoaded, counts.get(mostLoaded)! - 1);
    counts.set(leastLoaded, counts.get(leastLoaded)! + 1);
  }

  const writes = new Map<string, string>();
  for (const it of items) {
    const finalId = assignment.get(it.id);
    const currentEffective = it.assigned_packer_id || defaultPackerIdByItem.get(it.item_name) || null;
    if (finalId && finalId !== currentEffective) writes.set(it.id, finalId);
  }
  return writes;
}

// One category's current per-packer load within a sequence, from whatever
// is ALREADY there — the baseline placeNewItems() places new arrivals
// against, so appending never needs to touch an item that was already
// assigned.
function countsByPacker(items: ItemRow[], defaultPackerIdByItem: Map<string, string>, packerIds: string[]): Map<string, number> {
  const counts = new Map<string, number>(packerIds.map(id => [id, 0]));
  for (const it of items) {
    const eff = it.assigned_packer_id || defaultPackerIdByItem.get(it.item_name);
    if (eff && packerIds.includes(eff)) counts.set(eff, (counts.get(eff) || 0) + 1);
  }
  return counts;
}

// Places brand-new items (from an order just appended to an existing
// sequence) onto whichever packer in this category currently has the least
// load, starting from `existingCounts` (the sequence's real current state)
// — unlike balanceCategory, this never moves or re-evaluates an item that
// was already assigned before this call. Per Somya: "worry about load-
// balancing newly added orders, not messing around with the assignment of
// existing orders."
function placeNewItems(
  items: ItemRow[],
  defaultPackerIdByItem: Map<string, string>,
  packerIds: string[],
  existingCounts: Map<string, number>,
): Map<string, string> {
  if (!packerIds.length || !items.length) return new Map();
  const counts = new Map<string, number>(packerIds.map(id => [id, existingCounts.get(id) || 0]));
  const writes = new Map<string, string>();
  for (const it of items) {
    const def = defaultPackerIdByItem.get(it.item_name);
    const target = (def && packerIds.includes(def)) ? def : packerIds.reduce((a, b) => (counts.get(a)! <= counts.get(b)!) ? a : b);
    writes.set(it.id, target);
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  return writes;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const now = istNow();
    const today = istDateStr(now);
    const nowIso = new Date().toISOString();

    // ── Reset the rolling "recently sequenced societies" window on a new day ──
    const { data: stateRow } = await supabase.from('packer_sequence_state').select('*').eq('id', 1).maybeSingle();
    let recentGroups: string[] = [];
    if (stateRow) {
      const updatedDateStr = istDateStr(new Date(new Date(stateRow.updated_at).getTime() + 330 * 60 * 1000));
      recentGroups = updatedDateStr === today ? (stateRow.recent_group_names || []) : [];
    }

    // ── Load EVERY one of today's orders, sequenced or not, + their items ──
    // Sequenced orders are included now too (not just sequence_number is
    // null) — needed to know each existing sequence's current community
    // set, item count, and completeness, so a new order can be appended to
    // one instead of always starting a fresh sequence.
    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('sales_order_id,society,customer_name,deliver_by,created_at,is_pickup,status,sequence_number,dispatched_at')
      .like('sales_order_id', `${today}-%`)
      .neq('status', 'cancelled');
    if (ordersErr) throw new Error(ordersErr.message);
    if (!orders || !orders.length) {
      return new Response(JSON.stringify({ sequences_created: 0, orders_sequenced: 0, orders_appended: 0, reason: 'no orders today' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const soids = orders.map((o: OrderRow) => o.sales_order_id);
    const itemsByOrder = new Map<string, ItemRow[]>();
    const CHUNK = 150;
    for (let i = 0; i < soids.length; i += CHUNK) {
      const chunk = soids.slice(i, i + CHUNK);
      const { data: items, error: itemsErr } = await supabase
        .from('order_items')
        .select('id,sales_order_id,item_name,assigned_packer_id,status')
        .in('sales_order_id', chunk)
        .neq('status', 'cancelled');
      if (itemsErr) throw new Error(itemsErr.message);
      (items || []).forEach((it: ItemRow) => {
        if (!itemsByOrder.has(it.sales_order_id)) itemsByOrder.set(it.sales_order_id, []);
        itemsByOrder.get(it.sales_order_id)!.push(it);
      });
    }

    // ── Community priority + reference data ───────────────────────────────
    const [cpRes, kwRes, catalogRes, packerRes, assignRes, combMemberRes] = await Promise.all([
      supabase.from('community_priority').select('unique_id,display_name,rank,default_deliver_by'),
      supabase.from('community_priority_keywords').select('community_unique_id,keyword'),
      supabase.from('catalog').select('item_name,category'),
      supabase.from('packers').select('id,name,category').eq('active', true),
      supabase.from('packer_assignments').select('packer_id,item_name'),
      supabase.from('community_combinable_group_members').select('group_id,community_unique_id'),
    ]);
    // None of these are fatal to crash the whole run over — degrade
    // gracefully (community/category/assignment/combinable-group data just
    // comes up empty, same as if nothing were configured yet) but log so a
    // persistent problem is actually visible in the function's logs.
    [cpRes, kwRes, catalogRes, packerRes, assignRes, combMemberRes]
      .forEach(r => { if (r.error) console.error('Reference data fetch failed:', r.error.message); });
    const cpRows = cpRes.data, kwRows = kwRes.data,
          catalogRows = catalogRes.data, packerRows = packerRes.data, assignRows = assignRes.data,
          combMemberRows = combMemberRes.data;

    const priorities: CommunityPriority[] = (cpRows || []).map((c: any) => ({ ...c, keywords: [] as string[] }));
    const priorityById = new Map(priorities.map(p => [p.unique_id, p]));
    (kwRows || []).forEach((k: any) => { priorityById.get(k.community_unique_id)?.keywords.push(k.keyword); });

    // Somya-curated "these communities can share a sequence" groups
    // (Config → Combinable Groups). community_unique_id -> set of every
    // OTHER community_unique_id sharing at least one group with it — the
    // actual fix for the "unrelated communities got padded together" bug:
    // tier 2 of pickNextCandidate now only pads from a group an admin
    // explicitly built, not from whatever happens to sit at a nearby rank.
    const combinablePartners = new Map<string, Set<string>>();
    {
      const membersByGroup = new Map<string, string[]>();
      (combMemberRows || []).forEach((m: any) => {
        if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
        membersByGroup.get(m.group_id)!.push(m.community_unique_id);
      });
      for (const members of membersByGroup.values()) {
        for (const id of members) {
          if (!combinablePartners.has(id)) combinablePartners.set(id, new Set());
          const set = combinablePartners.get(id)!;
          for (const other of members) if (other !== id) set.add(other);
        }
      }
    }

    const categoryByItem = new Map<string, 'fruit' | 'vegetable'>();
    (catalogRows || []).forEach((c: any) => { if (c.category === 'fruit' || c.category === 'vegetable') categoryByItem.set(c.item_name, c.category); });
    function itemCategory(itemName: string): 'fruit' | 'vegetable' {
      const fromCatalog = categoryByItem.get(itemName);
      if (fromCatalog) return fromCatalog;
      return VEGETABLE_ITEM_NAMES.has(itemName.toLowerCase()) ? 'vegetable' : 'fruit';
    }

    const fruitPackerIds = (packerRows || []).filter((p: any) => p.category === 'fruit').map((p: any) => p.id);
    const vegPackerIds = (packerRows || []).filter((p: any) => p.category === 'vegetable').map((p: any) => p.id);
    const defaultPackerIdByItem = new Map<string, string>();
    (assignRows || []).forEach((a: any) => defaultPackerIdByItem.set(a.item_name, a.packer_id));

    // ── Classify every order ──────────────────────────────────────────────
    const metas: OrderMeta[] = orders.map((o: OrderRow) => {
      const items = itemsByOrder.get(o.sales_order_id) || [];
      const match = matchCommunity(o.society || o.customer_name, priorities);
      const groupName = match ? match.display_name : (o.society || o.customer_name);
      const rank = match?.rank ?? Infinity;
      // An order's own deadline always wins; the community's
      // default_deliver_by only fills in when this order has none of its
      // own — same fallback rule sortGroupsByPriority (parser.html) applies
      // for the Time Sensitive listing views, mirrored here for consistency.
      const deadlineMins = deadlineMinutesFromNow(o.deliver_by || match?.default_deliver_by || null, now);
      const tier0 = deadlineMins != null && deadlineMins <= TIMELINE_BUFFER_MIN;
      const createdMinsOfDay = istMinutesOfDayFromIso(o.created_at);
      // Open-ended: ANY order placed at or after 11:00 IST is "late", not
      // just ones placed in an 11:00-13:00 window — a 2pm order is late
      // exactly the same as an 11:05 one. Must have been placed TODAY, not
      // just at some point whose time-of-day happens to fall after
      // 11:00 — an order from yesterday at, say, 11:24 IST (for a next-day
      // delivery, hence today's sales_order_id prefix) was never "placed in
      // today's post-11:00 window" and shouldn't be penalised for one it
      // was never in. Late only ever affects RANKING (see comparePriority)
      // — it never excludes an order from this run.
      const late = !tier0
        && istDateStrFromIso(o.created_at) === today
        && createdMinsOfDay >= LATE_CUTOFF_MIN;
      return {
        order: o,
        itemCount: items.length,
        groupName,
        uniqueId: match?.unique_id ?? null,
        rank,
        groupSize: 0, // filled in below, once every order's groupName is known
        tier0,
        deadlineMins: tier0 ? deadlineMins! : Infinity,
        createdAtMs: new Date(o.created_at).getTime(),
        late,
      };
    }).filter(m => m.itemCount > 0); // nothing active left to pack — skip entirely

    const newMetas = metas.filter(m => toNum(m.order.sequence_number) == null);
    const existingMetas = metas.filter(m => toNum(m.order.sequence_number) != null);

    // ── Existing sequences: their current communities, load, and whether
    // they're still open to a new arrival ─────────────────────────────────
    interface ExistingSeq {
      seq: number;
      soids: string[];
      communities: Set<string>;
      uniqueIds: Set<string>;
      bestRank: number;
      tier0MinDeadline: number; // Infinity unless this sequence still has a live timeline order
      late: boolean; // true only if EVERY order in it was "late" (see classify()) — one pre-11 member is enough to count the whole sequence as not-late
      nonPickupCount: number;
      nonPickupOrderCount: number;          // # of non-pickup ORDERS (not items) in this sequence
      dispatchedNonPickupOrderCount: number; // # of those whose trip has actually left
      isComplete: boolean;
    }
    const existingSeqMap = new Map<number, ExistingSeq>();
    existingMetas.forEach(m => {
      const seqNum = toNum(m.order.sequence_number)!;
      if (!existingSeqMap.has(seqNum)) {
        existingSeqMap.set(seqNum, { seq: seqNum, soids: [], communities: new Set(), uniqueIds: new Set(), bestRank: Infinity, tier0MinDeadline: Infinity, late: true, nonPickupCount: 0, nonPickupOrderCount: 0, dispatchedNonPickupOrderCount: 0, isComplete: true });
      }
      const rec = existingSeqMap.get(seqNum)!;
      rec.soids.push(m.order.sales_order_id);
      rec.communities.add(m.groupName);
      if (m.uniqueId) rec.uniqueIds.add(m.uniqueId);
      if (m.rank < rec.bestRank) rec.bestRank = m.rank;
      if (m.tier0 && m.deadlineMins < rec.tier0MinDeadline) rec.tier0MinDeadline = m.deadlineMins;
      rec.late = rec.late && m.late;
      if (!m.order.is_pickup) {
        rec.nonPickupCount += m.itemCount;
        rec.nonPickupOrderCount += 1;
        if (m.order.dispatched_at) rec.dispatchedNonPickupOrderCount += 1;
      }
    });
    // Complete = either (a) EVERY non-pickup order in the sequence has
    // actually shipped (dispatched_at set on all of them), or (b) nothing
    // left in it is 'open'/'packed' — the exact same "pending" definition
    // parser.html's computeMyCurrentSequence uses to decide a packer is
    // done with a sequence. Item status alone isn't reliable for this: it
    // was letting a sequence absorb new orders hours after its real
    // dispatch, observed spanning created_at times from 9:20am to 5:07pm in
    // one "done" sequence, which obviously never happened as one trip. But
    // dispatch itself isn't always one atomic trip either — orders within a
    // sequence can and do go out separately, one rider at a time, as each
    // is ready — so checking for ANY single dispatched order was marking
    // the WHOLE sequence complete (and kicking off orphan-rescue below,
    // which re-sequences every other still-pending order in it elsewhere)
    // the moment just one order shipped early, blowing apart a sequence
    // Somya had just arranged while most of it was still mid-pack. Requires
    // ALL of them now.
    existingSeqMap.forEach(rec => {
      if (rec.nonPickupOrderCount > 0 && rec.dispatchedNonPickupOrderCount >= rec.nonPickupOrderCount) {
        rec.isComplete = true;
        return;
      }
      const items = rec.soids.flatMap(soid => itemsByOrder.get(soid) || []);
      rec.isComplete = items.length > 0 && items.every(it => it.status !== 'open' && it.status !== 'packed');
    });
    const existingSeqAscending = () => [...existingSeqMap.values()].sort((a, b) => a.seq - b.seq);
    const existingMetaBySoid = new Map(existingMetas.map(m => [m.order.sales_order_id, m]));

    // ── Tier0 upgrade: an order in an EXISTING sequence that has become
    // timeline-urgent (newly tier0) THIS run ───────────────────────────────
    // First try to merge just that ONE order into an earlier (better-
    // ranked), still-open sequence of its own community or a combinable
    // partner — ignoring the late/cohort split entirely, since timeline
    // overrides it. Only if nothing earlier can absorb it does the whole-
    // sequence promotion below take over. Per Somya: "try to fit the order
    // with timeline in a higher sequence of combinable group, if none
    // exists, push the whole sequence up." Merging into an already-active
    // sequence (even the one currently being packed) is fine here — it
    // only ADDS to that batch, same as any append, so it never "stops" or
    // splits anything.
    let ordersUrgentMoved = 0;
    for (const m of existingMetas.filter(x => x.tier0)) {
      const curSeq = toNum(m.order.sequence_number)!;
      const curRec = existingSeqMap.get(curSeq);
      if (!curRec) continue;
      const wouldAddCount = m.order.is_pickup ? 0 : m.itemCount;
      let target: ExistingSeq | undefined;
      for (const rec of existingSeqAscending()) {
        if (rec.seq >= curSeq) break; // only an earlier (better-ranked) sequence counts as an upgrade
        if (rec.isComplete || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
        if (rec.communities.has(m.groupName)) { target = rec; break; }
      }
      if (!target && m.uniqueId) {
        const partners = combinablePartners.get(m.uniqueId);
        if (partners && partners.size) {
          for (const rec of existingSeqAscending()) {
            if (rec.seq >= curSeq) break;
            if (rec.isComplete || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
            if ([...rec.uniqueIds].some(id => partners.has(id))) { target = rec; break; }
          }
        }
      }
      if (!target) continue; // nothing earlier can absorb it — whole-sequence promotion (below) handles this instead

      const { error: moveErr } = await supabase.from('orders')
        .update({ sequence_number: target.seq, sequenced_at: nowIso })
        .eq('sales_order_id', m.order.sales_order_id);
      if (moveErr) { console.error(`Failed to move urgent order ${m.order.sales_order_id} to sequence ${target.seq}:`, moveErr.message); continue; }

      // Place its (non-final/invoiced) items against target's CURRENT load
      // only — same rule an append uses, never touching an item already there.
      const movedItems = (itemsByOrder.get(m.order.sales_order_id) || [])
        .filter(it => it.status !== 'final' && it.status !== 'invoiced');
      const targetExistingItems = target.soids.flatMap(soid => itemsByOrder.get(soid) || []);
      const itemWrites = new Map<string, string>([
        ...placeNewItems(
          movedItems.filter(it => itemCategory(it.item_name) === 'fruit'),
          defaultPackerIdByItem, fruitPackerIds,
          countsByPacker(targetExistingItems.filter(it => itemCategory(it.item_name) === 'fruit'), defaultPackerIdByItem, fruitPackerIds),
        ),
        ...placeNewItems(
          movedItems.filter(it => itemCategory(it.item_name) === 'vegetable'),
          defaultPackerIdByItem, vegPackerIds,
          countsByPacker(targetExistingItems.filter(it => itemCategory(it.item_name) === 'vegetable'), defaultPackerIdByItem, vegPackerIds),
        ),
      ]);
      for (const [itemId, packerId] of itemWrites) {
        const { error: itemErr } = await supabase.from('order_items').update({ assigned_packer_id: packerId }).eq('id', itemId);
        if (itemErr) console.error(`Failed to assign urgent-moved item ${itemId}:`, itemErr.message);
      }
      // Keep the in-memory item cache consistent too — these ItemRow
      // objects are the same ones itemsByOrder hands out everywhere else
      // this run (append matching, the write loop, pace-rebalancing), so a
      // later step touching this same sequence sees the real current load
      // instead of each item's pre-move assignment.
      movedItems.forEach(it => { if (itemWrites.has(it.id)) it.assigned_packer_id = itemWrites.get(it.id)!; });
      ordersUrgentMoved++;

      // Keep in-memory state consistent for the rest of THIS run (the
      // promotion block right below, lineup ranking, pace-rebalancing).
      curRec.soids = curRec.soids.filter(s => s !== m.order.sales_order_id);
      curRec.nonPickupCount -= wouldAddCount;
      if (!m.order.is_pickup) curRec.nonPickupOrderCount -= 1;
      curRec.tier0MinDeadline = Math.min(
        Infinity,
        ...curRec.soids.map(soid => existingMetaBySoid.get(soid)).filter((em): em is OrderMeta => !!em && em.tier0).map(em => em.deadlineMins),
      );
      curRec.late = curRec.soids.length ? curRec.soids.every(soid => existingMetaBySoid.get(soid)!.late) : true;

      target.soids.push(m.order.sales_order_id);
      target.communities.add(m.groupName);
      if (m.uniqueId) target.uniqueIds.add(m.uniqueId);
      if (m.rank < target.bestRank) target.bestRank = m.rank;
      target.tier0MinDeadline = Math.min(target.tier0MinDeadline, m.deadlineMins);
      target.late = target.late && m.late;
      target.nonPickupCount += wouldAddCount;
      if (!m.order.is_pickup) target.nonPickupOrderCount += 1;

      m.order.sequence_number = target.seq;
    }

    // ── Promote an already-sequenced, still-OPEN sequence that has become
    // timeline-urgent since it was built (and couldn't be solved by moving
    // just the one order above) ────────────────────────────────────────────
    // "deliver_by within 90 minutes beats everything" (see file header) was
    // only ever being applied at the moment a sequence was first formed —
    // an order due at 1pm sitting in a sequence built at 9am (when it was
    // still 4 hours out, plain community-priority territory) stayed buried
    // there all the way to 1pm, because nothing ever re-ranked an existing
    // sequence once placed. This re-sorts the still-open sequences (anything
    // complete/dispatched is left exactly where it is — nothing to promote
    // there) using the same comparePriority rule: every sequence that's
    // currently tier0 (soonest deadline first, rank as tiebreak) moves ahead
    // of every sequence that isn't. Non-tier0 sequences keep their CURRENT
    // relative order exactly as-is, including anything Somya dragged by
    // hand — this only ever pulls an urgent sequence FORWARD, it never
    // reshuffles the rest. The CURRENT lowest-positioned, not-yet-complete
    // sequence is never part of this reshuffle at all — packers are
    // actively converging on it right now, so bumping anything ahead of it
    // would split it into two half-done sequences instead of letting it
    // finish; only sequences after it are reordered. It reassigns which of
    // today's already-in-use sequence_number VALUES each sequence sits at
    // (the same slot values just swap owners, excluding the locked current
    // one), so it can never collide with or move a completed sequence's
    // number, and only writes for a sequence whose position actually changed.
    {
      const incomplete = existingSeqAscending().filter(r => !r.isComplete);
      const rest = incomplete.slice(1); // index 0 is the current in-progress sequence — locked, never reordered
      const slots = rest.map(r => r.seq);
      const tier0Among = rest.filter(r => r.tier0MinDeadline !== Infinity).sort(comparePriority);
      const nonTier0Among = rest.filter(r => r.tier0MinDeadline === Infinity);
      const targetOrder = [...tier0Among, ...nonTier0Among];

      for (let i = 0; i < targetOrder.length; i++) {
        const rec = targetOrder[i];
        const newSeq = slots[i];
        if (rec.seq === newSeq) continue;
        const { error: promErr } = await supabase.from('orders')
          .update({ sequence_number: newSeq })
          .in('sales_order_id', rec.soids);
        if (promErr) { console.error(`Failed to promote sequence ${rec.seq} to ${newSeq}:`, promErr.message); continue; }
        existingSeqMap.delete(rec.seq);
        rec.seq = newSeq;
        existingSeqMap.set(newSeq, rec);
        for (const soid of rec.soids) { const em = existingMetaBySoid.get(soid); if (em) em.order.sequence_number = newSeq; }
      }
    }

    // ── Orphan rescue: an order whose own sequence has already dispatched
    // (a colleague's trip left) but which still has an 'open' or 'held'
    // item of its own — something was missing, out of stock, whatever —
    // never makes that trip. Left alone it would just sit forever pointing
    // at a sequence that's done and gone. Instead it re-enters the exact
    // same placement pipeline as a brand-new order below: try to join an
    // existing open sequence of its own/a combinable community first, else
    // fold into a brand-new one — "closest to the society or belong to
    // that society itself," per Somya, same as any other order would. Its
    // own "late" classification is irrelevant here (that only matters for
    // where an order's FIRST sequence lands; this one already had one) —
    // always eligible for rescue regardless of when it was originally
    // placed, and never demoted behind pre-11 work for it.
    const rescueMetas = existingMetas.filter(m => {
      const rec = existingSeqMap.get(toNum(m.order.sequence_number)!);
      if (!rec?.isComplete) return false;
      const items = itemsByOrder.get(m.order.sales_order_id) || [];
      return items.some(it => it.status === 'open' || it.status === 'held');
    });
    rescueMetas.forEach(m => { m.late = false; });

    // Every new or rescued order is processed THIS run, every run — nothing
    // is ever excluded or left waiting on a clock (see file header for why:
    // excluding late orders used to let them show up nowhere until some
    // release condition fired, and that condition itself had a bug letting
    // them jump ahead of unfinished pre-11 work once released). A late
    // order's only penalty is rank (comparePriority, above) — it still
    // tries to append into an existing open sequence exactly like anything
    // else, and only a brand-new sequence built for it gets pushed behind
    // today's whole pre-11 lineup.
    const allNew = [...newMetas, ...rescueMetas];
    // Group size = how many of this run's orders share a groupName — an
    // approximation of sortGroupsByPriority's own "size" (which scopes to
    // every active item today, not just today's new orders), close enough
    // for a tiebreak and cheap to compute from data already in memory
    // rather than a further query.
    const groupSizeCounts = new Map<string, number>();
    allNew.forEach(m => groupSizeCounts.set(m.groupName, (groupSizeCounts.get(m.groupName) || 0) + 1));
    allNew.forEach(m => { m.groupSize = groupSizeCounts.get(m.groupName) || 1; });

    const tier0s = allNew.filter(m => m.tier0).sort((a, b) => a.deadlineMins - b.deadlineMins);
    const tier2Early = allNew.filter(m => !m.tier0 && !m.late).sort(compareTier2);
    const tier2Late = allNew.filter(m => !m.tier0 && m.late).sort(compareTier2);
    const priorityOrder = [...tier0s, ...tier2Early, ...tier2Late]; // every new (or rescued) order this run will try to place, best first
    // No early return when this is empty (nothing unsequenced this run) —
    // the pace-rebalancing step below is independent of whether there's
    // anything new to sequence this run, and still needs to run.

    // ── Try to append each new order to an existing, still-open sequence —
    // same community first, then a combinable partner; whatever's left over
    // goes into the brand-new-sequence builder below. A non-tier0 order can
    // only append into a sequence in its OWN late/pre-11 cohort (rec.late
    // matches m.late) — otherwise a late order could slot into room inside
    // an already-ranked pre-11 sequence and get packed ahead of OTHER,
    // lower-priority pre-11 sequences that haven't been touched yet. Tier0
    // bypasses this entirely, same as everywhere else. ────────────────────
    const appendsBySeq = new Map<number, OrderMeta[]>();
    const homeless: OrderMeta[] = [];
    for (const m of priorityOrder) {
      const wouldAddCount = m.order.is_pickup ? 0 : m.itemCount;
      let target: ExistingSeq | undefined;

      for (const rec of existingSeqAscending()) {
        if (rec.isComplete || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
        if (!m.tier0 && rec.late !== m.late) continue;
        if (rec.communities.has(m.groupName)) { target = rec; break; }
      }
      if (!target && m.uniqueId) {
        const partners = combinablePartners.get(m.uniqueId);
        if (partners && partners.size) {
          for (const rec of existingSeqAscending()) {
            if (rec.isComplete || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
            if (!m.tier0 && rec.late !== m.late) continue;
            if ([...rec.uniqueIds].some(id => partners.has(id))) { target = rec; break; }
          }
        }
      }

      if (target) {
        target.communities.add(m.groupName);
        if (m.uniqueId) target.uniqueIds.add(m.uniqueId);
        if (m.rank < target.bestRank) target.bestRank = m.rank;
        if (m.tier0 && m.deadlineMins < target.tier0MinDeadline) target.tier0MinDeadline = m.deadlineMins;
        target.late = target.late && m.late;
        target.nonPickupCount += wouldAddCount;
        if (!appendsBySeq.has(target.seq)) appendsBySeq.set(target.seq, []);
        appendsBySeq.get(target.seq)!.push(m);
      } else {
        homeless.push(m);
      }
    }

    // ── Build brand-new sequences from whatever couldn't be appended ──────
    let remaining = homeless;
    const newSequences: OrderMeta[][] = [];
    while (remaining.length && newSequences.length < MAX_SEQUENCES_PER_RUN) {
      const startIdx = pickSequenceStart(remaining, recentGroups);
      const start = remaining.splice(startIdx, 1)[0];
      const seq = [start];
      let runningCount = start.order.is_pickup ? 0 : start.itemCount;
      const dominantGroup = start.groupName;
      const dominantUniqueId = start.uniqueId;
      const dominantLate = start.late;
      const dominantIsTier0 = start.tier0;

      while (runningCount < SEQUENCE_TARGET && remaining.length) {
        const capacityLeft = SEQUENCE_HARD_CAP - runningCount;
        const idx = pickNextCandidate(remaining, dominantGroup, dominantUniqueId, dominantLate, dominantIsTier0, combinablePartners, capacityLeft);
        if (idx < 0) break; // nothing left fits under the cap right now
        const next = remaining.splice(idx, 1)[0];
        seq.push(next);
        runningCount += next.order.is_pickup ? 0 : next.itemCount;
      }

      newSequences.push(seq);
      recentGroups.push(dominantGroup);
      while (recentGroups.length > RECENT_SOCIETY_WINDOW) recentGroups.shift();
    }

    // No early return here either (same reason as above) when nothing got
    // appended or newly sequenced this run — pace-rebalancing still runs.

    // ── Rank each brand-new sequence into today's current lineup ──────────
    // Not just appended at the end: a new sequence is inserted via a
    // fractional sequence_number at the position its own precedence would
    // put it — same as a manual drag's math (migration 122), so it can
    // never collide with one. Comparison is two-level, applied identically
    // to an EXISTING sequence re-evaluated this run and a brand-new one:
    // (1) a sequence with a live timeline order (tier0) always ranks below
    // every plain-community-rank sequence, soonest-deadline-first,
    // including overdue; (2) when two timeline sequences tie on deadline —
    // a real case: two orders due at the exact same time — community rank
    // breaks the tie, rather than falling back to whichever happened to be
    // discovered/built first. That build-order fallback was the actual bug
    // behind sequence 3 (Ferns/Bren/Purva, rank 16, deadline 13:00) landing
    // ahead of sequence 4 (77degree/Palladian, rank 3, ALSO deadline 13:00)
    // — both tier0 at the same instant, so only rank should have decided
    // it, not which one the homeless-builder loop happened to pop first.
    // Previously an existing sequence's timeline urgency was also discarded
    // the moment it was written (only its plain community rank got
    // compared against later), so a fresh tier0 sequence could leapfrog an
    // EARLIER, still-more-urgent tier0 sequence that had already been
    // placed — observed separately as a since-delivered Palladian order
    // ending up ranked below a later-deadline Bren/Purva one.
    let lineup = existingSeqAscending().map(r => ({ seqNumber: r.seq, key: { tier0MinDeadline: r.tier0MinDeadline, late: r.late, bestRank: r.bestRank } }));
    const seqNumberForNew = new Map<number, number>(); // index into newSequences -> assigned sequence_number
    newSequences.forEach((seq, i) => {
      const bestRank = Math.min(...seq.map(m => m.rank));
      const tier0Members = seq.filter(m => m.tier0);
      const tier0MinDeadline = tier0Members.length ? Math.min(...tier0Members.map(m => m.deadlineMins)) : Infinity;
      const late = seq.every(m => m.late); // one pre-11 member is enough to not demote the whole sequence
      const key: LineupKey = { tier0MinDeadline, late, bestRank };
      let insertSeqNumber: number;
      if (!lineup.length) {
        insertSeqNumber = 1;
      } else {
        const idx = lineup.findIndex(e => comparePriority(e.key, key) > 0);
        if (idx === -1) insertSeqNumber = lineup[lineup.length - 1].seqNumber + 1;
        else if (idx === 0) insertSeqNumber = lineup[0].seqNumber - 1;
        else insertSeqNumber = (lineup[idx - 1].seqNumber + lineup[idx].seqNumber) / 2;
      }
      seqNumberForNew.set(i, insertSeqNumber);
      lineup.push({ seqNumber: insertSeqNumber, key });
      lineup.sort((a, b) => a.seqNumber - b.seqNumber);
    });

    // ── Write everything ───────────────────────────────────────────────────
    let ordersSequenced = 0, ordersAppended = 0;

    for (const [seqNum, newMembers] of appendsBySeq) {
      const soidsToAppend = newMembers.map(m => m.order.sales_order_id);
      const { error: updErr } = await supabase.from('orders')
        .update({ sequence_number: seqNum, sequenced_at: nowIso })
        .in('sales_order_id', soidsToAppend);
      if (updErr) throw new Error(`Failed to append to sequence ${seqNum}: ${updErr.message}`);
      ordersAppended += soidsToAppend.length;

      // Place the NEW items against the sequence's CURRENT load only — see
      // placeNewItems' own comment on why this never touches an item that
      // was already assigned.
      const existingSoids = existingSeqMap.get(seqNum)!.soids;
      const existingItems = existingSoids.flatMap(soid => itemsByOrder.get(soid) || []);
      // Excludes already-final/invoiced items — matters for a rescued order
      // (orphan-rescue above), which can carry some items that are already
      // done alongside the one(s) that missed its old sequence's trip; a
      // brand-new order has no final/invoiced items yet, so this is a no-op
      // there.
      const newItems = soidsToAppend.flatMap(soid => itemsByOrder.get(soid) || [])
        .filter(it => it.status !== 'final' && it.status !== 'invoiced');
      const writes = new Map<string, string>([
        ...placeNewItems(
          newItems.filter(it => itemCategory(it.item_name) === 'fruit'),
          defaultPackerIdByItem, fruitPackerIds,
          countsByPacker(existingItems.filter(it => itemCategory(it.item_name) === 'fruit'), defaultPackerIdByItem, fruitPackerIds),
        ),
        ...placeNewItems(
          newItems.filter(it => itemCategory(it.item_name) === 'vegetable'),
          defaultPackerIdByItem, vegPackerIds,
          countsByPacker(existingItems.filter(it => itemCategory(it.item_name) === 'vegetable'), defaultPackerIdByItem, vegPackerIds),
        ),
      ]);
      for (const [itemId, packerId] of writes) {
        const { error: itemErr } = await supabase.from('order_items').update({ assigned_packer_id: packerId }).eq('id', itemId);
        if (itemErr) console.error(`Failed to assign appended item ${itemId}:`, itemErr.message);
      }
    }

    for (let i = 0; i < newSequences.length; i++) {
      const seq = newSequences[i];
      const seqNum = seqNumberForNew.get(i)!;
      const seqSoids = seq.map(m => m.order.sales_order_id);
      const { error: updErr } = await supabase
        .from('orders')
        .update({ sequence_number: seqNum, sequenced_at: nowIso })
        .in('sales_order_id', seqSoids);
      if (updErr) throw new Error(`Failed to stamp new sequence ${seqNum}: ${updErr.message}`);
      ordersSequenced += seqSoids.length;

      // Brand-new sequence — nothing pre-existing to preserve, so the full
      // default-then-even-out balance applies, same as always. Excludes
      // already-final/invoiced items for the same reason as the append
      // path above (a rescued order can carry some).
      const seqItems = seqSoids.flatMap(soid => itemsByOrder.get(soid) || [])
        .filter(it => it.status !== 'final' && it.status !== 'invoiced');
      const fruitItems = seqItems.filter(it => itemCategory(it.item_name) === 'fruit');
      const vegItems = seqItems.filter(it => itemCategory(it.item_name) === 'vegetable');
      const writes = new Map<string, string>([
        ...balanceCategory(fruitItems, defaultPackerIdByItem, fruitPackerIds),
        ...balanceCategory(vegItems, defaultPackerIdByItem, vegPackerIds),
      ]);
      for (const [itemId, packerId] of writes) {
        const { error: itemErr } = await supabase.from('order_items').update({ assigned_packer_id: packerId }).eq('id', itemId);
        if (itemErr) console.error(`Failed to rebalance item ${itemId}:`, itemErr.message);
      }
    }

    const { error: stateErr } = await supabase.from('packer_sequence_state')
      .update({ recent_group_names: recentGroups, updated_at: nowIso })
      .eq('id', 1);
    if (stateErr) console.error('Failed to update packer_sequence_state:', stateErr.message);

    // ── Packer pace rebalancing ────────────────────────────────────────────
    // Independent of whatever this run did above (runs even when nothing was
    // newly sequenced/appended) — every tick checks each category (fruit,
    // veg) for a packer who's pulled more than one sequence ahead of a
    // same-category colleague, and offloads half of that colleague's still-
    // untouched ('open' only — never packed/held/final/invoiced, so nothing
    // already weighed ever moves) items in the sequence she hasn't started
    // yet to the packer who's ahead. Per Somya: a fast packer shouldn't idle
    // on her own next sequence while a colleague is the sole bottleneck on
    // one she hasn't even begun. "Position" is 1-based rank among today's
    // distinct sequence_numbers, not the raw (possibly fractional) value —
    // a fractional gap of 2 to 2.5 is still "one sequence apart", not a tiny
    // gap. A packer with nothing pending at all counts as caught up with
    // everything — the most available to help, not excluded.
    const distinctSeqNumbers = [...new Set(existingMetas.map(m => toNum(m.order.sequence_number)!))].sort((a, b) => a - b);
    const positionOf = new Map<number, number>(distinctSeqNumbers.map((n, i) => [n, i + 1]));
    const allTodayItems = existingMetas.flatMap(m => {
      const seqNum = toNum(m.order.sequence_number)!;
      return (itemsByOrder.get(m.order.sales_order_id) || []).map(it => ({ item: it, seqNum }));
    });

    let itemsRebalanced = 0;
    if (distinctSeqNumbers.length) {
      for (const packerIds of [fruitPackerIds, vegPackerIds]) {
        if (packerIds.length < 2) continue;

        const positionByPacker = new Map<string, number>();
        for (const pid of packerIds) {
          const pending = allTodayItems.filter(({ item }) =>
            (item.status === 'open' || item.status === 'packed') &&
            (item.assigned_packer_id || defaultPackerIdByItem.get(item.item_name)) === pid);
          positionByPacker.set(pid, pending.length
            ? (positionOf.get(Math.min(...pending.map(p => p.seqNum))) ?? distinctSeqNumbers.length + 1)
            : distinctSeqNumbers.length + 1);
        }

        const fastestId = packerIds.reduce((a: string, b: string) => positionByPacker.get(a)! >= positionByPacker.get(b)! ? a : b);
        const fastestPos = positionByPacker.get(fastestId)!;

        for (const slowId of packerIds) {
          if (slowId === fastestId) continue;
          const slowPos = positionByPacker.get(slowId)!;
          if (fastestPos - slowPos <= 1) continue; // not far enough behind to act on

          const targetPos = slowPos + 1;
          if (targetPos > distinctSeqNumbers.length) continue; // nothing after her current sequence yet
          const targetSeq = distinctSeqNumbers[targetPos - 1];

          const herOpenItemsThere = allTodayItems
            .filter(({ item, seqNum }) => seqNum === targetSeq && item.status === 'open' &&
              (item.assigned_packer_id || defaultPackerIdByItem.get(item.item_name)) === slowId)
            .map(({ item }) => item)
            .sort((a: ItemRow, b: ItemRow) => a.id.localeCompare(b.id)); // stable, deterministic split
          if (!herOpenItemsThere.length) continue;

          const keepForSlow = Math.floor(herOpenItemsThere.length / 2); // round down for her — she keeps the floor
          const toReassign = herOpenItemsThere.slice(keepForSlow);
          if (!toReassign.length) continue;

          const { error: rebalErr } = await supabase.from('order_items')
            .update({ assigned_packer_id: fastestId })
            .in('id', toReassign.map(it => it.id));
          if (rebalErr) { console.error(`Failed to rebalance ${toReassign.length} item(s) from packer ${slowId} to ${fastestId}:`, rebalErr.message); continue; }
          itemsRebalanced += toReassign.length;
        }
      }
    }

    return new Response(
      JSON.stringify({ sequences_created: newSequences.length, orders_sequenced: ordersSequenced, orders_appended: ordersAppended, orders_urgent_moved: ordersUrgentMoved, items_rebalanced: itemsRebalanced }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
