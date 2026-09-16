-- ============================================================
-- PHASE 27 — IDENTITY MERGE (Infinity MFB · InfinityCore)
--
-- Consolidates the two InfinityCore identities that currently
-- represent ONE physical person into a canonical single identity,
-- resolved by EMAIL (never by guessed UUIDs).
--
--   CANONICAL / SUPER ADMIN (KEEP — already authenticated):
--     personal email (auth login): tamunosikiiwolomaclinton@gmail.com
--   OFFICIAL / DUPLICATE (FOLD):
--     work email: c.iwoloma@infinitymfb.com
--
-- CONTRACT:
--   * Additive + idempotent. Safe to re-run, safe on empty DB.
--   * Resolves rows by email only (auth.users/profiles/employees),
--     never by guessed UUIDs.
--   * Every child fold is DRIVE-BASED + self-guarding: the table is
--     checked with to_regclass() and the column with
--     information_schema before each UPDATE. If a table or column
--     does not exist in the target schema it is SKIPPED and reported
--     via a NOTICE — the migration never fails on schema drift.
--   * Both key classes are folded with the correct ID:
--       'auth' -> column FK targets auth.users        (employees that
--                 keep their user id in auth, e.g. performance_results,
--                 appraisal_results, leave_balances, ...)  -> auth U1
--       'emp'  -> column FK targets public.employees  (attendance,
--                 targets, payroll, KPIs, guarantors, ...)    -> emp E1
--   * Unique-index collisions are resolved BEFORE folding by
--     revoking/removing the DUPLICATE-side row so the canonical
--     row always wins (attendance_records, employee_auth_credentials,
--     employee_bankone_identifiers, employee_biometric_identifiers,
--     employee_digital_files, employee_supervisors, hierarchy_exceptions,
--     leave_balances, user_access_profiles).
--   * Audit/log tables (sara_audit_logs, user_approval_audit,
--     integration logs / outbound queue) are NOT rewritten.
--   * Canonical profile row is never written from bare SQL
--     (protect_super_admin_profile() only allows the super_admin
--     to self-edit). Only the DUPLICATE profile is deactivated,
--     guarded so a super_admin profile can never be demoted.
--   * No raw biometric data is ever stored or merged (WebAuthn only).
--
-- Run in Supabase SQL Editor OR apply as a migration. Wrapped in a
-- single transaction (begin/commit) so any failure rolls back.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. ADDITIVE COLUMNS (idempotent)
-- ------------------------------------------------------------
alter table public.employees
  add column if not exists personal_email text,
  add column if not exists work_email     text;

alter table public.profiles
  add column if not exists personal_email text,
  add column if not exists work_email     text;

comment on column public.employees.personal_email is
  'Personal (login) email — the infinitycore auth identity.';
comment on column public.employees.work_email is
  'Official Infinity MFB work email. Display/contact only — not an auth login.';
comment on column public.profiles.personal_email is
  'Personal (login) email mirror.';
comment on column public.profiles.work_email is
  'Official Infinity MFB work email mirror.';

