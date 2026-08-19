// WhatsApp group listener -> Good Papaya order parser
// Read-only. Never sends. Run on a dedicated secondary number.
//
// The listener itself has no order intelligence — it just batches raw
// message text (with sender identity and reply/quote context) per group
// and forwards it to the same /.netlify/functions/parse proxy that
// parser.html's image-upload flow calls, using the exact same rules
// prompt (kept in sync with ops-dashboard/parser.html's SYS constant).
// All parsing decisions happen in that Claude call, not here.
//
// Requires Node 20+ (uses built-in fetch).
// npm install

import 'dotenv/config'
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import P from 'pino'
import fs from 'fs'

// ============== CONFIG ==============
const GROUP_JIDS = new Set(
  (process.env.GROUP_JIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
) // leave empty first run to discover group JIDs

const PARSE_FUNCTION_URL = process.env.PARSE_FUNCTION_URL || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
// Shared secret for whatsapp-create-order (same one already configured on
// the Supabase project for auto-invoice-final-orders/generate-invoice's
// cron paths) — lets the listener push parsed rows straight into real
// orders, tagged pending_review, without a logged-in user session.
const CRON_SECRET = process.env.CRON_SECRET || ''

const BATCH_WINDOW_MS = parseInt(process.env.BATCH_WINDOW_MS || '45000', 10)
const AUTH_DIR = './auth'
const LOG_FILE = './parsed-orders.log.jsonl'
// Secondary number's full phone number, digits only, country code first
// (e.g. "919876543210" for an Indian number) — when set, links via a typed
// pairing code instead of a QR scan. Skips the QR-expiry race entirely.
const PAIRING_PHONE_NUMBER = (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '')
// ====================================

const logger = P({ level: 'silent' })

// Log crashes instead of letting them die silently — a crash here means
// Railway restarts the whole container (wiping ./auth without a volume
// attached), so seeing why it happened matters.
process.on('uncaughtException', (e) => console.error('[fatal] uncaughtException:', e))
process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', e))

function todayIST() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)
}

// ── Parser rules — kept in sync with the SYS constant in ops-dashboard/parser.html ──
// Same canonical item list / aliases / pc-to-kg table / society list / rules the
// tested image-upload parser uses. If those are edited on the parser page's Config
// tab, that's session-only (resets on refresh) — these are the shared defaults both
// start from, same as a fresh browser tab would.
const SOCIETIES = ["Kew","Rohan","77degree","77 degree","Ferns","Summerfield","Krishvigavakshi","Meda","Sunnyside","Assetz","Dhavala","Espana","UberPhase1","UberPhase2","Uber","Iris","Sobha Iris","Silversun","Ascentia","Ahad","Eternia","Sobha Eternia","Kethana","SJR","SJR Redwood","Silverdale","Oak","Oak Garden","Akme","Saroj","Regalia","Jade","Ivy","SLS","SLS Sunflower","SLS Signature","80 Trees","80trees","Lakefront","Vars","Suncity","Bhuvi","Palmera","Vajram","Vaswani","DSR Parkway","DSRParkway","Sunshine Signature","SunshineSignature","Iksha","Pristine","Villa","Lotus","T4","T3","Tower","Towers"]

const FRUITS = ["Mandarin orange","Rose apple","Avocado","Gala apple","Royal Gala apple","Pear","Pomegranate large","Blueberry","Guava white","Kiwi green","Muskmelon","Papaya","Badami mango","Yelakki banana","Watermelon","Pineapple","Amla","Washington apple","Dragon red","Green apple","Plum","Robusta banana","Red globe grapes","White dragon","Mosambi","Nati guava","Pomegranate medium","Pomegranate small","Pink lady apple","Guava pink","Nagpur orange","Red seedless grapes","Longan","Kiwi gold","Sapota","Kinnow orange","Raspberry","Green grapes","Black seedless grapes","Watermelon striped","Muskmelon striped","Totapuri mango","Passion fruit","Banganapalli mango","Pomegranate organic","Watermelon organic","Yelakki banana organic","Alphonso mango","Muskmelon organic","Sapota organic","Avocado local","Sindhura mango","Imampasand mango","Jackfruit","Valencia orange","Raw mango","Lychee","Mangosteen","Malgova mango","Malika mango","Jamun","Kesar mango","Benishan mango","Langra mango","Cherry Indian","Dasheri mango","Jamun flash","Rockit apple","Peach","Mango","Strawberry","Coconut","Custard apple","Rambutan","Imported grapes","Neelam mango","Cauliflower","Cabbage","Capsicum green","Carrot","Tomato","Ginger","Beans","Lady's finger","Cucumber","Coriander","Chilli green","Potato","Onion","Ridge gourd","Bitter gourd","Bottle gourd","Brinjal bottle","Broccoli","Banana leaves","Spinach","Amaranthus"]

