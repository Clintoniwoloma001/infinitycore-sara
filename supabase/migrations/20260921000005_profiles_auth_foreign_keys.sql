-- ============================================================
-- PROFILES — AUTH + EMPLOYEE FOREIGN-KEY INTEGRITY HARDENING
-- ------------------------------------------------------------
-- Guards against a repeat of the incident where a manually-run SQL
-- script wiped `profiles` rows and, before the manual restore via
-- `auth.users` + `employees`, left the app with orphaned/missing
-- profile rows (Super Admin access and the recruitment/approval
-- trigger flow broke until restored).
--
-- The base schema (schema.sql + schema_phase9) declares these FKs,
-- but nothing prevents a bad manual script (or a partially restored
-- environment) from dropping or never creating them. This migration
-- re-asserts them idempotently so auth-linked integrity is enforced
-- at the DB level:
--
--   1. profiles.id -> auth.users(id) ON DELETE CASCADE
--      Every profile row belongs to an auth user; deleting the auth
--      user can never orphan its profile (and a profile can never be
--      inserted for a nonexistent auth user).
--
--   2. profiles.employee_id -> employees(id) ON DELETE SET NULL
--      A bad manual insert can no longer point a profile at a
--      nonexistent employee; unlinking an employee nulls the link.
--
-- PRE-FLIGHT (do not skip): the FKs can only be created when no
-- orphaned values already exist. If profiles reference missing auth
-- users (or missing employees), the migration aborts with a clear
-- message naming the exact offending ids so the operator resolves
-- them first — failure is loud and self-diagnosing, never a silent
-- partial apply.
--
-- Idempotent + additive — safe to re-run. Never modifies existing
-- profiles/employees rows.
-- ============================================================

do $$
declare
  v_auth_orphans int;
  v_emp_orphans  int;
begin
  -- 1) profiles.id must exist in auth.users
  select count(*) into v_auth_orphans
    from public.profiles p
   where not exists (select 1 from auth.users u where u.id = p.id);

  if v_auth_orphans > 0 then
    raise notice 'Orphaned profile(s) with no matching auth.users row (%):', v_auth_orphans;
    raise info '%',
      (
        select string_agg(
          format('  id=%s email=%s created=%s', p.id, coalesce(p.email, '<null>'), coalesce(p.created_at::text, '?')),
          E'\n' order by p.created_at
        )
        from public.profiles p
        where not exists (select 1 from auth.users u where u.id = p.id)
      );
    raise exception 'profiles_auth_fk_aborted: % profile id(s) have no matching auth.users row. Restore or delete them first, then re-run this migration.', v_auth_orphans;
  end if;

  -- 2) profiles.employee_id (when populated) must exist in employees
  if to_regclass('public.employees') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles'
          and column_name = 'employee_id'
     ) then
    select count(*) into v_emp_orphans
      from public.profiles p
     where p.employee_id is not null
       and not exists (select 1 from public.employees e where e.id = p.employee_id);

    if v_emp_orphans > 0 then
      raise notice 'Profile(s) referencing a missing employee (%):', v_emp_orphans;
      raise info '%',
        (
          select string_agg(
            format('  profile=%s employee_id=%s', p.id, p.employee_id),
            E'\n' order by p.id
          )
          from public.profiles p
          where p.employee_id is not null
            and not exists (select 1 from public.employees e where e.id = p.employee_id)
        );
      raise exception 'profiles_employee_fk_aborted: % profile(s) reference a missing employee. Fix the links first, then re-run this migration.', v_emp_orphans;
    end if;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. profiles.id -> auth.users(id) ON DELETE CASCADE
--    (adds only if absent — id remains the primary key)
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_id_fkey'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. profiles.employee_id -> employees(id) ON DELETE SET NULL
--    (ensures the column exists, then adds the FK if absent)
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists employee_id uuid;

do $$
begin
  if to_regclass('public.employees') is not null
     and not exists (
       select 1 from pg_constraint
        where conname = 'profiles_employee_id_fkey'
          and conrelid = 'public.profiles'::regclass
     ) then
    alter table public.profiles
      add constraint profiles_employee_id_fkey
      foreign key (employee_id) references public.employees(id) on delete set null;
  end if;
end $$;