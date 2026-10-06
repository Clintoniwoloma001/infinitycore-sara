-- ============================================================================
-- 20261101000009 — Supervisory directory RPC (RBAC for supervisor pickers)
-- ============================================================================
--
-- Adds rpc_get_supervisory_directory(): the people who may legitimately be
-- chosen in a "Supervisor", "Department Head" or "Approver" field.
--
-- WHY THIS IS A NEW RPC RATHER THAN A CLIENT-SIDE FILTER
-- The role list must be enforced by the DATABASE. A client-side filter over a
-- broad employee list is only a UI convenience: a tampered or simply
-- out-of-date client would happily offer any role it liked. Every other
-- privileged read in this schema follows the same rule — the RPC is the
-- security boundary and the client only renders what it is handed.
--
-- READS `profiles`, NOT `employees`
-- Per 20260931000007, the executive offices (Director, Chairman, MD/CEO) are
-- PROFILE roles and deliberately have no `employees` row — they are office
-- holders, not branch roster lines. Selecting a supervisor from `employees`
-- would silently omit every single one of them. So this reads `profiles`,
-- which carries id, full_name, role, department, branch and a nullable
-- employee_id.
--
-- The Dart mirror of the role list lives in
-- lib/core/security/supervisory_roles.dart (SupervisoryRoles.supervisory).
-- The two must be changed together.
--
-- IDEMPOTENT: safe to re-run. Additive. Run AFTER 20261101000008.
-- ============================================================================

begin;

create or replace function public.rpc_get_supervisory_directory(
  p_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_count integer;
begin
  -- Reads public.profiles. The role filter is applied HERE, in the database.
  -- `approved` is required as well: a pending or rejected profile must never
  -- be offered as an approver, however senior the role on the row.
  with directory as (
    select
      p.id,
      coalesce(p.full_name, '')          as full_name,
      p.role,
      coalesce(p.department, '')        as department,
      coalesce(p.branch, '')            as branch,
      p.employee_id
    from public.profiles p
    where p.role in (
      'head_of_human_resources',
      'head_of_business',        -- "Head of Credit & Marketing"
      'head_of_operations',
      'head_of_e_business',
      'financial_controller',    -- "Head of FINCON"
      'head_of_audit',
      'area_manager',
      'branch_manager',
      'md_ceo',
      'director',
      'chairman'
    )
      and coalesce(p.approved, false) is true
    -- Optional server-side narrowing. The client filters as the user types,
    -- but doing the first cut here keeps the payload small when the
    -- supervisory population grows.
      and (
        p_query is null
        or btrim(p_query) = ''
        or coalesce(p.full_name, '') ilike '%' || btrim(p_query) || '%'
        or p.role ilike '%' || btrim(p_query) || '%'
      )
    -- Executives first, then alphabetically, so the MD/CEO is not buried
    -- under 40 branch managers.
    order by
      case p.role
        when 'md_ceo' then 0
        when 'chairman' then 1
        when 'director' then 2
        when 'head_of_business' then 3
        when 'head_of_operations' then 4
        when 'head_of_e_business' then 5
        when 'head_of_human_resources' then 6
        when 'financial_controller' then 7
        when 'head_of_audit' then 8
        when 'area_manager' then 9
        when 'branch_manager' then 10
        else 99
      end,
      coalesce(p.full_name, '') asc
  )
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb), count(*)
    into v_rows, v_count
  from directory d;

  return jsonb_build_object(
    'ok', true,
    'count', v_count,
    'people', v_rows
  );
end;
$$;

comment on function public.rpc_get_supervisory_directory(text) is
  'Server-authoritative list of profiles holding a supervisory/executive role and approved. Powers the Supervisor / Department Head combobox on mobile and web. Reads profiles (not employees) because executive offices have no employees row. Mirrored by SupervisoryRoles.supervisory in lib/core/security/supervisory_roles.dart.';

revoke all on function public.rpc_get_supervisory_directory(text) from public;
revoke all on function public.rpc_get_supervisory_directory(text) from anon;
grant execute on function public.rpc_get_supervisory_directory(text) to authenticated;

commit;
