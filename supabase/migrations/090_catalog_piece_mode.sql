-- Lets these items be ordered by piece count on the storefront instead of
-- (or as well as) weight. sold_by_piece is the on/off flag; piece_approx_kg
-- is a rough guide shown to customers ("~1.2kg") — NEVER used for pricing.
-- Piece orders are always priced/weighed by staff at packing time and bill
-- at Zoho's live rate then, same as the WhatsApp parser already does for
-- piece orders outside its own kg/pc table.
alter table public.catalog add column if not exists sold_by_piece  boolean not null default false;
alter table public.catalog add column if not exists piece_approx_kg numeric;

-- 16 of these values are already established/in production use, reused
-- verbatim from the WhatsApp parser's own kg/pc table (ops-dashboard/
-- parser.html's PKG constant): gala apple, royal gala apple, washington
-- apple, green apple, pink lady apple, rockit apple, guava white, guava
-- pink, nati guava, robusta banana, pomegranate large, pomegranate medium,
-- pear, mandarin orange, valencia orange, plum.
--
-- The other 39 are rough average-produce-weight ESTIMATES, not verified
-- against this business's real stock — correct any of these directly:
--   update catalog set piece_approx_kg = <value> where item_name = '<name>';
update public.catalog c set
  sold_by_piece = true,
  piece_approx_kg = v.kg
from (values
  ('Bitter gourd',0.10), ('Bottle gourd',0.50), ('Brinjal bottle',0.15), ('Broccoli',0.35),
  ('Capsicum green',0.15), ('Capsicum red',0.15), ('Capsicum yellow',0.15), ('Cauliflower',0.60),
  ('Carrot',0.08), ('Chilli bhajji',0.05), ('Cucumber',0.20), ('Desi corn',0.25),
  ('Dragon red',0.35), ('Drumstick',0.08), ('Fenugreek',0.10), ('Gala apple',0.20),
  ('Green apple',0.20), ('Guava pink',0.40), ('Guava white',0.40), ('Lemon',0.06),
  ('Mandarin orange',0.10), ('Mangalore cucumber',0.30), ('Mangosteen',0.08), ('Muskmelon',1.20),
  ('Mosambi',0.15), ('Muskmelon striped',1.20), ('Nagpur orange',0.15), ('Nati guava',0.40),
  ('Onion',0.12), ('Papaya',0.80), ('Passion fruit',0.04), ('Pineapple',1.00),
  ('Pear',0.16), ('Plum',0.05), ('Pink lady apple',0.20), ('Pomegranate large',0.35),
  ('Pomegranate medium',0.35), ('Potato',0.12), ('Pomegranate small',0.20), ('Rambutan',0.03),
  ('Ridge gourd',0.20), ('Raw mango',0.30), ('Robusta banana',0.20), ('Rockit apple',0.20),
  ('Royal Gala apple',0.20), ('Sapota',0.10), ('Spinach',0.10), ('Sweet corn',0.25),
  ('Tomato',0.10), ('Valencia orange',0.25), ('Washington apple',0.20), ('Watermelon',3.00),
  ('White dragon',0.35), ('Yellow banana',0.15), ('Watermelon striped',3.00)
) as v(name, kg)
where lower(c.item_name) = lower(v.name);
