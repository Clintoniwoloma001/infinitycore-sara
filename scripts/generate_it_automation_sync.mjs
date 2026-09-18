#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'data', 'it_automation_list.psv')
const OUTPUT = join(ROOT, 'schema_phase51_it_automation_sync.sql')
const EXPECTED_ROWS = 215

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ')
const sql = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`
const nullableSql = (value) => {
  const cleanValue = clean(value)
  return cleanValue ? sql(cleanValue) : 'null'
}

const lines = readFileSync(SOURCE, 'utf8').split(/\r?\n/).filter(Boolean)
const headers = lines.shift().split('|')
const expectedHeaders = ['sn', 'staff_id', 'full_name', 'status', 'designation', 'department', 'branch', 'gender', 'email', 'supervisor1', 'supervisor2', 'supervisor3']
if (headers.join('|') !== expectedHeaders.join('|')) throw new Error(`Unexpected source headers: ${headers.join('|')}`)

const rows = lines.map((line, index) => {
  const cells = line.split('|')
  if (cells.length !== expectedHeaders.length) throw new Error(`Source row ${index + 2} has ${cells.length} columns, expected ${expectedHeaders.length}`)
  const [sn, staffId, fullName, status, designation, department, branch, gender, email, supervisor1, supervisor2, supervisor3] = cells.map(clean)
  return { sn: Number(sn), staffId, fullName, status, designation, department, branch, gender, email, supervisor1, supervisor2, supervisor3 }
})

const duplicates = [...rows.reduce((map, row) => map.set(row.staffId, (map.get(row.staffId) || 0) + 1), new Map())]
  .filter(([, count]) => count > 1)
  .map(([staffId, count]) => `${staffId} (${count})`)

function valuesSql() {
  return rows.map((row) => `  (${row.sn}, ${sql(row.staffId)}, ${sql(row.fullName)}, ${sql(row.status)}, ${sql(row.designation)}, ${sql(row.department)}, ${sql(row.branch)}, ${nullableSql(row.gender)}, ${nullableSql(row.email)}, ${nullableSql(row.supervisor1)}, ${nullableSql(row.supervisor2)}, ${nullableSql(row.supervisor3)})`).join(',\n')
}

const output = `-- ============================================================
-- PHASE 51 — IT AUTOMATION LIST HR MASTER SYNC
-- Generated from data/it_automation_list.psv.
-- Re-run scripts/generate_it_automation_sync.mjs after source changes.
-- ============================================================

begin;

create temporary table _it_automation_source (
  sn integer not null,
  staff_id text not null,
  full_name text not null,
  confirmation_status text not null,
  designation text not null,
  department text not null,
  branch_name text not null,
  gender text,
  email text,
  supervisor1 text,
  supervisor2 text,
  supervisor3 text
) on commit preserve rows;

insert into _it_automation_source (
  sn, staff_id, full_name, confirmation_status, designation, department,
  branch_name, gender, email, supervisor1, supervisor2, supervisor3
) values
${valuesSql()};

do $$
declare
  v_duplicate text;
begin
  if (select count(*) from _it_automation_source) <> ${EXPECTED_ROWS} then
    raise exception 'IT_AUTOMATION_LIST contains % rows; expected ${EXPECTED_ROWS}. No data was changed.',
      (select count(*) from _it_automation_source);
  end if;

  select string_agg(staff_id || ' (' || row_count || ')', ', ' order by staff_id)
    into v_duplicate
  from (
    select staff_id, count(*) as row_count
    from _it_automation_source
    group by staff_id
    having count(*) > 1
  ) duplicates;
  if v_duplicate is not null then
    raise exception 'Duplicate STAFF ID values in IT_AUTOMATION_LIST: %. No data was changed.', v_duplicate;
  end if;
end;
$$;

create unique index if not exists uq_employees_staff_id
  on public.employees (staff_id)
  where staff_id is not null;

create temporary table _it_branch_results (branch_name text, action text) on commit preserve rows;
do $$
declare
  r record;
  v_branch_id uuid;
begin
  for r in
    select distinct on (lower(trim(branch_name))) trim(branch_name) as branch_name
    from _it_automation_source
    order by lower(trim(branch_name)), sn
  loop
    select b.id into v_branch_id
    from public.branches b
    where lower(trim(b.branch_name)) = lower(trim(r.branch_name))
    order by b.created_at nulls first, b.id
    limit 1;

    if v_branch_id is null then
      insert into public.branches (branch_name, status)
      values (r.branch_name, 'active')
      returning id into v_branch_id;
      insert into _it_branch_results values (r.branch_name, 'new');
    else
      update public.branches
      set branch_name = r.branch_name, status = 'active', updated_at = now()
      where id = v_branch_id;
      insert into _it_branch_results values (r.branch_name, 'updated');
    end if;
  end loop;
end;
$$;

insert into public.departments (code, name, is_active)
select distinct
  upper(regexp_replace(trim(department), '[^A-Za-z0-9]+', '_', 'g')),
  trim(department),
  true
from _it_automation_source
on conflict (code) do update set name = excluded.name, is_active = true;

insert into public.designations (title, department, category, is_active)
select distinct trim(designation), trim(department), trim(department), true
from _it_automation_source
on conflict (title, department) do update set is_active = true;

insert into public.employees (
  full_name, email, phone, department, "position", gender,
  staff_id, employee_number, employee_code, branch, branch_id,
  confirmation_status, employment_status, designation_id,
  source, import_source, imported_from_bank_master, updated_at
)
select
  s.full_name,
  case when lower(trim(s.email)) in ('', 'n/a') then null else trim(both ',' from lower(trim(s.email))) end,
  null,
  s.department,
  s.designation,
  nullif(s.gender, ''),
  s.staff_id,
  s.staff_id,
  s.staff_id,
  s.branch_name,
  b.id,
  s.confirmation_status,
  'active',
  d.id,
  'bank_master_import',
  'IT_AUTOMATION_LIST',
  true,
  now()
