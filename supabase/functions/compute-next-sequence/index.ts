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
const VEGETABLE_ITEM_NAMES = new Set(["cauliflower","cabbage","capsicum green","capsicum yellow","capsicum red","carrot","tomato","ginger","beans","lady's finger","cucumber","coriander","chilli green","potato","onion","ridge gourd","bitter gourd","bottle gourd","brinjal bottle","broccoli","banana leaves","spinach","amaranthus","fenugreek","mangalore cucumber","drumstick","chilli bhajji","coccinia","mint","lettuce","beetroot","zucchini green","zucchini yellow","red cabbage","mushroom","garlic","spring onion"]);
// Never reassigned across a fruit<->vegetable category line during
// workload rebalancing (see below) — too delicate/unfamiliar to hand to
// the other category's packer, even for a tiny top-up. Within the same
// category they move freely like anything else.
const LEAFY_ITEM_NAMES = new Set(["spinach", "fenugreek", "spring onion", "amaranthus", "coriander"]);

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
  rescueFromSeq: number | null; // set only for a rescued order: its OWN sequence number before rescue, excluded as an append target so "move it down" can't just match it straight back into the sequence it's being rescued FROM
  bypassCohort: boolean;   // true only for a rescued order — let it match EITHER cohort when searching for a target, not just its own. NOT implemented by forcing `late` to a fixed value: that's an equality check (rec.late !== m.late), so pinning `late` to false would only let it match pre-11 sequences specifically — actively blocking it from a late one, the opposite of neutral — which is exactly how a genuinely post-11 rescued order ended up sharing a sequence with a pre-11 order. `late` stays whatever it really was (it still matters for ranking if the order ends up needing a brand-new sequence); this flag is the actual bypass.
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
// dominant order (unless either side is tier0 or a rescued order, which
// bypasses the cohort split entirely) — otherwise a late order could pad
// its way into an otherwise-pre-11 brand-new sequence, the same cross-
// cohort leak the append loop guards against.
function cohortOk(o: OrderMeta, dominantLate: boolean, dominantIsTier0: boolean, dominantBypassCohort: boolean): boolean {
  return dominantIsTier0 || dominantBypassCohort || o.tier0 || o.bypassCohort || o.late === dominantLate;
}
function pickNextCandidate(remaining: OrderMeta[], dominantGroup: string, dominantUniqueId: string | null, dominantLate: boolean, dominantIsTier0: boolean, dominantBypassCohort: boolean, combinablePartners: Map<string, Set<string>>, capacityLeft: number): number {
  let idx = remaining.findIndex(o => o.groupName === dominantGroup && o.itemCount <= capacityLeft && cohortOk(o, dominantLate, dominantIsTier0, dominantBypassCohort));
  if (idx >= 0) return idx;

  if (dominantUniqueId) {
    const partners = combinablePartners.get(dominantUniqueId);
    if (partners && partners.size) {
      idx = remaining.findIndex(o => o.uniqueId != null && partners.has(o.uniqueId) && o.itemCount <= capacityLeft && cohortOk(o, dominantLate, dominantIsTier0, dominantBypassCohort));
      if (idx >= 0) return idx;
    }
  }

  return -1;
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
      // Every packer, not just active ones — the reassign-off-inactive sweep
      // below needs to know who's inactive, not just who's active.
      supabase.from('packers').select('id,name,category,active'),
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

    // active!==false (not active===true) so a packer whose row predates the
    // column, or has it null, still counts as active by default — same
    // convention the dashboard itself uses (parser.html's packersCache).
    const fruitPackerIds = (packerRows || []).filter((p: any) => p.category === 'fruit' && p.active !== false).map((p: any) => p.id);
    const vegPackerIds = (packerRows || []).filter((p: any) => p.category === 'vegetable' && p.active !== false).map((p: any) => p.id);
    const defaultPackerIdByItem = new Map<string, string>();
    (assignRows || []).forEach((a: any) => defaultPackerIdByItem.set(a.item_name, a.packer_id));

    // ── Reassign items stuck on a now-inactive packer ──────────────────────
    // packers.active has only ever gated NEW placements (placeNewItems
    // already only chooses among active packerIds above) — nothing
    // revisited an item assigned (explicitly, or via packer_assignments'
    // default) back when its packer was still active. Per Somya: toggling
    // a packer off should move her whole still-pending backlog to the
    // rest of her category, checked every run, not just stop giving her
    // anything new going forward. Scoped to 'open'/'held' — anything
    // packed/final/invoiced is already physically done, nothing left to
    // reassign.
    let itemsReassignedFromInactive = 0;
    {
      const inactiveIds = new Set((packerRows || []).filter((p: any) => p.active === false).map((p: any) => p.id));
      if (inactiveIds.size) {
        const allItemsToday = [...itemsByOrder.values()].flat();
        for (const [packerIds, category] of [[fruitPackerIds, 'fruit'], [vegPackerIds, 'vegetable']] as const) {
          const stuckItems = allItemsToday.filter(it =>
            (it.status === 'open' || it.status === 'held') &&
            itemCategory(it.item_name) === category &&
            inactiveIds.has(it.assigned_packer_id || defaultPackerIdByItem.get(it.item_name) || ''),
          );
          if (!stuckItems.length) continue;
          // Real current load (not just the stuck batch alone) as the
          // baseline, so this lands on whoever's actually least-loaded.
          const existingCounts = new Map<string, number>(packerIds.map((pid: string) => [pid,
            allItemsToday.filter(it => (it.status === 'open' || it.status === 'packed') &&
              (it.assigned_packer_id || defaultPackerIdByItem.get(it.item_name)) === pid).length,
          ]));
          const writes = placeNewItems(stuckItems, defaultPackerIdByItem, packerIds, existingCounts);
          for (const [itemId, newPackerId] of writes) {
            const { error: reassignErr } = await supabase.from('order_items').update({ assigned_packer_id: newPackerId }).eq('id', itemId);
            if (reassignErr) { console.error(`Failed to reassign item ${itemId} off inactive packer:`, reassignErr.message); continue; }
            const it = allItemsToday.find(i => i.id === itemId);
            if (it) it.assigned_packer_id = newPackerId; // keep itemsByOrder's shared objects consistent for the rest of this run
            itemsReassignedFromInactive++;
          }
        }
      }
    }

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
        rescueFromSeq: null,
        bypassCohort: false,
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
      packingComplete: boolean; // nothing left in it is 'open'/'packed' — see its own comment below for what this is (and isn't) used for
    }
    const existingSeqMap = new Map<number, ExistingSeq>();
    existingMetas.forEach(m => {
      const seqNum = toNum(m.order.sequence_number)!;
      if (!existingSeqMap.has(seqNum)) {
        existingSeqMap.set(seqNum, { seq: seqNum, soids: [], communities: new Set(), uniqueIds: new Set(), bestRank: Infinity, tier0MinDeadline: Infinity, late: true, nonPickupCount: 0, nonPickupOrderCount: 0, dispatchedNonPickupOrderCount: 0, isComplete: false, packingComplete: false });
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
    // Complete = EVERY non-pickup order in the sequence has actually
    // shipped (dispatched_at set on all of them) — the one unambiguous
    // "nothing more can happen to this sequence" signal, and the ONLY
    // thing that (a) stops a new order from being offered this sequence to
    // append into, and (b) lets orphan-rescue below treat one of its
    // orders as genuinely stranded and move it elsewhere. Capacity (the
    // 40-item hard cap) is a completely separate, already-self-enforcing
    // check done at the point of each append attempt — it was never part
    // of this flag and doesn't need to be.
    //
    // Deliberately NOT "nothing left is open/packed" any more (an earlier
    // version of this flag) — that treated a 'held' item as "done" (held
    // is neither open nor packed), which let a sequence that was fully
    // packed except for one still-unapproved held item get marked complete
    // with no trip having left at all. Orphan-rescue then saw "complete,
    // and this order still has a held item" and relocated that order
    // EVERY run, for as long as the held item sat there — which both
    // looked exactly like "my manually-arranged sequence keeps getting
    // reset" (one order kept relocating for no visible reason) and, since
    // a rescued order skips the late/cohort check entirely (see
    // rescueMetas below), let an ordinary post-11 order leak across the
    // pre-11/post-11 line it should never have crossed. Dispatch-only
    // trades that away for a narrower, accepted gap: a sequence that's
    // 100% packed but not yet actually dispatched stays technically
    // appendable in the meantime — a much smaller window than the bug it
    // replaces, since dispatch normally follows packing fairly closely.
    existingSeqMap.forEach(rec => {
      rec.isComplete = rec.nonPickupOrderCount > 0 && rec.dispatchedNonPickupOrderCount >= rec.nonPickupOrderCount;
      // packingComplete is a SEPARATE signal from isComplete and never
      // feeds into it — it does NOT stop new orders from appending here,
      // and does NOT by itself mean the sequence is "done" for any other
      // purpose. Its only job: once a packer has worked through everything
      // packable in this sequence (nothing left 'open'/'packed' — a held
      // item doesn't count, that's the whole point), any order still
      // sitting here with a held item is clearly not going anywhere soon —
      // see the held-item cascade in rescueMetas below, which moves it
      // forward to the next matching sequence instead of leaving it
      // stranded in a sequence everyone else has already moved past. Per
      // Somya: never hold it indefinitely — if it's still not ready by the
      // time a packer reaches wherever it landed next, she hits "I'm done"
      // again and it cascades forward again, same as any other append.
      const items = rec.soids.flatMap(soid => itemsByOrder.get(soid) || []);
      rec.packingComplete = items.length > 0 && items.every(it => it.status !== 'open' && it.status !== 'packed');
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

    // ── Rescue: an order sitting in a sequence that's moved on without it,
    // still carrying an item that can't be packed right now — never leave
    // it stranded. Two different ways a sequence "moves on without it":
    // (a) dispatched — a colleague's trip has actually left (isComplete),
    // so an 'open' OR 'held' item here missed that ride entirely; (b)
    // packing-complete — nobody dispatched yet, but every packer has
    // already finished everything ELSE in this sequence (packingComplete),
    // so a 'held' item here isn't "waiting its turn", it's just stuck,
    // indefinitely, while everyone else has moved on to later sequences.
    // Per Somya: never hold a held item indefinitely — move it down to the
    // next sequence of its own/a combinable community instead (same
    // placement pipeline as a brand-new order: append if room exists, else
    // a fresh sequence), and if it's STILL not ready by the time a packer
    // reaches THAT one and taps "I'm done" again, it cascades forward
    // again next run, same as this. Its own "late" classification is
    // irrelevant either way (that only matters for where an order's FIRST
    // sequence lands; this one already had one) — always eligible for
    // rescue regardless of when it was originally placed, and never
    // demoted behind pre-11 work for it.
    const rescueMetas = existingMetas.filter(m => {
      const rec = existingSeqMap.get(toNum(m.order.sequence_number)!);
      if (!rec) return false;
      const items = itemsByOrder.get(m.order.sales_order_id) || [];
      if (rec.isComplete) return items.some(it => it.status === 'open' || it.status === 'held');
      if (rec.packingComplete) return items.some(it => it.status === 'held');
      return false;
    });
    rescueMetas.forEach(m => { m.bypassCohort = true; m.rescueFromSeq = toNum(m.order.sequence_number); });

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
    // and a rescued order (bypassCohort) skip this check entirely, same as
    // everywhere else — but note bypassCohort genuinely ignores the cohort
    // (can match either), it does NOT pin the order to one side of it. ──
    const appendsBySeq = new Map<number, OrderMeta[]>();
    const homeless: OrderMeta[] = [];
    for (const m of priorityOrder) {
      const wouldAddCount = m.order.is_pickup ? 0 : m.itemCount;
      let target: ExistingSeq | undefined;

      for (const rec of existingSeqAscending()) {
        if (rec.isComplete || rec.seq === m.rescueFromSeq || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
        if (!m.tier0 && !m.bypassCohort && rec.late !== m.late) continue;
        if (rec.communities.has(m.groupName)) { target = rec; break; }
      }
      if (!target && m.uniqueId) {
        const partners = combinablePartners.get(m.uniqueId);
        if (partners && partners.size) {
          for (const rec of existingSeqAscending()) {
            if (rec.isComplete || rec.seq === m.rescueFromSeq || rec.nonPickupCount + wouldAddCount > SEQUENCE_HARD_CAP) continue;
            if (!m.tier0 && !m.bypassCohort && rec.late !== m.late) continue;
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
      const dominantBypassCohort = start.bypassCohort;

      while (runningCount < SEQUENCE_TARGET && remaining.length) {
        const capacityLeft = SEQUENCE_HARD_CAP - runningCount;
        const idx = pickNextCandidate(remaining, dominantGroup, dominantUniqueId, dominantLate, dominantIsTier0, dominantBypassCohort, combinablePartners, capacityLeft);
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
        // Find the boundary by PRIORITY, not by raw position in the
        // lineup array. A manual drag can legitimately leave the lineup
        // numerically out of priority order (e.g. a late, non-urgent
        // sequence manually placed ahead of pre-11 ones — exactly what a
        // manual drag is FOR, and nothing here should ever contest that).
        // The old position-based findIndex stopped scanning the moment it
        // hit the FIRST entry that looked "worse," even if that entry was
        // really just a manually-placed one sitting out of its "natural"
        // spot — miscomputing where a brand-new sequence should land
        // whenever one happened to need inserting near it. Comparing
        // every entry independently instead of trusting positional order
        // fixes that: insert right after the best-placed entry that's
        // genuinely better-or-equal, and before the worst-placed one that
        // isn't — never in between two entries whose OWN relative order
        // a manual drag has already decided to invert.
        const betterOrEqual = lineup.filter(e => comparePriority(e.key, key) <= 0);
        const worse = lineup.filter(e => comparePriority(e.key, key) > 0);
        const afterSeq = betterOrEqual.length ? Math.max(...betterOrEqual.map(e => e.seqNumber)) : null;
        const beforeSeq = worse.length ? Math.min(...worse.map(e => e.seqNumber)) : null;
        if (afterSeq == null) insertSeqNumber = beforeSeq! - 1;
        else if (beforeSeq == null) insertSeqNumber = afterSeq + 1;
        else if (beforeSeq > afterSeq) insertSeqNumber = (afterSeq + beforeSeq) / 2;
        else {
          // beforeSeq <= afterSeq — a manual drag has inverted their
          // relative order, so no clean "number strictly between them"
          // exists. Land right after the best-ranked entry instead of
          // risking a value that lands before something that outranks it
          // numerically; nudge past any exact collision.
          insertSeqNumber = afterSeq + 1;
          while (lineup.some(e => e.seqNumber === insertSeqNumber)) insertSeqNumber += 1;
        }
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

      // Brand-new sequence — nothing pre-existing to preserve, so this is
      // just placeNewItems against an empty baseline (default-if-active,
      // else least-loaded). No separate one-time "even out" pass any more
      // — the workload-rebalancing sweep below now owns ALL evening-out,
      // continuously, for new and old sequences alike. Excludes already-
      // final/invoiced items for the same reason as the append path above
      // (a rescued order can carry some).
      const seqItems = seqSoids.flatMap(soid => itemsByOrder.get(soid) || [])
        .filter(it => it.status !== 'final' && it.status !== 'invoiced');
      const fruitItems = seqItems.filter(it => itemCategory(it.item_name) === 'fruit');
      const vegItems = seqItems.filter(it => itemCategory(it.item_name) === 'vegetable');
      const writes = new Map<string, string>([
        ...placeNewItems(fruitItems, defaultPackerIdByItem, fruitPackerIds, new Map()),
        ...placeNewItems(vegItems, defaultPackerIdByItem, vegPackerIds, new Map()),
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

    // ── Sequence-number defragmentation ─────────────────────────────────────
    // A manual drag inserts a value strictly between two neighbours (their
    // midpoint) — repeated drags landing near the same spot over time keep
    // halving that gap, and JS double-precision floats eventually run out of
    // room to represent a distinct midpoint (seen in production: consecutive
    // sequence_numbers only ~1e-10 apart). Past that point `(a+b)/2` rounds
    // back to `a` or `b`, so the drag silently writes a value that isn't
    // actually different from its neighbour — the client's optimistic render
    // shows it moving, but the next reload re-fetches the real (unchanged)
    // order and it looks like the drag "reset". Fixing this permanently (not
    // just detecting it) means every tick re-flattens today's distinct
    // sequence_numbers back to clean, evenly spaced integers, preserving
    // whatever relative order they're currently in — including any manual
    // drag since the last tick — so there's always a full range of
    // precision available to bisect into again before the next one. Only
    // writes for a sequence whose value isn't already its target integer, so
    // once things settle this is a no-op most runs.
    // existingMetas is NOT a complete picture of today's sequence_numbers:
    // (1) classify() (line ~580) drops any order with zero active items
    // ("nothing left to pack — skip entirely") before existingMetas is even
    // built, so an order that's fully invoiced/dispatched, or whose one
    // item got individually cancelled, keeps a real sequence_number in the
    // database but is invisible to anything built only from existingMetas;
    // (2) a sequence built fresh THIS run (newSequences) or an order
    // appended into an already-open one THIS run (appendsBySeq) never gets
    // synced back into an OrderMeta's `order` object either. So the sweep
    // starts from the plain `orders` array instead — the actual full
    // fetch, every non-cancelled order today regardless of item status —
    // which tier0-upgrade and whole-sequence promotion already keep
    // current (they mutate `m.order` in place, and `order` IS this same
    // array's element, same object reference), then overlays this run's
    // append/new-sequence writes on top, since those two don't mutate
    // `order` in memory at all.
    let sequencesDefragmented = 0;
    const soidToSeqFinal = new Map<string, number>();
    for (const o of orders) {
      const n = toNum(o.sequence_number);
      if (n != null) soidToSeqFinal.set(o.sales_order_id, n);
    }
    for (const [seqNum, newMembers] of appendsBySeq) {
      for (const m of newMembers) soidToSeqFinal.set(m.order.sales_order_id, seqNum);
    }
    newSequences.forEach((seq, i) => {
      const seqNum = seqNumberForNew.get(i)!;
      for (const m of seq) soidToSeqFinal.set(m.order.sales_order_id, seqNum);
    });
    const distinctSeqNumbersFinal = [...new Set(soidToSeqFinal.values())].sort((a, b) => a - b);
    for (let i = 0; i < distinctSeqNumbersFinal.length; i++) {
      const oldSeq = distinctSeqNumbersFinal[i];
      const newSeq = i + 1;
      if (oldSeq === newSeq) continue;
      const soidsHere = [...soidToSeqFinal.entries()].filter(([, s]) => s === oldSeq).map(([soid]) => soid);
      const { error: renumberErr } = await supabase.from('orders')
        .update({ sequence_number: newSeq })
        .in('sales_order_id', soidsHere);
      if (renumberErr) { console.error(`Failed to defragment sequence ${oldSeq} -> ${newSeq}:`, renumberErr.message); continue; }
      sequencesDefragmented++;
    }

    // ── Packer workload rebalancing (category-agnostic) ────────────────────
    // Replaces both the old one-time "even out a brand-new sequence" pass
    // and the old category-split pace rebalancer. Per Somya: a packer can
    // never move past the EARLIEST sequence that still has anyone's pending
    // work in it while either of these is true —
    //   (A) someone else is still fully stuck there while she's already
    //       cleared a LATER sequence too (not just this one) — she "took
    //       the lead" and must go back and fully absorb the straggler's
    //       remaining OPEN items there first, however few (no threshold —
    //       "even if there are 2 or less items");
    //   (B) nobody's genuinely ahead like that, but the spread of still-
    //       pending work among whoever IS at that sequence (working it,
    //       just inherited items, or idle/available) is more than 2 items —
    //       one-item-at-a-time moves until the gap is ≤2.
    // Re-run on every cron tick AND the instant a packer finishes/skips a
    // sequence (the dashboard calls this function directly then — see
    // parser.html — not just waiting for the next tick). "Splitting the
    // debt" when a third packer later becomes available isn't a separate
    // rule: it falls straight out of re-running (A)/(B) against the
    // now-larger pool next time this fires. Category only ever decided who
    // got an item by default; this moves freely across fruit/veg lines,
    // except leafy items (LEAFY_ITEM_NAMES — always stay within their own
    // category's packers) and anything not 'open' (packed/held/final/
    // invoiced never move — nothing already touched is ever undone).
    let itemsRebalanced = 0;
    {
      const allPackerIds = [...fruitPackerIds, ...vegPackerIds];
      // Only this run's clean, final sequence positions (soidToSeqFinal/
      // distinctSeqNumbersFinal, just built above) — not the raw possibly-
      // fractional sequence_number — so "the earliest sequence" and "a
      // later one" mean the same thing a human reads off the Team tab.
      const cleanRankByOld = new Map<number, number>(distinctSeqNumbersFinal.map((n, i) => [n, i + 1]));
      const cleanSeqBySoid = new Map<string, number>();
      for (const [soid, old] of soidToSeqFinal) cleanSeqBySoid.set(soid, cleanRankByOld.get(old)!);

      // Everything with a real position today, excluding cancelled —
      // final/invoiced are excluded from the PENDING views below but kept
      // here (via allItemsEver) so "has she genuinely worked beyond S"
      // still sees a sequence she's already fully finished, not just one
      // she still has open work in.
      const allItemsEver: { item: ItemRow; seq: number }[] = [];
      for (const [soid, items] of itemsByOrder) {
        const seq = cleanSeqBySoid.get(soid);
        if (seq == null) continue;
        for (const it of items) if (it.status !== 'cancelled') allItemsEver.push({ item: it, seq });
      }
      const pendingItems = allItemsEver.filter(({ item }) => item.status === 'open' || item.status === 'packed');

      function effectivePacker(it: ItemRow): string | null {
        return it.assigned_packer_id || defaultPackerIdByItem.get(it.item_name) || null;
      }
      // A leafy item never crosses a fruit<->vegetable line — candidate
      // targets narrow to the mover's own category for one of these.
      function candidateTargets(it: ItemRow): string[] {
        if (!LEAFY_ITEM_NAMES.has(it.item_name.toLowerCase())) return allPackerIds;
        return itemCategory(it.item_name) === 'fruit' ? fruitPackerIds : vegPackerIds;
      }

      const currentSeqByPacker = new Map<string, number>(); // lowest pending seq, if any
      const maxSeqEverByPacker = new Map<string, number>(); // highest seq she's EVER had anything in (any status) — "genuinely ahead" signal
      for (const pid of allPackerIds) {
        const mine = pendingItems.filter(({ item }) => effectivePacker(item) === pid);
        if (mine.length) currentSeqByPacker.set(pid, Math.min(...mine.map(m => m.seq)));
        const everMine = allItemsEver.filter(({ item }) => effectivePacker(item) === pid);
        if (everMine.length) maxSeqEverByPacker.set(pid, Math.max(...everMine.map(m => m.seq)));
      }

      // Guard against ever looping forever — at most one pass per
      // currently-pending item, same bound the old code used.
      const guardLimit = pendingItems.length;
      for (let guard = 0; guard < guardLimit; guard++) {
        const pendingSeqs = [...currentSeqByPacker.values()];
        if (!pendingSeqs.length) break; // nobody has anything pending at all today — done
        const S = Math.min(...pendingSeqs);

        const pendingCountAt = (pid: string) => pendingItems.filter(({ item, seq }) => seq === S && effectivePacker(item) === pid).length;
        const openItemsAt = (pid: string) => allItemsEver
          .filter(({ item, seq }) => seq === S && item.status === 'open' && effectivePacker(item) === pid)
          .map(({ item }) => item);

        // "Genuinely ahead" — has real presence (pending OR already
        // finished) in a sequence LATER than S, not just "idle with
        // nothing assigned at all" (an idle packer still helps, but her
        // mere existence doesn't trigger a full takeover — see example in
        // the comment above: a packer with nothing queued up yet gets the
        // gentle (B) treatment, not a forced drain).
        const genuinelyAhead = allPackerIds.filter(pid => (maxSeqEverByPacker.get(pid) ?? -Infinity) > S);
        const stuckAtS = allPackerIds.filter(pid => currentSeqByPacker.get(pid) === S);

        let movedThisRound = false;

        if (genuinelyAhead.length) {
          // Rule A: fully drain every stuck packer's OPEN items at S onto
          // whoever's ahead/idle (never onto another still-stuck packer —
          // she hasn't earned being handed MORE while behind), least-
          // loaded-at-S-first so it doesn't all dump on one person.
          const receivers = allPackerIds.filter(pid => !stuckAtS.includes(pid));
          for (const giverId of stuckAtS) {
            for (const it of openItemsAt(giverId)) {
              const targets = candidateTargets(it).filter(pid => receivers.includes(pid));
              if (!targets.length) continue; // e.g. a leafy item with no same-category receiver — leave it, nothing safe to do
              const target = targets.reduce((a, b) => pendingCountAt(a) <= pendingCountAt(b) ? a : b);
              const { error } = await supabase.from('order_items').update({ assigned_packer_id: target }).eq('id', it.id);
              if (error) { console.error(`Failed to rebalance item ${it.id}:`, error.message); continue; }
              it.assigned_packer_id = target;
              itemsRebalanced++;
              movedThisRound = true;
            }
          }
        } else {
          // Rule B: nobody's lapped this sequence — just keep the spread
          // ≤2 among whoever has anything pending here, one item at a time.
          const atS = allPackerIds.filter(pid => stuckAtS.includes(pid) || pendingCountAt(pid) === 0);
          if (atS.length >= 2) {
            const most = atS.reduce((a, b) => pendingCountAt(a) >= pendingCountAt(b) ? a : b);
            const least = atS.reduce((a, b) => pendingCountAt(a) <= pendingCountAt(b) ? a : b);
            if (pendingCountAt(most) - pendingCountAt(least) > 2) {
              const openHere = openItemsAt(most);
              const movable = openHere.find(it => candidateTargets(it).includes(least));
              if (movable) {
                const { error } = await supabase.from('order_items').update({ assigned_packer_id: least }).eq('id', movable.id);
                if (error) { console.error(`Failed to rebalance item ${movable.id}:`, error.message); }
                else { movable.assigned_packer_id = least; itemsRebalanced++; movedThisRound = true; }
              }
              // else: everything movable from `most` is leafy with no
              // same-category recipient at `least` — nothing safe to move
              // this round; breaking out below avoids spinning forever on
              // the same unsolvable pair.
            }
          }
        }

        // Recompute currentSeqByPacker for anyone this round touched —
        // cheap enough (today's packer count is small) and simplest way
        // to keep it correct across iterations without hand-tracking every
        // delta.
        for (const pid of allPackerIds) {
          const mine = pendingItems.filter(({ item }) => effectivePacker(item) === pid);
          if (mine.length) currentSeqByPacker.set(pid, Math.min(...mine.map(m => m.seq)));
          else currentSeqByPacker.delete(pid);
        }
        if (!movedThisRound) break; // nothing left this sweep can safely do — stop rather than spin
      }
    }

    return new Response(
      JSON.stringify({ sequences_created: newSequences.length, orders_sequenced: ordersSequenced, orders_appended: ordersAppended, orders_urgent_moved: ordersUrgentMoved, items_rebalanced: itemsRebalanced, sequences_defragmented: sequencesDefragmented, items_reassigned_from_inactive_packer: itemsReassignedFromInactive }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
