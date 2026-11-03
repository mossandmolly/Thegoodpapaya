-- Migration 131: time-related standing instructions set deliver_by/deliver_after
--
-- A standing instruction like "deliver after 4pm" (Config -> Customer
-- Instructions) only ever reached orders as free text inside
-- delivery_instructions, so it never showed up as a timeline, the "Has
-- timeline" filter, or in sequencing. This reads the clock time out of the
-- instruction when it's saved and copies it onto each new order.
--
-- Same placement reasoning as migration 050: a database trigger, so every
-- order-creation path gets it. It's BEFORE INSERT on orders, and create-order
-- inserts with ignore-duplicates, so an existing order (add-on, same-day repeat)
-- is never touched and a time set or cleared by hand on an order stays as is.
--
-- Deliberately conservative: a wrong deadline reorders the delivery queue, so
-- anything not clearly a clock time sets nothing and is marked
-- time_needs_review, which Config shows on that instruction's row instead.

alter table public.customer_instructions
  add column if not exists deliver_after     time,
  add column if not exists deliver_by        time,
  add column if not exists time_needs_review boolean not null default false;

-- 12-hour clock. No am/pm stated: 1-7 reads as PM and 8-12 as written, matching
-- delivery hours. An hour of 13-23 is already 24-hour. Null if not a real time.
create or replace function public.instruction_clock(hh int, mm int, mer text)
returns time
language plpgsql
immutable
as $$
declare
  m text := left(replace(coalesce(mer, ''), '.', ''), 1);
begin
  if hh > 23 or coalesce(mm, 0) > 59 then return null; end if;
  if m in ('a', 'p') and (hh < 1 or hh > 12) then return null; end if;
  if m = 'p' then hh := case when hh = 12 then 12 else hh + 12 end;
  elsif m = 'a' then hh := case when hh = 12 then 0 else hh end;
  elsif hh between 1 and 7 then hh := hh + 12;
  elsif hh = 0 then return null;
  end if;
  return make_time(hh, coalesce(mm, 0), 0);
end;
$$;

-- A number with no am/pm or minutes only counts as a time when what follows
-- it can't be a unit: "after 4 only" is a time, "after 4 days" / "by 2 kg" isn't.
create or replace function public.instruction_is_clock_like(mm text, mer text, next_word text)
returns boolean
language sql
immutable
as $$
  select mm is not null
      or coalesce(mer, '') <> ''
      or coalesce(next_word, '') in
         ('', 'only', 'please', 'pls', 'plz', 'daily', 'every', 'everyday', 'sharp',
          'onwards', 'on', 'and', 'or', 'latest', 'always');
$$;

create or replace function public.parse_instruction_time(txt text,
  out deliver_after time, out deliver_by time, out needs_review boolean)
