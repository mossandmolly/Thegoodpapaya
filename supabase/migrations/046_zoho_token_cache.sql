-- Shared Zoho OAuth access-token cache across ALL edge functions that talk
-- to Zoho (generate-invoice, cancel-order, download-invoice, and any future
-- one). Each of those functions already caches the token in a module-level
-- variable, but that cache is private to that one function's own isolate —
-- switching between actions (e.g. downloading invoices, then generating
-- more) meant each function fetched its OWN fresh token from Zoho, working
-- against the very rate limit the per-function cache was meant to avoid
-- ("You have made too many requests continuously"). A single shared row
-- lets every function reuse the same token and refresh it only once across
-- the whole system, not once per function.
--
-- Single-row table (id is always 1) — simplest possible shared cache, no
-- need for a generic key-value table for just one value.

create table if not exists public.zoho_token_cache (
  id           int primary key default 1,
  access_token text not null,
  expires_at   timestamptz not null,
  updated_at   timestamptz not null default now(),
  constraint zoho_token_cache_single_row check (id = 1)
);

-- getZohoToken()'s upsert only ever sets access_token/expires_at, relying
-- on this trigger (not an explicit value) to keep updated_at meaningful —
-- it's the one field that tells you how often a real Zoho refresh actually
-- happened, as opposed to a cache hit.
drop trigger if exists zoho_token_cache_updated_at on public.zoho_token_cache;
create trigger zoho_token_cache_updated_at
  before update on public.zoho_token_cache
  for each row execute function update_updated_at();

alter table public.zoho_token_cache enable row level security;
-- Service-role only, same as `orders` — this is an internal credential
-- cache, never read or written directly by the frontend.
