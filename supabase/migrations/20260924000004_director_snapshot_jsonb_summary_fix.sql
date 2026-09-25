-- ===========================================================================
-- Director Intelligence: repair json || jsonb summary concatenation.
--
-- Run in Supabase SQL Editor AFTER 20260924000003. Transaction-wrapped and
-- idempotent. No data is inserted, updated, or deleted.
--
-- Root cause: row_to_json(o) returns json while jsonb_build_object(...) returns
-- jsonb. PostgreSQL has no json || jsonb operator, so every authenticated RPC
-- call failed with "operator does not exist: json || jsonb". The deployed
-- function is reissued from its current definition with the left operand cast
-- to jsonb via to_jsonb(o). CREATE OR REPLACE preserves the function owner,
-- grants, volatility, security definer flag, and search_path.
-- ===========================================================================
begin;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_invalid_expression text := '(select row_to_json(o) from overall o) || jsonb_build_object(';
  v_fixed_expression text := '(select to_jsonb(o) from overall o) || jsonb_build_object(';
begin
  select p.oid into v_function_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_director_executive_snapshot'
    and pg_get_function_identity_arguments(p.oid) =
      'p_start_date date, p_end_date date, p_department text, p_branch_id uuid, p_area text, p_role text, p_designation_id uuid, p_employee_id uuid';

  if not found then
    raise exception 'director_snapshot_function_missing: expected get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid)';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);

  if position(v_invalid_expression in v_definition) > 0 then
    v_definition := replace(v_definition, v_invalid_expression, v_fixed_expression);
    execute v_definition;
  elsif position(v_fixed_expression in v_definition) = 0 then
    raise exception 'director_snapshot_summary_shape_unrecognized: refusing to replace an unexpected function definition';
  end if;

  if position(v_fixed_expression in pg_get_functiondef(v_function_oid)) = 0 then
    raise exception 'director_snapshot_jsonb_repair_failed: to_jsonb summary expression is absent after replacement';
  end if;
end;
$migration$;

commit;
