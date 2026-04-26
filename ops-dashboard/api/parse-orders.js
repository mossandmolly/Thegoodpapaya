import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PARSE_SYSTEM = `You are an order entry assistant for The Good Papaya, a fresh fruit and vegetable delivery service in India.

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

async function fetchZohoItems() {
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !ZOHO_ORG_ID) return [];

  const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error('Zoho token error:', tokenData);
    return [];
  }

  const itemsRes = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${ZOHO_ORG_ID}&status=active&per_page=200`,
    { headers: { Authorization: `Zoho-oauthtoken ${tokenData.access_token}` } }
  );
  const itemsData = await itemsRes.json();
  return (itemsData.items || []).map(i => ({ name: i.name, unit: i.unit || '' }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, date } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });

  let zohoItems = [];
  try {
    zohoItems = await fetchZohoItems();
  } catch (e) {
    console.error('Zoho fetch failed:', e.message);
  }

  const catalogSection = zohoItems.length
    ? `Active product catalog (${zohoItems.length} items):\n${zohoItems.map(i => `- ${i.name}${i.unit ? ` (${i.unit})` : ''}`).join('\n')}`
    : 'No product catalog available — use your best judgment for item names.';

  const userMsg = `${catalogSection}\n\nOrder text to parse:\n"${text.trim()}"`;

  try {
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     PARSE_SYSTEM,
      messages:   [{ role: 'user', content: userMsg }],
    });

    const raw = msg.content[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { orders: [] };
    }

    const today   = date || new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    const batchId = `VOICE-${today}-${Date.now()}`;

    const orders = (parsed.orders || []).map(o => ({
      sales_order_id:     batchId,
      invoice_date:       today,
      customer_name:      (o.customer_name || 'Unknown').trim(),
      item_name:          (o.item_name     || '').trim(),
      requested_quantity: parseFloat(o.requested_quantity) || 1,
      description:        text.trim(),
      status:             'draft',
      _confidence:        o.matched_confidence || 'high',
      _match_note:        o.match_note || '',
    }));

    return res.status(200).json({ orders, zohoItemCount: zohoItems.length });
  } catch (e) {
    console.error('Claude parse error:', e);
    return res.status(500).json({ error: 'Failed to parse orders' });
  }
}
