-- Director Intelligence: fixed expected attendance of 20 days for every employee.
-- Apply after 20260924000005. Keep date filters on actual attendance unchanged.
-- All staff and summary/department/branch/area/role rates share expected_days.
-- Patch only this expression, preserving the deployed RPC body and access gates.
begin;

do $migration$
declare
  v_function regprocedure := 'public.get_director_executive_snapshot(date,date,text,uuid,text,text,uuid,uuid)'::regprocedure;
  v_definition text;
  v_previous text := '(select count(*) from range_days)::int expected_days';
  v_replacement text := '20::int expected_days';
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition, v_previous) > 0 then
    if (length(v_definition) - length(replace(v_definition, v_previous, ''))) / length(v_previous) <> 1 then
      raise exception 'Unexpected Director expected_days definition; no changes applied';
    end if;
    execute replace(v_definition, v_previous, v_replacement);
  elsif strpos(v_definition, v_replacement) = 0 then
    raise exception 'Director expected_days expression not found; no changes applied';
  end if;
end;
$migration$;

commit;
