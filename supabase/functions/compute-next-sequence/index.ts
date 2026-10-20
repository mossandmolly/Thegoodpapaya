// Supabase Edge Function — compute-next-sequence
//
// Replaces manual push-to-queue (migration 119, now retired — see
// migration 120) with an automated scheduler. Triggered every 3 minutes by
// pg_cron (migration 121), same x-cron-secret pattern as sync-catalog/
// auto-invoice-final-orders. Each run looks at EVERY one of today's orders,
// sequenced or not, and does one of three things with each still-unsequenced
// one: (1) appends it to an existing, still-open sequence that has room and
// a matching community, (2) folds it into a brand-new sequence with other
// newly-arrived orders, or (3) leaves it unsequenced (timeline/held rules
// below). orders.sequence_number/sequenced_at is the only thing the Packer
// tab's "My Sequence" view reads to decide what a given packer sees right
// now (see parser.html's computeMyCurrentSequence).
//
// Precedence: a deliver_by within 90 minutes beats everything (soonest
// first); otherwise Community Priority rank (community_priority.rank),
// then group size (smaller group first), then group name alphabetically,
// then created_at — the same four-tier order parser.html's
// sortGroupsByPriority/orderItemsByQueuePriority use client-side, so a
// listing built from either agrees with what the cron actually did. There
// is no manual override tier here (packer_priority_override, retired in
// migration 122): Somya's manual control happens by dragging a sequence or
// order directly in the Team tab's Sequences board. Any order placed at or
// after 11:00 IST (open-ended, no upper bound) is held out entirely until
// 15:30 IST — UNLESS every non-held order today has already been
// sequenced, in which case held orders release early and run through the
// same priority pipeline rather than leaving packers idle until 3:30 for
// no reason (see the nonHeld/heldOrders split further down).
//
// IMPORTANT — this function DOES revisit already-sequenced orders, but only
// to ADD to them, never to move, reorder, or re-balance anything already
// placed there (manual or automatic) — so a drag Somya has already done is
// never undone, and a packer already partway through a sequence never has
// her own already-packed items reassigned out from under her. A new order
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
const HOLD_WINDOW_START_MIN = 11 * 60; // open-ended — no upper bound, see classify()'s held check
const HOLD_RELEASE_MIN = 15 * 60 + 30;
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
  held: boolean;
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
// LATER sequence instead of delaying this one (the "23-24 item order" case).
function pickNextCandidate(remaining: OrderMeta[], dominantGroup: string, dominantUniqueId: string | null, combinablePartners: Map<string, Set<string>>, capacityLeft: number): number {
  let idx = remaining.findIndex(o => o.groupName === dominantGroup && o.itemCount <= capacityLeft);
  if (idx >= 0) return idx;

  if (dominantUniqueId) {
    const partners = combinablePartners.get(dominantUniqueId);
    if (partners && partners.size) {
      idx = remaining.findIndex(o => o.uniqueId != null && partners.has(o.uniqueId) && o.itemCount <= capacityLeft);
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
    const nowMinsOfDay = istMinutesOfDay(now);

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
      .select('sales_order_id,society,customer_name,deliver_by,created_at,is_pickup,status,sequence_number')
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
      // Open-ended: ANY order placed at or after 11:00 IST is held until
      // 15:30, not just ones placed in an 11:00-13:00 window — a 2pm order
      // is held exactly the same as an 11:05 one. Must have been placed
      // TODAY, not just at some point whose time-of-day happens to fall
      // after 11:00 — an order from yesterday at, say, 11:24 IST (for a
      // next-day delivery, hence today's sales_order_id prefix) was never
      // "placed in today's post-11:00 window" and shouldn't be held for one
      // it was never in. See the early-release exception further down
      // (nonHeld.length check) for when this gets overridden before 15:30.
      const held = !tier0
        && istDateStrFromIso(o.created_at) === today
        && createdMinsOfDay >= HOLD_WINDOW_START_MIN
        && nowMinsOfDay < HOLD_RELEASE_MIN;
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
        held,
      };
    }).filter(m => m.itemCount > 0); // nothing active left to pack — skip entirely

    const newMetas = metas.filter(m => toNum(m.order.sequence_number) == null);
    const existingMetas = metas.filter(m => toNum(m.order.sequence_number) != null);

    const nonHeld = newMetas.filter(m => !m.held);
    const heldOrders = newMetas.filter(m => m.held);
    // Early-release exception: if every non-held order today has already
    // been sequenced, there's nothing else for a packer to work on before
    // 15:30 — release what's on hold right now and run it through the
    // exact same priority pipeline (timeline, then community rank) rather
    // than leaving everyone idle until the clock strikes 3:30 for no
    // operational reason. Per Somya: "if orders of lower community
    // priority placed before 11 finish sooner than 3:30, system starts
    // picking orders placed after 11 in the order of community priority/
    // timeline" — same logic, just an earlier release trigger.
    const eligible = nonHeld.length ? nonHeld : heldOrders;
    // Group size = how many of this run's eligible NEW orders share a
    // groupName — an approximation of sortGroupsByPriority's own "size"
    // (which scopes to every active item today, not just today's new
    // orders), close enough for a tiebreak and cheap to compute from data
    // already in memory rather than a further query.
    const groupSizeCounts = new Map<string, number>();
    eligible.forEach(m => groupSizeCounts.set(m.groupName, (groupSizeCounts.get(m.groupName) || 0) + 1));
    eligible.forEach(m => { m.groupSize = groupSizeCounts.get(m.groupName) || 1; });

    const tier0s = eligible.filter(m => m.tier0).sort((a, b) => a.deadlineMins - b.deadlineMins);
    const tier2s = eligible.filter(m => !m.tier0).sort(compareTier2);
    const priorityOrder = [...tier0s, ...tier2s]; // every new order this run will try to place, best first
    // No early return when this is empty (held, or nothing unsequenced) —
    // the pace-rebalancing step below is independent of whether there's
    // anything new to sequence this run, and still needs to run.

    // ── Existing sequences: their current communities, load, and whether
    // they're still open to a new arrival ─────────────────────────────────
    interface ExistingSeq {
      seq: number;
      soids: string[];
      communities: Set<string>;
      uniqueIds: Set<string>;
      bestRank: number;
      tier0MinDeadline: number; // Infinity unless this sequence still has a live timeline order
      nonPickupCount: number;
      isComplete: boolean;
    }
    const existingSeqMap = new Map<number, ExistingSeq>();
    existingMetas.forEach(m => {
      const seqNum = toNum(m.order.sequence_number)!;
      if (!existingSeqMap.has(seqNum)) {
        existingSeqMap.set(seqNum, { seq: seqNum, soids: [], communities: new Set(), uniqueIds: new Set(), bestRank: Infinity, tier0MinDeadline: Infinity, nonPickupCount: 0, isComplete: true });
      }
      const rec = existingSeqMap.get(seqNum)!;
      rec.soids.push(m.order.sales_order_id);
      rec.communities.add(m.groupName);
      if (m.uniqueId) rec.uniqueIds.add(m.uniqueId);
      if (m.rank < rec.bestRank) rec.bestRank = m.rank;
      if (m.tier0 && m.deadlineMins < rec.tier0MinDeadline) rec.tier0MinDeadline = m.deadlineMins;
      if (!m.order.is_pickup) rec.nonPickupCount += m.itemCount;
    });
    // Complete = nothing left in it that's 'open' or 'packed' — the exact
    // same "pending" definition parser.html's computeMyCurrentSequence uses
    // to decide a packer is done with a sequence, so this never reopens one
    // a packer (or Somya, looking at the Sequences board) would already
    // consider finished.
    existingSeqMap.forEach(rec => {
      const items = rec.soids.flatMap(soid => itemsByOrder.get(soid) || []);
      rec.isComplete = items.length > 0 && items.every(it => it.status !== 'open' && it.status !== 'packed');
    });
    const existingSeqAscending = () => [...existingSeqMap.values()].sort((a, b) => a.seq - b.seq);

    // ── Try to append each new order to an existing, still-open sequence —
    // same community first, then a combinable partner; whatever's left over
    // goes into the brand-new-sequence builder below ─────────────────────
    const appendsBySeq = new Map<number, OrderMeta[]>();
    const homeless: OrderMeta[] = [];
    for (const m of priorityOrder) {
      const wouldAddCount = m.order.is_pickup ? 0 : m.itemCount;
      let target: ExistingSeq | undefined;

      for (const rec of existingSeqAscending()) {
        if (rec.isComplete || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
        if (rec.communities.has(m.groupName)) { target = rec; break; }
      }
      if (!target && m.uniqueId) {
        const partners = combinablePartners.get(m.uniqueId);
        if (partners && partners.size) {
          for (const rec of existingSeqAscending()) {
            if (rec.isComplete || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
            if ([...rec.uniqueIds].some(id => partners.has(id))) { target = rec; break; }
          }
        }
      }

      if (target) {
        target.communities.add(m.groupName);
        if (m.uniqueId) target.uniqueIds.add(m.uniqueId);
        if (m.rank < target.bestRank) target.bestRank = m.rank;
        if (m.tier0 && m.deadlineMins < target.tier0MinDeadline) target.tier0MinDeadline = m.deadlineMins;
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

      while (runningCount < SEQUENCE_TARGET && remaining.length) {
        const capacityLeft = SEQUENCE_HARD_CAP - runningCount;
        const idx = pickNextCandidate(remaining, dominantGroup, dominantUniqueId, combinablePartners, capacityLeft);
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
    interface LineupKey { tier0MinDeadline: number; bestRank: number }
    function comparePriority(a: LineupKey, b: LineupKey): number {
      const aTier0 = a.tier0MinDeadline !== Infinity, bTier0 = b.tier0MinDeadline !== Infinity;
      if (aTier0 !== bTier0) return aTier0 ? -1 : 1;
      if (aTier0 && a.tier0MinDeadline !== b.tier0MinDeadline) return a.tier0MinDeadline - b.tier0MinDeadline;
      return a.bestRank - b.bestRank;
    }
    let lineup = existingSeqAscending().map(r => ({ seqNumber: r.seq, key: { tier0MinDeadline: r.tier0MinDeadline, bestRank: r.bestRank } }));
    const seqNumberForNew = new Map<number, number>(); // index into newSequences -> assigned sequence_number
    newSequences.forEach((seq, i) => {
      const bestRank = Math.min(...seq.map(m => m.rank));
      const tier0Members = seq.filter(m => m.tier0);
      const tier0MinDeadline = tier0Members.length ? Math.min(...tier0Members.map(m => m.deadlineMins)) : Infinity;
      const key: LineupKey = { tier0MinDeadline, bestRank };
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
    const nowIso = new Date().toISOString();
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
      const newItems = soidsToAppend.flatMap(soid => itemsByOrder.get(soid) || []);
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
      // default-then-even-out balance applies, same as always.
      const seqItems = seqSoids.flatMap(soid => itemsByOrder.get(soid) || []);
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
      JSON.stringify({ sequences_created: newSequences.length, orders_sequenced: ordersSequenced, orders_appended: ordersAppended, items_rebalanced: itemsRebalanced }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