from _it_automation_source s
left join lateral (
  select id from public.branches b
  where lower(trim(b.branch_name)) = lower(trim(s.branch_name))
  order by b.created_at nulls first, b.id
  limit 1
) b on true
left join public.designations d
  on d.title = s.designation and d.department = s.department
on conflict (staff_id) where staff_id is not null do update set
  full_name = excluded.full_name,
  email = excluded.email,
  department = excluded.department,
  "position" = excluded."position",
  gender = excluded.gender,
  employee_number = excluded.employee_number,
  employee_code = excluded.employee_code,
  branch = excluded.branch,
  branch_id = excluded.branch_id,
  confirmation_status = excluded.confirmation_status,
  employment_status = excluded.employment_status,
  designation_id = excluded.designation_id,
  source = 'bank_master_import',
  import_source = 'IT_AUTOMATION_LIST',
  imported_from_bank_master = true,
  updated_at = now();

create temporary table _it_employee_map on commit preserve rows as
select s.*, e.id as employee_id
from _it_automation_source s
join public.employees e on e.staff_id = s.staff_id;

delete from public.employee_supervisors es
using _it_employee_map m
where es.employee_id = m.employee_id;

do $$
declare
  r record;
  v_level integer;
  v_source_name text;
  v_supervisor_id uuid;
  v_match_count integer;
begin
  for r in select * from _it_employee_map loop
    for v_level in 1..3 loop
      v_source_name := case v_level when 1 then nullif(trim(r.supervisor1) , '') when 2 then nullif(trim(r.supervisor2), '') else nullif(trim(r.supervisor3), '') end;
      if v_source_name is null then continue; end if;

      -- Exact normalized match first, then a unique token-set match to handle
      -- harmless ordering/extra-middle-name differences in the export.
      select e.id into v_supervisor_id
      from _it_employee_map m
      join public.employees e on e.id = m.employee_id
      where lower(trim(e.full_name)) = lower(v_source_name)
      limit 1;

      if v_supervisor_id is null then
        select count(*) into v_match_count
        from _it_employee_map m
        join public.employees e on e.id = m.employee_id
        where regexp_split_to_array(trim(regexp_replace(lower(v_source_name), '[^a-z0-9]+', ' ', 'g')), '\\s+')
          <@ regexp_split_to_array(trim(regexp_replace(lower(e.full_name), '[^a-z0-9]+', ' ', 'g')), '\\s+');
        if v_match_count = 1 then
          select e.id into v_supervisor_id
          from _it_employee_map m
          join public.employees e on e.id = m.employee_id
          where regexp_split_to_array(trim(regexp_replace(lower(v_source_name), '[^a-z0-9]+', ' ', 'g')), '\\s+')
            <@ regexp_split_to_array(trim(regexp_replace(lower(e.full_name), '[^a-z0-9]+', ' ', 'g')), '\\s+')
          limit 1;
        end if;
      end if;

      if v_supervisor_id is not null then
        insert into public.employee_supervisors (
          employee_id, supervisor_employee_id, level, supervisor_title,
          effective_from, source
        ) values (
          r.employee_id, v_supervisor_id, v_level, v_source_name,
          current_date, 'IT_AUTOMATION_LIST'
        ) on conflict (employee_id, supervisor_employee_id, level) do update set
          supervisor_title = excluded.supervisor_title,
          effective_from = excluded.effective_from,
          source = excluded.source;

        update public.hierarchy_exceptions
        set status = 'resolved', resolution = jsonb_build_object('resolved_employee_id', v_supervisor_id), resolved_at = now()
        where employee_id = r.employee_id and source_supervisor_name = v_source_name and level = v_level;
      else
        insert into public.hierarchy_exceptions (
          employee_id, source_supervisor_name, level, reason, status
        ) values (
          r.employee_id, v_source_name, v_level,
          'Supervisor name did not resolve uniquely within this import.', 'open'
        ) on conflict (employee_id, source_supervisor_name, level) do update set
          reason = excluded.reason, status = 'open', resolution = null,
          resolved_by = null, resolved_at = null;
      end if;
      v_supervisor_id := null;
    end loop;
  end loop;
end;
$$;

commit;

-- Verification/report queries. Branches absent from this import are flagged,
-- never deleted.
select 'source_rows' as metric, count(*)::text as value from _it_automation_source
union all
select 'employee_rows_matching_source', count(*)::text from public.employees e where e.staff_id in (select staff_id from _it_automation_source)
union all
select 'unresolved_supervisor_links', count(*)::text from public.hierarchy_exceptions h where h.status = 'open' and h.employee_id in (select employee_id from _it_employee_map);

select b.branch_name as branch_in_db_not_in_import
from public.branches b
where not exists (
  select 1 from _it_automation_source s
  where lower(trim(s.branch_name)) = lower(trim(b.branch_name))
)
order by b.branch_name;
`

writeFileSync(OUTPUT, output)

console.log(JSON.stringify({
  source: SOURCE,
  output: OUTPUT,
  rows: rows.length,
  expectedRows: EXPECTED_ROWS,
  rowCountMatches: rows.length === EXPECTED_ROWS,
  duplicateStaffIds: duplicates,
  uniqueStaffIds: new Set(rows.map((row) => row.staffId)).size,
}, null, 2))
