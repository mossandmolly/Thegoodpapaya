// Supabase Edge Function — sales-dashboard
//
// Aggregates invoice_line_items (the Zoho-synced source of truth for what
// was actually billed) into weekly vegetable-vs-fruit metrics and a
// society-level customer spread, for the ops sales dashboard.
//
// GET /sales-dashboard
//   ?month=2026-08          default: current month (server time)
//   &launch_date=2026-08-15 default: 2026-08-15 (when the vegetable line launched)
//
// Uses the service role key so it can read across all customers —
// invoice_line_items RLS otherwise restricts SELECT to the caller's own
// phone number. The response is aggregated (no raw PII beyond a
// customer/society label), same trust level as the other admin-* functions.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

// ── Community / society resolution ──────────────────────────────────────────
// Mirrors extract_community() in migration 005: last space-separated token
// containing a digit is the door number; everything before it is the
// community. Then best-effort canonicalise against the societies table.

function extractCommunity(customerName: string): string | null {
  const parts = customerName.trim().split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/\d/.test(parts[i])) {
      if (i === 0) return null;
      return parts.slice(0, i).join(' ');
    }
  }
  return customerName;
}

function cleanKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, ' ').split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function buildSocietyResolver(societies: { canonical_name: string; aliases: string[] }[]) {
  const map = new Map<string, string>(); // cleaned alias/canonical -> display name
  for (const s of societies) {
    const display = titleCase(s.canonical_name);
    map.set(cleanKey(s.canonical_name), display);
    for (const a of s.aliases || []) map.set(cleanKey(a), display);
  }
  return (community: string | null): string => {
    if (!community) return 'Unmatched / Other';
    const key = cleanKey(community);
    if (map.has(key)) return map.get(key)!;
    // fall back to substring match (community strings often carry extra
    // words, e.g. "APR Villas" vs canonical "villa")
    for (const [k, display] of map) {
      if (key.includes(k)) return display;
    }
    return titleCase(community);
  };
}

