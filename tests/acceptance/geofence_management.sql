\set ON_ERROR_STOP on
-- Behavioural proof for 20261102000001_geofence_management_rbac.sql
--   * role gate: Super Admin / Head of HR only, everything else HTTP 403
--     (SQLSTATE 42501) on the geofence management endpoints
--   * one write keeps branch_geofences, branches and attendance_geofences equal
--   * check_is_within_geofence reports the engine's own distance
--   * the tracking baseline admits Head of HR / MD-CEO / Director / Chairman
--   * resolve_employee_location enforces what the settings page saved
--
-- Convention follows tracking_resolved_place_cascade.sql: a temporary table
-- collects every check and a final DO block raises if any of them failed, so
-- one run reports every failure rather than only the first.

begin;

create temporary table geo_results (
  ord  serial primary key,
  test text not null,
  ok   boolean not null,
  note text
) on commit drop;

create or replace function pg_temp_geo_ok(boolean, text, text default null)
returns void language plpgsql as $$
begin
  insert into geo_results (test, ok, note) values ($2, coalesce($1, false), $3);
end $$;

do $$
declare
  v_super uuid        := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_headhr uuid       := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_hrofficer uuid    := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_director uuid     := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  v_staff uuid        := 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  v_employee_user uuid:= 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  v_branch uuid       := '11111111-1111-4111-8111-111111111112';
  v_branch2 uuid      := '11111111-1111-4111-8111-111111111113';
  v_branch3 uuid      := '11111111-1111-4111-8111-111111111114';
  v_legacy_row uuid   := '33333333-3333-4333-8333-333333333333';
  v_employee uuid;
  v_sqlstate text;
  v_res jsonb;
  v_dist float;
  v_within boolean;
  v_radius numeric;
