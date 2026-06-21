-- Migration 011: Tighten RLS on operations table
-- Packers (authenticated) can only update final_quantity, status, last_updated_by
-- Only admin (service role / password gate) can insert or delete

-- Drop existing open policies
drop policy if exists "ops_insert" on operations;
drop policy if exists "ops_update" on operations;
drop policy if exists "ops_delete" on operations;

-- Packers: authenticated users can update ONLY packer-editable columns
-- Column-level restriction enforced in app + RLS prevents deletes
create policy "ops_update_auth" on operations
  for update
  to authenticated
  using (true)
  with check (true);

-- Insert and delete: service role only (via admin CSV upload)
-- Anon and authenticated users cannot insert or delete operations rows
