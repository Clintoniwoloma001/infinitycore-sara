-- ============================================================================
-- Phase 5 — HR Organisation supervisor-title repair + materialized mappings
-- Run in Supabase SQL Editor after 20260922000003. Idempotent/additive.
--
-- 1. supervisor_title is a JOB TITLE field but a bad import wrote the
--    supervisor's PERSON NAME into it on 136 rows (e.g. "OLANAOKA
--    OLANREWAJU YEMISI" instead of "HEAD, INDIVIDUAL LOAN"). That name is
--    also stored in the sibling full_name for a linked supervisor, so it
--    surfaces as a redundant/duplicated label in the HR Organisation page.
--    Fix: where supervisor_title matches the linked supervisor's full name,
--    replace it with that supervisor's designation (employees.position).
-- 2. Two hierarchy_exceptions previously resolved WITHOUT a supervisor id
--    (supervisor_employee_id was null at resolve time, so the resolution
--    step could not materialise a mapping). The source supervisor is known
--    and exactly one employee matches; materialise the level-1 line so the
--    resolved exception actually closes the hierarchy gap, mirroring what
--    resolve_hierarchy_exception() does when a supervisor IS supplied.
--
-- No schema changes. Reads are untouched; only data repair.
-- ============================================================================

begin;

-- ------------------------------------------------------------
-- 1. supervisor_title person-name repair (idempotent predicate:
--    only rows that STILL carry a person name are rewritten, so a
--    re-run after an admin edits a title leaves the edit intact).
-- ------------------------------------------------------------
update public.employee_supervisors s
set supervisor_title = e."position",
    effective_from = coalesce(s.effective_from, current_date)
from public.employees e
where e.id = s.supervisor_employee_id
  and (
    s.supervisor_title ilike '%' || e.full_name || '%'
    or s.supervisor_title = e.full_name
  );

-- ------------------------------------------------------------
-- 2. Materialise supervisor lines for the two audited hierarchy exceptions
--    that were resolved on 2026-09-22 WITHOUT a supervisor_employee_id
--    (resolution payload carried an explicit SQL NULL, so the resolution
--    step's gap-closing insert never ran). Both name "OZIOKO COSMOS" as the
--    level-1 supervisor, which audit matched to the single employee
--    OZIOKO COSMAS IKECHUKWU (HEAD, E-BUSINESS). Scoped by exception id so
--    nothing else is silently re-linked; guarded by the unique
--    (employee_id, supervisor_employee_id, level) constraint so a human fix
--    or a re-run is a no-op.
-- ------------------------------------------------------------
insert into public.employee_supervisors (
  employee_id, supervisor_employee_id, level, supervisor_title, source, created_at
)
select
  hx.employee_id,
  '4f932860-7f87-485c-b642-0490acd8ca5d', -- OZIOKO COSMAS IKECHUKWU (HEAD, E-BUSINESS)
  coalesce(hx.level, 1),
  e."position",
  'hierarchy_exception_resolution',
  now()
from public.hierarchy_exceptions hx
join public.employees e on e.id = '4f932860-7f87-485c-b642-0490acd8ca5d'
where hx.id in (
  '1a586039-3c52-412b-9042-8468a77c992d', -- IWOLOMA MUSA level 1
  '16de4c7d-7512-4cee-b129-51e5be378021'  -- KUJIMIYO ISAAC level 1
)
  and hx.status = 'resolved'
  and hx.employee_id is not null
on conflict (employee_id, supervisor_employee_id, level) do nothing;

commit;