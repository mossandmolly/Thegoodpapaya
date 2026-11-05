// Supabase Edge Function — create-storefront-bulk-payment-link
//
// "Pay All" — keeps ONE Razorpay payment link in sync with every pending
// (unpaid/partially-paid) invoice currently on file for a phone number,
// instead of making the customer pay each one separately.
//
// Called automatically on every storefront lookup (not just on a button
// tap) — see storefront/invoices.html's lookup(). That means this function
// has to be cheap and idempotent when nothing has actually changed:
//   - 2+ pending invoices, same set/amounts as the last call → returns the
//     SAME link straight back, no Razorpay calls at all.
//   - 2+ pending invoices, but the set or an amount changed since the last
//     call (one got paid separately, a new one appeared, a balance moved)
//     → cancels the stale link and makes a fresh one for the new total.
//   - fewer than 2 pending invoices → cancels and clears any stale link
//     left over from before (so a bulk link covering orders that are now
//     settled by some other channel can never be paid again — see the
//     "size < 2" branch below for why this matters).
//
// SECURITY: no login check, same posture as create-storefront-payment-link —
// but there's no separate ownership check needed here at all, because the
// list of orders to charge is derived entirely from get_invoices_by_phone
// for the phone number passed in. That RPC only ever returns invoices whose
// invoice_line_items.phone_number matches — the exact same boundary the
// normal "View My Invoices" lookup already relies on. A caller can never
// steer this towards someone else's order.
//
// Input:  { phone: string }
// Output: { bulk: false } | { bulk: true, payment_url, razorpay_link_id, sales_order_ids: string[], amount }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};

type BreakdownItem = { sales_order_id: string; amount: number };

async function cancelPaymentLink(linkId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
}

