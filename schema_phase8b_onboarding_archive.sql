-- ============================================================
-- PHASE 8b: ONBOARDING LINK ARCHIVE SUPPORT
--
-- Adds soft-delete (archive) columns to employee_onboarding_links
-- so HR can remove revoked/expired links from the operational view
-- without destroying audit history.
--
-- ALL ADDITIVE. Safe to re-run. Non-destructive.
-- ============================================================

alter table public.employee_onboarding_links
  add column if not exists is_archived boolean default false;
alter table public.employee_onboarding_links
  add column if not exists archived_at timestamptz;
alter table public.employee_onboarding_links
  add column if not exists archived_by uuid references auth.users(id) on delete set null;

-- Backfill: existing rows get is_archived = false
update public.employee_onboarding_links
  set is_archived = false
  where is_archived is null;

alter table public.employee_onboarding_links
  alter column is_archived set default false;

create index if not exists idx_onb_links_archived on public.employee_onboarding_links(is_archived);
