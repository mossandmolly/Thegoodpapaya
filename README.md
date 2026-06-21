# The Good Papaya — Platform

## Architecture

```
Zoho Books (invoices, source of truth)
       │  pull every 5 min
       ▼
  sync-service  ──────────────────────────► Razorpay (payment links)
       │                                         │
       ▼                                         │
  Supabase (PostgreSQL + Auth)  ◄────────────────┘
       │  RLS: phone-gated reads
       ▼
  Shopify Custom Theme  (thegoodpapaya.com/pages/invoices)
```

---

## Components

| Folder | What it does |
|---|---|
| `supabase/migrations/` | SQL schema — run once in Supabase SQL Editor |
| `sync-service/` | Node.js cron — Zoho → Supabase → Razorpay |
| `shopify-theme/` | Plain Liquid theme (no starter theme) |

---

## 1 — Supabase setup

1. Create a project at [supabase.com](https://supabase.com)
2. **Authentication → Providers → Phone** — enable, choose Twilio or MSG91
3. Open **SQL Editor**, paste & run `supabase/migrations/001_initial_schema.sql`
4. Copy **Project URL** and **anon public key** from Settings → API

---

## 2 — Shopify domain setup

1. Shopify Admin → **Settings → Domains → Add existing domain**
2. Enter `thegoodpapaya.com`
3. At your DNS registrar, add:

| Type | Name | Value |
|---|---|---|
| `A` | `@` | `23.227.38.65` |
| `CNAME` | `www` | `shops.myshopify.com` |

4. Back in Shopify → **Verify connection** → **Set as primary**

---

## 3 — Shopify theme

### Upload
```bash
# Install Shopify CLI
npm install -g @shopify/cli @shopify/theme

cd shopify-theme
shopify theme push --store your-store.myshopify.com
```

### Supabase keys as metafields
In Shopify Admin → **Settings → Custom data → Metafields → Shop**, add:

| Namespace | Key | Value |
|---|---|---|
| `thegoodpapaya` | `supabase_url` | `https://xxxx.supabase.co` |
| `thegoodpapaya` | `supabase_anon_key` | `eyJ...` |

### Create the page
Online Store → **Pages → Add page**
- Title: `Invoices`
- Template: `page.invoices`

---

## 4 — Sync service

```bash
cd sync-service
cp .env.example .env
# Fill in all values in .env

npm install
node index.js        # runs immediately then every 5 min
```

### Zoho OAuth one-time setup
1. Go to [api-console.zoho.in](https://api-console.zoho.in) → **Server-based Apps**
2. Redirect URI: `http://localhost:8080/callback` (just for getting the refresh token)
3. Scope: `ZohoBooks.invoices.READ`
4. Generate the refresh token once and put it in `.env`

### Zoho Organization ID
Zoho Books → **Settings → Organisation Profile** → Organisation ID

### Razorpay
Dashboard → **Settings → API Keys** → Generate key

---

## 5 — Sync service deployment

Deploy on any Node.js host (Railway, Render, Fly.io, or a simple VPS):

```bash
# Railway
railway init && railway up

# Or as a systemd service on a VPS
# Copy sync-service/ to server, set .env, npm install
# systemctl enable --now goodpapaya-sync
```

---

## Invoice flow

1. Ops team creates/confirms invoice in Zoho Books
2. Sync service detects it within 5 min, writes line items to Supabase, creates Razorpay payment link
3. Customer visits `thegoodpapaya.com/pages/invoices`
4. Logs in with mobile OTP
5. Sees last 5 invoices (paginated), each with **Pay now** and **PDF** buttons
6. Razorpay handles payment, redirects back with `?payment=success`
