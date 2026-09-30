-- ============================================================================
-- LIVE PERMISSION PROPAGATION + LOCATION SYNC SUPPORT
-- ============================================================================
-- Additive. No table is dropped, renamed or truncated, and no historical
-- location row or existing grant is touched.
--
-- 1. REALTIME PUBLICATION
--    The web client subscribes to postgres_changes on user_permissions /
--    role_permissions so a Super Admin's grant reaches the affected user's open
--    tab immediately. The tables existed with RLS, but were never added to the
--    realtime publication, so the subscription silently delivered nothing and
--    the only way a permission ever changed was a manual re-login.
--
--    This is what makes "granted but still hidden" fixable without asking the
--    user to clear a cache: the client had no way to be told.
--
-- 2. USER_ROLES REPLICA IDENTITY
--    Same publication, same reason: a role reassignment must also propagate.
--
-- 3. LOCATION OBSERVATION IDEMPOTENCY INDEX
--    record_employee_location() already dedupes on
--    (employee_id, recorded_at, latitude, longitude). The supporting index is
--    verified/created here so a growing history does not turn every retried
--    offline upload into a sequential scan. Additive and safe: an equivalent
--    index is simply left in place.
-- ============================================================================
begin;

-- 1. Realtime publication for permission changes ---------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_permissions'
  ) then
    alter publication supabase_realtime add table public.user_permissions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'role_permissions'
  ) then
    alter publication supabase_realtime add table public.role_permissions;
  end if;
end $$;

-- 2. Replica identity for the filterable permission tables -----------------------
--    'full' is required for a DELETE to be delivered with its old row, which is
--    how a REVOKE reaches the client.
alter table public.user_permissions  replica identity full;
alter table public.role_permissions replica identity full;

-- user_roles only exists in environments that use it.
do $$
begin
  if to_regclass('public.user_roles') is not null then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_roles'
    ) then
      alter publication supabase_realtime add table public.user_roles;
    end if;
    alter table public.user_roles replica identity full;
  end if;
end $$;

-- 3. Location dedupe / lookup index ----------------------------------------------
-- The tracking tables are added by an earlier migration. This is guarded rather
-- than assumed, so applying the permission/publication half of this file to an
-- environment that has not run the tracking migration yet cannot fail the whole
-- deployment (and vice versa).
do $$
begin
  if to_regclass('public.employee_location_events') is not null then
    -- Supports the ON CONFLICT dedupe in record_employee_location(), so a
    -- retried offline upload is an index probe rather than a sequential scan.
    create index if not exists employee_location_events_observation_uniq_idx
      on public.employee_location_events (employee_id, recorded_at, latitude, longitude);

    -- Supports "who is where right now" and the per-employee history the
    -- tracking UI reads.
    create index if not exists employee_location_events_employee_recorded_idx
      on public.employee_location_events (employee_id, recorded_at desc);
  end if;
end $$;

commit;
