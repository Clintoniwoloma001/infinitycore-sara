-- Roles: super admin, an HR manager (to be delegated to), a plain staff member.
insert into auth.users (id,email) values
 ('a0000000-0000-0000-0000-0000000000f1','clinton@infinitybank.com'),
 ('a0000000-0000-0000-0000-000000000003','hr@infinitybank.com'),
 ('a0000000-0000-0000-0000-000000000009','staff@infinitybank.com')
on conflict (id) do nothing;

-- The account used by t1.sql is 'staff' by design (it is the clock-in subject).
-- Use a SEPARATE super admin and staff account for the authorization tests.
insert into public.profiles (id, role, full_name) values
 ('a0000000-0000-0000-0000-0000000000f1','super_admin','Clinton Admin')
on conflict (id) do update set role = excluded.role;

\echo '=== T7a: staff (no grant) is DENIED ==='
select public.test_sign_in('a0000000-0000-0000-0000-000000000009','staff');
select public.employee_tracking_access() ->> 'can_view' as staff_can_view,
       public.employee_tracking_access() ->> 'reason' as reason;
select case when public.list_tracked_employees() is not null then 'LEAKED' else 'DENIED_OK' end as t7a_read_attempt;

\echo '=== T8: super admin shares tracking with HR MANAGER for 2 days ==='
select public.test_sign_in('a0000000-0000-0000-0000-0000000000f1','super_admin');
select public.grant_tracking_access('role',null,'head_of_human_resources','P2D',null,'Ops review') ->> 'expires_at' as expires;

\echo '=== T7b: HR manager CAN now access (delegated, unexpired) ==='
select public.test_sign_in('a0000000-0000-0000-0000-000000000003','head_of_human_resources');
select public.employee_tracking_access() ->> 'can_view' as hr_can_view,
       public.employee_tracking_access() ->> 'can_manage' as hr_can_manage,
       public.employee_tracking_access() ->> 'via' as via;
select public.employee_tracking_access('a0000000-0000-0000-0000-000000000009') ->> 'can_view' as staff_still_denied;

\echo '=== T7c: delegate CANNOT manage shares (view only) ==='
select case when public.grant_tracking_access('role',null,'staff','P1D') is not null
       then 'ESCALATED' else 'DENIED_OK' end as t7c;

\echo '=== T8b: after expiry the grant is auto-revoked (no manual step) ==='
select public.test_sign_in('a0000000-0000-0000-0000-0000000000f1','super_admin');
update public.tracking_access_grants set expires_at = now() - interval '1 minute';
select public.test_sign_in('a0000000-0000-0000-0000-000000000003','head_of_human_resources');
select public.employee_tracking_access() ->> 'can_view' as hr_after_expiry,
       public.employee_tracking_access() ->> 'via' as via;

\echo '=== T9: fresh grant then IMMEDIATE revoke ==='
select public.test_sign_in('a0000000-0000-0000-0000-0000000000f1','super_admin');
select public.grant_tracking_access('role',null,'head_of_human_resources','P2D') ->> 'id' as gid \gset
select public.test_sign_in('a0000000-0000-0000-0000-000000000003','head_of_human_resources');
select public.employee_tracking_access() ->> 'can_view' as hr_before_revoke;
select public.test_sign_in('a0000000-0000-0000-0000-0000000000f1','super_admin');
select public.revoke_tracking_access(:'gid') ->> 'revoked_at' as revoked_at;
select public.test_sign_in('a0000000-0000-0000-0000-000000000003','head_of_human_resources');
select public.employee_tracking_access() ->> 'can_view' as hr_after_revoke;

\echo '=== T10: no direct table SELECT for any authenticated session ==='
select public.test_sign_in('a0000000-0000-0000-0000-0000000000f1','super_admin');
select case when has_table_privilege('authenticated','public.employee_location_events','SELECT')
       then 'RLS_LEAK' else 'NO_DIRECT_SELECT_GRANT' end as location_events_priv,
       case when has_table_privilege('authenticated','public.tracking_access_grants','SELECT')
       then 'RLS_LEAK' else 'NO_DIRECT_SELECT_GRANT' end as grants_priv;

\echo '=== T11: live view returns real points with staleness ==='
select jsonb_pretty(r -> 'employees') from public.list_tracked_employees(120) r;

\echo '=== T12: movement history returns only REAL recorded points, in order ==='
select p->>'recorded_at' as at, p->>'location_label' as label, p->>'inside_geofence' as inside
  from jsonb_array_elements(
    public.employee_location_history(
      'aaaaaaaa-0000-0000-0000-000000000001',
      (now() at time zone 'Africa/Lagos')::date - 1) -> 'points') p;

\echo '=== T13: audit trail records the access decisions ==='
select action from public.audit_logs
 where action like 'TRACKING%' or action like 'EMPLOYEE_LOCATION%'
 order by created_at;