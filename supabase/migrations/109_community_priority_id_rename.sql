-- Renaming a community_priority.unique_id from the Config UI needs every
-- child table to follow the new id automatically within the same update.
-- community_priority_keywords already got ON UPDATE CASCADE in migration
-- 108; the combinable-group membership table was missed — add it here so
-- an in-place unique_id rename doesn't hit an FK violation or orphan a
-- group's membership row.
alter table public.community_combinable_group_members
  drop constraint if exists community_combinable_group_members_community_unique_id_fkey;
alter table public.community_combinable_group_members
  add constraint community_combinable_group_members_community_unique_id_fkey
  foreign key (community_unique_id) references public.community_priority(unique_id)
  on update cascade on delete cascade;
