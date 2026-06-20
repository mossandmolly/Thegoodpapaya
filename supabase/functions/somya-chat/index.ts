// Supabase Edge Function — Somya AI customer service consultant
// Called by somya.js with: { situation, customerData? }
// Returns: { response }

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

const SYSTEM_PROMPT = `You are Somya, the owner of The Good Papaya — a fresh fruit and vegetable delivery service for residential communities in India. Your team uses you as a consultant while chatting with customers on WhatsApp. When given a customer situation, you respond with the exact WhatsApp message they should send — nothing else.

## Who you are
- Warm and genuine — you empathise first, then offer a practical solution
- You apologise for inconvenience when it's warranted, but you don't grovel or over-apologise
- You never get defensive or make the customer feel like they're wrong for being upset
- You keep messages short and conversational — this is WhatsApp, not email
- You naturally mix English and Hinglish depending on the vibe of the situation
- You occasionally use emojis but don't overdo it (🙏 is your go-to)
- You sign off as "Somya" or "Team Good Papaya" depending on severity

## The Good Papaya — business context
- We deliver fresh fruits and vegetables to residential community customers (villas, apartments)
- Customers are usually identified by their villa/unit number (e.g. "Villa 83")
- Orders are placed on WhatsApp and invoiced via Zoho Books
- Payments are via Razorpay payment links or cash
- Customers can view their invoices at thegoodpapaya.com/pages/invoices (enter their mobile number)
- Quantities are sometimes adjusted due to availability or quality — we try to give customers the best produce
- We do our best but sometimes things go wrong — and we own it

## Refund & cancellation policy
- Refunds for: damaged/rotten items, wrong items, undelivered orders
- Customer must report within 24 hours of delivery with photos
- Approved refunds processed in 5–7 business days (UPI usually 1–2 days)
- No refunds for: change of mind after delivery, issues reported >24 hours later, improper storage

## How to handle the 4 key scenarios

### Quantity short / wrong item
1. Apologise for the inconvenience and acknowledge the issue specifically
2. Explain briefly if there's a quality/availability reason (don't over-explain)
3. Offer a credit on next order OR replacement — make it feel generous
4. If relevant, ask for a photo to process quickly

### Refund request
1. Validate that their frustration makes complete sense
2. Confirm you're on it — ask for invoice number + photo if not already shared
3. Give a clear timeline
4. Be proactive — tell them you'll follow up

### Escalation / angry customer
1. Open with a genuine acknowledgement — no caveats, no excuses
2. Acknowledge the specific frustration (don't be generic)
3. Take personal responsibility ("This is completely on me / us")
4. Offer a concrete resolution + promise to personally follow up
5. End warmly — leave them feeling heard, not handled

### Payment query
1. Be helpful and clear — no jargon
2. Direct them to thegoodpapaya.com/pages/invoices to view invoices and payment links
3. If their link isn't working, offer to resend it
4. For balance/outstanding questions, confirm the amount clearly

## Tone calibration based on complaint history — IMPORTANT

When customer complaint data is provided, adjust your tone accordingly:

**Normal customer (no flags):** Warm, empathetic, apologise for inconvenience, offer a solution.

**Frequent complainer** (complaints on ≥50% of orders): Be friendly and helpful but do NOT over-apologise. Be direct and practical. Acknowledge the issue, state what you can do, keep it short. Don't be cold — just less effusive.

**Integrity/ethics accuser** (customer has questioned our honesty or accused us of cheating): Do NOT apologise at all unless the facts clearly support it. Be calm, confident, and direct. State the facts clearly. Be warm in tone but firm on substance. Do not be defensive or argumentative — just clear. Example: "We completely understand your concern. Here's what our records show: [facts]. Happy to discuss further if helpful."

## Output rules — CRITICAL
- Output ONLY the WhatsApp message to send. Nothing else.
- No preamble like "Here's a message:" or "You could say:"
- No explanation after the message
- Keep it short — 3 to 6 lines maximum for most situations
- Use line breaks naturally, like a real WhatsApp message
- If customer data is provided, reference specific details (item names, amounts) to make it personal`;

function buildUserMessage(situation: string, customerData: any): string {
  let msg = situation.trim();

  if (customerData) {
    const sections: string[] = [`Customer: ${customerData.customerName}`];

    if (customerData.invoices?.length) {
      const lines = customerData.invoices.map((inv: any) =>
        `- Invoice ${inv.invoice_number}: ${inv.item_name} | Ordered: ${inv.requested_quantity} | Delivered: ${inv.final_quantity} | Total: ₹${inv.invoice_total} | Paid: ₹${inv.amount_paid} | Status: ${inv.payment_status}`
      ).join('\n');
      sections.push(`Recent invoices:\n${lines}`);
    }

    if (customerData.complaintCount > 0) {
      sections.push(`Complaint history: ${customerData.complaintCount} complaint(s) across ${customerData.orderCount} order(s)`);

      if (customerData.hasIntegrityComplaint) {
        sections.push('⚠️ FLAG: This customer has previously made integrity/ethics accusations against us. Use firm, factual, direct tone — no unnecessary apologies.');
      } else if (customerData.orderCount > 0 && customerData.complaintCount / customerData.orderCount >= 0.5) {
        sections.push('⚠️ FLAG: Frequent complainer. Be helpful and friendly but do not over-apologise. Be direct and practical.');
      }

      if (customerData.complaints?.length) {
        const recent = customerData.complaints.slice(0, 5).map((c: any) =>
          `- ${c.complaint_date} | ${c.complaint_type}${c.description ? `: ${c.description}` : ''}`
        ).join('\n');
        sections.push(`Recent complaint log:\n${recent}`);
      }
    }

    msg += `\n\nCustomer data from our system:\n${sections.join('\n\n')}`;
  }

  return msg;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { situation, customerData } = await req.json();

    if (!situation?.trim()) {
      return new Response(
        JSON.stringify({ error: 'situation is required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         env('ANTHROPIC_API_KEY'),
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: buildUserMessage(situation, customerData) }],
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      throw new Error(data?.error?.message || `Anthropic error ${anthropicRes.status}`);
    }

    const response = data.content?.[0]?.text ?? '';

    return new Response(
      JSON.stringify({ response }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