-- ------------------------------------------------------------
-- 2. MERGE LOGIC (email-resolved, idempotent, logged)
-- ------------------------------------------------------------
do $$
declare
  v_personal_email constant text := 'tamunosikiiwolomaclinton@gmail.com';
  v_work_email     constant text := 'c.iwoloma@infinitymfb.com';

  v_auth_canon    uuid;   -- auth.users.id for the personal (login) email
  v_auth_dup      uuid;   -- auth.users.id for the official work email
  v_canon_emp_id  uuid;   -- employees.id carrying the personal identity
  v_dup_emp_id    uuid;   -- employees.id carrying the work identity
  v_canon_prof_id uuid;   -- profiles.id for the personal identity
  v_dup_prof_id   uuid;   -- profiles.id for the work identity
  v_canon_emp_name text;
  v_dup_emp_name   text;

  -- Drive-based fold list: {schema, table, column, kind}
  --   kind = 'auth' -> re-link with auth user U1/U2
  --   kind = 'emp'  -> re-link with employee E1/E2
  fold_list text[][] := array[
    -- Class A — column FK targets auth.users
    ['public','performance_results','employee_id','auth'],
    ['public','appraisal_results','employee_id','auth'],
    ['public','leave_balances','employee_id','auth'],
    ['public','transport_allowance_config','employee_id','auth'],
    ['public','employee_bankone_identifiers','employee_id','auth'],
    -- Class B — column FK targets public.employees
    ['public','attendance_records','employee_id','emp'],
    ['public','attendance_exceptions','employee_id','emp'],
    ['public','attendance_issues','employee_id','emp'],
    ['public','targets','employee_id','emp'],
    ['public','payroll','employee_id','emp'],
    ['public','employee_kpis','employee_id','emp'],
    ['public','employee_supervisors','employee_id','emp'],
    ['public','employee_guarantors','employee_id','emp'],
    ['public','employee_fidelity_bonds','employee_id','emp'],
    ['public','employee_education','employee_id','emp'],
    ['public','employee_work_history','employee_id','emp'],
    ['public','employee_digital_files','employee_id','emp'],
    ['public','employee_queries','employee_id','emp'],
    ['public','employee_appraisals','employee_id','emp'],
    ['public','employee_onboarding_submissions','employee_id','emp'],
    ['public','employee_account_invites','employee_id','emp'],
    ['public','employee_auth_credentials','employee_id','emp'],
    ['public','employee_biometric_identifiers','employee_id','emp'],
    ['public','webauthn_challenges','employee_id','emp'],
    ['public','hierarchy_exceptions','employee_id','emp'],
    ['public','hr_queries','employee_id','emp'],
    ['public','guarantor_verifications','employee_id','emp'],
    ['public','fidelity_bond_verifications','employee_id','emp'],
    ['public','bankone_import_rows','employee_id','emp'],
    ['public','bankone_transactions','employee_id','emp'],
    ['public','reconciliation_cases','employee_id','emp'],
    -- Class D — user_id FK -> auth.users
    ['public','attendance_events','user_id','auth'],
    ['public','employee_appraisals','user_id','auth'],
    ['public','employee_digital_files','user_id','auth'],
    ['public','employee_queries','user_id','auth'],
    ['public','integration_connections','user_id','auth'],
    ['public','kpi_assignments','user_id','auth'],
    ['public','kpi_submissions','user_id','auth'],
    ['public','notifications','user_id','auth'],
    ['public','user_access_profiles','user_id','auth'],
    ['public','work_plans','user_id','auth'],
    -- Class E — created_by FK -> auth.users
    ['public','leave_requests','created_by','auth'],
    ['public','loan_applications','created_by','auth'],
    ['public','offer_letters','created_by','auth'],
    ['public','support_cases','created_by','auth'],
    ['public','customers','created_by','auth'],
    ['public','hr_assessments','created_by','auth'],
    ['public','hr_jobs','created_by','auth'],
    ['public','data_import_jobs','created_by','auth'],
    ['public','attendance_devices','created_by','auth'],
    ['public','attendance_geofences','created_by','auth'],
    ['public','tasks','created_by','auth'],
    ['public','kpi_definitions','created_by','auth'],
    ['public','work_plans','created_by','auth'],
    ['public','employee_onboarding_links','created_by','auth'],
    ['public','bankone_column_mappings','created_by','auth'],
    -- Class F — created_by FK -> public.profiles (id == auth.users.id)
    ['public','webauthn_challenges','created_by','auth'],
    ['public','employee_auth_credentials','created_by','auth']
  ];
  f text[];
  v_to   uuid;
  v_from uuid;
  v_rows bigint;
