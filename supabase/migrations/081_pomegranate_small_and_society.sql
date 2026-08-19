-- Pomegranate small is a new canonical item (see FRUITS in
-- ops-dashboard/parser.html and whatsapp-listener/index.js) — track it on
-- the Stock tab the same way migration 078 did for the vegetable batch.
insert into stock_tracked_fruits (item_name)
values ('Pomegranate small')
on conflict (item_name) do nothing;

-- Best-effort society name, captured separately from customer_name so it
-- survives even when the WhatsApp listener can't derive a full
-- society+door customer_name (e.g. the sender's WhatsApp profile name is
-- just a bare first name, unlike the dashboard's image parser, which reads
-- screenshots of contacts already saved with full society+door names).
-- Shown as its own column in Order Overview so ops staff renaming a
-- fallback customer_name (like a bare first name) can still see which
-- society the order actually came from.
alter table public.orders add column if not exists society text;
