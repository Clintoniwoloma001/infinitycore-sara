\set ON_ERROR_STOP on
-- Behavioural proof of the Employee Tracking access fix.
-- Uses REAL profiles rows and REAL grants, and switches auth.uid() the same way
-- PostgREST does, so the assertions exercise the deployed function bodies.
--
-- Convention follows tests/acceptance/tracking_resolved_place_cascade.sql: a
-- temporary table collects the checks and a final DO block raises if any failed.

begin;

-- The app's handle_new_user() trigger currently ends without a RETURN and so
-- raises "control reached end of trigger procedure without RETURN" on every new
-- auth.users insert. That is a PRE-EXISTING bug, unrelated to this fix, but it
-- blocks creating the fixture accounts below, so triggers are suppressed for the
-- duration of THIS transaction. session_replication_role is session-scoped, so it
-- resets automatically when this psql connection ends — nothing is left disabled.
set session_replication_role = replica;

create temporary table trk_results (
  ord  serial primary key,
  test text not null,
  ok   boolean not null,
  note text
) on commit drop;

-- Assert helper: records the outcome instead of aborting, so one run reports
-- every failure rather than only the first.
create or replace function pg_temp_trk_ok(b boolean, t text, n text default null)
returns void language plpgsql as $$
begin
  insert into trk_results (test, ok, note) values (t, coalesce(b, false), n);
end $$;

do $$
declare
  v_super uuid := '11111111-1111-4111-8111-111111111111';
  v_grantee uuid := '22222222-2222-4222-8222-222222222222';
  v_stranger uuid := '33333333-3333-4333-8333-333333333333';
  -- Deliberately a DIFFERENT id from every account above, so "passing the
  -- employee id confused the access check" cannot accidentally pass.
  v_emp uuid := '44444444-4444-4444-8444-444444444444';
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_res jsonb;
  v_gate text;
begin
  -- ------------------------------------------------------------------
  -- FIXTURES: three real accounts with real profiles rows.
  -- ------------------------------------------------------------------
  insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    (v_super,    'trk.super@test.local',    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now()),
    (v_grantee,  'trk.grantee@test.local',  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now()),
    (v_stranger, 'trk.stranger@test.local', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, email, full_name, role)
  values
    (v_super,    'trk.super@test.local',    'Tracking Super',    'super_admin'),
    (v_grantee,  'trk.grantee@test.local',  'Tracking Grantee',  'head_of_human_resources'),
    (v_stranger, 'trk.stranger@test.local', 'Tracking Stranger', 'staff')
  on conflict (id) do update set role = excluded.role;

  -- An employee to read the history OF.
  insert into public.employees (id, full_name, employee_number, employment_status)
  values (v_emp, 'History Subject', 'IMFB/00/0001', 'active')
  on conflict (id) do nothing;

  -- A grant to the grantee that expires in 1 hour. Column list matches the real
-- table exactly (id/target_type/target_user_id/target_role/expires_at/revoked_at).
  insert into public.tracking_access_grants
    (target_type, target_user_id, expires_at)
  values ('user', v_grantee, now() + interval '1 hour');

  -- ==================================================================
  -- T1  THE SUPER ADMIN NEEDS NO GRANT
  -- ==================================================================
  perform set_config('request.jwt.claim.sub', v_super::text, true);
  v_res := public.employee_tracking_access();
  perform pg_temp_trk_ok((v_res ->> 'can_view')::boolean, 'T1 super admin can_view without a grant');
  perform pg_temp_trk_ok((v_res ->> 'can_manage')::boolean, 'T1 super admin can_manage (may share access)');
  perform pg_temp_trk_ok(v_res ->> 'via' = 'super_admin', 'T1 reported via=super_admin');

  -- THE REGRESSION: the live list reads. This must not raise.
  v_res := public.list_tracked_employees(60);
  perform pg_temp_trk_ok(jsonb_typeof(v_res) = 'array', 'T1 super admin live positions readable');

  -- THE REGRESSION: the history drawer. It previously refused the Super Admin
  -- with "requires an explicit grant". It must now return cleanly.
  v_res := public.employee_location_history(v_emp, v_today);
  perform pg_temp_trk_ok((v_res ->> 'ok')::boolean, 'T1 super admin history READS (was TRACKING_FORBIDDEN)');
  perform pg_temp_trk_ok(v_res ? 'points', 'T1 history payload has points');

  -- And the previously ungated live-locations function must work for them too.
  v_res := public.employee_current_locations(null, null, 240);
  perform pg_temp_trk_ok(jsonb_typeof(v_res) = 'array', 'T1 super admin current_locations readable');
