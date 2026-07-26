// Supabase Edge Function — parse WhatsApp screenshot images, live listener text, or voice/text orders
// POST { images: [{data, media_type}], date? }              → image mode
// POST { messages: [{sender, phone, text, timestamp}], date? } → live text mode (WhatsApp listener)
// POST { text, date? }                                        → text mode (ops voice/typed entry)

function env(key: string, fallback?: string): string {
  return Deno.env.get(key) ?? fallback ?? '';
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const ITEM_NAMES = [
  "Mandarin orange","Rose apple","Avocado","Gala apple","Royal Gala apple",
  "Pear","Pomegranate large","Blueberry","Guava white","Kiwi green","Muskmelon",
  "Papaya","Badami mango","Yelakki banana","Watermelon","Pineapple","Amla",
  "Washington apple","Dragon red","Green apple","Plum","Robusta banana",
  "Red globe grapes","White dragon","Mosambi","Nati guava","Pomegranate medium",
  "Pink lady apple","Guava pink","Nagpur orange","Red seedless grapes","Longan",
  "Kiwi gold","Sapota","Kinnow orange","Raspberry","Green grapes",
  "Black seedless grapes","Watermelon striped","Muskmelon striped","Totapuri mango",
  "Passion fruit","Banganapalli mango","Pomegranate organic","Watermelon organic",
  "Yelakki banana organic","Alphonso mango","Muskmelon organic","Sapota organic",
  "Avocado local","Sindhura mango","Imampasand mango","Jackfruit","Valencia orange",
  "Raw mango","Lychee","Mangosteen","Malgova mango","Malika mango","Jamun",
  "Kesar mango","Benishan mango","Langra mango","Cherry Indian","Dasheri mango",
  "Jamun flash","Rockit apple","Peach","Strawberry","Coconut","Custard apple"
];

const PC_TO_KG: Record<string,number> = {
  "apple":0.20,"gala apple":0.20,"royal gala apple":0.20,"washington apple":0.20,
  "green apple":0.20,"pink lady apple":0.20,"rockit apple":0.20,"rose apple":0.20,
  "guava":0.40,"guava white":0.40,"guava pink":0.40,"nati guava":0.40,
  "yelakki banana":0.10,"yelakki banana organic":0.10,"robusta banana":0.20,
  "pomegranate":0.35,"pomegranate large":0.35,"pomegranate medium":0.35,"pomegranate organic":0.35,
  "pear":0.16,"mandarin orange":0.10,"valencia orange":0.25,"plum":0.05,"peach":0.15,
  "mango":0.50,"kesar mango":0.50,"langra mango":0.50,"banganapalli mango":0.50,
  "alphonso mango":0.50,"badami mango":0.50,"dasheri mango":0.50,"totapuri mango":0.50,
  "sindhura mango":0.50,"malika mango":0.50,"malgova mango":0.50,"benishan mango":0.50,"imampasand mango":0.50
};

function todayIST(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function buildImageSystemPrompt(today: string): string {
  return `You are an order parser for Good Papaya, a fresh produce delivery business in Bengaluru. Parse WhatsApp group screenshots into structured order rows.

TODAY: ${today}

CANONICAL ITEM NAMES — match input to EXACTLY one of these:
${ITEM_NAMES.join(', ')}

PIECE TO KG CONVERSIONS:
${Object.entries(PC_TO_KG).map(([k,v]) => `${k}=${v}kg/pc`).join(', ')}

ALIASES:
mini orange/mini orange sweet/sweet orange → Mandarin orange
yellaki/yellakki/yalakki/yalaki/elaichi banana/elachi banana/banana → Yelakki banana
langda/langdaa/langra → Langra mango
kesar → Kesar mango, alphonso → Alphonso mango, dasheri → Dasheri mango, badami → Badami mango
beganpalli/baganpalli/pedanpally → Banganapalli mango
cherry sweet/cherry → Cherry Indian
jamun big/jamun small → Jamun (qualifier to description)
grapes → Green grapes, litchi → Lychee, sweet lime → Mosambi, rocket apple → Rockit apple
watermelon medium/small/large → Watermelon (qualifier to description)

RULES:
1. customer_name = bold/colored sender name at top of each bubble including flat/door number
2. IGNORE lines with: complaint, photo, delivery, replacement, dry, not fresh, late, sorry, refund, missing, damaged, cancel, wrong, issue, feedback, 👍, 🙏
3. IGNORE non-order messages
4. item_name = ONLY base fruit name from canonical list, no qualifiers
5. description = qualifier words only (big, small, medium, large, sweet, organic, raw etc.)
6. Quantity: stated in kg/g → convert to kg (500g=0.5). Plain number or Npc → multiply by kg/pc if in table, add "assumed N pieces" to description. No qty → use 1, flag it.
7. sales_order = ${today}-CustomerNameNoSpaces
8. final_quantity and status = always empty string
9. plain "mango" with no variety = flag, use item_name "Mango"
10. plain "grapes" = Green grapes

Respond ONLY with valid JSON, no markdown:
{"rows":[{"order_date":"${today}","customer_name":"","item_name":"","description":"","quantity":0,"final_quantity":"","status":"","sales_order":""}],"flags":[]}`;
}

// Same canonical item list / aliases / pc-to-kg / ignore-rules as the image parser above,
// adapted for live WhatsApp text messages (from the group listener) instead of screenshots.
// The sender name is already known from WhatsApp metadata, so unlike the image prompt we
// don't need Claude to guess it from a bold/colored name in a chat bubble.
function buildLiveTextSystemPrompt(today: string): string {
  return `You are an order parser for Good Papaya, a fresh produce delivery business in Bengaluru. Parse live WhatsApp group messages into structured order rows.

TODAY: ${today}

Each line below is tagged "SenderName: message text" — SenderName is the real WhatsApp sender name (already includes flat/door number where the customer set that as their display name).

CANONICAL ITEM NAMES — match input to EXACTLY one of these:
${ITEM_NAMES.join(', ')}

PIECE TO KG CONVERSIONS:
${Object.entries(PC_TO_KG).map(([k,v]) => `${k}=${v}kg/pc`).join(', ')}

ALIASES:
mini orange/mini orange sweet/sweet orange → Mandarin orange
yellaki/yellakki/yalakki/yalaki/elaichi banana/elachi banana/banana → Yelakki banana
langda/langdaa/langra → Langra mango
kesar → Kesar mango, alphonso → Alphonso mango, dasheri → Dasheri mango, badami → Badami mango
beganpalli/baganpalli/pedanpally → Banganapalli mango
cherry sweet/cherry → Cherry Indian
jamun big/jamun small → Jamun (qualifier to description)
grapes → Green grapes, litchi → Lychee, sweet lime → Mosambi, rocket apple → Rockit apple
watermelon medium/small/large → Watermelon (qualifier to description)

RULES:
1. customer_name = the SenderName tag on each line, used exactly as given — do not reformat, guess, or invent a name
2. Consecutive lines with the SAME SenderName tag are one order — combine all their item lines into that customer's order, the same way multiple lines under one WhatsApp chat bubble would be combined
3. IGNORE lines with: complaint, photo, delivery, replacement, dry, not fresh, late, sorry, refund, missing, damaged, cancel, wrong, issue, feedback, 👍, 🙏
4. IGNORE non-order messages (greetings, chit-chat, admin notices)
5. item_name = ONLY base fruit name from canonical list, no qualifiers
6. description = qualifier words only (big, small, medium, large, sweet, organic, raw etc.)
7. Quantity: stated in kg/g → convert to kg (500g=0.5). Plain number or Npc → multiply by kg/pc if in table, add "assumed N pieces" to description. No qty → use 1, flag it.
8. sales_order = ${today}-CustomerNameNoSpaces
9. final_quantity and status = always empty string
10. plain "mango" with no variety = flag, use item_name "Mango"
11. plain "grapes" = Green grapes

Respond ONLY with valid JSON, no markdown:
{"rows":[{"order_date":"${today}","customer_name":"","item_name":"","description":"","quantity":0,"final_quantity":"","status":"","sales_order":""}],"flags":[]}`;
}

const TEXT_PARSE_SYSTEM = `You are an order entry assistant for The Good Papaya, a fresh fruit and vegetable delivery service in India.

You will receive:
1. A list of active products from the Zoho catalog (use this as the definitive source of item names)
2. Natural language text describing orders for the day — spoken or typed by the ops team

Your job is to extract structured order line items and map each item to the CLOSEST match in the catalog.

Critical matching rules:
- Qualifiers matter: "white guava" ≠ "latte guava" ≠ "pink guava" — pick the right one
- "Kesar mango" ≠ "Alphonso mango" ≠ "Banginapalli mango" — do not merge varieties
- If you genuinely cannot tell which catalog item is meant, pick the closest and set confidence to "low"
- Use the EXACT catalog name in item_name — never invent names

Return ONLY a raw JSON object (no markdown fences, no explanation):
{
  "orders": [
    {
      "customer_name": "as spoken/written e.g. Villa 83, B-12, Sharma",
      "item_name": "exact name from catalog",
      "requested_quantity": 2.5,
      "unit": "kg or piece or dozen or box etc.",
      "matched_confidence": "high|medium|low",
      "match_note": "brief note only when confidence is medium or low, else empty string"
    }
  ]
}

Rules:
- One entry per customer–item pair
- If a customer mentions the same item twice, combine into one entry
- If quantity is unclear, use 1
- If customer is unclear, use "Unknown"
- matched_confidence: high = obvious match, medium = reasonable but uncertain, low = guessing`;

async function fetchZohoItems(): Promise<{ name: string; unit: string }[]> {
  const clientId     = env('ZOHO_CLIENT_ID');
  const clientSecret = env('ZOHO_CLIENT_SECRET');
  const refreshToken = env('ZOHO_REFRESH_TOKEN');
  const orgId        = env('ZOHO_ORG_ID');
  if (!clientId || !clientSecret || !refreshToken || !orgId) return [];
  const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'refresh_token', client_id:clientId, client_secret:clientSecret, refresh_token:refreshToken }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return [];
  const itemsRes = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&status=active&per_page=200`,
    { headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` } }
  );
  const itemsData = await itemsRes.json();
  return (itemsData.items ?? []).map((i: any) => ({ name: i.name, unit: i.unit ?? '' }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const body = await req.json();
    const today = body.date || todayIST();
    const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY');

    // ── IMAGE MODE ──────────────────────────────────────────────────────────
    if (body.images && Array.isArray(body.images) && body.images.length > 0) {
      const imageBlocks = body.images.map((img: any) => ({
        type: "image",
        source: { type: "base64", media_type: img.media_type || "image/jpeg", data: img.data }
      }));

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: buildImageSystemPrompt(today),
          messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: 'Parse all orders from these screenshots. Return only JSON.' }] }]
        }),
      });

      const aiData = await anthropicRes.json();
      if (!anthropicRes.ok) throw new Error(aiData?.error?.message ?? `Anthropic error ${anthropicRes.status}`);

      const raw = aiData.content?.[0]?.text ?? '{}';
      let parsed: any;
      try { parsed = JSON.parse(raw); }
      catch (_) { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { rows: [], flags: [] }; }

      return new Response(JSON.stringify(parsed), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── LIVE TEXT MODE (WhatsApp group listener) ────────────────────────────
    // POST { messages: [{ sender, phone, text, timestamp }], date?, groupName? }
    // Same canonical item list / aliases / pc-to-kg table / ignore-rules as image mode.
    if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
      const lines = body.messages
        .map((m: any) => `${(m.sender ?? 'Unknown').toString().trim()}: ${(m.text ?? '').toString().trim()}`)
        .filter((l: string) => l.length > 0)
        .join('\n');

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: buildLiveTextSystemPrompt(today),
          messages: [{ role: 'user', content: `Parse all orders from these live WhatsApp messages. Return only JSON.\n\n${lines}` }]
        }),
      });

      const aiData = await anthropicRes.json();
      if (!anthropicRes.ok) throw new Error(aiData?.error?.message ?? `Anthropic error ${anthropicRes.status}`);

      const raw = aiData.content?.[0]?.text ?? '{}';
      let parsed: any;
      try { parsed = JSON.parse(raw); }
      catch (_) { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { rows: [], flags: [] }; }

      return new Response(JSON.stringify(parsed), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // ── TEXT MODE (existing behaviour) ──────────────────────────────────────
    const { text } = body;
    if (!text?.trim()) {
      return new Response(JSON.stringify({ error: 'text or images required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    let zohoItems: { name: string; unit: string }[] = [];
    try { zohoItems = await fetchZohoItems(); } catch (e: any) { console.error('Zoho fetch failed:', e.message); }

    const catalogSection = zohoItems.length
      ? `Active product catalog (${zohoItems.length} items):\n${zohoItems.map(i => `- ${i.name}${i.unit ? ` (${i.unit})` : ''}`).join('\n')}`
      : 'No product catalog available — use your best judgment for item names.';

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: TEXT_PARSE_SYSTEM,
        messages: [{ role: 'user', content: `${catalogSection}\n\nOrder text to parse:\n"${text.trim()}"` }],
      }),
    });

    const aiData = await anthropicRes.json();
    if (!anthropicRes.ok) throw new Error(aiData?.error?.message ?? `Anthropic error ${anthropicRes.status}`);

    const raw = aiData.content?.[0]?.text ?? '{}';
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch (_) { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { orders: [] }; }

    const batchId = `VOICE-${today}-${Date.now()}`;
    const orders = (parsed.orders ?? []).map((o: any) => ({
      sales_order_id: batchId, invoice_date: today,
      customer_name: (o.customer_name ?? 'Unknown').trim(),
      item_name: (o.item_name ?? '').trim(),
      requested_quantity: parseFloat(o.requested_quantity) || 1,
      description: text.trim(), status: 'draft',
      _confidence: o.matched_confidence ?? 'high',
      _match_note: o.match_note ?? '',
    }));

    return new Response(JSON.stringify({ orders, zohoItemCount: zohoItems.length }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
