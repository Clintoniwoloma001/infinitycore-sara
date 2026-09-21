-- ============================================================
-- PHASE 64 — PAYROLL EXCEL IMPORT (structure takeover)
-- (run in Supabase SQL Editor after Phase 63; idempotent/additive)
-- ============================================================
-- Goal: let HR upload the CURRENT payroll Excel (.xlsx / .xls / .csv)
-- and have the system adopt that workbook as the payroll structure
-- going forward:
--
--   1. NEW table public.payroll_imports — ONE stored "active" import
--      carrying the adopted workbook structure verbatim:
--      columns jsonb = [{ "key", "label" }]  (header order preserved)
--      rows    jsonb = [{ <key>: value, ... }] for each data row.
--      Uploading a NEW file supersedes the previous active import
--      ONLY after the caller confirms the override (explicit flag).
--   2. NEW employees snapshot columns — payroll_import_id /
--      payroll_import_snapshot / payroll_import_at. Each row matched
--      to an employee (by staff identifier) records its imported
--      values on the employee profile ("update the employee profile
--      with those values"). Removal of an import clears snapshots.
--   3. RPC save_payroll_import(...) — SECURITY DEFINER, super_admin /
--      admin / hr_manager only. Validates the payload, returns
--      {ok:false, code:'override_required'} when an active import
--      already exists and p_confirm_override is false, otherwise
--      supersedes the previous import (flagged + snapshot cleared)
--      and writes matched rows to employees. Audited.
--   4. RPC get_active_payroll_import() — read-only fetch of the
--      current structure (columns + rows) for the Payroll Master tab.
--   5. RPC deactivate_payroll_import(...) — remove the import and
--      clear employee snapshots (reverts to the derived master).
--   6. RPC get_employee_payroll_import(employee_id) — the snapshot
--      for an employee's profile (Employee 360 → Payroll tab).
-- ============================================================

-- -- -- employees snapshot columns (additive) -- -- --
alter table public.employees
  add column if not exists payroll_import_id uuid,
  add column if not exists payroll_import_snapshot jsonb,
  add column if not exists payroll_import_at timestamptz;


-- ============================================================
-- 1. payroll_imports — the adopted workbook structure
-- ============================================================
create table if not exists public.payroll_imports (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  source_format text not null check (source_format in ('xlsx', 'xls', 'csv')),
  period_label text,
  currency text default 'NGN',
  match_key text,
  columns jsonb not null default '[]'::jsonb,
  rows jsonb not null default '[]'::jsonb,
  row_count integer default 0,
  matched_profiles integer default 0,
  imported_by uuid,
  imported_by_name text,
  created_at timestamptz default now(),
  is_active boolean default true
);

create index if not exists idx_payroll_imports_active on public.payroll_imports(is_active, created_at desc);

alter table public.payroll_imports enable row level security;

-- RLS: SELECT-only, restricted to payroll-viewing roles. Writes flow
-- exclusively through the SECURITY DEFINER RPCs below, so payroll
-- values never reach the browser except through the authorised RPCs.
drop policy if exists payroll_imports_select on public.payroll_imports;
create policy payroll_imports_select on public.payroll_imports
  for select to authenticated
  using (public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

grant select on public.payroll_imports to authenticated;


-- ============================================================
-- 3. save_payroll_import — adopt the uploaded workbook structure
-- ============================================================
create or replace function public.save_payroll_import(
  p_filename text,
  p_source_format text,
  p_period_label text default null,
  p_currency text default 'NGN',
  p_match_key text default null,
  p_columns jsonb default '[]'::jsonb,
  p_rows jsonb default '[]'::jsonb,
  p_confirm_override boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor text;
  v_import_id uuid;
  v_active uuid;
  v_row jsonb;
  v_code text;
  v_affected integer := 0;
  v_override boolean := false;
  v_col_count integer;
  v_row_count integer;
  v_period text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to import the payroll file';
  end if;
  if coalesce(btrim(p_filename), '') = '' then
    raise exception 'A file name is required';
  end if;
  if p_source_format not in ('xlsx', 'xls', 'csv') then
    raise exception 'Only .xlsx, .xls and .csv files are supported';
  end if;
  select count(*) into v_col_count from jsonb_array_elements(coalesce(p_columns, '[]'::jsonb));
  select count(*) into v_row_count from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb));
  if v_col_count = 0 then
    raise exception 'The file contains no recognizable column headers';
  end if;
  if v_row_count = 0 then
    raise exception 'The file contains no data rows';
  end if;

  -- an active import already exists → require explicit override
  select id into v_active from public.payroll_imports
  where is_active order by created_at desc limit 1;
  if v_active is not null and not coalesce(p_confirm_override, false) then
    return jsonb_build_object('ok', false, 'code', 'override_required');
  end if;
  if v_active is not null then
    update public.payroll_imports set is_active = false where is_active;
    update public.employees
    set payroll_import_id = null, payroll_import_snapshot = null, payroll_import_at = null
    where payroll_import_id = v_active;
    v_override := true;
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  v_period := nullif(btrim(coalesce(p_period_label, '')), '');

  insert into public.payroll_imports
    (filename, source_format, period_label, currency, match_key, columns, rows,
     row_count, imported_by, imported_by_name, is_active)
  values
    (p_filename, p_source_format, v_period, coalesce(nullif(btrim(p_currency), ''), 'NGN'),
     nullif(nullif(btrim(coalesce(p_match_key, '')), ''), ''),
     p_columns, p_rows, v_row_count, auth.uid(), v_actor, true)
  returning id into v_import_id;

  -- link imported rows to employee profiles by staff identifier
  if nullif(btrim(coalesce(p_match_key, '')), '') is not null then
    for v_row in select * from jsonb_array_elements(p_rows) loop
      v_code := nullif(btrim(coalesce(v_row ->> p_match_key, '')), '');
      if v_code is null then
        continue;
      end if;
      update public.employees e
      set payroll_import_id = v_import_id,
          payroll_import_snapshot = v_row,
          payroll_import_at = now()
      where coalesce(e.employee_code, e.employee_number, e.staff_id) = v_code
        and coalesce(e.is_archived, false) = false;
    end loop;
  end if;

  update public.payroll_imports
  set matched_profiles = (select count(*) from public.employees where payroll_import_id = v_import_id)
  where id = v_import_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_IMPORT_SAVED', 'payroll_import', v_import_id, v_actor,
    jsonb_build_object(
      'filename', p_filename,
      'source_format', p_source_format,
      'period_label', v_period,
      'currency', coalesce(nullif(btrim(p_currency), ''), 'NGN'),
      'match_key', nullif(btrim(coalesce(p_match_key, '')), ''),
      'columns', v_col_count,
      'rows', v_row_count,
      'matched_profiles', (select count(*) from public.employees where payroll_import_id = v_import_id),
      'override_applied', v_override
    ), 'info');

  return jsonb_build_object(
    'ok', true,
    'id', v_import_id,
    'filename', p_filename,
    'columns', v_col_count,
    'rows', v_row_count,
    'matched_profiles', (select count(*) from public.employees where payroll_import_id = v_import_id),
    'override_applied', v_override
  );
