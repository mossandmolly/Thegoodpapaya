-- Adds Parwal, Spine gourd, Long beans to stock tracking, same pattern as
-- migrations 078/085/093/095/096 — item_name must match the catalog row
-- exactly for the Stock tab to actually display it. None of these three
-- are in the canonical WhatsApp/parser item list yet (whatsapp-listener,
-- parse-orders) or confirmed as active Zoho catalog items, so this alone
-- won't show data until both of those catch up.
insert into stock_tracked_fruits (item_name)
values
  ('Parwal'),
  ('Spine gourd'),
  ('Long beans')
on conflict (item_name) do nothing;
