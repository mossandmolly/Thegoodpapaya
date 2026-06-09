// Returns distinct invoices where no Razorpay payment link was created.
// Grouped by invoice_number so we show one row per invoice, not per line item.

function env(key: string) { return Deno.env.get(key) ?? ''; }

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
    const url = `${env('SUPABASE_URL')}/rest/v1/invoice_line_items` +
      `?payment_link=is.null&invoice_date=gte.${since}&select=customer_name,invoice_number,invoice_date,invoice_total,phone_number` +
      `&order=invoice_date.desc`;

    const res  = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'apikey': key },
    });
    const rows = res.ok ? await res.json() : [];

    // Deduplicate — one row per invoice_number
    const seen = new Set<string>();
    const invoices = (rows as any[]).filter(r => {
      if (seen.has(r.invoice_number)) return false;
      seen.add(r.invoice_number);
      return true;
    });

    return new Response(
      JSON.stringify({ invoices }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