begin
  -- ------------------------------------------------------------------
  -- FIXTURES
  -- ------------------------------------------------------------------
  insert into auth.users (id, email) values
    (v_super, 'geo.super@test.local'),
    (v_headhr, 'geo.headhr@test.local'),
    (v_hrofficer, 'geo.hrofficer@test.local'),
    (v_director, 'geo.director@test.local'),
    (v_staff, 'geo.staff@test.local'),
    (v_employee_user, 'geo.employee@test.local')
  on conflict (id) do nothing;

  insert into public.profiles (id, email, full_name, role) values
    (v_super,     'geo.super@test.local',     'Geo Super',      'super_admin'),
    (v_headhr,    'geo.headhr@test.local',    'Geo Head HR',    'head_of_human_resources'),
    (v_hrofficer, 'geo.hrofficer@test.local', 'Geo HR Officer', 'hr_officer'),
    (v_director,  'geo.director@test.local',  'Geo Director',   'director'),
    (v_staff,     'geo.staff@test.local',     'Geo Staff',      'staff'),
    (v_employee_user, 'geo.employee@test.local', 'Geo Employee', 'staff')
  on conflict (id) do nothing;

  insert into public.branches (id, branch_name, branch_code, latitude, longitude,
                               geofence_radius, geofence_active, location, updated_at)
  values
    (v_branch,  'Marina Branch', 'MNA', 6.440000, 3.390000, 150, false, 'Lagos', now()),
    (v_branch2, 'Ikeja Branch',  'IKJ', 6.600000, 3.350000, null, false, 'Lagos', now())
  on conflict (id) do nothing;

  insert into public.employees (id, user_id, full_name, employee_number, branch_id, is_archived)
  values ('99999999-9999-4999-8999-999999999999', v_employee_user, 'Geo Employee', 'EMP-GEO',
          v_branch, false)
  on conflict (id) do nothing
  returning id into v_employee;

  -- ------------------------------------------------------------------
  -- 1. ROLE GATE ON THE MANAGEMENT ENDPOINTS
  -- ------------------------------------------------------------------
  perform public.test_sign_in(v_super, 'authenticated');
  perform pg_temp_geo_ok(public.is_geofence_admin() = true,
                         'super_admin is a geofence admin');

  perform public.test_sign_in(v_headhr, 'authenticated');
  perform pg_temp_geo_ok(public.is_geofence_admin() = true,
                         'head of HR is a geofence admin');

  perform public.test_sign_in(v_hrofficer, 'authenticated');
  perform pg_temp_geo_ok(public.is_geofence_admin() = false,
                         'HR officer is NOT a geofence admin');

  perform public.test_sign_in(v_staff, 'authenticated');
  perform pg_temp_geo_ok(public.is_geofence_admin() = false,
                         'staff is NOT a geofence admin');

  -- Every management endpoint must refuse a non-admin with 42501, which
  -- PostgREST renders as HTTP 403 Forbidden.
  perform public.test_sign_in(v_staff, 'authenticated');

  begin
    perform public.list_branch_geofences();
    perform pg_temp_geo_ok(false, 'staff LIST refused', 'list returned without raising');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '42501', 'staff LIST refused with 403', sqlstate || ' ' || sqlerrm);
  end;

  begin
    perform public.save_branch_geofence(v_branch, 6.44, 3.39, 300, true);
    perform pg_temp_geo_ok(false, 'staff SAVE refused', 'save returned without raising');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '42501', 'staff SAVE refused with 403', sqlstate || ' ' || sqlerrm);
  end;

  begin
    perform public.set_branch_geofence_active(v_branch, false);
    perform pg_temp_geo_ok(false, 'staff TOGGLE refused', 'toggle returned without raising');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '42501', 'staff TOGGLE refused with 403', sqlstate || ' ' || sqlerrm);
  end;

  begin
    perform public.delete_branch_geofence(v_branch);
    perform pg_temp_geo_ok(false, 'staff DELETE refused', 'delete returned without raising');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '42501', 'staff DELETE refused with 403', sqlstate || ' ' || sqlerrm);
  end;

  -- ------------------------------------------------------------------
  -- 2. SAVE AS SUPER ADMIN — canonical row + both legacy readers agree
  -- ------------------------------------------------------------------
  perform public.test_sign_in(v_super, 'authenticated');

  -- An attendance_geofences row already exists for this branch: it must be
  -- updated in step, never duplicated.
  insert into public.attendance_geofences (id, name, branch_id, location_name, latitude,
                                           longitude, radius_meters, active, created_by, updated_at)
  values ('22222222-2222-4222-8222-222222222222', 'Marina Branch', v_branch::text,
          'Marina', 6.44, 3.39, 150, true, v_super, now())
  on conflict (id) do nothing;

  v_res := public.save_branch_geofence(v_branch, 6.441000, 3.391000, 300, true);

  perform pg_temp_geo_ok(coalesce((v_res ->> 'ok')::boolean, false),
                         'save returns ok', v_res::text);

  perform pg_temp_geo_ok(
    (select count(*) = 1 from public.branch_geofences where branch_id = v_branch),
    'save creates exactly one canonical row per branch');

  perform pg_temp_geo_ok(
    (select latitude = 6.441000 and longitude = 3.391000
            and geofence_radius = 300 and geofence_active = true
       from public.branches where id = v_branch),
    'branches mirror is written by the same save');

  perform pg_temp_geo_ok(
    (select latitude = 6.441000 and longitude = 3.391000
            and radius_meters = 300 and active = true
       from public.attendance_geofences where branch_id = v_branch::text),
    'existing attendance_geofences row is updated, not duplicated');

  perform pg_temp_geo_ok(
    (select count(*) = 1 from public.attendance_geofences where branch_id = v_branch::text),
    'no duplicate attendance_geofences row was created');

  perform pg_temp_geo_ok(
    (select center_lat = latitude and center_lng = longitude and active = is_active
       from public.branch_geofences where branch_id = v_branch),
    'legacy centre columns are mirrored for the pre-existing shape');

  perform pg_temp_geo_ok(
    (select created_by = v_super from public.branch_geofences where branch_id = v_branch),
    'created_by records the saving admin');

  -- ------------------------------------------------------------------
  -- 3. THE DISTANCE UTILITY
  -- ------------------------------------------------------------------
  v_dist := public.geo_distance(6.441000::float, 3.391000::float, 6.441000::float, 3.391000::float);
  v_res := public.check_is_within_geofence(6.441000, 3.391000, v_branch);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'within')::boolean, false),
                         'at the centre: within = true', v_res::text);
  perform pg_temp_geo_ok(coalesce(abs((v_res ->> 'distance_meters')::float) < 0.2, false),
                         'at the centre: distance_meters ~= 0', v_res::text);

  -- ~500m north of centre: outside a 300m fence, distance ~55600m?? No:
  -- 0.001 degrees of latitude is ~111m, so 0.004 is ~444m.
  v_res := public.check_is_within_geofence(6.445000, 3.391000, v_branch);
  v_dist := public.geo_distance(6.445000::float, 3.391000::float, 6.441000::float, 3.391000::float);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'within')::boolean, false) = false,
                         'outside a 300m fence: within = false', v_res::text);
  perform pg_temp_geo_ok(
    coalesce(abs((v_res ->> 'distance_meters')::float - v_dist) < 0.2, false),
    'distance_meters matches geo_distance exactly', v_res::text);
  perform pg_temp_geo_ok(
    coalesce(((v_res ->> 'meters_outside')::float) > 0, false),
    'meters_outside reports how far outside', v_res::text);

  -- ------------------------------------------------------------------
  -- 4. RADIUS AND COORDINATE VALIDATION
  -- ------------------------------------------------------------------
  begin
    perform public.save_branch_geofence(v_branch, 6.44, 3.39, 5001, true);
    perform pg_temp_geo_ok(false, 'radius above 5000 rejected', 'accepted 5001');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '22023', 'radius above 5000 rejected', sqlstate || ' ' || sqlerrm);
  end;

  begin
    perform public.save_branch_geofence(v_branch, 6.44, 3.39, 5, true);
    perform pg_temp_geo_ok(false, 'radius below 10 rejected', 'accepted 5');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '22023', 'radius below 10 rejected', sqlstate || ' ' || sqlerrm);
  end;

  begin
    perform public.save_branch_geofence(v_branch, 999, 3.39, 300, true);
    perform pg_temp_geo_ok(false, 'latitude out of range rejected', 'accepted 999');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '22023', 'latitude out of range rejected', sqlstate || ' ' || sqlerrm);
  end;

  -- ------------------------------------------------------------------
  -- 5. TOGGLE AND DELETE
  -- ------------------------------------------------------------------
  perform public.test_sign_in(v_headhr, 'authenticated');
  v_res := public.set_branch_geofence_active(v_branch, false);

  perform pg_temp_geo_ok(
    (select geofence_active = false from public.branches where id = v_branch),
    'head of HR can disable; branches mirror follows');
  perform pg_temp_geo_ok(
    (select active = false from public.attendance_geofences where branch_id = v_branch::text),
    'attendance_geofences mirror follows the disable');
  perform pg_temp_geo_ok(
    (select is_active = false from public.branch_geofences where branch_id = v_branch),
    'canonical row keeps existing after disable (no data destroyed)');

  v_res := public.check_is_within_geofence(6.441000, 3.391000, v_branch);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'has_geofence')::boolean, false) = false
                         or coalesce((v_res ->> 'within')::boolean, false) = false,
                         'disabled fence no longer reports inside', v_res::text);

  -- Re-enable so the engine check below sees an active fence.
  perform public.set_branch_geofence_active(v_branch, true);

  -- ------------------------------------------------------------------
  -- 6. THE ENGINE ENFORCES WHAT THE SETTINGS PAGE SAVED
  -- ------------------------------------------------------------------
  v_res := public.resolve_employee_location(6.441000, 3.391000, 'clock_in', null);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'inside')::boolean, false),
                         'resolve_employee_location: inside the saved 300m fence',
                         v_res::text);

  v_res := public.resolve_employee_location(6.445000, 3.391000, 'clock_in', null);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'inside')::boolean, false) = false,
                         'resolve_employee_location: outside the saved 300m fence',
                         v_res::text);

  -- ------------------------------------------------------------------
  -- 7. TRACKING BASELINE — the five roles the product defines as viewers
  -- ------------------------------------------------------------------
  perform public.test_sign_in(v_super, 'authenticated');
  v_res := public.employee_tracking_access();
  perform pg_temp_geo_ok(coalesce((v_res ->> 'can_view')::boolean, false)
                         and coalesce((v_res ->> 'can_manage')::boolean, false),
                         'super admin: view + manage', v_res::text);

  perform public.test_sign_in(v_headhr, 'authenticated');
  v_res := public.employee_tracking_access();
  perform pg_temp_geo_ok(coalesce((v_res ->> 'can_view')::boolean, false),
                         'head of HR: can_view without a grant', v_res::text);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'can_manage')::boolean, false) = false,
                         'head of HR: can_manage stays false', v_res::text);
  perform pg_temp_geo_ok((v_res ->> 'via') = 'baseline_role',
                         'head of HR: via = baseline_role', v_res::text);

  perform public.test_sign_in(v_director, 'authenticated');
  v_res := public.employee_tracking_access();
  perform pg_temp_geo_ok(coalesce((v_res ->> 'can_view')::boolean, false),
                         'director: can_view without a grant', v_res::text);

  perform public.test_sign_in(v_hrofficer, 'authenticated');
  v_res := public.employee_tracking_access();
  perform pg_temp_geo_ok(coalesce((v_res ->> 'can_view')::boolean, false) = false,
                         'HR officer: still denied (not a tracking viewer role)', v_res::text);

  perform public.test_sign_in(v_staff, 'authenticated');
  v_res := public.employee_tracking_access();
  perform pg_temp_geo_ok(coalesce((v_res ->> 'can_view')::boolean, false) = false,
                         'staff: still denied', v_res::text);

  -- The readers that serve /api/v1/tracking/* refuse the same way.
  begin
    perform public.list_tracked_employees(60, null, null);
    perform pg_temp_geo_ok(false, 'staff tracking LIST refused', 'list returned without raising');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = '42501' or position('TRACKING_FORBIDDEN' in sqlerrm) > 0,
                          'staff tracking LIST refused', sqlstate || ' ' || sqlerrm);
  end;

  -- ------------------------------------------------------------------
  -- 8. DELETE AS HEAD OF HR — canonical row gone, evidence preserved
  -- ------------------------------------------------------------------
  perform public.test_sign_in(v_headhr, 'authenticated');
  v_res := public.delete_branch_geofence(v_branch);

  perform pg_temp_geo_ok(
    (select count(*) = 0 from public.branch_geofences where branch_id = v_branch),
    'delete removes the canonical row');
  perform pg_temp_geo_ok(
    (select geofence_active = false from public.branches where id = v_branch),
    'delete disables the branches copy instead of erasing its coordinates');
  perform pg_temp_geo_ok(
    (select latitude is not null and longitude is not null
       from public.branches where id = v_branch),
    'delete keeps the branch centre coordinates for historical audit');
  perform pg_temp_geo_ok(
    (select count(*) = 1 from public.attendance_geofences where branch_id = v_branch::text),
    'delete never erases the attendance_geofences row');

  v_res := public.resolve_employee_location(6.441000, 3.391000, 'clock_in', null);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'inside')::boolean, false) = false,
                         'after delete the engine no longer reports inside', v_res::text);

  -- Deleting a branch with no geofence is a clean 404-style refusal.
  begin
    perform public.delete_branch_geofence(v_branch2);
    perform pg_temp_geo_ok(false, 'delete of a fenceless branch refused', 'returned normally');
  exception when others then
    perform pg_temp_geo_ok(sqlstate = 'P0002', 'delete of a fenceless branch refused',
                           sqlstate || ' ' || sqlerrm);
  end;

  -- A branch that has never been configured answers the distance utility
  -- honestly instead of raising.
  v_res := public.check_is_within_geofence(6.600000, 3.350000, v_branch2);
  perform pg_temp_geo_ok(coalesce((v_res ->> 'has_geofence')::boolean, false) = false,
                         'unconfigured branch: has_geofence = false, no raise', v_res::text);

  -- ------------------------------------------------------------------
  -- 9. THE LEGACY TABLE SHAPE (created by the mobile migration) IS
  --    RECONCILED, NOT BROKEN: a row written before this migration existed is
  --    backfilled into the canonical columns and keeps working.
  -- ------------------------------------------------------------------
  perform public.test_sign_in(v_super, 'authenticated');

  perform pg_temp_geo_ok(
    (select latitude = center_lat and longitude = center_lng
            and is_active = active and created_by is null
       from public.branch_geofences where id = v_legacy_row),
    'legacy row backfilled: latitude/longitude/is_active follow centre columns',
    (select latitude::text || '/' || longitude::text || '/active=' || is_active::text
       from public.branch_geofences where id = v_legacy_row));

  v_res := public.check_is_within_geofence(6.447000, 3.470000, v_branch3);
  perform pg_temp_geo_ok(
    coalesce((v_res ->> 'within')::boolean, false)
    and (v_res ->> 'source') = 'branch_geofences'
    and (v_res ->> 'radius_meters')::numeric = 250,
    'distance utility reads the reconciled legacy row', v_res::text);

  -- Correcting a legacy-shape fence writes BOTH shapes.
  v_res := public.save_branch_geofence(v_branch3, 6.448000, 3.471000, 450, true);
  perform pg_temp_geo_ok(
    (select latitude = 6.448000 and longitude = 3.471000
            and center_lat = 6.448000 and center_lng = 3.471000
            and radius_meters = 450 and is_active and active
            and center_lat is not null
       from public.branch_geofences where id = v_legacy_row),
    'save on a legacy-shape row updates canonical and centre columns together');
  perform pg_temp_geo_ok(
    (select geofence_radius = 450 and geofence_active = true
            and latitude = 6.448000 and longitude = 3.471000
       from public.branches where id = v_branch3),
    'branches mirror follows a legacy-shape save too');

  v_res := public.list_branch_geofences();
  perform pg_temp_geo_ok(
    jsonb_array_length(v_res -> 'geofences') >= 1
    and (v_res -> 'geofences') -> 0 ->> 'branch_name' = 'Lekki Branch'
    and (v_res -> 'geofences') -> 0 ->> 'branch_code' = 'LKK'
    and jsonb_exists((v_res -> 'geofences') -> 0, 'assigned_employees'),
    'list returns every fence with its branch name and employee count', v_res::text);

  perform public.test_sign_out();
end $$;

-- ---------------------------------------------------------------------------
-- REPORT
-- ---------------------------------------------------------------------------
select ord, case when ok then 'PASS' else 'FAIL' end as result, test, note
  from geo_results
 order by ord;

do $$
declare
  v_failed int;
  v_total int;
begin
  select count(*) filter (where not ok), count(*) into v_failed, v_total from geo_results;
  if v_failed > 0 then
    raise exception 'GEOFENCE ACCEPTANCE: % of % checks FAILED', v_failed, v_total;
  end if;
  raise notice 'GEOFENCE ACCEPTANCE: all % checks passed', v_total;
end $$;

rollback;
