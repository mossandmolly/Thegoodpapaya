// Supabase Edge Function — compute-next-sequence
//
// Replaces manual push-to-queue (migration 119, now retired — see
// migration 120) with an automated scheduler. Triggered every 3 minutes by
// pg_cron (migration 121), same x-cron-secret pattern as sync-catalog/
// auto-invoice-final-orders. Each run partitions today's still-unsequenced
// orders into one or more numbered "sequences" (~30 items, 40 hard cap,
// whole orders only) and stamps orders.sequence_number/sequenced_at —
// the only thing the Packer tab's "My Sequence" view reads to decide what
// a given packer sees right now (see parser.html's computeMyCurrentSequence).
//
// Precedence: a deliver_by within 90 minutes beats everything (soonest
// first); otherwise Community Priority rank (community_priority.rank),
// with Somya's same-day manual drag-reorder (packer_priority_override) as
// a tiebreak that a timeline order still always beats. Orders placed
// 11:00-13:00 IST are held out entirely until after 15:30 IST. A sequence
// doesn't linger on one society — once started, it prefers to fill from
// the same/neighbouring-rank community, but a NEW sequence prefers a
// society not in the last two sequences' societies (packer_sequence_state)
// unless nothing else is eligible; a revisited society only pulls its
// pre-11:00 orders that run.
//
// Once a sequence's order set is fixed, its items are split fruit/veg
// packer, defaulting to packer_assignments and moving overflow (>130% of
// that category's per-sequence average) to the least-loaded same-category
// packer — see balanceCategory() below.
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
const HOLD_WINDOW_START_MIN = 11 * 60;
const HOLD_WINDOW_END_MIN = 13 * 60;
const HOLD_RELEASE_MIN = 15 * 60 + 30;
const SEQUENCE_TARGET = 30;
const SEQUENCE_HARD_CAP = 40;
const RECENT_SOCIETY_WINDOW = 2;
const PACKER_OVERFLOW_FACTOR = 1.3;
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
}
interface ItemRow {
  id: string;
  sales_order_id: string;
  item_name: string;
  assigned_packer_id: string | null;
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
  rank: number;            // Infinity if unmatched
  override: number | null;
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

function compareTier2(a: OrderMeta, b: OrderMeta): number {
  if (a.override != null && b.override != null) return a.override - b.override;
  if (a.override != null) return -1;
  if (b.override != null) return 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
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
// a lone timeline order's trip, or just keeps a society together; (2) the
// nearest-ranked neighbouring community; (3) next in overall priority order,
// skipping a recently-used society unless nothing else fits; (4) same,
// allowing a recently-used society rather than leaving a tiny sequence.
// Every tier is filtered to orders that actually fit under the remaining
// capacity — an order that doesn't is left in `remaining` for a LATER
// sequence instead of delaying this one (the "23-24 item order" case).
function pickNextCandidate(remaining: OrderMeta[], dominantGroup: string, dominantRank: number, recentGroups: string[], capacityLeft: number): number {
  let idx = remaining.findIndex(o => o.groupName === dominantGroup && o.itemCount <= capacityLeft);
  if (idx >= 0) return idx;

  if (dominantRank !== Infinity) {
    let bestIdx = -1, bestDist = Infinity;
    remaining.forEach((o, i) => {
      if (o.rank === Infinity || o.itemCount > capacityLeft) return;
      const dist = Math.abs(o.rank - dominantRank);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    if (bestIdx >= 0) return bestIdx;
  }

  idx = remaining.findIndex(o => o.itemCount <= capacityLeft && !recentGroups.includes(o.groupName));
  if (idx >= 0) return idx;

  return remaining.findIndex(o => o.itemCount <= capacityLeft);
}

// Splits one category's (fruit or veg) items across that category's active
// packers: defaults to packer_assignments, places anything unassigned on
// the least-loaded packer, then moves overflow (> PACKER_OVERFLOW_FACTOR
// times the per-sequence average) from the most- to least-loaded packer
// until balanced or no further valid move exists. Returns only the item IDs
// that actually need a DB write (i.e. differ from their current effective
// packer) — items staying on their default need no override row at all.
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

  const avg = items.length / packerIds.length;
  const threshold = avg * PACKER_OVERFLOW_FACTOR;
  for (let guard = 0; guard < items.length; guard++) { // bounded — at most one move per item, ever
    const over = packerIds.filter(p => (counts.get(p) || 0) > threshold);
    if (!over.length) break;
    const from = over.reduce((a, b) => counts.get(a)! >= counts.get(b)! ? a : b);
    const to = packerIds.reduce((a, b) => counts.get(a)! <= counts.get(b)! ? a : b);
    if (from === to) break;
    const itemToMove = items.find(it => assignment.get(it.id) === from);
    if (!itemToMove) break;
    assignment.set(itemToMove.id, to);
    counts.set(from, counts.get(from)! - 1);
    counts.set(to, counts.get(to)! + 1);
  }

  const writes = new Map<string, string>();
  for (const it of items) {
    const finalId = assignment.get(it.id);
    const currentEffective = it.assigned_packer_id || defaultPackerIdByItem.get(it.item_name) || null;
    if (finalId && finalId !== currentEffective) writes.set(it.id, finalId);
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

    // ── Load today's still-unsequenced orders + their items ──────────────
    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('sales_order_id,society,customer_name,deliver_by,created_at,is_pickup,status')
      .like('sales_order_id', `${today}-%`)
      .is('sequence_number', null)
      .neq('status', 'cancelled');
    if (ordersErr) throw new Error(ordersErr.message);
    if (!orders || !orders.length) {
      return new Response(JSON.stringify({ sequences_created: 0, orders_sequenced: 0, reason: 'nothing unsequenced' }),
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
      (items || []).forEach((it: ItemRow & { status: string }) => {
        if (!itemsByOrder.has(it.sales_order_id)) itemsByOrder.set(it.sales_order_id, []);
        itemsByOrder.get(it.sales_order_id)!.push(it);
      });
    }

    // ── Community priority + manual override + reference data ────────────
    const [cpRes, kwRes, overrideRes, catalogRes, packerRes, assignRes] = await Promise.all([
      supabase.from('community_priority').select('unique_id,display_name,rank,default_deliver_by'),
      supabase.from('community_priority_keywords').select('community_unique_id,keyword'),
      supabase.from('packer_priority_override').select('group_name,sort_order').eq('view_date', today),
      supabase.from('catalog').select('item_name,category'),
      supabase.from('packers').select('id,name,category').eq('active', true),
      supabase.from('packer_assignments').select('packer_id,item_name'),
    ]);
    // None of these are fatal to crash the whole run over — degrade
    // gracefully (community/override/category/assignment data just comes
    // up empty, same as if nothing were configured yet) but log so a
    // persistent problem is actually visible in the function's logs.
    [cpRes, kwRes, overrideRes, catalogRes, packerRes, assignRes].forEach(r => { if (r.error) console.error('Reference data fetch failed:', r.error.message); });
    const cpRows = cpRes.data, kwRows = kwRes.data, overrideRows = overrideRes.data,
          catalogRows = catalogRes.data, packerRows = packerRes.data, assignRows = assignRes.data;

    const priorities: CommunityPriority[] = (cpRows || []).map((c: any) => ({ ...c, keywords: [] as string[] }));
    const priorityById = new Map(priorities.map(p => [p.unique_id, p]));
    (kwRows || []).forEach((k: any) => { priorityById.get(k.community_unique_id)?.keywords.push(k.keyword); });

    const overrideByGroup = new Map<string, number>();
    (overrideRows || []).forEach((r: any) => overrideByGroup.set(r.group_name, r.sort_order));

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
      const held = !tier0
        && createdMinsOfDay >= HOLD_WINDOW_START_MIN && createdMinsOfDay < HOLD_WINDOW_END_MIN
        && nowMinsOfDay < HOLD_RELEASE_MIN;
      return {
        order: o,
        itemCount: items.length,
        groupName,
        rank,
        override: overrideByGroup.has(groupName) ? overrideByGroup.get(groupName)! : null,
        tier0,
        deadlineMins: tier0 ? deadlineMins! : Infinity,
        createdAtMs: new Date(o.created_at).getTime(),
        held,
      };
    }).filter(m => m.itemCount > 0); // nothing active left to pack — skip entirely

    const eligible = metas.filter(m => !m.held);
    const tier0s = eligible.filter(m => m.tier0).sort((a, b) => a.deadlineMins - b.deadlineMins);
    const tier2s = eligible.filter(m => !m.tier0).sort(compareTier2);
    let remaining = [...tier0s, ...tier2s];

    // ── Build sequences ────────────────────────────────────────────────────
    const sequences: OrderMeta[][] = [];
    while (remaining.length && sequences.length < MAX_SEQUENCES_PER_RUN) {
      const startIdx = pickSequenceStart(remaining, recentGroups);
      const start = remaining.splice(startIdx, 1)[0];
      const seq = [start];
      let runningCount = start.order.is_pickup ? 0 : start.itemCount;
      const dominantGroup = start.groupName;
      const dominantRank = start.rank;

      while (runningCount < SEQUENCE_TARGET && remaining.length) {
        const capacityLeft = SEQUENCE_HARD_CAP - runningCount;
        const idx = pickNextCandidate(remaining, dominantGroup, dominantRank, recentGroups, capacityLeft);
        if (idx < 0) break; // nothing left fits under the cap right now
        const next = remaining.splice(idx, 1)[0];
        seq.push(next);
        runningCount += next.order.is_pickup ? 0 : next.itemCount;
      }

      sequences.push(seq);
      recentGroups.push(dominantGroup);
      while (recentGroups.length > RECENT_SOCIETY_WINDOW) recentGroups.shift();
    }

    if (!sequences.length) {
      return new Response(JSON.stringify({ sequences_created: 0, orders_sequenced: 0, reason: 'nothing eligible this run (held or no match)' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── Find the next sequence number for today ───────────────────────────
    const { data: maxRow } = await supabase
      .from('orders').select('sequence_number')
      .like('sales_order_id', `${today}-%`).not('sequence_number', 'is', null)
      .order('sequence_number', { ascending: false }).limit(1).maybeSingle();
    let nextSeqNumber = (maxRow?.sequence_number ?? 0) + 1;

    let ordersSequenced = 0;
    for (const seq of sequences) {
      const seqSoids = seq.map(m => m.order.sales_order_id);
      const { error: updErr } = await supabase
        .from('orders')
        .update({ sequence_number: nextSeqNumber, sequenced_at: new Date().toISOString() })
        .in('sales_order_id', seqSoids);
      if (updErr) throw new Error(`Failed to stamp sequence ${nextSeqNumber}: ${updErr.message}`);
      ordersSequenced += seqSoids.length;

      // Rebalance packer load within this sequence, fruit and veg separately.
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

      nextSeqNumber++;
    }

    const { error: stateErr } = await supabase.from('packer_sequence_state')
      .update({ recent_group_names: recentGroups, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (stateErr) console.error('Failed to update packer_sequence_state:', stateErr.message);

    return new Response(
      JSON.stringify({ sequences_created: sequences.length, orders_sequenced: ordersSequenced }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
