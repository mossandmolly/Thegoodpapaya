import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token'
const ZOHO_BASE      = 'https://www.zohoapis.in/books/v3'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

async function getZohoToken(): Promise<string> {
  const params = new URLSearchParams({
    refresh_token: Deno.env.get('ZOHO_REFRESH_TOKEN')!,
    client_id:     Deno.env.get('ZOHO_CLIENT_ID')!,
    client_secret: Deno.env.get('ZOHO_CLIENT_SECRET')!,
    grant_type:    'refresh_token',
  })
  const res  = await fetch(`${ZOHO_TOKEN_URL}?${params}`, { method: 'POST' })
  const json = await res.json()
  if (!json.access_token) throw new Error('Zoho auth failed: ' + JSON.stringify(json))
  return json.access_token
}

// Rules:
// 1. Strip everything except letters, digits, and spaces
//    (hyphens, slashes, dots, parens, etc. all become a space)
// 2. Collapse runs of spaces, trim
// 3. Each word: first char uppercase, rest lowercase
//    e.g. "VILLA-23A" → "Villa 23a"
//         "D.S.R PARKWAY 12" → "D S R Parkway 12"
//         "KRISHVIGAVAKSHI BLOCK B 101" → "Krishvigavakshi Block B 101"
function cleanCustomerName(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const sb    = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const orgId = Deno.env.get('ZOHO_ORG_ID')!
    const token = await getZohoToken()

    // Fetch all active customers from Zoho Books, paginated
    const allContacts: any[] = []
    let page = 1
    while (true) {
      const res  = await fetch(
        `${ZOHO_BASE}/contacts?organization_id=${orgId}&contact_type=customer&status=active&page=${page}&per_page=200`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || `Zoho contacts API error (${res.status})`)
      allContacts.push(...(data.contacts ?? []))
      if (!data.page_context?.has_more_page) break
      page++
    }

    if (!allContacts.length) {
      return new Response(
        JSON.stringify({ synced: 0, message: 'No active customers in Zoho' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const rows = allContacts
      .filter((c: any) => c.contact_name?.trim())
      .map((c: any) => ({
        customer_name:   cleanCustomerName(c.contact_name),
        zoho_contact_id: String(c.contact_id),
        active:          c.status === 'active',
        synced_at:       new Date().toISOString(),
      }))
      .filter(r => r.customer_name.length > 0)

    // Upsert on zoho_contact_id.
    // customer_name also has a unique constraint; if Zoho has two contacts
    // that clean to the same name, the second one is skipped (no error thrown).
    const { error } = await sb
      .from('customers')
      .upsert(rows, { onConflict: 'zoho_contact_id', ignoreDuplicates: false })
    if (error) throw new Error('DB upsert failed: ' + error.message)

    return new Response(
      JSON.stringify({ synced: rows.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