begin
  -- 2a. RESOLVE AUTH IDENTITIES BY EMAIL ONLY.
  select u.id into v_auth_canon from auth.users u
    where lower(u.email) = lower(v_personal_email) limit 1;
  select u.id into v_auth_dup from auth.users u
    where lower(u.email) = lower(v_work_email) limit 1;

  -- 2b. RESOLVE EMPLOYEE ROWS (by auth link OR by stored email).
  select e.id into v_canon_emp_id from public.employees e
    where (v_auth_canon is not null and e.user_id = v_auth_canon)
       or lower(coalesce(e.email, '')) = lower(v_personal_email)
    limit 1;
  select e.id into v_dup_emp_id from public.employees e
    where e.id is distinct from v_canon_emp_id
      and ((v_auth_dup is not null and e.user_id = v_auth_dup)
        or lower(coalesce(e.email, '')) = lower(v_work_email)
        or lower(coalesce(e.work_email, '')) = lower(v_work_email))
    limit 1;

  select e.full_name into v_canon_emp_name from public.employees e where e.id = v_canon_emp_id;
  select e.full_name into v_dup_emp_name   from public.employees e where e.id = v_dup_emp_id;

  -- 2c. RESOLVE PROFILES (profiles.id == auth.users.id where present).
  select p.id into v_canon_prof_id from public.profiles p
    where lower(coalesce(p.email, '')) = lower(v_personal_email)
       or (v_auth_canon is not null and p.id = v_auth_canon)
    limit 1;
  select p.id into v_dup_prof_id from public.profiles p
    where lower(coalesce(p.email, '')) = lower(v_work_email)
       or lower(coalesce(p.work_email, '')) = lower(v_work_email)
       or (v_auth_dup is not null and p.id = v_auth_dup)
    limit 1;

  -- 2d. NORMALIZE EMAILS ON BOTH EMPLOYEE ROWS so the dual-email
  --     separation is explicit in the UI. (Canonical profile row is
  --     intentionally NOT written — protect_super_admin_profile().)
  if v_canon_emp_id is not null then
    update public.employees
       set personal_email = lower(v_personal_email),
           work_email     = lower(v_work_email)
     where id = v_canon_emp_id;
  end if;
  if v_dup_emp_id is not null then
    update public.employees
       set personal_email = lower(v_personal_email),
           work_email     = lower(v_work_email)
     where id = v_dup_emp_id;
  end if;

  -- 2e. UNIQUE-INDEX COLLISION GUARDS (canonical row always wins).
  --     auth.users-keyed guards.
  if v_auth_canon is not null and v_auth_dup is not null
     and v_auth_canon <> v_auth_dup then
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='leave_balances' and indexdef ilike '%unique%' and indexdef ilike '%(employee_id, year, leave_type)%') then
      delete from public.leave_balances lb
       where lb.employee_id = v_auth_dup
         and exists (select 1 from public.leave_balances c
                      where c.employee_id = v_auth_canon
                        and c.year = lb.year and c.leave_type = lb.leave_type);
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='employee_bankone_identifiers' and indexdef ilike '%unique%' and indexdef ilike '%(employee_id, bankone_staff_id)%') then
      delete from public.employee_bankone_identifiers d
       where d.employee_id = v_auth_dup
         and exists (select 1 from public.employee_bankone_identifiers c
                      where c.employee_id = v_auth_canon
                        and c.bankone_staff_id = d.bankone_staff_id);
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='user_access_profiles' and indexdef ilike '%unique%' and indexdef ilike '%(user_id)%') then
      delete from public.user_access_profiles d
       where d.user_id = v_auth_dup
         and exists (select 1 from public.user_access_profiles c where c.user_id = v_auth_canon);
    end if;
  end if;

  --     employees-keyed guards.
  if v_canon_emp_id is not null and v_dup_emp_id is not null
     and v_canon_emp_id <> v_dup_emp_id then
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='attendance_records' and indexdef ilike '%unique%' and indexdef ilike '%(employee_id, attendance_date)%') then
      delete from public.attendance_records d
       where d.employee_id = v_dup_emp_id
         and exists (select 1 from public.attendance_records c
                      where c.employee_id = v_canon_emp_id
                        and c.attendance_date = d.attendance_date);
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='employee_auth_credentials' and indexdef ilike '%unique%' and indexdef ilike '%(external_id)%') then
      update public.employee_auth_credentials
         set revoked_at = now()
       where employee_id = v_dup_emp_id
         and revoked_at is null
         and external_id in (select external_id from public.employee_auth_credentials
                              where employee_id = v_canon_emp_id and revoked_at is null);
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='employee_biometric_identifiers' and indexdef ilike '%unique%' and indexdef ilike '%(device_id, external_user_id)%') then
      delete from public.employee_biometric_identifiers d
       where d.employee_id = v_dup_emp_id
         and exists (select 1 from public.employee_biometric_identifiers c
                      where c.employee_id = v_canon_emp_id
                        and c.device_id = d.device_id
                        and c.external_user_id = d.external_user_id);
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='employee_digital_files' and indexdef ilike '%unique%' and indexdef ilike '%(employee_id)%') then
      delete from public.employee_digital_files d
       where d.employee_id = v_dup_emp_id
         and exists (select 1 from public.employee_digital_files c where c.employee_id = v_canon_emp_id);
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='employee_supervisors' and indexdef ilike '%unique%' and indexdef ilike '%(employee_id%') then
      delete from public.employee_supervisors d
       where d.employee_id = v_dup_emp_id
         and exists (select 1 from public.employee_supervisors c
                      where c.employee_id          = v_canon_emp_id
                        and c.supervisor_employee_id = d.supervisor_employee_id
                        and coalesce(c.level, 0) = coalesce(d.level, 0));
    end if;
    if exists (select 1 from pg_indexes where schemaname='public' and tablename='hierarchy_exceptions' and indexdef ilike '%unique%' and indexdef ilike '%(employee_id%') then
      delete from public.hierarchy_exceptions d
       where d.employee_id = v_dup_emp_id
         and exists (select 1 from public.hierarchy_exceptions c
                      where c.employee_id = v_canon_emp_id
                        and coalesce(c.source_supervisor_name, '') = coalesce(d.source_supervisor_name, '')
                        and coalesce(c.level, 0) = coalesce(d.level, 0));
    end if;
  end if;

  -- 2f. DRIVE-BASED FOLD: re-link every child column that actually
  --     exists in the target schema. Missing tables/columns are
  --     SKIPPED with a NOTICE (the migration never fails on drift).
  foreach f slice 1 in array fold_list loop
    v_from := case when f[4] = 'emp' then v_dup_emp_id else v_auth_dup end;
    v_to   := case when f[4] = 'emp' then v_canon_emp_id else v_auth_canon end;
    if v_from is null or v_to is null or v_from = v_to then
      continue;
    end if;
    if to_regclass(f[1] || '.' || f[2]) is null
       or not exists (select 1 from information_schema.columns c
                       where c.table_schema = f[1] and c.table_name = f[2] and c.column_name = f[3]) then
      raise notice 'phase27: SKIPPED %.%.% (table/column absent in this schema)', f[1], f[2], f[3];
      continue;
    end if;
    execute format('update %I.%I set %I = %L where %I = %L', f[1], f[2], f[3], v_to, f[3], v_from);
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      raise notice 'phase27: folded %.%.% (% rows)', f[1], f[2], f[3], v_rows;
    end if;
  end loop;

  -- 2g. SPECIAL OWNERSHIP COLUMNS (guarded, not in the drive list).
  if v_auth_canon is not null and v_auth_dup is not null
     and v_auth_canon <> v_auth_dup then
    if to_regclass('public.task_progress_reports') is not null
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='task_progress_reports' and column_name='submitted_by') then
      update public.task_progress_reports set submitted_by = v_auth_canon where submitted_by = v_auth_dup;
    end if;
    if to_regclass('public.work_tasks') is not null
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='work_tasks' and column_name='assigned_to_user_id') then
      update public.work_tasks set assigned_to_user_id = v_auth_canon where assigned_to_user_id = v_auth_dup;
    end if;
    if to_regclass('public.employee_appraisals') is not null
       and exists (select 1 from information_schema.columns where table_schema='public' and table_name='employee_appraisals' and column_name='reviewer_id') then
      update public.employee_appraisals set reviewer_id = v_auth_canon where reviewer_id = v_auth_dup;
    end if;
  end if;

  -- 2h. LEAVE REQUESTS RECORDED BY NAME — re-point to canonical name.
  --     Guarded against schema drift (employee_name may not exist).
  if v_canon_emp_id is not null and v_dup_emp_id is not null
     and v_canon_emp_id <> v_dup_emp_id
     and v_canon_emp_name is not null and v_dup_emp_name is not null
     and v_canon_emp_name <> v_dup_emp_name
     and to_regclass('public.leave_requests') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='leave_requests' and column_name='employee_name') then
    update public.leave_requests
       set employee_name = v_canon_emp_name
     where employee_name = v_dup_emp_name;
  end if;

  -- 2i. NO canonical employee row exists (only the work-email one):
  --     PROMOTE the work-identity employee as the canonical row and
  --     leave its user_id pointed at the canonical auth identity.
  if v_canon_emp_id is null and v_dup_emp_id is not null then
    update public.employees
       set user_id        = coalesce(v_auth_canon, user_id),
           personal_email = lower(v_personal_email),
           work_email     = lower(v_work_email)
     where id = v_dup_emp_id;
    raise notice 'phase27: promoted employee % as canonical', v_dup_emp_id;
  end if;

  -- 2i2. DUPLICATE EMPLOYEE — when a canonical employee row already
  --      exists, deactivate + detach the duplicate work-identity
  --      employee row. Reversible; never touches the canonical row
  --      (mutually exclusive with the promote branch above).
  if v_dup_emp_id is not null and v_canon_emp_id is not null
     and v_dup_emp_id <> v_canon_emp_id then
    update public.employees
       set employment_status = 'inactive',
           user_id           = null
     where id = v_dup_emp_id
       and (user_id is null or user_id <> v_auth_canon)
       and (employment_status is distinct from 'inactive' or user_id is not null);
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      raise notice 'phase27: deactivated duplicate employee % (row retained)', v_dup_emp_id;
    end if;
  end if;

  -- 2j. DUPLICATE PROFILE — deactivate in-app account; guard so a
  --     super_admin profile can never be demoted by this script.
  if v_dup_prof_id is not null and (v_canon_prof_id is null or v_dup_prof_id <> v_canon_prof_id) then
    update public.profiles
       set status      = 'inactive',
           approved    = false,
           employee_id = coalesce(v_canon_emp_id, employee_id)
     where id = v_dup_prof_id
       and role <> 'super_admin';
  end if;

  -- 2k. DUPLICATE AUTH ACCOUNT — ban the login (reversible). NEVER deleted.
  if v_auth_dup is not null and v_auth_canon is not null
     and v_auth_dup <> v_auth_canon then
    update auth.users
       set banned_until = now()
     where id = v_auth_dup
       and banned_until is null;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      raise notice 'phase27: banned duplicate auth identity % (row retained)', v_auth_dup;
    end if;
  end if;

  raise notice 'phase27: identity merge complete (idempotent).';
end $$;

-- ------------------------------------------------------------
-- 3. VERIFY — one canonical identity, duplicate deactivated/banned
-- ------------------------------------------------------------
select
  (select count(*) from public.profiles
    where lower(coalesce(email,'')) = lower('tamunosikiiwolomaclinton@gmail.com')
       or lower(coalesce(personal_email,'')) = lower('tamunosikiiwolomaclinton@gmail.com'))
     as canonical_profile_rows,
  (select count(*) from public.profiles
    where lower(coalesce(email,'')) = lower('c.iwoloma@infinitymfb.com')
       and role <> 'super_admin'
       and status <> 'inactive')
     as active_duplicate_profile_rows,
  (select count(*) from public.employees
    where (lower(coalesce(email,'')) = lower('c.iwoloma@infinitymfb.com')
       or lower(coalesce(work_email,'')) = lower('c.iwoloma@infinitymfb.com'))
       and employment_status <> 'inactive')
     as active_official_employee_rows,
  (select count(*) from auth.users u
    where lower(u.email) = lower('c.iwoloma@infinitymfb.com')
      and u.banned_until is not null)
     as duplicate_auth_banned;

commit;