-- Migration 076: raw source text on whatsapp_parsed_orders
--
-- Every row parsed from a WhatsApp batch now carries the exact raw batch
-- text (tagged "[Sender | phone]: message" lines) it was parsed from, so
-- the Live tab can show it next to the parsed fields — lets a human catch
-- and correct a parsing mistake by comparing against what was actually
-- typed, instead of trusting the parse blind.

alter table public.whatsapp_parsed_orders add column if not exists raw_text text;