language plpgsql
immutable
as $$
declare
  -- groups: hour, minutes, am/pm (or a marker that just confirms it's a time)
  t constant text := '(\d{1,2})(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|baje|o.?clock)?(?![.:]?[0-9a-z])';
  s text := lower(coalesce(txt, ''));
  m text[];
  a time;
  b time;
begin
  needs_review := false;

  -- Differs by day: one time on every order would be wrong some days.
  if s ~ '\m(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays?|weekends?|alternate)\M' then
    needs_review := s ~ '\d\s*(am|pm|a\.m|p\.m)\M|\m(after|before|by|till|until|between)\s+\d|\m(morning|afternoon|evening|night)\M';
    return;
  end if;

  s := regexp_replace(s, '\m12\s*noon\M', '12pm', 'g');
  s := regexp_replace(s, '\m(noon|mid\s?day)\M', '12pm', 'g');

  -- Hinglish puts the word after the time: "4 baje ke baad", "4 baje tak".
  s := regexp_replace(s, '(\d{1,2}(?:[:.][0-5]\d)?\s*(?:am|pm)?)\s*(?:baje\s*)?(?:ke|k)\s+(?:baad|bad)\M', ' after \1 ', 'g');
  s := regexp_replace(s, '(\d{1,2}(?:[:.][0-5]\d)?\s*(?:am|pm)?)\s*(?:baje\s*)?(?:se\s+(?:pehle|pahle|phle)|tak)\M', ' before \1 ', 'g');

  -- Negation flips the bound: "not before 10am" is after 10am, "no delivery
  -- after 7pm" is by 7pm, "not home till 6pm" is after 6pm.
  s := regexp_replace(s, '\m(?:not|never|avoid|no|nobody|don.?t|dont)\s+(?:[a-z]+\s+){0,3}?(?:before|till|until|til)\M', ' after ', 'g');
  s := regexp_replace(s, '\m(?:not|never|avoid|no|nobody|don.?t|dont)\s+(?:[a-z]+\s+){0,3}?after\M', ' before ', 'g');
  s := regexp_replace(s, '\mno\s+later\s+than\M', ' before ', 'g');
  s := regexp_replace(s, '\mno\s+earlier\s+than\M', ' after ', 'g');

  -- Ranges: "between 2 and 4pm", "from 10 to 12", "2-4pm". Without "between" or
  -- "from", the end has to say am/pm, so "2-3 kg" and "2 to 4 pieces" don't count.
  m := regexp_match(s, '\m(between|btw|from)?\s*' || t || '\s*(?:and|to|-|–|&)\s*' || t || '\s*([a-z]*)');
  if m is not null
     and (m[1] is not null or m[7] ~ '^[ap]')
     and public.instruction_is_clock_like(m[6], m[7], m[8]) then
    b := public.instruction_clock(m[5]::int, m[6]::int, m[7]);
    a := public.instruction_clock(m[2]::int, m[3]::int, coalesce(nullif(m[4], ''), m[7]));
    -- "11 to 1pm", "10 to 12pm": the start doesn't share the end's am/pm.
    if a is not null and b is not null and a >= b and coalesce(m[4], '') !~ '^[ap]' then
      a := public.instruction_clock(m[2]::int, m[3]::int, 'am');
    end if;
    if a is not null and b is not null and a < b then
      deliver_after := a;
      deliver_by := b;
      return;
    end if;
  end if;

  m := regexp_match(s, '\m(?:after|from|post|onwards?\s+from)\s+(?:around\s+|about\s+)?' || t || '\s*([a-z]*)');
  if m is not null and public.instruction_is_clock_like(m[2], m[3], m[4]) then
    a := public.instruction_clock(m[1]::int, m[2]::int, m[3]);
  end if;

  m := regexp_match(s, '\m(?:before|by|till|til|until|upto|up\s+to)\s+(?:around\s+|about\s+)?' || t || '\s*([a-z]*)');
  if m is not null and public.instruction_is_clock_like(m[2], m[3], m[4]) then
    b := public.instruction_clock(m[1]::int, m[2]::int, m[3]);
  end if;

  if a is not null and b is not null and a >= b then
    needs_review := true;
    return;
  end if;

  deliver_after := a;
  deliver_by := b;

  -- Mentions a time of day, but not one that can be used as a bound.
  if a is null and b is null then
    needs_review := s ~ '\d\s*(am|pm|a\.m|p\.m)\M|\d:[0-5]\d|\m\d{1,2}\s*baje\M|\m(morning|afternoon|evening|night|lunch|subah|sham|shaam|dopahar|raat)\M';
  end if;
end;
$$;

create or replace function public.customer_instructions_parse_time()
returns trigger
language plpgsql
as $$
declare
  p record;
begin
  p := public.parse_instruction_time(new.instructions);
  new.deliver_after := p.deliver_after;
  new.deliver_by := p.deliver_by;
  new.time_needs_review := p.needs_review;
  return new;
end;
$$;

drop trigger if exists customer_instructions_parse_time on public.customer_instructions;
create trigger customer_instructions_parse_time
  before insert or update of instructions on public.customer_instructions
  for each row execute function public.customer_instructions_parse_time();

-- Fires the trigger above for instructions already saved.
update public.customer_instructions set instructions = instructions;

-- An order's own time wins: if either field came from the customer's message or
-- was typed in, the standing time is left out altogether. Mixing them could
-- build an impossible window ("after 4pm" standing, "by 2pm" today). Packer-only
-- instructions and pickups don't set a delivery time.
create or replace function public.orders_apply_standing_delivery_time()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  norm_key text;
  r record;
  a time;
  b time;
begin
  if new.deliver_by is not null or new.deliver_after is not null
     or coalesce(new.is_pickup, false) or new.customer_name is null then
    return new;
  end if;

  norm_key := lower(regexp_replace(new.customer_name, '[^a-zA-Z0-9]', '', 'g'));
  if norm_key = '' then
    return new;
  end if;

  -- Latest-edited instruction first, so if two disagree the newer one wins.
  for r in
    select ci.deliver_after, ci.deliver_by
      from public.customer_instructions ci
     where ci.normalized_key = norm_key
       and ci.target in ('delivery', 'both')
       and (ci.deliver_after is not null or ci.deliver_by is not null)
     order by ci.updated_at desc
  loop
    if a is null and r.deliver_after is not null and (b is null or r.deliver_after < b) then
      a := r.deliver_after;
    end if;
    if b is null and r.deliver_by is not null and (a is null or a < r.deliver_by) then
      b := r.deliver_by;
    end if;
  end loop;

  new.deliver_after := a;
  new.deliver_by := b;
  return new;
end;
$$;

drop trigger if exists orders_standing_delivery_time on public.orders;
create trigger orders_standing_delivery_time
  before insert on public.orders
  for each row execute function public.orders_apply_standing_delivery_time();
