# WhatsApp group listener → Good Papaya parser

A read-only listener. It never sends messages. It logs in as a **dedicated
secondary number**, watches one or more WhatsApp groups, batches new
messages, and sends each batch to the same `/.netlify/functions/parse`
proxy that `parser.html`'s image-upload flow calls — using the exact same
rules prompt (canonical item list, aliases, pc-to-kg table, society list,
name-stripping, reply/add-on detection). The listener itself has no order
intelligence: it only batches raw text and forwards it. All parsing
decisions happen in that one Claude call.

---

## 1. Get a dedicated number

Use a cheap prepaid SIM, NOT your business/personal number. Activate
WhatsApp on it (any spare phone). This is the number that carries the ban
risk — keep it disposable, and keep that phone charged and online at least
once every ~2 weeks (WhatsApp force-logs-out linked devices if the primary
phone stays offline too long).

## 2. Deploy to Railway

- railway.app → New Project → Deploy from GitHub repo → select this
  `whatsapp-listener` folder as the service root.
- **Attach a volume** mounted at `/app/auth` (Settings → Volumes). Without
  this, the WhatsApp session is lost on every redeploy/restart and you'd
  have to re-scan the QR code each time.
- Set environment variables (Settings → Variables) from `.env.example`:
  `PARSE_FUNCTION_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `CRON_SECRET` (same value already set on the Supabase project — enables
  pushing parsed rows straight into orders, tagged pending_review, on top
  of the existing whatsapp_parsed_orders/Live tab write),
  `GROUP_JIDS` (leave empty for the first run), `BATCH_WINDOW_MS`
  (optional, defaults to 45000).

## 3. Find your groups' JIDs (one-time discovery run)

Deploy with `GROUP_JIDS` empty. Open the Railway service's **Logs** tab.

By default the listener prints a QR code there as ASCII art — scan it with
the secondary number's WhatsApp: **Settings → Linked Devices → Link a
Device**. QR codes expire quickly and WhatsApp only allows a handful of
refreshes before giving up (`408 "QR refs attempts ended"`), so have the
camera open and ready before it appears.

If QR scanning keeps failing, set `PAIRING_PHONE_NUMBER` instead (digits
only, country code first, e.g. `919876543210`) and redeploy — the listener
will print an 8-character code to type into WhatsApp under **Settings →
Linked Devices → Link a Device → "Link with phone number instead"**,
skipping the QR race entirely. Remove the variable once linked.

Either way, once linked, then send any message in each group you want
watched — the logs will print:

```
[discover] My Customer Group  =>  120363021234567890@g.us
```

Copy each JID you need.

## 4. Add the number to your groups

The listener can only read groups the secondary number is actually a
member of — same as adding any regular contact. Add it to every group you
want monitored (save it as a clear contact name, e.g. "Good Papaya Order
Log", and drop a one-line notice in each group that messages are logged —
keeps this transparent and compliant with India's DPDP Act).

## 5. Configure and restart

In Railway → Variables, set `GROUP_JIDS` to a comma-separated list of the
JIDs from step 3, then redeploy. The listener will now:

1. Watch every configured group.
2. Batch each group's messages for `BATCH_WINDOW_MS` (default 45s) after
   the first unflushed message — the window starts on the first message in
   an empty batch and does not reset on later ones, so a burst of messages
   more than ~45s apart lands in two separate parses.
3. Tag each message with the sender's real WhatsApp display name, and with
   any quoted/replied-to text (so reply "also add 2kg mango" messages get
   the same add-on treatment as a screenshot's quoted grey box).
4. POST the batch to `/.netlify/functions/parse` using the exact rules
   prompt from `parser.html`.
5. Write the parsed rows into the `whatsapp_parsed_orders` Supabase table
   (migration `041_whatsapp_parsed_orders.sql`), append them to
   `parsed-orders.log.jsonl` as an audit trail, and print them to the logs.

The listener never touches `orders`/`order_items` directly and never calls
a Supabase edge function — that only happens when a human reviews the
"Live" tab on `parser.html` and clicks **Push to operations**, which reuses
the exact same `create-order` + `order_items` flow the image-upload parser
already uses.

---

## Guardrails (keep the ban risk low)

- **Read-only.** This script never calls `sendMessage`. That avoids almost
  all of the behavioural ban triggers (volume, spam reports, unanswered-
  message counting).
- **Disposable number, not your main one.** If it's banned, just add a
  fresh number to the groups (you're admin) and re-scan.
- **You stay the human admin.** Never make the listener number the sole
  admin, so the group survives a number ban untouched.
- **Persistent session, single IP.** Don't log in/out repeatedly or hop
  regions — this is why the Railway volume in step 2 matters.
- **Consent.** The one-line notice in each group (step 4) removes report
  risk and covers you under India's DPDP Act.
- Residual risk remains: protocol-level detection can still ban the
  number, especially right after WhatsApp pushes an update. Treat this as
  "works until it doesn't" and keep number-swapping cheap.
