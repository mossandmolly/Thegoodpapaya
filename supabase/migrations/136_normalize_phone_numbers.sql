-- One-time cleanup: strip country code and spacing from every phone number
-- already stored, to match the new normalize-on-save rule (set-order-phone,
-- create-order-payment-link). "+91 98766 97877" / "91-9876697877" all
-- become "9876697877" — keep only the last 10 digits once there are more
-- than 10, same country-code-agnostic rule the application code now uses.
--
-- customer_phones needs a dedupe pass FIRST: its primary key is
-- (customer_name, phone_number), so if one customer has two rows that
-- normalize to the same 10 digits (e.g. one saved as "+919876697877", one
-- as "9876697877"), updating both would collide on that key. Keeps
-- whichever row is newest per (customer_name, normalized number) and drops
-- the rest before normalizing what remains. orders and invoice_line_items
-- have no such constraint on phone — straightforward column updates.

create or replace function pg_temp.normalize_phone(raw text) returns text as $$
  select case when length(regexp_replace(raw, '\D', '', 'g')) > 10
              then right(regexp_replace(raw, '\D', '', 'g'), 10)
              else regexp_replace(raw, '\D', '', 'g')
         end;
$$ language sql immutable;

-- 1. Dedupe customer_phones rows that would collide after normalization —
--    keep the newest, drop the rest.
delete from public.customer_phones a
using public.customer_phones b
where a.customer_name = b.customer_name
  and pg_temp.normalize_phone(a.phone_number) = pg_temp.normalize_phone(b.phone_number)
  and a.created_at < b.created_at;

-- 2. Normalize what's left in customer_phones.
update public.customer_phones
set phone_number = pg_temp.normalize_phone(phone_number)
where phone_number is not null
  and phone_number <> pg_temp.normalize_phone(phone_number);

-- 3. orders.phone — no uniqueness constraint, plain update.
update public.orders
set phone = pg_temp.normalize_phone(phone)
where phone is not null
  and phone <> ''
  and phone <> pg_temp.normalize_phone(phone);

-- 4. invoice_line_items.phone_number — same, no uniqueness constraint.
update public.invoice_line_items
set phone_number = pg_temp.normalize_phone(phone_number)
where phone_number is not null
  and phone_number <> ''
  and phone_number <> pg_temp.normalize_phone(phone_number);