// ── Week buckets ─────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildWeeks(monthStart: Date, monthEnd: Date, launchDate: Date, now: Date) {
  const weeks: { start: string; end: string; label: string; period: string }[] = [];
  let cursor = new Date(monthStart);
  let n = 1;
  while (cursor <= monthEnd) {
    const start = new Date(cursor);
    const end = new Date(Math.min(
      new Date(cursor.getTime() + 6 * 86400000).getTime(),
      monthEnd.getTime(),
    ));
    if (start <= now) {
      const allPre = end < launchDate;
      const allPost = start >= launchDate;
      const period = allPre ? 'pre' : allPost ? 'post' : 'transition';
      const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      weeks.push({
        start: isoDate(start),
        end: isoDate(end),
        label: `Week ${n} (${fmt(start)}–${fmt(end)})`,
        period,
      });
    }
    cursor = new Date(cursor.getTime() + 7 * 86400000);
    n++;
  }
  return weeks;
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url = new URL(req.url);
    const now = new Date();

    const monthParam = url.searchParams.get('month'); // "YYYY-MM"
    const monthDate = monthParam ? new Date(`${monthParam}-01T00:00:00Z`) : now;
    const monthStart = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0));

    const launchParam = url.searchParams.get('launch_date');
    const launchDate = new Date(`${launchParam || '2026-08-15'}T00:00:00Z`);

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const [{ data: catalogRows }, { data: societyRows }, { data: orderRows }, { data: lineRows }] =
      await Promise.all([
        supabase.from('catalog').select('item_name_normal, category'),
        supabase.from('societies').select('canonical_name, aliases').eq('active', true),
        supabase.from('orders')
          .select('sales_order_id, customer_name, community')
          .gte('created_at', monthStart.toISOString())
          .lte('created_at', new Date(monthEnd.getTime() + 86400000).toISOString()),
        supabase.from('invoice_line_items')
          .select('customer_name, invoice_date, zoho_invoice_id, sales_order_id, item_name, final_quantity, item_price, invoice_total, payment_status')
          .gte('invoice_date', isoDate(monthStart))
          .lte('invoice_date', isoDate(monthEnd)),
      ]);

    if (!lineRows) throw new Error('Failed to read invoice_line_items');

    const categoryMap = new Map<string, string>();
    for (const c of catalogRows || []) categoryMap.set(c.item_name_normal, c.category);

    const orderCommunityMap = new Map<string, string | null>();
    for (const o of orderRows || []) orderCommunityMap.set(o.sales_order_id, o.community);

    const resolveSociety = buildSocietyResolver(societyRows || []);

    function normaliseItemKey(name: string): string {
      return name.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    // ── Group line items into orders (one row per invoice) ───────────────────
    type OrderAgg = {
      invoiceId: string;
      date: string;
      customerName: string;
      society: string;
      invoiceTotal: number;
      vegRevenue: number;
      fruitRevenue: number;
      unmatchedRevenue: number;
    };
    const orders = new Map<string, OrderAgg>();
    const unmatchedItems = new Set<string>();

    for (const li of lineRows) {
      if (li.payment_status === 'cancelled') continue; // cancelled invoices aren't real sales
      const key = li.zoho_invoice_id;
      if (!orders.has(key)) {
        const community = li.sales_order_id
          ? orderCommunityMap.get(li.sales_order_id) ?? extractCommunity(li.customer_name)
          : extractCommunity(li.customer_name);
        orders.set(key, {
          invoiceId: key,
          date: li.invoice_date,
          customerName: li.customer_name,
          society: resolveSociety(community),
          invoiceTotal: Number(li.invoice_total) || 0,
          vegRevenue: 0,
          fruitRevenue: 0,
          unmatchedRevenue: 0,
        });
      }
      const agg = orders.get(key)!;
      const lineRevenue = (Number(li.final_quantity) || 0) * (Number(li.item_price) || 0);
      const category = categoryMap.get(normaliseItemKey(li.item_name));
      if (category === 'vegetable') agg.vegRevenue += lineRevenue;
      else if (category === 'fruit') agg.fruitRevenue += lineRevenue;
      else { agg.unmatchedRevenue += lineRevenue; unmatchedItems.add(li.item_name); }
    }

    const orderList = [...orders.values()];

    // ── Weekly buckets ────────────────────────────────────────────────────────
    const weekDefs = buildWeeks(monthStart, monthEnd, launchDate, now);

    function emptyBucket() {
      return {
        orders: 0, uniqueCustomers: new Set<string>(), revenue: 0,
        vegOrders: 0, vegRevenue: 0,
        fruitOrders: 0, fruitRevenue: 0,
      };
    }

    const buckets = weekDefs.map(() => emptyBucket());

    for (const o of orderList) {
      const idx = weekDefs.findIndex(w => o.date >= w.start && o.date <= w.end);
      if (idx === -1) continue;
      const b = buckets[idx];
      b.orders += 1;
      b.uniqueCustomers.add(o.customerName);
      b.revenue += o.invoiceTotal;
      if (o.vegRevenue > 0) { b.vegOrders += 1; b.vegRevenue += o.vegRevenue; }
      if (o.fruitRevenue > 0) { b.fruitOrders += 1; b.fruitRevenue += o.fruitRevenue; }
    }

    const round = (n: number) => Math.round(n * 100) / 100;

    const weeks = weekDefs.map((w, i) => {
      const b = buckets[i];
      return {
        label: w.label,
        start: w.start,
        end: w.end,
        period: w.period,
        orders: b.orders,
        uniqueCustomers: b.uniqueCustomers.size,
        revenue: round(b.revenue),
        aov: b.orders ? round(b.revenue / b.orders) : 0,
        veg: {
          orders: b.vegOrders,
          pctOfOrders: b.orders ? round((b.vegOrders / b.orders) * 100) : 0,
          revenue: round(b.vegRevenue),
          aov: b.vegOrders ? round(b.vegRevenue / b.vegOrders) : 0,
        },
        fruit: {
          orders: b.fruitOrders,
          pctOfOrders: b.orders ? round((b.fruitOrders / b.orders) * 100) : 0,
          revenue: round(b.fruitRevenue),
          aov: b.fruitOrders ? round(b.fruitRevenue / b.fruitOrders) : 0,
        },
      };
    });

    // ── Pre vs post summary (transition week excluded — too few days on either side) ──
    function summarise(period: 'pre' | 'post') {
      const relevant = weeks.filter(w => w.period === period);
      const days = relevant.reduce((s, w) => s + (new Date(w.end).getTime() - new Date(w.start).getTime()) / 86400000 + 1, 0);
      const totalOrders = relevant.reduce((s, w) => s + w.orders, 0);
      const totalRevenue = relevant.reduce((s, w) => s + w.revenue, 0);
      const vegOrders = relevant.reduce((s, w) => s + w.veg.orders, 0);
      const vegRevenue = relevant.reduce((s, w) => s + w.veg.revenue, 0);
      const fruitOrders = relevant.reduce((s, w) => s + w.fruit.orders, 0);
      const fruitRevenue = relevant.reduce((s, w) => s + w.fruit.revenue, 0);
      return {
        days: round(days),
        orders: totalOrders,
        ordersPerDay: days ? round(totalOrders / days) : 0,
        revenue: round(totalRevenue),
        aov: totalOrders ? round(totalRevenue / totalOrders) : 0,
        veg: {
          orders: vegOrders,
          pctOfOrders: totalOrders ? round((vegOrders / totalOrders) * 100) : 0,
          revenue: round(vegRevenue),
          aov: vegOrders ? round(vegRevenue / vegOrders) : 0,
        },
        fruit: {
          orders: fruitOrders,
          pctOfOrders: totalOrders ? round((fruitOrders / totalOrders) * 100) : 0,
          revenue: round(fruitRevenue),
          aov: fruitOrders ? round(fruitRevenue / fruitOrders) : 0,
        },
      };
    }

    // ── Society spread ───────────────────────────────────────────────────────
    type SocietyAgg = {
      society: string; customers: Set<string>; orders: number; revenue: number;
      vegOrders: number; vegRevenue: number;
    };
    const societyMap = new Map<string, SocietyAgg>();
    for (const o of orderList) {
      if (!societyMap.has(o.society)) {
        societyMap.set(o.society, { society: o.society, customers: new Set(), orders: 0, revenue: 0, vegOrders: 0, vegRevenue: 0 });
      }
      const s = societyMap.get(o.society)!;
      s.customers.add(o.customerName);
      s.orders += 1;
      s.revenue += o.invoiceTotal;
      if (o.vegRevenue > 0) { s.vegOrders += 1; s.vegRevenue += o.vegRevenue; }
    }
    const societies = [...societyMap.values()]
      .map(s => ({
        society: s.society,
        customers: s.customers.size,
        orders: s.orders,
        revenue: round(s.revenue),
        aov: s.orders ? round(s.revenue / s.orders) : 0,
        vegOrders: s.vegOrders,
        vegPctOfOrders: s.orders ? round((s.vegOrders / s.orders) * 100) : 0,
        vegRevenue: round(s.vegRevenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    return new Response(JSON.stringify({
      month: isoDate(monthStart).slice(0, 7),
      launchDate: isoDate(launchDate),
      generatedAt: now.toISOString(),
      totalOrders: orderList.length,
      weeks,
      summary: { pre: summarise('pre'), post: summarise('post') },
      societies,
      unmatchedItems: [...unmatchedItems].sort(),
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
