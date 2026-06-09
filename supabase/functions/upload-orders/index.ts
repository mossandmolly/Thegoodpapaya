// Supabase Edge Function — secure orders CSV upload
// Verifies admin password server-side before inserting.
// Looks up phone numbers for all customers; if any are missing,
// returns { missingPhones: [...] } so the frontend can prompt the user.
// Accepts optional phones map { customerName: phoneNumber } on resubmit.

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

async function upsertCustomers(entries: { customer_name: string; phone_number: string }[]) {
  if (!entries.length) return;
  await fetch(`${env('SUPABASE_URL')}/rest/v1/customers?on_conflict=customer_name`, {
    method:  'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(entries),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { password, records, phones = {} } = await req.json();

    if (!password || password !== env('ADMIN_PASSWORD')) {
      return new Response(
        JSON.stringify({ error: 'Wrong password' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

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

      // Check if caller supplied a phone for this customer
      const supplied = phones[name] ?? phones[key] ?? null;
      if (supplied) {
        const norm = normalizePhone(supplied);
        if (norm) {
          phone = norm;
          if (!phoneMap.has(key)) newEntries.push({ customer_name: name, phone_number: norm });
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

    // Upsert any newly provided phones
    await upsertCustomers(newEntries);

    // Attach phone_number to every record
    const enriched = (records as any[]).map(r => ({
      ...r,
      phone_number: phoneMap.get((r.customer_name as string).toLowerCase().trim()),
    }));

    const supabaseUrl = env('SUPABASE_URL');
    const uploadDate  = enriched[0].invoice_date;

    const delRes = await fetch(
      `${supabaseUrl}/rest/v1/operations?invoice_date=eq.${uploadDate}`,
      { method: 'DELETE', headers: sbHeaders() }
    );
    if (!delRes.ok) throw new Error(`Delete failed: ${await delRes.text()}`);

    const insRes = await fetch(
      `${supabaseUrl}/rest/v1/operations`,
      { method: 'POST', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' }, body: JSON.stringify(enriched) }
    );
    if (!insRes.ok) throw new Error(`Insert failed: ${await insRes.text()}`);

    return new Response(
      JSON.stringify({ inserted: enriched.length, date: uploadDate }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
