-- Add phone_number to operations so every order row is traceable to a customer phone
alter table operations add column if not exists phone_number text;
