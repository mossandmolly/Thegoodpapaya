import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token'
const ZOHO_BASE      = 'https://www.zohoapis.in/books/v3'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

async function getZohoToken(): Promise<string> {
  const clientId     = Deno.env.get('ZOHO_CLIENT_ID')
  const clientSecret = Deno.env.get('ZOHO_CLIENT_SECRET')
  const refreshToken = Deno.env.get('ZOHO_REFRESH_TOKEN')
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Zoho secrets — set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in Supabase')
  }
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'refresh_token',
  })
  const res  = await fetch(`${ZOHO_TOKEN_URL}?${params}`, { method: 'POST' })
  const json = await res.json()
  if (!json.access_token) throw new Error('Zoho auth failed: ' + JSON.stringify(json))
  return json.access_token
}

// Use ZOHO_ORG_ID secret if set; otherwise auto-discover from /organizations.
async function getOrgId(token: string): Promise<string> {
  const envOrgId = Deno.env.get('ZOHO_ORGANIZATION_ID')?.trim()
  if (envOrgId) return envOrgId

  const res  = await fetch(`${ZOHO_BASE}/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  })
  const data = await res.json()
  if (!res.ok || !data.organizations?.length) {
    throw new Error(
      'Could not discover Zoho org ID (code ' + res.status + '): ' +
      (data.message || JSON.stringify(data)) +
      ' — set ZOHO_ORG_ID secret manually if needed'
    )
  }
  return String(data.organizations[0].organization_id)
}

// Strip special chars, collapse spaces, proper-case each word.
// "VILLA-23A" → "Villa 23a", "D.S.R PARKWAY 12" → "D S R Parkway 12"
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
    const token = await getZohoToken()
    const orgId = await getOrgId(token)

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

    const { error } = await sb
      .from('customers')
      .upsert(rows, { onConflict: 'zoho_contact_id', ignoreDuplicates: false })
    if (error) throw new Error('DB upsert failed: ' + error.message)

    return new Response(
      JSON.stringify({ synced: rows.length, org_id: orgId }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})