end; $$;

grant execute on function public.save_payroll_import(text, text, text, text, text, jsonb, jsonb, boolean) to authenticated;


-- ============================================================
-- 4. get_active_payroll_import — current adopted structure
-- ============================================================
create or replace function public.get_active_payroll_import()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_r record;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to view the payroll master';
  end if;
  select id, filename, source_format, period_label, currency, match_key,
         columns, rows, row_count, matched_profiles, imported_by_name, created_at
  into v_r
  from public.payroll_imports
  where is_active
  order by created_at desc
  limit 1;
  if v_r.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_r.id,
    'filename', v_r.filename,
    'source_format', v_r.source_format,
    'period_label', v_r.period_label,
    'currency', v_r.currency,
    'match_key', v_r.match_key,
    'columns', v_r.columns,
    'rows', v_r.rows,
    'row_count', v_r.row_count,
    'matched_profiles', v_r.matched_profiles,
    'imported_by_name', v_r.imported_by_name,
    'created_at', v_r.created_at
  );
end; $$;

grant execute on function public.get_active_payroll_import() to authenticated;


-- ============================================================
-- 5. deactivate_payroll_import — remove import + clear snapshots
-- ============================================================
create or replace function public.deactivate_payroll_import(
  p_import_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_actor text;
  v_existed boolean;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to modify the payroll import';
  end if;
  select exists(select 1 from public.payroll_imports where id = p_import_id) into v_existed;
  if not v_existed then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  update public.payroll_imports set is_active = false where id = p_import_id;

  update public.employees
  set payroll_import_id = null, payroll_import_snapshot = null, payroll_import_at = null
  where payroll_import_id = p_import_id;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_IMPORT_REMOVED', 'payroll_import', p_import_id, v_actor,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')), 'info');

  return jsonb_build_object('ok', true, 'id', p_import_id);
end; $$;

grant execute on function public.deactivate_payroll_import(uuid, text) to authenticated;


-- ============================================================
-- 6. get_employee_payroll_import — profile snapshot (Employee 360)
-- ============================================================
create or replace function public.get_employee_payroll_import(p_employee_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_columns jsonb;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to view payroll records';
  end if;
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then
    return null;
  end if;
  if v_emp.payroll_import_snapshot is null then
    return null;
  end if;
  select columns into v_columns
  from public.payroll_imports
  where id = v_emp.payroll_import_id;
  return jsonb_build_object(
    'import_id', v_emp.payroll_import_id,
    'snapshot', v_emp.payroll_import_snapshot,
    'columns', coalesce(v_columns, '[]'::jsonb),
    'at', v_emp.payroll_import_at
  );
end; $$;

grant execute on function public.get_employee_payroll_import(uuid) to authenticated;