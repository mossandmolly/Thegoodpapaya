// Supabase Edge Function — insert manually entered orders into operations
// Looks up phone numbers for all customers; returns { missingPhones } if any absent.
// Accepts optional phones map on resubmit; saves new phones to customers table.

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

async function fetchAllPhones(): Promise<Map<string, string>> {
  const url = `${env('SUPABASE_URL')}/rest/v1/customers?select=customer_name,phone_number`;
  const res  = await fetch(url, { headers: sbHeaders() });
  const rows = res.ok ? await res.json() : [];
  const map  = new Map<string, string>();
  for (const r of rows) map.set((r.customer_name as string).toLowerCase().trim(), r.phone_number);
  return map;
}

async function sbUpsert(table: string, rows: any[], onConflict: string) {
  if (!rows.length) return;
  await fetch(`${env('SUPABASE_URL')}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method:  'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { records, phones = {}, newCustomers = [], newItems = [] } = await req.json();

    if (!records?.length) {
      return new Response(
        JSON.stringify({ error: 'No records provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Phone resolution ──────────────────────────────────────
    const phoneMap   = await fetchAllPhones();
    const newEntries: { customer_name: string; phone_number: string }[] = [];
    const missing:    string[] = [];

    const uniqueCustomers = [...new Set((records as any[]).map(r => (r.customer_name as string).trim()))];

    for (const name of uniqueCustomers) {
      const key      = name.toLowerCase();
      let   phone    = phoneMap.get(key) ?? null;

      const supplied = phones[name] ?? phones[key] ?? null;
      if (supplied) {
        const norm = normalizePhone(supplied);
        if (norm) {
          phone = norm;
          newEntries.push({ customer_name: name, phone_number: norm });
        }
      }

      if (!phone) missing.push(name);
      else phoneMap.set(key, phone);
    }

    if (missing.length) {
      return new Response(
        JSON.stringify({ missingPhones: missing }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Save new phones to customers table
    await sbUpsert('customers', newEntries, 'customer_name');

    // Attach phone to every record
    const enriched = (records as any[]).map(r => ({
      ...r,
      phone_number: phoneMap.get((r.customer_name as string).toLowerCase().trim()),
    }));

    // Insert orders
    const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/operations`, {
      method:  'POST',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body:    JSON.stringify(enriched),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Insert failed: ${res.status}`);

    // Save new master entries (best effort)
    await Promise.allSettled([
      sbUpsert('customer_master',
        (newCustomers as string[]).filter(Boolean).map(n => ({ name: n.trim(), source: 'manual' })), 'name'),
      sbUpsert('item_master',
        (newItems as any[]).filter(i => i?.name).map(i => ({ name: i.name.trim(), unit: i.unit ?? '', source: 'manual' })), 'name'),
    ]);

    return new Response(
      JSON.stringify({ inserted: enriched.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
