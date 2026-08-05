-- Buyer role (new "Purchases" tab) logs an expense against each purchase
-- tranche already entered under Stock > Purchased — stock_purchases had no
-- price field at all until now, only qty/source. `cost` is the total ₹
-- spent on that one tranche (not a per-unit rate), entered by the buyer
-- after the fact; null until they fill it in.
alter table stock_purchases add column if not exists cost numeric;
