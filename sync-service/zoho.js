/**
 * Zoho Books API client
 * Handles OAuth token refresh + invoice fetching
 */
const axios = require('axios');

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });

  const res = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!res.data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(res.data)}`);
  }

  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + res.data.expires_in * 1000;
  return accessToken;
}

function authHeaders(token) {
  return {
    Authorization: `Zoho-oauthtoken ${token}`,
    'X-com-zoho-books-organizationid': process.env.ZOHO_ORGANIZATION_ID,
  };
}

/**
 * Fetch invoices last modified after `sinceDate` (YYYY-MM-DD)
 * Returns array of Zoho invoice summary objects.
 */
async function fetchModifiedInvoices(sinceDate) {
  const token = await getAccessToken();
  const base = process.env.ZOHO_BASE_URL;
  let page = 1;
  const invoices = [];

  while (true) {
    const res = await axios.get(`${base}/invoices`, {
      headers: authHeaders(token),
      params: {
        last_modified_time: sinceDate, // "YYYY-MM-DD HH:MM:SS"
        page,
        per_page: 200,
      },
    });

    const data = res.data;
    if (!data.invoices || data.invoices.length === 0) break;
    invoices.push(...data.invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }

  return invoices;
}

/**
 * Fetch full invoice detail including line items.
 */
async function fetchInvoiceDetail(zohoInvoiceId) {
  const token = await getAccessToken();
  const res = await axios.get(
    `${process.env.ZOHO_BASE_URL}/invoices/${zohoInvoiceId}`,
    { headers: authHeaders(token) }
  );
  return res.data.invoice;
}

/**
 * Fetch the PDF download URL for an invoice.
 * Returns a URL string or null.
 */
async function fetchInvoicePdfUrl(zohoInvoiceId) {
  // Zoho returns a time-limited signed URL for the PDF
  const token = await getAccessToken();
  try {
    const res = await axios.get(
      `${process.env.ZOHO_BASE_URL}/invoices/${zohoInvoiceId}?accept=pdf`,
      {
        headers: authHeaders(token),
        maxRedirects: 0,
        validateStatus: s => s === 200 || s === 302,
        responseType: 'arraybuffer',
      }
    );
    // Return the direct download URL (caller can store in Supabase storage if needed)
    // For now we just return the Zoho web URL
    return `https://books.zoho.in/app#/invoices/${zohoInvoiceId}`;
  } catch {
    return null;
  }
}

/**
 * Fetch ALL phone numbers for a Zoho contact.
 * Returns array of { phone, label } objects in E.164 format.
 * Pulls: contact.mobile, contact.phone, and each contact_person's mobile/phone.
 */
async function fetchContactPhones(zohoContactId) {
  if (!zohoContactId) return [];
  const token = await getAccessToken();
  try {
    const res = await axios.get(
      `${process.env.ZOHO_BASE_URL}/contacts/${zohoContactId}`,
      { headers: authHeaders(token) }
    );
    const c = res.data.contact;
    const results = [];

    const add = (raw, label) => {
      const normalised = normalisePhone(raw);
      if (normalised) results.push({ phone: normalised, label });
    };

    // Primary contact fields
    add(c?.mobile, 'mobile');
    add(c?.phone,  'landline');

    // Contact persons (spouse, etc.)
    for (const person of c?.contact_persons || []) {
      const personLabel = person.first_name || person.last_name
        ? `${person.first_name || ''} ${person.last_name || ''}`.trim()
        : 'contact';
      add(person.mobile, personLabel);
      add(person.phone,  personLabel);
    }

    // Deduplicate by phone number
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.phone)) return false;
      seen.add(r.phone);
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Normalise any Indian phone number to E.164 (+91XXXXXXXXXX).
 */
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10)                            return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.length === 11 && digits.startsWith('0'))  return '+91' + digits.slice(1);
  return null;
}

/**
 * Case/punctuation-insensitive name match, same rule the ops-dashboard's
 * generate-invoice Edge Function uses, so recovery doesn't create a
 * duplicate Zoho contact for a customer that already has one there.
 */
function canonicalKey(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find a Zoho contact by exact (canonicalised) name, or create one.
 * @param {string} name
 * @param {string|null} phone  E.164, e.g. "+919999000001"
 * @returns {string} contact_id
 */
async function getOrCreateContact(name, phone) {
  const token = await getAccessToken();
  const base = process.env.ZOHO_BASE_URL;

  const search = await axios.get(`${base}/contacts`, {
    headers: authHeaders(token),
    params: { contact_name: name },
  });
  const targetKey = canonicalKey(name);
  const existing = (search.data.contacts || []).find(
    c => canonicalKey(c.contact_name) === targetKey
  );
  if (existing) return existing.contact_id;

  const body = { contact_name: name, contact_type: 'customer' };
  if (phone) body.contact_persons = [{ phone }];
  const create = await axios.post(`${base}/contacts`, body, { headers: authHeaders(token) });
  if (create.data.code !== 0) throw new Error(`Zoho create contact failed: ${create.data.message}`);
  return create.data.contact.contact_id;
}

/**
 * Create a Zoho Books invoice. Mirrors ops-dashboard's generate-invoice
 * Edge Function line-item shape (including the cf_requested_quantity
 * custom field), so invoices created here look identical to ones created
 * from the live dashboard.
 * @param {string} contactId
 * @param {string} salesOrderId   stored as the invoice's reference_number
 * @param {string} date           "YYYY-MM-DD"
 * @param {Array<{name:string, requestedQty:number, qty:number, rate:number, description?:string}>} lineItems
 */
async function createInvoice(contactId, salesOrderId, date, lineItems) {
  const token = await getAccessToken();
  const base = process.env.ZOHO_BASE_URL;

  const body = {
    customer_id:      contactId,
    reference_number: salesOrderId,
    date,
    line_items: lineItems.map(i => ({
      name:        i.name,
      description: i.description || '',
      quantity:    i.qty,
      rate:        i.rate,
      custom_fields: [{ api_name: 'cf_requested_quantity', value: i.requestedQty }],
    })),
  };
  const res = await axios.post(`${base}/invoices`, body, { headers: authHeaders(token) });
  if (res.data.code !== 0) throw new Error(`Zoho create invoice failed: ${res.data.message}`);
  const inv = res.data.invoice;
  return {
    invoice_id:     inv.invoice_id,
    invoice_number: inv.invoice_number,
    invoice_total:  parseFloat(inv.total ?? '0'),
  };
}

module.exports = {
  fetchModifiedInvoices, fetchInvoiceDetail, fetchInvoicePdfUrl, fetchContactPhones,
  getOrCreateContact, createInvoice,
};
