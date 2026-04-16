-- Migration 006: RLS policies for operations dashboard
-- Ops dashboard uses anon key — grant minimum required access

-- ── Operations ────────────────────────────────────────────────
create policy "ops_read"   on operations for select using (true);
create policy "ops_insert" on operations for insert with check (true);
create policy "ops_update" on operations for update using (true);
create policy "ops_delete" on operations for delete using (true);

-- ── Packers ───────────────────────────────────────────────────
create policy "packers_read"   on packers for select using (true);
create policy "packers_write"  on packers for all using (true);

-- ── Packer assignments ────────────────────────────────────────
create policy "assignments_read"  on packer_assignments for select using (true);
create policy "assignments_write" on packer_assignments for all using (true);

-- ── Customer notes ────────────────────────────────────────────
create policy "notes_read"  on customer_notes for select using (true);
create policy "notes_write" on customer_notes for all using (true);

-- ── Communities ───────────────────────────────────────────────
create policy "communities_read" on communities for select using (true);
