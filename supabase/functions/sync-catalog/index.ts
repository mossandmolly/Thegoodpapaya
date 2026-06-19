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

// "ALPHONSO MANGO" → "Alphonso Mango"
function properCase(s: string): string {
  return s.trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const sb    = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const orgId = Deno.env.get('ZOHO_ORG_ID')!
    const token = await getZohoToken()

    // Fetch all active items, paginated
    const allItems: any[] = []
    let page = 1
    while (true) {
      const res  = await fetch(
        `${ZOHO_BASE}/items?organization_id=${orgId}&status=active&page=${page}&per_page=200`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || `Zoho items API error (${res.status})`)
      allItems.push(...(data.items ?? []))
      if (!data.page_context?.has_more_page) break
      page++
    }

    if (!allItems.length) {
      return new Response(
        JSON.stringify({ synced: 0, message: 'No active items in Zoho' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const rows = allItems.map((item: any) => ({
      item_name:    properCase(String(item.name ?? '')),
      unit:         String(item.unit || 'kg').toLowerCase(),
      unit_price:   parseFloat(item.rate) || 0,
      active:       true,
      zoho_item_id: String(item.item_id),
      synced_at:    new Date().toISOString(),
    })).filter(r => r.item_name)

    // Upsert on zoho_item_id (unique partial index).
    // item_name may change in Zoho → we update it here too.
    const { error } = await sb
      .from('catalog')
      .upsert(rows, { onConflict: 'zoho_item_id', ignoreDuplicates: false })
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
