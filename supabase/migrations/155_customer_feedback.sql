-- Short "what can we improve / would you recommend us" survey shown next
-- to My Invoices (storefront/invoices.html) — fully public, anonymous-
-- capable submission (no login on the storefront), so RLS allows anon
-- INSERT only. No anon SELECT — a customer should never be able to read
-- anyone else's feedback back out through the same public anon key.
-- authenticated (ops-dashboard) gets read access for a future review view.
create table if not exists public.customer_feedback (
  id uuid primary key default gen_random_uuid(),
  phone_number     text,
  improvement_text text,
  -- "Would you recommend us to a friend?" as a 5-point smiley scale, not a
  -- 10-point NPS — 1 = not right now, 5 = absolutely.
  recommend_score  int check (recommend_score between 1 and 5),
  created_at       timestamptz not null default now()
);

alter table public.customer_feedback enable row level security;

drop policy if exists "anon insert" on public.customer_feedback;
create policy "anon insert" on public.customer_feedback
  for insert to anon with check (true);

drop policy if exists "authenticated read" on public.customer_feedback;
create policy "authenticated read" on public.customer_feedback
  for select to authenticated using (true);