const PKG = {"apple":0.20,"gala apple":0.20,"royal gala apple":0.20,"washington apple":0.20,"green apple":0.20,"pink lady apple":0.20,"rockit apple":0.20,"rose apple":0.20,"guava":0.40,"guava white":0.40,"guava pink":0.40,"nati guava":0.40,"yelakki banana":0.10,"yelakki banana organic":0.10,"robusta banana":0.20,"pomegranate":0.35,"pomegranate large":0.35,"pomegranate medium":0.35,"pomegranate organic":0.35,"pear":0.16,"mandarin orange":0.10,"valencia orange":0.25,"plum":0.05,"peach":0.15,"mango":0.50,"kesar mango":0.50,"langra mango":0.50,"banganapalli mango":0.50,"alphonso mango":0.50,"badami mango":0.50,"dasheri mango":0.50,"totapuri mango":0.50,"sindhura mango":0.50,"malika mango":0.50,"malgova mango":0.50,"benishan mango":0.50,"imampasand mango":0.50}

const ALIASES = {"mini orange":"Mandarin orange","mini orange sweet":"Mandarin orange","sweet orange":"Mandarin orange","yellaki":"Yelakki banana","yellakki":"Yelakki banana","yalakki":"Yelakki banana","yalaki":"Yelakki banana","elaichi banana":"Yelakki banana","elachi banana":"Yelakki banana","banana":"Yelakki banana","y banana":"Yelakki banana","y bananas":"Yelakki banana","langda":"Langra mango","langdaa":"Langra mango","langra":"Langra mango","langa":"Langra mango","kesar":"Kesar mango","alphonso":"Alphonso mango","dasheri":"Dasheri mango","dussehri":"Dasheri mango","badami":"Badami mango","beganpalli":"Banganapalli mango","baganpalli":"Banganapalli mango","pedanpally":"Banganapalli mango","banganphalli":"Banganapalli mango","baiganphali":"Banganapalli mango","bagganpalli":"Banganapalli mango","cherry sweet":"Cherry Indian","cherry":"Cherry Indian","grapes":"Green grapes","litchi":"Lychee","lichi":"Lychee","sweet lime":"Mosambi","rocket apple":"Rockit apple","rock apple":"Rockit apple","rambuttan":"Rambutan","rambutten":"Rambutan","rambhutan":"Rambutan","rambuthan":"Rambutan","imanpasad":"Imampasand mango","imampasad":"Imampasand mango","thai guava":"Guava white","white guava":"Guava white","dragon fruit red":"Dragon red","dragonfruit red":"Dragon red"}

