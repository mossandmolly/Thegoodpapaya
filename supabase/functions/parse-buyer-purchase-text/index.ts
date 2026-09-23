// Supabase Edge Function — parse-buyer-purchase-text
//
// Parses the buyer's informal daily purchase report (a WhatsApp-style
// message listing what was bought, how much, and what it cost — often with
// a stray transport/loading cost line mixed in) into structured rows the
// Purchases tab can diff against what's already logged in stock_purchases/
// daily_expenses for the day.
//
// Input:  { text: string }
// Output: { purchases: [{item_name, qty, unit, cost}], expenses: [{category, description, amount}] }
//
// item_name is normalized to the closest known catalog name where the text
// clearly means one of them (handles typos/local spellings) — left as the
// buyer's own wording if nothing matches closely, so the client-side diff
// can still show it as "not found in system" rather than silently guessing
// wrong. qty/cost/amount are numbers; cost/amount are null when the buyer's
// text didn't mention a price for that line.
//
// Required env vars: ANTHROPIC_API_KEY

function env(key: string): string {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

// Kept in sync by hand with ops-dashboard/parser.html's own FRUITS list —
// same drift-risk tradeoff already accepted for parse-orders/index.ts's
// ITEM_NAMES (used only to steer the AI's normalization, not as a strict
// allowlist, so an out-of-date entry here just means one fewer name gets
// auto-normalized, never a hard failure).
const ITEM_NAMES = [
  "Mandarin orange","Rose apple","Avocado","Gala apple","Royal Gala apple",
  "Pear","Pomegranate large","Blueberry","Guava white","Kiwi green","Muskmelon",
  "Papaya","Badami mango","Yelakki banana","Watermelon","Pineapple","Amla",
  "Washington apple","Dragon red","Green apple","Plum","Robusta banana",
  "Red globe grapes","White dragon","Mosambi","Nati guava","Pomegranate medium","Pomegranate small",
  "Pink lady apple","Guava pink","Nagpur orange","Red seedless grapes","Longan",
  "Kiwi gold","Sapota","Kinnow orange","Raspberry","Green grapes",
  "Black seedless grapes","Watermelon striped","Muskmelon striped","Totapuri mango",
  "Passion fruit","Banganapalli mango","Pomegranate organic","Watermelon organic",
  "Yelakki banana organic","Alphonso mango","Muskmelon organic","Sapota organic",
  "Avocado local","Sindhura mango","Imampasand mango","Jackfruit","Valencia orange",
  "Raw mango","Lychee","Mangosteen","Malgova mango","Malika mango","Jamun",
  "Kesar mango","Benishan mango","Langra mango","Cherry Indian","Dasheri mango",
  "Jamun flash","Rockit apple","Peach","Mango","Strawberry","Coconut","Custard apple",
  "Rambutan","Imported grapes","Neelam mango",
  "Cauliflower","Cabbage","Capsicum green","Capsicum yellow","Capsicum red","Carrot","Tomato","Ginger","Beans",
  "Lady's finger","Cucumber","Coriander","Chilli green",
  "Potato","Onion","Ridge gourd","Bitter gourd","Bottle gourd","Brinjal bottle","Broccoli",
  "Banana leaves","Spinach","Amaranthus","Fenugreek","Mangalore cucumber","Drumstick","Chilli bhajji","Coccinia","Mint",
  "Lettuce","Beetroot","Zucchini green","Zucchini yellow","Red cabbage","Mushroom","Garlic",
  "Lemon","Pumpkin","Snake gourd","Sweet potato","Radish","Baby corn","Parwal","Spine gourd",
  "Long beans","Brinjal long","Spring onion","Arvi",
];

const EXPENSE_CATEGORIES = ['Packaging', 'Housekeeping', 'Transport', 'Rent & Electricity', 'Other'];

const SYSTEM_PROMPT = `You parse a fruit/vegetable buyer's rough daily purchase report (WhatsApp text, may have typos, mixed languages, shorthand units) into structured JSON.

Known item names (normalize to the closest one if the text clearly means it — otherwise keep the buyer's own wording as-is):
${ITEM_NAMES.join(', ')}

The text may cover more than one vendor/supplier in one message (e.g. separate sections headed by a name, or a vendor's own letterhead like "The Good Papaya"). Combine every section into ONE flat list — these are all still purchases for the same day, regardless of which supplier they came from.

Two kinds of lines:
1. A fruit/vegetable purchase: item name + quantity (assume kg unless the text says "pc"/"piece"/"box" etc.) + optional cost in rupees.
2. A running expense NOT tied to a specific fruit — transport/auto fare, porter/loading-unloading labor, parking, packaging materials, etc. Categorize into exactly one of: ${EXPENSE_CATEGORIES.join(', ')} (porter/auto/parking/loading -> "Transport", use "Other" if unclear).

Skip entirely (neither a purchase nor an expense):
- Running-total, settlement, or balance-due arithmetic (e.g. "16395 - 15000 = 1,395", "45 Milaga", "Total = 12387 (Farhan payment)").
- Section headers/names with no item or amount of their own (e.g. "--- FARHAN ---", "The Good Papaya").
- Pure chit-chat with no item/quantity or expense amount.

Return ONLY this JSON shape, no prose:
{"purchases":[{"item_name":"...","qty":0,"unit":"kg","cost":0}],"expenses":[{"category":"...","description":"...","amount":0}]}

Rules:
- qty is always a number (never a string, never a range — if a range is given, use the midpoint).
- cost/amount are numbers when a price is mentioned, or null when it is not.
- Do not invent costs that aren't in the text.
- Keep the "description" field on expenses short (a few words) — the response must stay valid, complete JSON even for a long input with many lines, so don't pad it with extra commentary.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { text } = await req.json();
    if (!text?.trim()) {
      return new Response(JSON.stringify({ error: 'text is required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        // A single message can cover several vendors/dozens of line items
        // (real example: three suppliers, ~65 lines, in one paste) — 2048
        // was cutting Claude's own JSON off mid-array on inputs that size,
        // producing a hard parse failure with no usable fallback. Sized
        // generously since this is plain structured JSON, not prose.
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Buyer's text to parse:\n"${text.trim()}"` }],
      }),
    });

    const aiData = await anthropicRes.json();
    if (!anthropicRes.ok) throw new Error(aiData?.error?.message ?? `Anthropic error ${anthropicRes.status}`);

    const raw = aiData.content?.[0]?.text ?? '{}';
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      // Fallback for when Claude wraps the JSON in a little prose despite
      // being told not to — NOT a fix for genuine truncation (a response
      // cut off mid-array is still invalid JSON after this regex), so this
      // itself is wrapped rather than left to throw a raw, cryptic
      // "Expected ',' or ']'"-style parser error straight at the user.
      const m = raw.match(/\{[\s\S]*\}/);
      try { parsed = m ? JSON.parse(m[0]) : { purchases: [], expenses: [] }; }
      catch (_e) {
        throw new Error('The AI response was too long or got cut off (a very large paste — many vendors/lines at once — is the usual cause). Try splitting the text into smaller chunks and comparing each separately.');
      }
    }

    const purchases = (parsed.purchases ?? []).map((p: any) => ({
      item_name: (p.item_name ?? '').trim(),
      qty: parseFloat(p.qty) || 0,
      unit: p.unit || 'kg',
      cost: p.cost != null && p.cost !== '' ? parseFloat(p.cost) : null,
    })).filter((p: any) => p.item_name && p.qty > 0);

    const expenses = (parsed.expenses ?? []).map((e: any) => ({
      category: EXPENSE_CATEGORIES.includes(e.category) ? e.category : 'Other',
      description: (e.description ?? '').trim() || null,
      amount: parseFloat(e.amount) || 0,
    })).filter((e: any) => e.amount > 0);

    return new Response(JSON.stringify({ purchases, expenses }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
