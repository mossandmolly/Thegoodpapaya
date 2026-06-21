// Supabase Edge Function — manual order entry
//
// Input:  { records, phones?, newCustomers?, newItems? }
//   records: [{ customer_name, invoice_date, item_name, requested_quantity, description?, community? }]
//   phones:  { "CustomerName": "9876543210" }  — supplied when re-submitting after missingPhones
//
// Output: { inserted, held }
//   held = items that already existed in operations for that customer+date (needs admin review)
//
// Behaviour mirrors upload-orders but without admin password (uses service role from ops dashboard).
//   • Generates sales_order_id per customer
//   • Merges into operations: new items → 'draft'; duplicates → 'held'
//   • Phones saved to customer_phones
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function sbHeaders() {
  return {
    'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey':        env('SUPABASE_SERVICE_ROLE_KEY'),
    'Content-Type':  'application/json',
  };
}

function normalizePhone(raw: string): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length === 10 && /^[6-9]/.test(d))                          return '+91' + d;
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d[2])) return '+' + d;
  if (d.length === 11 && d.startsWith('0')  && /^[6-9]/.test(d[1])) return '+91' + d.slice(1);
  return null;
}

function makeSalesOrderId(date: string, customerName: string): string {
  return `${date}-${customerName.trim().replace(/\s+/g, '-')}`;
}

async function sbFetch(path: string, opts?: RequestInit) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${path}`;
  const res  = await fetch(url, { ...opts, headers: { ...sbHeaders(), ...(opts?.headers as any) } });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function fetchKnownPhones(): Promise<Map<string, string>> {
  const res  = await sbFetch('customer_phones?select=customer_name,phone_number');
  const rows = await res.json() as Array<{ customer_name: string; phone_number: string }>;
  const map  = new Map<string, string>();
  for (const r of rows) map.set(r.customer_name.toLowerCase().trim(), r.phone_number);
  return map;
}

async function fetchExistingKeys(date: string): Promise<Set<string>> {
  const res  = await sbFetch(`operations?invoice_date=eq.${date}&select=sales_order_id,item_name`);
  const rows = await res.json() as Array<{ sales_order_id: string; item_name: string }>;
  return new Set(rows.map(r => `${r.sales_order_id}||${r.item_name}`));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { records, phones = {}, newCustomers = [], newItems = [] } = await req.json();

    if (!records?.length) {
      return new Response(
        JSON.stringify({ error: 'No records provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // ── Phone resolution ──────────────────────────────────────────────────────
    const phoneMap   = await fetchKnownPhones();
    const newPhones: Array<{ customer_name: string; phone_number: string; label: string }> = [];
    const missing:   string[] = [];

    const uniqueCustomers = [...new Set((records as any[]).map((r: any) => (r.customer_name as string).trim()))];

    for (const name of uniqueCustomers) {
      const key      = name.toLowerCase();
      let   phone    = phoneMap.get(key) ?? null;
      const supplied = phones[name] ?? phones[key] ?? null;

      if (supplied) {
        const norm = normalizePhone(supplied);
        if (norm) {
          phone = norm;
          newPhones.push({ customer_name: name, phone_number: norm, label: 'primary' });
        }
      }

      if (!phone) missing.push(name);
      else phoneMap.set(key, phone);
    }

    if (missing.length) {
      return new Response(
        JSON.stringify({ missingPhones: missing }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Save any new phones to customer_phones
    if (newPhones.length) {
      await sbFetch('customer_phones?on_conflict=customer_name,phone_number', {
        method:  'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(newPhones),
      });
    }

    const uploadDate = (records as any[])[0].invoice_date as string;
    const existingKeys = await fetchExistingKeys(uploadDate);

    // ── Separate new vs duplicate items ───────────────────────────────────────
    const newOps:  any[] = [];
    const heldIds: string[] = [];

    for (const r of records as any[]) {
      const name         = (r.customer_name as string).trim();
      const salesOrderId = makeSalesOrderId(uploadDate, name);
      const key          = `${salesOrderId}||${r.item_name}`;

      const base = {
        sales_order_id:     salesOrderId,
        invoice_date:       uploadDate,
        customer_name:      name,
        community:          r.community ?? null,
        item_name:          r.item_name,
        description:        r.description ?? null,
        requested_quantity: parseFloat(r.requested_quantity) || 0,
        unit_price:         r.unit_price ? parseFloat(r.unit_price) : null,
      };

      if (existingKeys.has(key)) {
        heldIds.push(key);
      } else {
        newOps.push({ ...base, status: 'draft' });
      }
    }

    if (newOps.length) {
      await sbFetch('operations', {
        method:  'POST',
        headers: { Prefer: 'return=minimal' },
        body:    JSON.stringify(newOps),
      });
    }

    // Mark draft duplicates as 'held' (don't touch rows already being packed)
    for (const key of heldIds) {
      const [soid, itemName] = key.split('||');
      await sbFetch(
        `operations?sales_order_id=eq.${soid}&item_name=eq.${encodeURIComponent(itemName)}&status=eq.draft`,
        { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'held' }) },
      );
    }

    // ── Upsert orders header rows (one per customer) ──────────────────────────
    const customerSet = new Map<string, any>();
    for (const r of records as any[]) {
      const name = (r.customer_name as string).trim();
      if (!customerSet.has(name)) {
        const salesOrderId = makeSalesOrderId(uploadDate, name);
        const phone        = phoneMap.get(name.toLowerCase());
        customerSet.set(name, {
          sales_order_id: salesOrderId,
          customer_name:  name,
          community:      r.community ?? null,
          phone:          phone ? phone.replace('+91', '') : null,
          order_date:     uploadDate,
          source:         'manual',
          payment_method: 'cod',
          invoice_date:   uploadDate,
          invoice_status: 'pending',
        });
      }
    }

    const orderRows = [...customerSet.values()];
    if (orderRows.length) {
      await sbFetch('orders?on_conflict=sales_order_id', {
        method:  'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(orderRows),
      });
    }

    // Best-effort: update master tables for autocomplete
    if (newCustomers.length || newItems.length) {
      await Promise.allSettled([
        newCustomers.length && sbFetch('customer_master?on_conflict=name', {
          method:  'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body:    JSON.stringify(
            (newCustomers as string[]).filter(Boolean).map(n => ({ name: n.trim(), source: 'manual' })),
          ),
        }),
        newItems.length && sbFetch('item_master?on_conflict=name', {
          method:  'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body:    JSON.stringify(
            (newItems as any[]).filter(i => i?.name).map(i => ({ name: i.name.trim(), unit: i.unit ?? '', source: 'manual' })),
          ),
        }),
      ]);
    }

    return new Response(
      JSON.stringify({ inserted: newOps.length, held: heldIds.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