-- ==================================================================
  -- T2  A LIVE GRANT IS ENOUGH, AND IS NOT THE SUPER ADMIN
  -- ==================================================================
  perform set_config('request.jwt.claim.sub', v_grantee::text, true);
  v_res := public.employee_tracking_access();
  perform pg_temp_trk_ok((v_res ->> 'can_view')::boolean, 'T2 granted user can_view');
  perform pg_temp_trk_ok((v_res ->> 'allowed')::boolean, 'T2 allowed alias agrees with can_view');
  perform pg_temp_trk_ok(NOT (v_res ->> 'can_manage')::boolean,
    'T2 a grantee canNOT re-share access (can_manage=false)');
  perform pg_temp_trk_ok(v_res ->> 'via' like 'delegated:%', 'T2 reported as delegated');
  perform pg_temp_trk_ok(v_res ->> 'expires_at' is not null, 'T2 grant reports its expiry');

  v_res := public.employee_location_history(v_emp, v_today);
  perform pg_temp_trk_ok((v_res ->> 'ok')::boolean, 'T2 granted user history reads');

  -- ==================================================================
  -- T3  NO GRANT => NO ACCESS (fail closed)
  -- ==================================================================
  perform set_config('request.jwt.claim.sub', v_stranger::text, true);
  v_res := public.employee_tracking_access();
  perform pg_temp_trk_ok(NOT (v_res ->> 'can_view')::boolean, 'T3 ungranted user denied');
  perform pg_temp_trk_ok(NOT (v_res ->> 'can_manage')::boolean, 'T3 ungranted user cannot manage');

  -- Each read surface must REFUSE, and must say why.
  begin
    perform public.list_tracked_employees(60);
    raise exception 'FAILED: T3 list_tracked_employees should have been refused';
  exception when others then
    perform pg_temp_trk_ok(sqlerrm like 'TRACKING_FORBIDDEN%',
      'T3 list_tracked_employees refused with TRACKING_FORBIDDEN');
  end;

  begin
    perform public.employee_location_history(v_emp, v_today);
    raise exception 'FAILED: T3 employee_location_history should have been refused';
  exception when others then
    perform pg_temp_trk_ok(sqlerrm like 'TRACKING_FORBIDDEN%',
      'T3 employee_location_history refused with TRACKING_FORBIDDEN');
  end;

  -- THE BYPASS: this function had NO gate and leaked every live coordinate to
  -- any authenticated account.
  begin
    perform public.employee_current_locations(null, null, 240);
    raise exception 'FAILED: T3 employee_current_locations should have been refused';
  exception when others then
    perform pg_temp_trk_ok(sqlerrm like 'TRACKING_FORBIDDEN%',
      'T3 employee_current_locations now refused (previously an open bypass)');
  end;

  -- ==================================================================
  -- T4  AN EXPIRED GRANT FAILS CLOSED, WITH NO CRON
  -- ==================================================================
  update public.tracking_access_grants set expires_at = now() - interval '1 minute'
   where target_user_id = v_grantee;
  perform set_config('request.jwt.claim.sub', v_grantee::text, true);
  v_res := public.employee_tracking_access();
  perform pg_temp_trk_ok(NOT (v_res ->> 'can_view')::boolean, 'T4 expired grant denied immediately');

  begin
    perform public.employee_location_history(v_emp, v_today);
    raise exception 'FAILED: T4 expired grantee should have been refused';
  exception when others then
    perform pg_temp_trk_ok(sqlerrm like 'TRACKING_FORBIDDEN%', 'T4 expired grantee history refused');
  end;

  -- ==================================================================
  -- T5  A REVOKED GRANT ALSO FAILS CLOSED
  -- ==================================================================
  update public.tracking_access_grants
     set expires_at = now() + interval '1 hour', revoked_at = now()
   where target_user_id = v_grantee;
  v_res := public.employee_tracking_access();
  perform pg_temp_trk_ok(NOT (v_res ->> 'can_view')::boolean, 'T5 revoked grant denied');

  -- ==================================================================
  -- T6  A PASSED ARGUMENT CANNOT WIDEN ACCESS (the Defect 1 class)
  -- ==================================================================
  -- The stranger passes the SUPER ADMIN's id. Authorization is about the
  -- caller, so this must still be refused.
  perform set_config('request.jwt.claim.sub', v_stranger::text, true);
  v_res := public.employee_tracking_access(v_super);
  perform pg_temp_trk_ok(NOT (v_res ->> 'can_view')::boolean,
    'T6 passing another user id does NOT grant access');

  -- ==================================================================
  -- T7  DEFENCE: every deployed reader really is gated
  -- ==================================================================
  foreach v_gate in array array[
    'list_tracked_employees','employee_location_history',
    'employee_current_locations','list_tracking_geofences'] loop
    perform pg_temp_trk_ok(
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = v_gate
                 and p.prosrc like '%employee_tracking_access%')
      or v_gate not in (select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public'),
      format('T7 %s is access-gated', v_gate));
  end loop;

  -- ------------------------------------------------------------------
  -- REPORT
  -- ------------------------------------------------------------------
  raise notice '';
  raise notice '--------- Employee Tracking access control ---------';
  raise notice '%',
    (select string_agg(
              case when ok then 'ok   ' else 'FAIL ' end || test,
              E'\n' order by ord)
       from trk_results);

  if exists (select 1 from trk_results where not ok) then
    raise exception 'tracking access control: % of % checks FAILED',
      (select count(*) from trk_results where not ok),
      (select count(*) from trk_results);
  end if;
  raise notice '% checks passed', (select count(*) from trk_results);

  -- ------------------------------------------------------------------
  -- CLEANUP
  -- ------------------------------------------------------------------
  delete from public.tracking_access_grants where target_user_id in (v_grantee, v_super, v_stranger);
  delete from public.employees where id = v_emp;
  delete from public.profiles where id in (v_super, v_grantee, v_stranger);
  delete from auth.users where id in (v_super, v_grantee, v_stranger);

  drop function if exists pg_temp_trk_ok(boolean, text, text);

  -- Restore trigger firing before COMMIT (see the header note).
  set session_replication_role = 'origin';
end $$;

commit;