function buildSystemPrompt(today, groupName) {
  const aliasLines = Object.entries(ALIASES).map(([k, v]) => k + '→' + v).join(', ')
  const pkgLines = Object.entries(PKG).map(([k, v]) => k + '=' + v + 'kg/pc').join(', ')
  const societyList = SOCIETIES.join(', ')

  return `You are an order parser for Good Papaya, a fresh produce delivery business in Bengaluru.

TODAY: ${today}

You are reading LIVE messages from the WhatsApp group "${groupName}", not a screenshot. Each line below is tagged "[SenderName | phone]: message text" — SenderName is the sender's real WhatsApp display name, phone is their WhatsApp number. A line may also be tagged "(replying to: "...")" when it's a reply to an earlier message.

CANONICAL ITEMS: ${FRUITS.join(', ')}

KG/PC CONVERSIONS: ${pkgLines}

ALIASES: ${aliasLines}

RULES:
1. customer_name = society name + door/flat number ONLY, society first then door. Derive this from whichever of the tagged SenderName OR the message text itself actually contains the society/door — customers often type their society+door straight into the message body (e.g. "Villa 384, 2kg mango"), and that text takes priority over SenderName whenever it contains a derivable society/door pattern. Only fall back to SenderName when the message text itself has no society/door in it.
   KNOWN SOCIETIES: ${societyList}
   Also use judgement to identify new societies not on this list.
   STRIP: Indian first/last names (Kalika, Radhika, Kavita, Shalu, Sapna, Femina, Usha, Harpreet, Swati, Nandhini, Komali, Monika, Gayathri, Anu, Nikesha, Chanchal, Sampada, Chanda, Soumya, Anupreet etc), Indian city names (Delhi, Mumbai, Bangalore etc), builder prefixes (APR, Prestige, Brigade unless part of society name).
   NEVER strip the society name itself. When in doubt whether a word is a person name or society name, KEEP it.
   IMPORTANT: some society names are shared by multiple different builders (e.g. "Sobha Eternia" and "Snnraj Eternia" are two DIFFERENT, unrelated societies that happen to both be called "Eternia") — for any society name that appears in KNOWN SOCIETIES as part of a two-word compound (builder + name), KEEP the full compound exactly as listed. Never shorten it down to just the shared tail word, even if that bare tail word ALSO appears in KNOWN SOCIETIES on its own — that would wrongly merge two distinct societies into one.
   REORDER if needed: society always before door e.g. "B303 T4"→"T4 B303", "Sapna T4 B303"→"T4 B303".
   Examples: "Kalika Villa 384"→"Villa 384", "Radhika Meda A705"→"Meda A705", "Kavita Ferns E402"→"Ferns E402", "Usha Espana L401"→"Espana L401", "Harpreet Lakefront E501"→"Lakefront E501", "Rupal APR Villa 269"→"Villa 269", "Snnraj Eternia B204"→"Snnraj Eternia B204" (keep "Snnraj" — do NOT shorten to "Eternia B204")
   NEVER leave customer_name empty. If NEITHER the message text NOR the tagged SenderName has a derivable society/door pattern (e.g. a business name, generic contact name), fall back to using the tagged SenderName exactly as given, and add a flag noting the customer needs manual identification.

2. IGNORE ONLY: 👍 reacted messages, payment/UPI confirmations, deleted messages, system messages (member added/removed)

3. item_name = canonical name only, NO qualifiers in item_name

4. description = EVERYTHING except the base fruit name and quantity:
   - All qualifiers: ripe, sweet, medium, large, small, organic, ready to eat, semi-ripe, not very ripe, long, striped etc
   - Delivery instructions: "door pe rakh dena", "leave at door", "call before delivery" etc
   - Conditions: "only if sweet", "if available", "not overripe" etc
   - Piece count: ALWAYS include "N pieces" when order is by count e.g. "2 pieces", "ripe, 3 pieces", "ready to eat, 1 piece"
   - Complaints or special requests also go here

4a. delivery_instructions = a SEPARATE copy of anything from the message
    that's specifically an instruction for the delivery person, not the
    packer — e.g. "deliver after 4pm", "before 10am only", "don't ring the
    bell", "leave with security", "don't collect money" / "already paid" /
    COD notes, gate codes, "call before coming up". This is IN ADDITION to
    also including that same text in description per rule 4 above — it's
    not a replacement, both fields get it. Empty string "" if the message
    has nothing delivery-specific (most orders won't).

4b. deliver_by = a structured "HH:MM" (24-hour) LATEST-time deadline ONLY
    if the customer stated a hard latest-time to receive the order — e.g.
    "need by 4pm"→"16:00", "before 10am"→"10:00", "by 6:30pm"→"18:30",
    "between 2 and 4pm"→"16:00" (the later bound). Only fill it in when a
    specific clock time is actually stated — NOT for vague urgency ("asap",
    "soon", "whenever"). Empty string "" if no explicit latest-time was
    given (most orders won't have one).

4c. deliver_after = a structured "HH:MM" (24-hour) EARLIEST-time
    constraint — the mirror of deliver_by, for phrasing like "deliver after
    4pm"→"16:00", "not before 10am"→"10:00", "between 2 and 4pm"→"14:00"
    (the earlier bound — same "between" statement fills BOTH deliver_by and
    deliver_after together, one bound each). Empty string "" if no explicit
    earliest-time was given (most orders won't have one).

5. Quantity rules:
   - g/gm/gms/kg stated → convert to kg decimal (500g=0.5, 300gm=0.3, half kg=0.5, 1/2kg=0.5, 2kg=2)
   - N pc / N pieces / plain N → if fruit in KG/PC table: qty = N × kg/pc, add "N pieces" to description
   - fruit NOT in table with piece count → qty = raw count, flag yellow, add "N pieces" to description
   - Rambutan with piece count → qty = raw count, flag (no conversion yet), add "N pieces" to description
   - no quantity → qty = 1, flag yellow

6. sales_order = ${today}-CustomerNameNoSpaces

7. final_quantity and status = always empty string ""

8. Plain "mango" no variety → item_name="Mango", flag for manual variety entry

9. Plain "grapes" → Green grapes

10. DEFAULTS — when no variety specified, use these:
    - "orange" → Mandarin orange (add "confirm mandarin variety" to description)
    - "pomegranate" with no size mentioned → Pomegranate medium
    - "pomegranate small" / "small pomegranate" → Pomegranate small
    - "pomegranate large" / "large pomegranate" or any other size word → Pomegranate large
    - "watermelon" → Watermelon (NOT Watermelon striped — only use striped if customer explicitly says striped)
    - "muskmelon" → Muskmelon (NOT Muskmelon striped — only use striped if explicitly stated)
    - "guava" → Guava white
    - "banana" → Yelakki banana
    - "cherry" → Cherry Indian
    - "apple" → Gala apple

11. SOCIETY NAME — if a customer's tagged name has no recognizable society (just a door/flat number, or a generic WhatsApp profile name):
    - The group name is "${groupName}" — infer the society from it if possible (e.g. "77 degree fresh fruits group" → society is "77degree")
    - OR look at other messages in this batch from customers who do have a society name
    - Prepend the inferred society to the door number
    - If you cannot determine society from any context → keep door number only and flag
    - ALSO fill the separate "society" output field below with your best-guess society name whenever you can determine one from ANY source (group name, other messages in the batch, or the customer's own text) — do this independently of customer_name, even when customer_name itself falls back to the raw WhatsApp profile name because no door number could be found. This is a safety net for ops staff to see which society an order came from at a glance when customer_name alone isn't useful. Leave "society" as an empty string only if truly nothing points to one.

12. REPLY/ADD-ON ORDERS — a message tagged "(replying to: "...")" is a reply to an earlier message:
    - Output ONLY the NEW items in that message, not the items in the quoted text shown in the tag
    - The quoted text is the ORIGINAL order — ignore it, it was already parsed
    - This applies regardless of exact wording — "also add", "plus", "and also", or any reply to their own order
    - If the reply is just a confirmation, address, or non-order text → ignore entirely
    - For add-on items, prepend "add-on" to the description e.g. "add-on, ripe" or just "add-on" if no other qualifiers

13. phone = the phone number from the "[SenderName | phone]" tag of whichever message(s) this row came from, copied exactly as given. Every row has a phone — never leave it empty.

CRITICAL:
- description never blank if any qualifier/note/condition/piece count exists
- Always include "N pieces" in description when order was by count
- item_name = base fruit only, no qualifiers ever
- Watermelon/Muskmelon = plain variety by default, NEVER striped unless explicitly said
- "orange" = Mandarin orange always, never mango

Return ONLY valid compact JSON, no markdown fences:
{"rows":[{"order_date":"${today}","customer_name":"","phone":"","item_name":"","description":"","delivery_instructions":"","deliver_by":"","deliver_after":"","quantity":0,"sales_order":"","society":""}],"flags":[]}`
}

