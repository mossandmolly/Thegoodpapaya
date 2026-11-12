// Supabase Edge Function — fix-phone-mapping
//
// Backs the ops-dashboard's "Phone Lookup" admin tab. A wrong customer-
// name/phone-number pairing lives in up to three places at once —
// customer_phones (what every future order for that name auto-fills from,
// via the orders_fill_phone_from_customer trigger), orders.phone (the
// live field on that customer's current orders), and
// invoice_line_items.phone_number (the frozen per-invoice snapshot the
// storefront's own phone lookup actually searches by) — and fixing only
// one of the three means the "fix" regresses the next time an order or
// invoice gets created/regenerated for that customer. This touches all
// three in one call, same as the ad hoc SQL this replaces.
//
// orders and invoice_line_items both lock writes to service-role only
// (orders always has; invoice_line_items only ever had a SELECT grant for
// authenticated, migration 094) — customer_phones alone allows a direct
// client write, so this couldn't be a client-side-only fix even for that
// one table once the other two also need touching in the same action.
//
// Server-side restricted to Somya/Rohith — the first function in this app
// to actually enforce that server-side (every other admin-only feature so
// far has only ever hidden its button client-side); this one changes real
// customer data across three tables, so it gets the stricter version.
//
// Two actions:
//   - delete: this customer_name should not be associated with `phone` at
//     all — removes the customer_phones row, clears phone_number/phone to
//     null wherever invoice_line_items/orders currently carry it for this
//     exact customer_name.
//   - edit: this customer_name's phone was wrong (`phone`) — replaces it
//     with `new_phone` everywhere, but only on the rows that currently
//     carry the wrong one (never a blanket overwrite of every row for
//     that customer_name, in case some of those already have a different,
//     separately-wrong number that needs its own fix).
//
// Input:  { action: 'delete'|'edit', customer_name: string, phone: string, new_phone?: string }
// Output: { ok: true, customer_phones: number, invoice_line_items: number, orders: number }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const ALLOWED_EMAILS = new Set(['somya@thegoodpapaya.com', 'rohith@thegoodpapaya.com']);

async function requireAdminAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
  const user = await res.json();
  const email = (user?.email || '').toLowerCase();
  if (!ALLOWED_EMAILS.has(email)) throw new Error('Not authorized for this action');
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAdminAuth(req);
    const { action, customer_name, phone, new_phone } = await req.json();
    if (!action || !customer_name || !phone) throw new Error('Missing action/customer_name/phone');
    if (action !== 'delete' && action !== 'edit') throw new Error('action must be delete or edit');
    if (action === 'edit' && !new_phone) throw new Error('new_phone required for edit');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    let touchedCustomerPhones = 0, touchedInvoiceLineItems = 0, touchedOrders = 0;

    // The house-list RPCs this tab's search is built on (admin_houses_for_
    // phone, admin_invoices_for_phone) match a phone number in NORMALIZED
    // form — last 10 digits, regardless of a +91 prefix — specifically so
    // "9036073273" and "+919036073273" are recognized as the same number.
    // An exact-string match here would silently miss whichever format
    // variant isn't the one passed in, leaving a "fixed" mapping actually
    // half-fixed. Matching against every plausible stored form instead.
    const bare = phone.replace(/^\+91/, '');
    const phoneVariants = [...new Set([phone, bare, '+91' + bare])];

    if (action === 'delete') {
      const { data: cpRows, error: cpErr } = await supabase
        .from('customer_phones').delete()
        .eq('customer_name', customer_name).in('phone_number', phoneVariants)
        .select('customer_name');
      if (cpErr) throw new Error(`customer_phones: ${cpErr.message}`);
      touchedCustomerPhones = cpRows?.length ?? 0;

      const { data: iliRows, error: iliErr } = await supabase
        .from('invoice_line_items').update({ phone_number: null })
        .eq('customer_name', customer_name).in('phone_number', phoneVariants)
        .select('id');
      if (iliErr) throw new Error(`invoice_line_items: ${iliErr.message}`);
      touchedInvoiceLineItems = iliRows?.length ?? 0;

      const { data: orderRows, error: orderErr } = await supabase
        .from('orders').update({ phone: null })
        .eq('customer_name', customer_name).in('phone', phoneVariants)
        .select('sales_order_id');
      if (orderErr) throw new Error(`orders: ${orderErr.message}`);
      touchedOrders = orderRows?.length ?? 0;

    } else {
      // edit — customer_phones has no natural "update the number for this
      // name" since (customer_name, phone_number) is the primary key
      // together (migration 103/135): delete whichever format variant of
      // the wrong row exists, insert the right one. A harmless no-op on
      // the delete half if the wrong row wasn't actually in customer_
      // phones at all (e.g. it only ever existed on orders/invoice_line_
      // items) — the insert below still runs either way.
      const { error: delErr } = await supabase
        .from('customer_phones').delete()
        .eq('customer_name', customer_name).in('phone_number', phoneVariants);
      if (delErr) throw new Error(`customer_phones delete: ${delErr.message}`);
      const { error: insErr } = await supabase
        .from('customer_phones').upsert(
          { customer_name, phone_number: new_phone },
          { onConflict: 'customer_name,phone_number' },
        );
      if (insErr) throw new Error(`customer_phones insert: ${insErr.message}`);
      touchedCustomerPhones = 1;

      const { data: iliRows, error: iliErr } = await supabase
        .from('invoice_line_items').update({ phone_number: new_phone })
        .eq('customer_name', customer_name).in('phone_number', phoneVariants)
        .select('id');
      if (iliErr) throw new Error(`invoice_line_items: ${iliErr.message}`);
      touchedInvoiceLineItems = iliRows?.length ?? 0;

      const { data: orderRows, error: orderErr } = await supabase
        .from('orders').update({ phone: new_phone })
        .eq('customer_name', customer_name).in('phone', phoneVariants)
        .select('sales_order_id');
      if (orderErr) throw new Error(`orders: ${orderErr.message}`);
      touchedOrders = orderRows?.length ?? 0;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        customer_phones: touchedCustomerPhones,
        invoice_line_items: touchedInvoiceLineItems,
        orders: touchedOrders,
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
