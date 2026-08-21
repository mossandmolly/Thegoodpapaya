-- Powers the new customer storefront's Fruits/Vegetables grouping and
-- product thumbnails. category didn't exist anywhere before this — the
-- only prior source of "is this a vegetable" was the hardcoded
-- VEGETABLE_ITEM_NAMES list in ops-dashboard/parser.html (and its copies
-- in whatsapp-listener/index.js and parse-orders/index.ts, which stay as
-- they are — this is a one-time data backfill, not a refactor of those
-- parser prompts).
alter table public.catalog add column if not exists category  text; -- 'fruit' | 'vegetable'
alter table public.catalog add column if not exists image_url text;

update public.catalog
set category = 'vegetable'
where item_name in (
  'Cauliflower','Cabbage','Capsicum green','Capsicum yellow','Capsicum red','Carrot','Tomato',
  'Ginger','Beans','Lady''s finger','Cucumber','Coriander','Chilli green','Potato','Onion',
  'Ridge gourd','Bitter gourd','Bottle gourd','Brinjal bottle','Broccoli','Banana leaves',
  'Spinach','Amaranthus','Fenugreek','Mangalore cucumber','Drumstick','Chilli bhajji','Coccinia'
)
and (category is null or category <> 'vegetable');

-- Everything else already active in the catalog is a fruit — this table
-- has never carried anything else (see sync-catalog/index.ts, which pulls
-- the business's full active Zoho item list wholesale).
update public.catalog
set category = 'fruit'
where category is null;