// A greedy /\{[\s\S]*\}/ regex matches from the first "{" to the LAST "}"
// anywhere in the text — if the response ever has trailing content after a
// complete JSON object (extra prose, a stray duplicated block), that
// swallows it too, producing "valid JSON, then garbage" which JSON.parse
// rejects with "Unexpected non-whitespace character after JSON". Walking
// brace depth instead (string-aware, so a brace inside a quoted value
// doesn't miscount) finds exactly the first balanced object and stops
// there, ignoring whatever follows it.
function extractFirstJsonObject(raw) {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null // unbalanced — response was truncated mid-object
}

function parseJson(raw) {
  const jsonStr = extractFirstJsonObject(raw)
  if (!jsonStr) throw new Error('No JSON: ' + raw.slice(0, 150))
  try {
    return JSON.parse(jsonStr)
  } catch (e) {
    try {
      return JSON.parse(jsonStr.replace(/,(\s*[}\]])/g, '$1').replace(/[\x00-\x1F\x7F]/g, ' '))
    } catch (e2) {
      throw new Error('JSON parse failed: ' + e.message)
    }
  }
}

// Unwrap ephemeral / view-once wrapper messages so disappearing-message
// groups don't silently produce empty text.
function unwrapMessage(message, depth = 0) {
  if (!message || depth > 3) return message
  const wrapperKeys = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
  ]
  for (const key of wrapperKeys) {
    if (message[key]?.message) return unwrapMessage(message[key].message, depth + 1)
  }
  return message
}