// Same set of orders, same amount on each (to the paisa) — order doesn't
// matter, Map insertion order isn't guaranteed to match what was stored.
function breakdownsMatch(stored: any, fresh: BreakdownItem[]): boolean {
  if (!Array.isArray(stored) || stored.length !== fresh.length) return false;
  const normalize = (arr: any[]) =>
    arr.map(b => `${b.sales_order_id}:${Math.round((+b.amount || 0) * 100)}`).sort();
  const a = normalize(stored), b = normalize(fresh);
  return a.every((v, i) => v === b[i]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { phone: rawPhone } = await req.json();
    const phone = String(rawPhone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!/^\d{10}$/.test(phone)) throw new Error('Invalid phone number');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const keyId     = env('RAZORPAY_KEY_ID');
    const keySecret = env('RAZORPAY_KEY_SECRET');
    const auth      = btoa(`${keyId}:${keySecret}`);

    // Same two-form lookup the storefront itself does (bare vs +91-prefixed
    // — whichever one actually has rows in invoice_line_items.phone_number).
    let { data: rows, error: rpcErr } = await supabase.rpc('get_invoices_by_phone', { p_phone: phone });
    if (!rpcErr && (!rows || !rows.length)) {
      ({ data: rows, error: rpcErr } = await supabase.rpc('get_invoices_by_phone', { p_phone: '+91' + phone }));
    }
    if (rpcErr) throw new Error(rpcErr.message);

    // get_invoices_by_phone returns one row per line item — collapse to one
    // entry per invoice (same grouping storefront/invoices.html does
    // client-side), keep only the ones still owing money, and dedupe by
    // sales_order_id (an order could in principle appear more than once if
    // it was ever re-invoiced, though in practice it won't).
    const bySalesOrder = new Map<string, { customer_name: string; balance: number }>();
    for (const r of rows ?? []) {
      if (r.payment_status === 'paid') continue;
      const balance = +r.balance || 0;
      if (balance <= 0) continue;
      if (!r.sales_order_id || bySalesOrder.has(r.sales_order_id)) continue;
      bySalesOrder.set(r.sales_order_id, { customer_name: r.customer_name, balance });
    }

    // Whatever unconsumed bulk link this phone already has, if any — the
    // thing every branch below needs to either reuse, replace, or clear.
    const { data: existing } = await supabase
      .from('razorpay_bulk_payment_links')
      .select('razorpay_link_id, payment_url, breakdown')
      .eq('phone', phone)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Fewer than 2 pending invoices — a combined link no longer makes sense
    // (1 invoice already has its own "Pay Now", 0 means nothing's owed).
    // If a bulk link from an earlier, larger pending set is still sitting
    // active, it MUST be torn down here: something external (a rider
    // marking one order cash-collected, a reconcile pass, a manual Zoho
    // payment) could have settled enough of the original set that this
    // link's total no longer matches anything real — left alone, it would
    // still be a live, payable Razorpay link that double-credits whatever
    // it used to cover.
    if (bySalesOrder.size < 2) {
      if (existing) {
        try { await cancelPaymentLink(existing.razorpay_link_id, auth); }
        catch (e: any) { console.error('[create-storefront-bulk-payment-link] cancel (stale, <2 pending) failed:', e.message); }
        await supabase.from('razorpay_bulk_payment_links').delete().eq('razorpay_link_id', existing.razorpay_link_id);
      }
      return new Response(JSON.stringify({ bulk: false }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const breakdown = [...bySalesOrder.entries()].map(([sales_order_id, v]) => ({
      sales_order_id, amount: v.balance,
    }));
    const totalRupees = breakdown.reduce((sum, b) => sum + b.amount, 0);

    // Nothing changed since the link already on file for this phone was
    // made — hand the same one back. No Razorpay calls at all on this path,
    // which is the common case: a repeat lookup (or the storefront's own
    // tab-refocus auto-refresh) finding the same pending set it found last
    // time.
    if (existing && breakdownsMatch(existing.breakdown, breakdown)) {
      return new Response(
        JSON.stringify({
          bulk: true,
          payment_url: existing.payment_url,
          razorpay_link_id: existing.razorpay_link_id,
          sales_order_ids: breakdown.map(b => b.sales_order_id),
          amount: totalRupees,
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Something changed (or there was nothing before) — replace whatever
    // stale link existed first, so it can never be double-paid alongside
    // the new one.
    if (existing) {
      try { await cancelPaymentLink(existing.razorpay_link_id, auth); }
      catch (e: any) { console.error('[create-storefront-bulk-payment-link] cancel (superseded) failed:', e.message); }
      await supabase.from('razorpay_bulk_payment_links').delete().eq('razorpay_link_id', existing.razorpay_link_id);
    }

    const amountPaise = Math.round(totalRupees * 100);
    const customerName = [...bySalesOrder.values()][0].customer_name;

    // Cancel whichever individual per-order links were already active —
    // once this bulk link is paid, those orders are fully settled, so a
    // customer paying the old individual link too (or trying to) should
    // never be possible. Run concurrently (these are all independent of
    // each other) rather than one Razorpay round trip at a time, which
    // matters here since this whole function now runs on every lookup, not
    // just an explicit button tap.
    await Promise.all([...bySalesOrder.keys()].map(async (salesOrderId) => {
      try {
        const { data: order } = await supabase
          .from('orders').select('razorpay_link_id').eq('sales_order_id', salesOrderId).maybeSingle();
        if (order?.razorpay_link_id) {
          await cancelPaymentLink(order.razorpay_link_id, auth);
          await supabase.from('orders')
            .update({ razorpay_link_id: null, razorpay_url: null })
            .eq('sales_order_id', salesOrderId);
        }
      } catch (e: any) {
        console.error(`[create-storefront-bulk-payment-link] cancel failed for ${salesOrderId}:`, e.message);
      }
    }));

    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        description: `The Good Papaya — ${breakdown.length} invoice${breakdown.length === 1 ? '' : 's'}`,
        customer: { name: customerName, contact: `+91${phone}` },
        notify:          { sms: true, whatsapp: true, email: false },
        reminder_enable: false,
        // Razorpay notes are short strings only — the real breakdown this
        // webhook actually needs lives in razorpay_bulk_payment_links,
        // keyed by this link's own id. sales_order_ids here is just for
        // anyone reading the Razorpay dashboard directly.
        notes: { sales_order_ids: breakdown.map(b => b.sales_order_id).join(','), phone, bulk: 'true' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');

    const { error: insertErr } = await supabase.from('razorpay_bulk_payment_links').insert({
      razorpay_link_id: data.id,
      phone,
      breakdown,
      payment_url: data.short_url,
    });
    if (insertErr) {
      // Without this row the webhook can't split the payment when it lands
      // — cancel the link rather than leave a payable-but-unsplittable one.
      await cancelPaymentLink(data.id, auth);
      throw new Error('Could not save payment breakdown: ' + insertErr.message);
    }

    return new Response(
      JSON.stringify({
        bulk: true,
        payment_url: data.short_url,
        razorpay_link_id: data.id,
        sales_order_ids: breakdown.map(b => b.sales_order_id),
        amount: totalRupees,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
