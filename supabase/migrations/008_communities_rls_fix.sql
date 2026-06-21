-- Migration 008: Fix missing insert policy on communities table
-- The operations insert trigger writes to communities but 006 only granted SELECT

create policy "communities_write" on communities for insert with check (true);