function textFromMessageObj(m) {
  if (!m) return null
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  )
}

function contextInfoOf(m) {
  if (!m) return null
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null
  )
}

// Extracts { text, quotedText } — quotedText is set when this message is a
// WhatsApp reply, so rule 12 (add-on detection) can work on live text the
// same way it does on screenshots with a visible quoted grey box.
function extractMessage(msg) {
  const m = unwrapMessage(msg.message)
  const text = textFromMessageObj(m)
  if (!text) return null
  const ctx = contextInfoOf(m)
  const quotedText = ctx?.quotedMessage ? textFromMessageObj(unwrapMessage(ctx.quotedMessage)) : null
  return { text, quotedText }
}

// msg.key.participant is normally the sender's real phone-number JID
// ("91XXXXXXXXXX@s.whatsapp.net") inside a group — but WhatsApp's LID
// (Linked ID) privacy rollout can make it an opaque, non-phone-number JID
// ("XXXXXXXXX@lid") instead, for some groups/accounts. A plain
// .split('@')[0] on that just extracts the meaningless LID, silently
// saving a garbage "phone" that isn't usable anywhere downstream (Zoho
// contact matching, Razorpay payment links, etc.). Baileys exposes the
// real phone-number JID as participantAlt when the primary one is a LID
// — prefer participant when it's already a real number, fall back to
// participantAlt, and log clearly if neither resolves so a garbage phone
// never saves silently again.
function resolveSenderPhone(msg) {
  const participant = msg.key.participant || ''
  if (participant.endsWith('@s.whatsapp.net')) return participant.split('@')[0]
  const alt = msg.key.participantAlt || ''
  if (alt.endsWith('@s.whatsapp.net')) return alt.split('@')[0]
  console.warn(`[phone] could not resolve a real phone number for sender (participant=${participant || 'none'}, participantAlt=${alt || 'none'})`)
  return participant.split('@')[0] || null
}

function formatMessageLine({ sender, phone, text, quotedText }) {
  const tag = `[${sender} | ${phone}]`
  const reply = quotedText ? ` (replying to: "${quotedText.slice(0, 120)}")` : ''
  return `${tag}${reply}: ${text}`
}

// ---- Batching: collect messages per group, flush to the parser after a quiet window ----
const batches = new Map() // jid -> { timer, items: [] }

function queueMessage(jid, item) {
  let b = batches.get(jid)
  if (!b) {
    b = { timer: null, items: [] }
    batches.set(jid, b)
  }
  b.items.push(item)
  if (!b.timer) {
    b.timer = setTimeout(() => flush(jid), BATCH_WINDOW_MS)
  }
}

async function flush(jid) {
  const b = batches.get(jid)
  batches.delete(jid)
  if (!b || b.items.length === 0) return

  const groupName = groupNames[jid] || jid
  const today = todayIST()
  const lines = b.items.map(formatMessageLine).join('\n')

  console.log(`[parser] sending batch of ${b.items.length} message(s) from "${groupName}"`)
  try {
    const result = await callParser(lines, today, groupName)
    logResult(groupName, b.items.length, result)
    if (result?.rows?.length) {
      await insertParsedRows(result.rows, today, groupName, lines)
      await pushToOrders(result.rows, groupName, lines)
    }
  } catch (e) {
    console.error('[parser] request failed:', e.message)
    logResult(groupName, b.items.length, { error: e.message })
  }
}

