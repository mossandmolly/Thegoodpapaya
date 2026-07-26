// WhatsApp group listener -> Good Papaya order parser
// Read-only. Never sends. Run on a dedicated secondary number.
//
// Requires Node 20+ (uses built-in fetch).
// npm install

import 'dotenv/config'
import makeWASocket, {
  useMultiFileAuthState,
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

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const PARSE_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/parse-orders` : ''

const BATCH_WINDOW_MS = parseInt(process.env.BATCH_WINDOW_MS || '45000', 10)
const AUTH_DIR = './auth'
const LOG_FILE = './parsed-orders.log.jsonl'
// ====================================

const logger = P({ level: 'silent' })

function todayIST() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10)
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

function extractText(msg) {
  const m = unwrapMessage(msg.message)
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
  const payload = {
    date: todayIST(),
    groupName,
    messages: b.items.map(({ sender, phone, text, timestamp }) => ({ sender, phone, text, timestamp })),
  }

  console.log(`[parser] sending batch of ${b.items.length} message(s) from "${groupName}"`)
  try {
    const result = await postToParser(payload)
    logResult(groupName, payload, result)
    if (result?.rows?.length) {
      const phoneBySender = new Map(b.items.map((m) => [m.sender, m.phone]))
      await insertParsedRows(result.rows, payload.date, groupName, phoneBySender)
    }
  } catch (e) {
    console.error('[parser] request failed:', e.message)
    logResult(groupName, payload, { error: e.message })
  }
}

// Writes parsed rows into the `whatsapp_parsed_orders` table that the parser
// page's "Live WhatsApp Orders" list reads from.
async function insertParsedRows(rows, orderDate, groupName, phoneBySender) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return
  const records = rows.map((r) => ({
    order_date: r.order_date || orderDate,
    group_name: groupName,
    customer_name: r.customer_name,
    phone: phoneBySender.get(r.customer_name) || null,
    item_name: r.item_name,
    description: r.description || null,
    quantity: r.quantity != null ? String(r.quantity) : null,
    sales_order: r.sales_order || null,
  }))
  const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/whatsapp_parsed_orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(records),
  })
  if (!resp.ok) throw new Error(`table insert failed: ${await resp.text()}`)
  console.log(`[table] inserted ${records.length} row(s) into whatsapp_parsed_orders`)
}

async function postToParser(payload) {
  if (!PARSE_ENDPOINT || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[parser] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — printing batch instead:')
    console.log(JSON.stringify(payload, null, 2))
    return null
  }
  const resp = await fetch(PARSE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify(payload),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data?.error || `parser error ${resp.status}`)
  return data
}

function logResult(groupName, payload, result) {
  const entry = { at: new Date().toISOString(), groupName, sent: payload.messages.length, result }
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
  } catch (e) {
    console.error('[log] failed to write audit log:', e.message)
  }

  if (result?.error) return
  if (result?.rows) {
    console.log(`[parser] ${result.rows.length} row(s) parsed` + (result.flags?.length ? `, ${result.flags.length} flag(s)` : ''))
    for (const r of result.rows) {
      console.log(`  - ${r.customer_name} | ${r.item_name} ${r.quantity}kg ${r.description || ''}`.trim())
    }
    for (const f of result.flags || []) console.log(`  ⚠ ${f}`)
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

let reconnectAttempts = 0

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion() // pin to current protocol -> lowers detection risk

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    markOnlineOnConnect: false, // stay low-profile; your phone remains the "primary"
    syncFullHistory: false, // only new messages, not full backfill
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) qrcode.generate(qr, { small: true }) // scan once with the secondary number
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut
      if (loggedOut) {
        console.log('logged out — delete ./auth and re-scan to reconnect')
        return
      }
      const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts)
      reconnectAttempts++
      console.log(`connection closed. reconnecting in ${delay}ms`)
      setTimeout(start, delay)
    } else if (connection === 'open') {
      reconnectAttempts = 0
      console.log('connected — listening' + (GROUP_JIDS.size ? '' : ' (discovery mode: printing all group JIDs)'))
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

      const text = extractText(msg)
      if (!text) continue

      queueMessage(jid, {
        sender: msg.pushName || 'unknown',
        phone: (msg.key.participant || '').split('@')[0],
        text,
        timestamp: new Date(Number(msg.messageTimestamp || 0) * 1000).toISOString(),
      })
    }
  })
}

start()
