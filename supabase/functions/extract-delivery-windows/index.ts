// Supabase Edge Function — extract-delivery-windows
//
// Triggered every 20 minutes by pg_cron (see migration
// 163_extract_delivery_windows_cron.sql) — no logged-in-user session, just
// the shared x-cron-secret, same pattern as auto-invoice-final-orders.
//
// place-order saves a customer's checkout delivery note verbatim onto
// order_items.delivery_instructions, synchronously, with zero added
// latency. Turning that free text into a structured deliver_by/
// deliver_after deadline needs an LLM call, which this cron does entirely
// off the checkout request's lifetime — nothing on the client side, and
// nothing tied to any individual request's lifetime (no
// EdgeRuntime.waitUntil) — it just sweeps for anything not yet looked at.
//
// Most notes never mention a time at all ("no onions", "ring the bell
// twice") — see hasTimeSignal below, which skips the Claude call entirely
// for any note with no digit and no "noon"/"midnight" in it, since those
// are the only ways a clock time can appear in English. That's most
// notes, most of the time, so it's most of the Claude calls this
// function would otherwise make.
//
// orders.delivery_window_checked_at (migration 162) marks an order as
// already looked at — set the moment a Claude call for it succeeds,
// whether or not it actually found a time, so a note with no deadline in
// it doesn't get re-sent to Claude every single run forever. Left null on
// a failed Claude call so that order is simply retried on the next run.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, ANTHROPIC_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret',
};

// An order still unchecked after this long is a backlog item, not
// something this cron should keep burning Claude calls scanning for on
// every single run forever — same bounding rule auto-invoice-final-orders
// applies to its own scan.
const LOOKBACK_HOURS = 48;

const DELIVERY_WINDOW_SYSTEM_PROMPT = `You read a customer's free-text delivery note for a grocery order and extract any delivery deadline they stated.

Return ONLY this JSON, no prose:
{"deliver_by":"HH:MM"|null,"deliver_after":"HH:MM"|null}

Rules:
- deliver_by is the LATEST time the order should arrive ("by 4pm", "before 6", "no later than 5:30").
- deliver_after is the EARLIEST time the order should arrive ("after 6pm", "not before 11am", "only after 2").
- "between X and Y" sets deliver_after to X and deliver_by to Y.
- Use 24-hour "HH:MM". If no am/pm is stated and the hour is 1-7, assume PM (a same-day grocery delivery note saying "by 4" means 4pm, never 4am). Hours 8-12 are already unambiguous. "noon" is 12:00, "midnight" is 00:00.
- Vague time-of-day words with no actual clock time ("evening", "tonight", "morning", "ASAP", "soon") are NOT a deadline — only extract when a specific time is actually given.
- If the text states no delivery-time deadline at all (e.g. "no onions please", "ring the bell twice", "leave at the gate"), return {"deliver_by":null,"deliver_after":null}.
- Never invent a time that isn't actually stated or clearly implied.`;

function asHHMM(v: any): string | null {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null;
}

async function extractDeliveryWindow(notes: string): Promise<{ deliver_by: string | null; deliver_after: string | null }> {
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: DELIVERY_WINDOW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Delivery note:\n"${notes.trim()}"` }],
    }),
  });
  const aiData = await anthropicRes.json();
  if (!anthropicRes.ok) throw new Error(aiData?.error?.message ?? `Anthropic error ${anthropicRes.status}`);

  const raw = aiData.content?.[0]?.text ?? '{}';
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }
  return { deliver_by: asHHMM(parsed.deliver_by), deliver_after: asHHMM(parsed.deliver_after) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const { data: orders, error: ordersErr } = await supabase
      .from('orders').select('sales_order_id')
      .is('delivery_window_checked_at', null)
      .gte('created_at', since);
    if (ordersErr) throw new Error(ordersErr.message);

    const candidateIds = (orders ?? []).map(o => o.sales_order_id as string);
    if (!candidateIds.length) {
      return new Response(JSON.stringify({ checked: 0, updated: [], errors: [] }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const { data: items, error: itemsErr } = await supabase
      .from('order_items').select('sales_order_id, delivery_instructions')
      .in('sales_order_id', candidateIds)
      .not('delivery_instructions', 'is', null);
    if (itemsErr) throw new Error(itemsErr.message);

    // Every item on one order shares the same checkout-level note (see
    // place-order) — one lookup per order is enough.
    const notesByOrder = new Map<string, string>();
    for (const row of items ?? []) {
      const id = row.sales_order_id as string;
      const text = ((row.delivery_instructions as string) || '').trim();
      if (text && !notesByOrder.has(id)) notesByOrder.set(id, text);
    }

    // A note can only carry a clock-time deadline if it has a digit in it
    // somewhere, or spells out "noon"/"midnight" (the only clock times
    // that don't). Everything else — empty notes, "no onions please",
    // "ring the bell twice" — gets marked checked without ever reaching
    // Claude, which is most notes most of the time.
    const hasTimeSignal = (text: string) => /\d/.test(text) || /\b(noon|midnight)\b/i.test(text);
    const toProcess = [...notesByOrder].filter(([, text]) => hasTimeSignal(text));
    const skip = candidateIds.filter(id => !notesByOrder.has(id) || !hasTimeSignal(notesByOrder.get(id)!));
    if (skip.length) {
      await supabase.from('orders')
        .update({ delivery_window_checked_at: new Date().toISOString() })
        .in('sales_order_id', skip);
    }

    const updated: string[] = [];
    const errors: Array<{ sales_order_id: string; error: string }> = [];

    for (const [salesOrderId, notes] of toProcess) {
      try {
        const { deliver_by, deliver_after } = await extractDeliveryWindow(notes);
        const { error } = await supabase.from('orders')
          .update({ deliver_by, deliver_after, delivery_window_checked_at: new Date().toISOString() })
          .eq('sales_order_id', salesOrderId);
        if (error) throw new Error(error.message);
        if (deliver_by || deliver_after) updated.push(salesOrderId);
      } catch (e: any) {
        // Left un-checked on purpose — picked up again next run instead of
        // silently losing a real deadline to a transient Claude/DB error.
        errors.push({ sales_order_id: salesOrderId, error: e.message });
      }
    }

    return new Response(
      JSON.stringify({ checked: skip.length + toProcess.length, updated, errors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