async function callParser(lines, today, groupName) {
  if (!PARSE_FUNCTION_URL) {
    console.log('[parser] PARSE_FUNCTION_URL not set — printing batch instead:')
    console.log(lines)
    return null
  }
  const resp = await fetch(PARSE_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: buildSystemPrompt(today, groupName),
      messages: [{ role: 'user', content: 'Parse all orders from these live WhatsApp messages. Return only valid compact JSON.\n\n' + lines }],
    }),
  })
  const txt = await resp.text()
  let data
  try {
    data = JSON.parse(txt)
  } catch (e) {
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 150)}`)
  }
  if (data.error) throw new Error(JSON.stringify(data.error))
  if (!data.content?.length) throw new Error('No content: ' + data.stop_reason)
  return parseJson(data.content.map((x) => x.text || '').join(''))
}

// Writes parsed rows into the `whatsapp_parsed_orders` table that the parser
// page's "Live" tab reads from. Nothing here touches orders/order_items —
// that only happens when a human clicks "Push to operations" in the UI.
async function postToParsedOrders(records) {
  return fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/whatsapp_parsed_orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(records),
  })
}

async function insertParsedRows(rows, today, groupName, rawText) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  const records = rows.map((r) => ({
    order_date: r.order_date || today,
    group_name: groupName,
    customer_name: r.customer_name,
    phone: r.phone || null,
    item_name: r.item_name,
    description: r.description || null,
    delivery_instructions: r.delivery_instructions || null,
    deliver_by: r.deliver_by || null,
    deliver_after: r.deliver_after || null,
    quantity: r.quantity != null ? String(r.quantity) : null,
    sales_order: r.sales_order || null,
    // The whole batch's raw tagged text, not just this row's slice of it —
    // Claude doesn't report which line(s) produced which row, and every row
    // from one batch sharing the same raw_text is still enough for a human
    // to compare a parsed row against what was actually typed.
    raw_text: rawText || null,
  }))
  let resp = await postToParsedOrders(records)
  if (!resp.ok) {
    const errText = await resp.text()
    // A single POST is one atomic SQL insert — Postgres can't partially
    // apply it, so an unrecognised column (42703, e.g. raw_text before its
    // migration has run) would otherwise silently drop the ENTIRE batch,
    // including the actual order data that matters far more than raw_text.
    // Retry once without it instead of losing real orders to one missing,
    // non-essential column.
    if (errText.includes('42703') || /column .* does not exist/i.test(errText)) {
      console.error('[table] insert failed on a missing column, retrying without raw_text:', errText)
      const stripped = records.map(({ raw_text, ...rest }) => rest)
      resp = await postToParsedOrders(stripped)
      if (!resp.ok) throw new Error(`table insert failed even after stripping raw_text: ${await resp.text()}`)
      console.log(`[table] inserted ${stripped.length} row(s) into whatsapp_parsed_orders (raw_text column missing — ran migration 076 yet?)`)
      return
    }
    throw new Error(`table insert failed: ${errText}`)
  }
  console.log(`[table] inserted ${records.length} row(s) into whatsapp_parsed_orders`)
}

// Pushes the same parsed rows straight into real orders/order_items (via
// whatsapp-create-order), tagged pending_review — additional to, not a
// replacement for, the whatsapp_parsed_orders insert above. Best-effort:
// a failure here still leaves the batch safely recoverable from the Live
// tab (whatsapp_parsed_orders), so it's logged, not thrown.
async function pushToOrders(rows, groupName, rawText) {
  if (!SUPABASE_URL || !CRON_SECRET) {
    if (!CRON_SECRET) console.log('[orders] CRON_SECRET not set — skipping direct push, Live tab only')
    return
  }
  const payloadRows = rows
    .filter((r) => r.sales_order && r.customer_name)
    .map((r) => ({
      sales_order_id: r.sales_order,
      customer_name: r.customer_name,
      phone: r.phone || null,
      item_name: r.item_name || null,
      description: r.description || null,
      delivery_instructions: r.delivery_instructions || null,
      deliver_by: r.deliver_by || null,
      deliver_after: r.deliver_after || null,
      quantity: r.quantity != null ? Number(r.quantity) : 0,
      society: r.society || null,
    }))
  if (!payloadRows.length) return
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/whatsapp-create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
      body: JSON.stringify({ rows: payloadRows, raw_text: rawText || null, group_name: groupName }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
    console.log(`[orders] pushed ${data.opened} new item(s), ${data.held} held, ${data.splitCount} split — pending review`)
  } catch (e) {
    console.error('[orders] direct push failed (still safe in whatsapp_parsed_orders / Live tab):', e.message)
  }
}

// Single-row status the ops dashboard's Live tab reads to flag a dead
// connection — best-effort, never throws, since losing this shouldn't take
// the listener itself down.
async function updateListenerStatus(status, detail) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/whatsapp_listener_status?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: 1, status, detail: detail || null, updated_at: new Date().toISOString() }),
    })
    if (!resp.ok) console.error('[status] update failed:', await resp.text())
  } catch (e) {
    console.error('[status] update failed:', e.message)
  }
}

function logResult(groupName, sentCount, result) {
  const entry = { at: new Date().toISOString(), groupName, sent: sentCount, result }
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
  } catch (e) {
    console.error('[log] failed to write audit log:', e.message)
  }

  if (!result || result.error) return
  if (result.rows) {
    console.log(`[parser] ${result.rows.length} row(s) parsed` + (result.flags?.length ? `, ${result.flags.length} flag(s)` : ''))
    for (const r of result.rows) {
      console.log(`  - ${r.customer_name} | ${r.item_name} ${r.quantity}kg ${r.description || ''}`.trim())
    }
    // Claude doesn't always return flags as plain strings — sometimes a
    // {row, reason}-shaped object instead. Template-literal interpolation on
    // an object silently stringifies to "[object Object]", so stringify
    // non-strings explicitly to keep these actually readable in the logs.
    for (const f of result.flags || []) console.log(`  ⚠ ${typeof f === 'string' ? f : JSON.stringify(f)}`)
  }
}

// ---- Guard against Baileys occasionally re-emitting the same upsert event ----
const seenMessageIds = new Set()
function alreadySeen(id) {
  if (seenMessageIds.has(id)) return true
  seenMessageIds.add(id)
  if (seenMessageIds.size > 5000) seenMessageIds.clear()
  return false
}

const groupNames = {} // jid -> subject cache
const discoveredGroups = new Set()
let groupsListed = false // print the full participating-groups list once per process
let isConnected = false

// Heartbeat while connected — without this, a hang that never fires a
// connection.update 'close' event (rare, but possible) would leave the
// dashboard showing a stale "connected" status forever. Refreshing
// updated_at periodically lets the dashboard flag "no heartbeat in a while"
// even when it never received a clean disconnect signal.
setInterval(() => {
  if (isConnected) updateListenerStatus('connected')
}, 5 * 60 * 1000)

let reconnectAttempts = 0
let currentSock = null
let shuttingDown = false

// Closing the socket cleanly on shutdown (redeploy, Ctrl-C) matters: killing
// the process mid-write can leave the Signal Protocol session files
// (pre-key-N.json, session-*.json) out of sync with what WhatsApp's server
// still thinks is current, which WhatsApp then reports back as a session
// "conflict" (code 440) on every future reconnect — a self-inflicted loop
// that looks like two clients fighting over one session when there's really
// just one, with corrupted state. sock.end() logs off the socket without
// revoking the underlying link, unlike sock.logout().
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal} received, closing WhatsApp connection cleanly…`)
  try {
    currentSock?.end(undefined)
  } catch (e) {
    console.error('[shutdown] error closing socket:', e.message)
  }
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  try {
    const existing = fs.readdirSync(AUTH_DIR)
    console.log(`[auth] ${AUTH_DIR} has ${existing.length} file(s): ${existing.join(', ') || '(empty)'}`)
  } catch (e) {
    console.log(`[auth] could not read ${AUTH_DIR}: ${e.message}`)
  }
  // fetchLatestBaileysVersion() has a known bug where it can report a stale
  // version while claiming isLatest:true, which silently breaks pairing —
  // fetchLatestWaWebVersion() asks WhatsApp directly instead of Baileys'
  // own version registry, so try that first. Falls back to the registry
  // version if the direct fetch itself fails (e.g. that endpoint blocked
  // on this network) rather than leaving the listener unable to start at all.
  const waVersion = await fetchLatestWaWebVersion().catch(() => null)
  const version = waVersion && !waVersion.error
    ? waVersion.version
    : (await fetchLatestBaileysVersion()).version
  console.log(`[version] using WA protocol version ${version.join('.')}${waVersion && !waVersion.error ? ' (direct)' : ' (registry fallback)'}`)

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    markOnlineOnConnect: false, // stay low-profile; your phone remains the "primary"
    syncFullHistory: false, // only new messages, not full backfill
    qrTimeout: 120000, // give 2 minutes per QR instead of WhatsApp's tighter default before it refreshes
    // Both needed for requestPairingCode() specifically — the default query
    // timeout is too aggressive for the pairing round trip (causes an
    // immediate "Connection Closed"/401), and some WhatsApp versions reject
    // pairing from Baileys' default browser identifier. Omitted entirely
    // (not set to undefined) when not pairing — Baileys' own defaults
    // assume a real array here, so an explicit `browser: undefined` breaks
    // internals that read browser[0] unconditionally.
    ...(PAIRING_PHONE_NUMBER
      ? { defaultQueryTimeoutMs: undefined, browser: ['Windows', 'Chrome', '114.0.5735.198'] }
      : {}),
  })
  currentSock = sock

  sock.ev.on('creds.update', saveCreds)

  // Pairing-code path: request it once, only if this device isn't already
  // linked. Avoids the QR-scan race entirely — WhatsApp shows this code for
  // you to type in yourself instead of a camera-scannable, fast-expiring QR
  // image. Delayed a few seconds rather than fired immediately after
  // makeWASocket() — requesting it before the underlying WebSocket has
  // actually finished its opening handshake causes an immediate
  // "Connection Closed" / 401, a known Baileys race, not a real pairing
  // failure.
  if (PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER)
        console.log(`[pairing] Enter this code on your phone: ${code}`)
        console.log('[pairing] WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"')
      } catch (e) {
        console.error('[pairing] requestPairingCode failed:', e.message)
      }
    }, 3000)
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr && !PAIRING_PHONE_NUMBER) qrcode.generate(qr, { small: true }) // scan once with the secondary number
    if (connection === 'close') {
      isConnected = false
      if (shuttingDown) return // intentional shutdown — don't reconnect
      const code = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.message || 'unknown reason'
      console.log(`connection closed — code=${code} reason="${reason}"`)
      const loggedOut = code === DisconnectReason.loggedOut
      if (loggedOut) {
        console.log('logged out — delete ./auth and re-scan to reconnect')
        updateListenerStatus('logged_out', `code=${code} reason="${reason}" — needs re-scan/re-pair`)
        return
      }
      // A "conflict" (connectionReplaced) means WhatsApp's server still
      // thinks a previous connection using this session is active — almost
      // always because we reconnected faster than the server finished
      // tearing down the last one, which just triggers another conflict on
      // the new attempt too. Waiting it out (rather than the usual fast
      // 1s-then-backoff retry) gives the server time to actually release it.
      const conflict = code === DisconnectReason.connectionReplaced
      const delay = conflict ? 15000 : Math.min(30000, 1000 * 2 ** reconnectAttempts)
      reconnectAttempts++
      console.log(`reconnecting in ${delay}ms${conflict ? ' (session conflict — waiting longer for WhatsApp to release the previous connection)' : ''}`)
      updateListenerStatus('reconnecting', `code=${code} reason="${reason}"`)
      setTimeout(start, delay)
    } else if (connection === 'open') {
      reconnectAttempts = 0
      isConnected = true
      updateListenerStatus('connected')
      console.log('connected — listening' + (GROUP_JIDS.size ? '' : ' (discovery mode: printing all group JIDs)'))
      // Lists every group this number is already a member of — no message
      // needs to land in a group first, unlike the messages.upsert discovery
      // path below (which only ever sees groups that actually post while
      // watching). Once per process so a flappy connection doesn't reprint
      // this on every reconnect.
      if (!groupsListed) {
        groupsListed = true
        try {
          const groups = await sock.groupFetchAllParticipating()
          const list = Object.values(groups)
          console.log(`[groups] member of ${list.length} group(s) — JID list below:`)
          for (const g of list) {
            groupNames[g.id] = g.subject
            console.log(`[groups] ${g.subject}  =>  ${g.id}`)
          }
        } catch (e) {
          console.error('[groups] failed to fetch group list:', e.message)
        }
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return // ignore history/sync batches
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (!jid?.endsWith('@g.us')) continue // groups only
      if (msg.key.fromMe) continue
      if (msg.key.id && alreadySeen(`${jid}:${msg.key.id}`)) continue

      if (!groupNames[jid]) {
        try {
          groupNames[jid] = (await sock.groupMetadata(jid)).subject
        } catch {
          groupNames[jid] = jid
        }
      }

      // Discovery mode: no groups configured -> print every group's name + JID once.
      if (GROUP_JIDS.size === 0) {
        if (!discoveredGroups.has(jid)) {
          discoveredGroups.add(jid)
          console.log(`[discover] ${groupNames[jid]}  =>  ${jid}`)
        }
        continue
      }
      if (!GROUP_JIDS.has(jid)) continue

      const extracted = extractMessage(msg)
      if (!extracted) continue

      queueMessage(jid, {
        sender: msg.pushName || 'unknown',
        phone: resolveSenderPhone(msg),
        text: extracted.text,
        quotedText: extracted.quotedText,
        timestamp: new Date(Number(msg.messageTimestamp || 0) * 1000).toISOString(),
      })
    }
  })
}

start()
