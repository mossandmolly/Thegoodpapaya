-- Migration 024: Vegetable vs fruit category on catalog
--
-- The Good Papaya started as a fruit-only delivery service and added a
-- vegetable line in August 2026. Nothing in the schema previously
-- distinguished "vegetable" from "fruit" items — this backfills a
-- best-guess classification from item name keywords so sales analytics
-- (see the sales-dashboard function) can split revenue/orders by category.
--
-- Best-guess only: review `select item_name, category from catalog order by
-- category, item_name` after running this and correct any misclassified
-- item with `update catalog set category = 'vegetable' where item_name = '...'`.

ALTER TABLE catalog
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'fruit'
    CHECK (category IN ('vegetable', 'fruit'));

CREATE INDEX IF NOT EXISTS idx_catalog_category ON catalog(category);

-- Keyword list covers common vegetables sold by Indian grocery/produce
-- vendors (English + common Hindi/regional names customers use).
UPDATE catalog
SET category = 'vegetable'
WHERE item_name_normal ~ (
  '(' || array_to_string(ARRAY[
    'tomato', 'onion', 'potato', 'carrot', 'cabbage', 'cauliflower',
    'brinjal', 'eggplant', 'baingan', 'capsicum', 'bell pepper',
    'cucumber', 'kakdi', 'beans', 'peas', 'matar', 'lady finger',
    'ladies finger', 'bhindi', 'okra', 'spinach', 'palak', 'coriander',
    'dhania', 'methi', 'fenugreek', 'mint', 'pudina', 'curry leaves',
    'ginger', 'adrak', 'garlic', 'lehsun', 'chilli', 'chili', 'mirchi',
    'beetroot', 'chukandar', 'radish', 'mooli', 'drumstick', 'moringa',
    'bottle gourd', 'lauki', 'dudhi', 'ridge gourd', 'turai', 'tori',
    'bitter gourd', 'karela', 'pumpkin', 'kaddu', 'sweet potato',
    'shakarkand', 'yam', 'suran', 'colocasia', 'arbi', 'cluster beans',
    'gawar', 'broad beans', 'snake gourd', 'ash gourd', 'corn', 'maize',
    'bhutta', 'sweetcorn', 'zucchini', 'broccoli', 'leek', 'celery',
    'turnip', 'shallot', 'spring onion', 'lemongrass', 'raw banana',
    'plantain', 'sponge gourd'
  ], '|') || ')'
)
AND item_name_normal !~ '(fruit|tamarind)';
