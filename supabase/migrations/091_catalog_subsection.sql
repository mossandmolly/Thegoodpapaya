-- Groups items within the storefront's existing Fruits/Vegetables filter
-- into labeled subsections (e.g. "Daily Vegetables", "Seasonal Fruits") —
-- the top-level All/Fruits/Vegetables tabs are unchanged, this only adds
-- a finer grouping shown within whichever one is selected.
--
-- These are a reasonable starting taxonomy, not verified against how this
-- business actually thinks about its own catalog — correct any item
-- directly, e.g.:
--   update catalog set subsection = 'Daily Vegetables' where item_name = 'Broccoli';
alter table public.catalog add column if not exists subsection text;

update public.catalog set subsection = 'Daily Vegetables' where category = 'vegetable' and item_name in (
  'Tomato','Onion','Potato','Carrot','Cauliflower','Cabbage','Cucumber',
  'Capsicum green','Capsicum red','Capsicum yellow','Beans','Lady''s finger','Chilli green'
);
update public.catalog set subsection = 'Leafy Greens' where category = 'vegetable' and item_name in (
  'Spinach','Coriander','Fenugreek','Amaranthus','Banana leaves'
);
update public.catalog set subsection = 'Gourds & Other Vegetables' where category = 'vegetable' and subsection is null;

update public.catalog set subsection = 'Seasonal Fruits' where category = 'fruit' and (
  item_name ilike '%mango%' or item_name in ('Lychee','Jamun','Jamun flash','Longan','Mangosteen','Rambutan')
);
update public.catalog set subsection = 'Everyday Fruits' where category = 'fruit' and item_name in (
  'Gala apple','Royal Gala apple','Washington apple','Green apple','Pink lady apple','Rockit apple','Rose apple',
  'Yelakki banana','Yelakki banana organic','Robusta banana','Mandarin orange','Valencia orange','Nagpur orange',
  'Kinnow orange','Mosambi','Papaya','Watermelon','Watermelon organic','Watermelon striped','Muskmelon',
  'Muskmelon organic','Muskmelon striped','Pomegranate large','Pomegranate medium','Pomegranate small',
  'Pomegranate organic','Guava white','Guava pink','Nati guava','Pineapple'
);
update public.catalog set subsection = 'Exotic & Berries' where category = 'fruit' and subsection is null;
