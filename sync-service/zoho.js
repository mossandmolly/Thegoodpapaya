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
 * Fetch a contact's phone number from Zoho Books.
 * Returns E.164 string (+91XXXXXXXXXX) or null.
 */
async function fetchContactPhone(zohoContactId) {
  if (!zohoContactId) return null;
  const token = await getAccessToken();
  try {
    const res = await axios.get(
      `${process.env.ZOHO_BASE_URL}/contacts/${zohoContactId}`,
      { headers: authHeaders(token) }
    );
    const c = res.data.contact;

    // Prefer mobile over landline; check contact_persons array too
    const raw =
      c?.mobile ||
      c?.phone  ||
      c?.contact_persons?.[0]?.mobile ||
      c?.contact_persons?.[0]?.phone  ||
      null;

    return raw ? normalisePhone(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Normalise any Indian phone number to E.164 (+91XXXXXXXXXX).
 */
function normalisePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10)                          return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '+91' + digits.slice(1);
  return null; // unrecognised format — caller handles null
}

module.exports = { fetchModifiedInvoices, fetchInvoiceDetail, fetchInvoicePdfUrl, fetchContactPhone };
