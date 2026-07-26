# WhatsApp group listener → Good Papaya parser

A read-only listener. It never sends messages. It logs in as a **dedicated
secondary number**, watches one or more WhatsApp groups, batches new
messages, and sends each batch to the `parse-orders` Supabase function
(`liveText` mode) — the same canonical item list / aliases / pc-to-kg table
used by the tested image-screenshot parser.

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
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROUP_JIDS` (leave empty for
  the first run), `BATCH_WINDOW_MS` (optional, defaults to 45000).

## 3. Find your groups' JIDs (one-time discovery run)

Deploy with `GROUP_JIDS` empty. Open the Railway service's **Logs** tab —
the listener prints a QR code there as ASCII art.

Scan it with the secondary number's WhatsApp: **Settings → Linked Devices →
Link a Device**. Then send any message in each group you want watched — the
logs will print:

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
   the first unflushed message.
3. POST the batch to `parse-orders` (`liveText` mode) using
   `SUPABASE_SERVICE_ROLE_KEY`.
4. Print the parsed rows/flags to the logs, append them to
   `parsed-orders.log.jsonl` as an audit trail, and insert them into the
   `whatsapp_parsed_orders` Supabase table (migration
   `024_whatsapp_parsed_orders.sql`).

That table feeds a new "Live WhatsApp Orders" section on
[parser.html](https://goodpapaya-operations.netlify.app/parser.html) — a
separate, running list from the image-upload table on the same page, polled
every 20s, with its own Copy TSV / Push to operations / Clear controls.
"Push to operations" calls the same `add-orders` function the manual entry
page uses; "Clear" soft-hides rows (sets `cleared = true`, doesn't delete)
so new rows keep appending after a clear.

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
