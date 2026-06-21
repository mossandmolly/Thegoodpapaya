/**
 * zoho-auth.js — one-time script to get your Zoho refresh token
 *
 * Steps:
 *   1. Go to https://api-console.zoho.in → "Server-based Apps" → Add Client
 *   2. Set Redirect URI to: http://localhost:8080/callback
 *   3. Copy Client ID + Client Secret into .env
 *   4. Run: node zoho-auth.js
 *   5. A browser URL is printed — open it, approve access
 *   6. Zoho redirects to localhost:8080/callback?code=XXXX
 *   7. This script captures the code, exchanges it for tokens, prints your REFRESH TOKEN
 *   8. Paste ZOHO_REFRESH_TOKEN into .env — you never need to do this again
 */
require('dotenv').config();
const http  = require('http');
const https = require('https');
const url   = require('url');

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:8080/callback';

const SCOPE = 'ZohoBooks.invoices.READ';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env first');
  process.exit(1);
}

const authUrl =
  `https://accounts.zoho.in/oauth/v2/auth` +
  `?response_type=code` +
  `&client_id=${CLIENT_ID}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&access_type=offline`;

console.log('\n──────────────────────────────────────────────');
console.log('Open this URL in your browser to authorise:\n');
console.log(authUrl);
console.log('\n──────────────────────────────────────────────');
console.log('Waiting for redirect on http://localhost:8080 …\n');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/callback') return;

  const code = parsed.query.code;
  if (!code) {
    res.end('No code received — try again.');
    return;
  }

  res.end('<h2>Got it! Check your terminal for the refresh token.</h2>');

  // Exchange code for tokens
  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  }).toString();

  const options = {
    hostname: 'accounts.zoho.in',
    path:     '/oauth/v2/token',
    method:   'POST',
    headers:  {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const tokenReq = https.request(options, tokenRes => {
    let data = '';
    tokenRes.on('data', chunk => data += chunk);
    tokenRes.on('end', () => {
      const json = JSON.parse(data);
      console.log('\n✅  SUCCESS\n');
      console.log('Add this to your .env:\n');
      console.log(`ZOHO_REFRESH_TOKEN=${json.refresh_token}`);
      console.log('\nAccess token (expires in 1h, you do NOT need to save this):');
      console.log(json.access_token?.substring(0, 40) + '…');
      server.close();
    });
  });

  tokenReq.on('error', err => console.error('Token exchange failed:', err.message));
  tokenReq.write(body);
  tokenReq.end();
});

server.listen(8080);
