-- Marks a community as a confirmed-real society name, distinct from
-- merely existing in the table (which happens automatically — and messily
-- — any time a new/misspelled name gets derived from an order). Intended
-- to gate the storefront's society search so customers never see junk.
--
-- Starting point only, not a real curation pass: a community someone
-- already bothered to set up for trip grouping (combinable_group) is
-- almost certainly real, so it's pre-marked verified to save some of the
-- manual work. Everything else starts false and needs a human look in
-- Config -> Communities.
alter table public.communities
  add column if not exists verified boolean not null default false;

update public.communities set verified = true
where combinable_group is not null and verified = false;
