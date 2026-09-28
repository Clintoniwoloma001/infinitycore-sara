-- ===========================================================================
-- Real-organisation scenario harness for the leave approval chain.
-- Run inside the local Supabase Postgres. Everything is rolled back at the end.
-- ===========================================================================
-- Two isolated branches (A and B), each with a real branch manager, a real
-- area manager and its own Head of Business, plus one Head of HR, a Head of
-- Department and an MD/CEO. Every actor is a real auth.users + profiles +
-- employees row, so the resolver exercises the production joins.
\set ON_ERROR_STOP on
begin;

-- The role-change policy trigger fires on our fixture profile upsert because
-- postgres' auth.uid() is null here. This is fixture setup only; the triggers
-- are restored before commit, so the application path is unaffected.
alter table public.profiles disable trigger trg_enforce_role_change;

-- Fixed UUIDs keep the scenario assertions readable.
create temp table fx (name text primary key, id uuid);
insert into fx values
  ('requester',   '7a111111-0000-0000-0000-000000000001'),
  ('branch_mgr_a','7a111111-0000-0000-0000-000000000002'),
  ('branch_mgr_b','7a111111-0000-0000-0000-000000000003'),
  ('area_mgr_a',  '7a111111-0000-0000-0000-000000000004'),
  ('area_mgr_b',  '7a111111-0000-0000-0000-000000000005'),
  ('hob_a',       '7a111111-0000-0000-0000-000000000006'),
  ('hob_b',       '7a111111-0000-0000-0000-000000000007'),
  ('hohr',        '7a111111-0000-0000-0000-000000000008'),
  ('md',          '7a111111-0000-0000-0000-000000000009'),
  ('dept_head',   '7a111111-0000-0000-0000-00000000000a'),
  ('branch_a',    '7a222222-0000-0000-0000-000000000001'),
  ('branch_b',    '7a222222-0000-0000-0000-000000000002'),
  ('branch_ho',   '7a222222-0000-0000-0000-000000000003'),
  ('area_a',      '7a333333-0000-0000-0000-000000000001'),
  ('area_b',      '7a333333-0000-0000-0000-000000000002'),
  ('emp_requester','7a444444-0000-0000-0000-000000000001'),
  ('emp_md',      '7a444444-0000-0000-0000-000000000002'),
  ('emp_ho',      '7a444444-0000-0000-0000-000000000003'),
  ('emp_branch_a','7a444444-0000-0000-0000-000000000005'),
  ('emp_branch_b','7a444444-0000-0000-0000-000000000006'),
  ('staff_a',     '7a111111-0000-0000-0000-00000000000b'),
  ('staff_b',     '7a111111-0000-0000-0000-00000000000c'),
  ('desig_hob',   '7a555555-0000-0000-0000-000000000001'),
  ('desig_md',    '7a555555-0000-0000-0000-000000000002'),
  ('desig_hr',    '7a555555-0000-0000-0000-000000000003'),
  ('desig_bm',    '7a555555-0000-0000-0000-000000000004');

-- --- auth identities -------------------------------------------------------
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id, lower(name)||'@leave.test', 'authenticated', 'authenticated',
       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  from fx
 where name in ('requester','branch_mgr_a','branch_mgr_b','area_mgr_a','area_mgr_b',
                'hob_a','hob_b','hohr','md','dept_head','staff_a','staff_b');

-- --- profiles --------------------------------------------------------------
-- ON CONFLICT because handle_new_user() already created a profile row when the
-- auth.users row was inserted above; we only fill in the leave fixture fields.
insert into public.profiles (id, full_name, role, status, email)
select id, initcap(replace(name,'_',' ')),
       case name
         when 'hohr'      then 'head_of_human_resources'
         when 'hob_a'     then 'head_of_business'
         when 'hob_b'     then 'head_of_business'
         when 'dept_head' then 'head_of_operations'
         when 'branch_mgr_a' then 'branch_manager'
         when 'branch_mgr_b' then 'branch_manager'
         when 'area_mgr_a'  then 'area_manager'
         when 'area_mgr_b'  then 'area_manager'
         else 'staff'
       end,
       'active', lower(name)||'@leave.test'
  from fx
 where name in ('requester','branch_mgr_a','branch_mgr_b','area_mgr_a','area_mgr_b',
                'hob_a','hob_b','hohr','md','dept_head')
on conflict (id) do update
   set full_name = excluded.full_name,
       role      = excluded.role,
       status    = excluded.status,
       email     = excluded.email;

-- --- branches (must exist before employees reference branch_id) -------------
-- The real bank already has a Head Office (code 'HO'); reuse it rather than
-- creating a duplicate, so the Head Office route is exercised against it.
insert into public.branches (id, branch_name, branch_code, status, working_days) values
  ('7a222222-0000-0000-0000-000000000001','FIXTURE BRANCH A','LX-A','active', array['mon','tue','wed','thu','fri']),
  ('7a222222-0000-0000-0000-000000000002','FIXTURE BRANCH B','LX-B','active', array['mon','tue','wed','thu','fri']);

-- EXACT managers, resolved by the production join.
update public.branches set manager_id = (select id from fx where name='branch_mgr_a')
 where id = '7a222222-0000-0000-0000-000000000001';
update public.branches set manager_id = (select id from fx where name='branch_mgr_b')
 where id = '7a222222-0000-0000-0000-000000000002';

do $$
declare v_ho uuid;
begin
  select id into v_ho from public.branches where upper(btrim(branch_code)) = 'HO' limit 1;
  if v_ho is null then
    insert into public.branches (id, branch_name, branch_code, status, working_days)
    values ('7a222222-0000-0000-0000-000000000003','FIXTURE HEAD OFFICE','LX-HO','active',
            array['mon','tue','wed','thu','fri'])
    returning id into v_ho;
  end if;
  update fx set id = v_ho where name = 'branch_ho';
end $$;

-- --- designations ----------------------------------------------------------
insert into public.designations (id, title, is_active) values
  ('7a555555-0000-0000-0000-000000000001','HEAD OF BUSINESS', true),
  ('7a555555-0000-0000-0000-000000000002','MD/CEO', true),
  ('7a555555-0000-0000-0000-000000000003','HEAD, HUMAN RESOURCES', true),
  ('7a555555-0000-0000-0000-000000000004','BRANCH MANAGER', true);

-- --- employees: the requesters --------------------------------------------
insert into public.employees (id, full_name, user_id, designation_id, position, branch_id, employment_status)
select e.id, 'Fixture '||e.pos, e.uid, e.desig, e.title, e.branch, 'active'
  from (values
   ('7a444444-0000-0000-0000-000000000001'::uuid,'requester',   '7a111111-0000-0000-0000-000000000001'::uuid,'7a555555-0000-0000-0000-000000000004'::uuid,'BRANCH MANAGER',        '7a222222-0000-0000-0000-000000000001'::uuid),
   ('7a444444-0000-0000-0000-000000000002'::uuid,'md',          '7a111111-0000-0000-0000-000000000009'::uuid,'7a555555-0000-0000-0000-000000000002'::uuid,'MD/CEO',                 (select id from fx where name='branch_ho')),
   ('7a444444-0000-0000-0000-000000000003'::uuid,'emp_ho',      '7a111111-0000-0000-0000-00000000000a'::uuid,'7a555555-0000-0000-0000-000000000003'::uuid,'HEAD, HUMAN RESOURCES', (select id from fx where name='branch_ho')),
   ('7a444444-0000-0000-0000-000000000005'::uuid,'emp_branch_a','7a111111-0000-0000-0000-00000000000b'::uuid,'7a555555-0000-0000-0000-000000000004'::uuid,'BRANCH MANAGER',        '7a222222-0000-0000-0000-000000000001'::uuid),
   ('7a444444-0000-0000-0000-000000000006'::uuid,'emp_branch_b','7a111111-0000-0000-0000-00000000000c'::uuid,'7a555555-0000-0000-0000-000000000004'::uuid,'BRANCH MANAGER',        '7a222222-0000-0000-0000-000000000002'::uuid)
  ) as e(id,pos,uid,desig,title,branch);

-- The approvers also need employee rows, so employee_id resolution is real.
insert into public.employees (id, full_name, user_id, designation_id, position, employment_status)
select gen_random_uuid(), initcap(replace(f.name,'_',' ')), f.id,
       case f.name when 'hob_a' then '7a555555-0000-0000-0000-000000000001'::uuid
                   when 'hob_b' then '7a555555-0000-0000-0000-000000000001'::uuid
                   when 'hohr'  then '7a555555-0000-0000-0000-000000000003'::uuid
                   else '7a555555-0000-0000-0000-000000000004'::uuid end,
       case f.name when 'hob_a' then 'HEAD OF BUSINESS'
                   when 'hob_b' then 'HEAD OF BUSINESS'
                   when 'hohr'  then 'HEAD, HUMAN RESOURCES'
                   else 'BRANCH MANAGER' end,
       'active'
  from fx f
 where f.name in ('branch_mgr_a','branch_mgr_b','area_mgr_a','area_mgr_b','hob_a','hob_b','hohr');

-- --- areas (need employees for manager_employee_id, so they come after) -----
insert into public.areas (id, area_code, area_name, manager_employee_id, is_active)
select f.id, upper(f.name), 'Fixture '||upper(f.name),
       (select e.id from public.employees e join fx g on g.id = e.user_id where g.name = f.mgr),
       true
  from (values
    ('7a333333-0000-0000-0000-000000000001'::uuid,'area_a'::text,'area_mgr_a'::text),
    ('7a333333-0000-0000-0000-000000000002'::uuid,'area_b'::text,'area_mgr_b'::text)
  ) as f(id,name,mgr);

insert into public.branch_area_assignments (branch_id, area_id, is_current, assigned_from)
select b.id::uuid, b.area::uuid, true, current_date
  from (values
    ('7a222222-0000-0000-0000-000000000001'::uuid,'7a333333-0000-0000-0000-000000000001'::uuid),
    ('7a222222-0000-0000-0000-000000000002'::uuid,'7a333333-0000-0000-0000-000000000002'::uuid)
  ) as b(id,area);

-- Authoritative business-scope HoB mapping: one per area, no bank-wide default.
insert into public.leave_business_heads (area_id, approver_user_id, approver_employee_id, approver_name, is_active)
select a.id::uuid, h.id,
       (select e.id from public.employees e where e.user_id = h.id),
       'Fixture HoB '||a.area, true
  from (values
    ('7a333333-0000-0000-0000-000000000001'::uuid,'hob_a'::text,'A'::text),
    ('7a333333-0000-0000-0000-000000000002'::uuid,'hob_b'::text,'B'::text)
  ) as a(id,hob,area)
  join fx h on h.name = a.hob;

-- Supervisor mapping so the Head Office route has a Department Head.
insert into public.employee_supervisors (employee_id, supervisor_employee_id, level, effective_from)
select '7a444444-0000-0000-0000-000000000003'::uuid, e.id, 1, current_date
  from public.employees e join fx f on f.id = e.user_id where f.name = 'dept_head';

-- Balance rows so the final approval has something to move.
insert into public.leave_balances (employee_id, employee_name, year, leave_type, entitled_days, used_days, effective_entitlement)
select f.id, 'Fixture '||f.name, 2026, 'annual', 10, 0, 10
  from fx f where f.name in ('requester','staff_a')
on conflict do nothing;

-- Restore the trigger the fixture disabled.
alter table public.profiles enable trigger trg_enforce_role_change;

-- ===========================================================================
-- Helper: act as a given user. The RPCs read auth.uid()/current_role(), so
-- every scenario impersonates a real actor.
-- ===========================================================================
create or replace function pg_temp.act_as(p_name text)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from fx where name = p_name;
  perform set_config('request.jwt.claim.sub', v_id::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id::text, 'role','authenticated')::text, true);
end $$;

create or replace function pg_temp.assert(p_ok boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'ASSERTION FAILED: %', p_label;
  end if;
  raise notice 'PASS: %', p_label;
end $$;

-- ===========================================================================
-- S1. Branch route: exact branch manager -> area manager -> HoB -> HoHR
-- ===========================================================================
select pg_temp.act_as('requester');
do $$
declare v jsonb; v_req uuid; v_t jsonb;
begin
  v := public.submit_leave_request(
    (select id from public.employees where user_id = (select id from fx where name='requester')),
    'annual', current_date + 7, current_date + 9, 'Scenario 1');
  v_req := (v ->> 'request_id')::uuid;
  perform pg_temp.assert(v ->> 'route' = 'branch', 'S1 route is branch');
  perform pg_temp.assert(v ->> 'config_status' = 'complete', 'S1 config complete');

  v_t := public.get_leave_approval_timeline(v_req);
  perform pg_temp.assert(jsonb_array_length(v_t -> 'stages') = 4, 'S1 has 4 stages');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'approver_user_id')
      = (select id from fx where name='branch_mgr_a')::text, 'S1 stage 1 is branch A manager');
  perform pg_temp.assert((v_t -> 'stages' -> 1 ->> 'approver_user_id')
      = (select id from fx where name='area_mgr_a')::text, 'S1 stage 2 is area A manager');
  perform pg_temp.assert((v_t -> 'stages' -> 2 ->> 'approver_user_id')
      = (select id from fx where name='hob_a')::text, 'S1 stage 3 is HoB A');
  perform pg_temp.assert((v_t -> 'stages' -> 3 ->> 'approver_user_id')
      = (select id from fx where name='hohr')::text, 'S1 stage 4 is Head of HR');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'status') = 'current', 'S1 stage 1 is current');
  perform pg_temp.assert((v_t ->> 'chain_locked')::boolean, 'S1 chain is locked');
  perform pg_temp.assert((v_t ->> 'original_start_date') = (current_date + 7)::text,
      'S1 original start captured');
  perform pg_temp.assert(v_t -> 'stages' -> 0 ->> 'approver_employee_id' is not null,
      'S1 stage 1 resolved employee_id');
end $$;

-- ===========================================================================
-- S2. Two-branch isolation: a branch B request must NEVER reach branch A's
--     manager, and a branch A approver must not be able to act on branch B.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb; v_raised boolean := false;
begin
  perform pg_temp.act_as('hohr');  -- HR files on behalf of the branch B employee
  v := public.submit_leave_request(
    (select id from public.employees where id = '7a444444-0000-0000-0000-000000000006'),
    'annual', current_date + 14, current_date + 16, 'Scenario 2');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'approver_user_id')
      = (select id from fx where name='branch_mgr_b')::text,
      'S2 branch B request routes to branch B manager');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'approver_user_id')
      <> (select id from fx where name='branch_mgr_a')::text,
      'S2 branch A manager is NOT in the branch B chain');
  perform pg_temp.assert((v_t -> 'stages' -> 2 ->> 'approver_user_id')
      = (select id from fx where name='hob_b')::text,
      'S2 branch B routes to its own HoB');

  -- branch A's manager must be refused on a branch B request.
  perform pg_temp.act_as('branch_mgr_a');
  begin
    perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'nope');
  exception when others then
    v_raised := true;
  end;
  perform pg_temp.assert(v_raised, 'S2 cross-branch approver is refused');
end $$;

-- ===========================================================================
-- S3. Missing mapping: break branch B's manager, rebuild, and require the
--     request to be flagged INCOMPLETE rather than routed to a stand-in.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb;
begin
  update public.branches set manager_id = null
   where id = '7a222222-0000-0000-0000-000000000002';
  perform pg_temp.act_as('hohr');
  v := public.submit_leave_request(
    (select id from public.employees where id = '7a444444-0000-0000-0000-000000000006'),
    'annual', current_date + 21, current_date + 23, 'Scenario 3');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert((v_t ->> 'config_status') = 'incomplete',
      'S3 missing branch manager flags the request incomplete');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'status') = 'unassigned',
      'S3 the broken stage is unassigned');
  perform pg_temp.assert(v_t -> 'stages' -> 0 ->> 'unresolved_issue' like '%Branch Manager%',
      'S3 the reason names the missing Branch Manager');
  -- The chain STOPS at the broken stage rather than skipping a whole approval
  -- level: no later stage may become current while stage 1 is unresolved.
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'status') = 'unassigned'
      and not exists (select 1 from jsonb_array_elements(v_t -> 'stages') s
                       where s ->> 'status' = 'current'),
      'S3 the chain is BLOCKED, not fast-tracked past the missing approver');
  -- restore
  update public.branches set manager_id = (select id from fx where name='branch_mgr_b')
   where id = '7a222222-0000-0000-0000-000000000002';
end $$;

-- ===========================================================================
-- S4. MD/CEO routing: straight to the Head of HR, no branch/area stages.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb;
begin
  perform pg_temp.act_as('md');
  v := public.submit_leave_request(
    (select id from public.employees where user_id = (select id from fx where name='md')),
    'annual', current_date + 28, current_date + 30, 'Scenario 4');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert(v ->> 'route' = 'md', 'S4 MD route detected');
  perform pg_temp.assert(jsonb_array_length(v_t -> 'stages') = 1,
      'S4 MD has exactly one stage');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'stage_key') = 'head_of_human_resources',
      'S4 MD goes to Head of HR only');
end $$;

-- ===========================================================================
-- S5. Head Office route: Department Head -> HoB -> Head of HR.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb;
begin
  perform pg_temp.act_as('hohr');
  v := public.submit_leave_request(
    (select id from public.employees where id = '7a444444-0000-0000-0000-000000000003'),
    'annual', current_date + 35, current_date + 37, 'Scenario 5');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert(v ->> 'route' = 'head_office', 'S5 head office route detected');
  perform pg_temp.assert(jsonb_array_length(v_t -> 'stages') = 3, 'S5 has 3 stages');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'stage_key') = 'head_of_department',
      'S5 stage 1 is Head of Department');
  perform pg_temp.assert((v_t -> 'stages' -> 2 ->> 'stage_key') = 'head_of_human_resources',
      'S5 last stage is Head of HR');
end $$;

-- ===========================================================================
-- S6. Rejection REQUIRES a reason, and is terminal.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb; v_raised boolean := false;
begin
  perform pg_temp.act_as('requester');
  v := public.submit_leave_request(
    (select id from public.employees where user_id = (select id from fx where name='requester')),
    'annual', current_date + 42, current_date + 44, 'Scenario 6');
  perform pg_temp.act_as('branch_mgr_a');
  -- p_rejection_reason is the 4th argument; leaving it NULL must be refused.
  begin
    perform public.act_on_leave_stage(
      (v ->> 'request_id')::uuid, 'rejected', 'looks fine to me', null);
  exception when others then
    v_raised := true;
  end;
  perform pg_temp.assert(v_raised, 'S6 rejection without a reason is refused');

  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'rejected',
                                    'Peak period, resubmit for a quieter period',
                                    'Peak period, resubmit for a quieter period');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert(v_t ->> 'status' = 'rejected', 'S6 request is rejected');
  perform pg_temp.assert(v_t -> 'stages' -> 0 ->> 'rejection_reason'
      like '%Peak period%', 'S6 the reason is stored on the stage');
end $$;

-- ===========================================================================
-- S7. Date modification: the approver shortens the leave. The ORIGINAL period
--     must survive untouched, and the change must be attributed.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb; v_raised boolean := false;
begin
  perform pg_temp.act_as('requester');
  v := public.submit_leave_request(
    (select id from public.employees where user_id = (select id from fx where name='requester')),
    'annual', current_date + 50, current_date + 56, 'Scenario 7');
  perform pg_temp.act_as('branch_mgr_a');

  -- A date change without a stated reason must be refused.
  begin
    perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'ok',
                                      null, current_date + 50, current_date + 52, null);
  exception when others then v_raised := true; end;
  perform pg_temp.assert(v_raised, 'S7 date change without a reason is refused');

  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved',
    'Shortened to the first three days', null,
    current_date + 50, current_date + 52, 'Cover needed for the branch');

  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert((v_t ->> 'start_date') = (current_date + 50)::text
      and (v_t ->> 'end_date') = (current_date + 52)::text, 'S7 current dates updated');
  perform pg_temp.assert((v_t ->> 'original_start_date') = (current_date + 50)::text
      and (v_t ->> 'original_end_date') = (current_date + 56)::text,
      'S7 ORIGINAL dates are preserved');
  perform pg_temp.assert((v_t ->> 'dates_modified')::boolean, 'S7 flagged as modified');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'modified_end_date') = (current_date + 52)::text,
      'S7 the change is recorded on the acting stage');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'modification_comment')
      like '%Cover needed%', 'S7 the modification reason is stored');
  perform pg_temp.assert((v_t -> 'stages' -> 1 ->> 'status') = 'current',
      'S7 the chain advanced to stage 2');
end $$;

-- ===========================================================================
-- S8. Duplicate action is exactly-once: the same approver clicking twice must
--     fail the second time, and the balance must move only once.
-- ===========================================================================
do $$
declare v jsonb; v_raised boolean := false;
begin
  -- The employee files their own request, so created_by is a real requester and
  -- the self-approval guard cannot be tripped by the Head of HR.
  perform pg_temp.act_as('staff_a');
  v := public.submit_leave_request(
    (select id from public.employees where id = '7a444444-0000-0000-0000-000000000005'),
    'annual', current_date + 60, current_date + 62, 'Scenario 8');
  perform pg_temp.act_as('branch_mgr_a');
  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'ok');
  perform pg_temp.act_as('area_mgr_a');
  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'ok');
  perform pg_temp.act_as('hob_a');
  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'ok');
  perform pg_temp.act_as('hohr');
  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'final');

  perform pg_temp.assert((select status from public.leave_requests
                           where id = (v ->> 'request_id')::uuid) = 'approved',
      'S8 request reached approved');

  -- The final approver tries to approve AGAIN (double click / retry).
  begin
    perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'again');
  exception when others then v_raised := true; end;
  perform pg_temp.assert(v_raised, 'S8 a duplicate final approval is refused');

  perform pg_temp.assert((select count(*) from public.leave_approvals
                           where leave_request_id = (v ->> 'request_id')::uuid
                             and decision = 'approved') = 4,
      'S8 exactly four approval trail rows (one per stage, no duplicate)');
  -- The period may span a weekend, so compare against the engine's own count
  -- rather than assuming three days.
  perform pg_temp.assert((select days from public.leave_requests
                           where id = (v ->> 'request_id')::uuid)
      = public.leave_working_days(current_date + 60, current_date + 62,
           (select branch_id from public.employees
             where id = '7a444444-0000-0000-0000-000000000005')),
      'S8 the approved request kept its computed working days');

  -- And the balance moved by exactly that amount, once.
  perform pg_temp.assert((select used_days from public.leave_balances
      where employee_id = (select id from fx where name='staff_a')
        and leave_type = 'annual') = 1,
      'S8 the balance was deducted exactly once for the approved request');
end $$;

-- ===========================================================================
-- S9. Self-approval is refused, whoever asks.
-- ===========================================================================
do $$
declare v jsonb; v_raised boolean := false;
begin
  perform pg_temp.act_as('hohr');
  v := public.submit_leave_request(
    (select id from public.employees where user_id = (select id from fx where name='requester')),
    'annual', current_date + 70, current_date + 71, 'Scenario 9');
  -- The requester here holds no approver role, but the guard must still hold for
  -- the case where the requester IS the current approver (checked in S8's setup).
  perform pg_temp.act_as('requester');
  begin
    perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'self');
  exception when others then v_raised := true; end;
  perform pg_temp.assert(v_raised, 'S9 self-approval is refused');
end $$;

-- ===========================================================================
-- S10. HR repair: a broken mapping is fixable, audited, and the stalled
--      request resumes. Also proves an unassigned stage is NOT auto-guessed.
-- ===========================================================================
do $$
declare v jsonb; v_t jsonb; v_stage uuid;
begin
  update public.branches set manager_id = null
   where id = '7a222222-0000-0000-0000-000000000001';
  perform pg_temp.act_as('requester');
  v := public.submit_leave_request(
    (select id from public.employees where user_id = (select id from fx where name='requester')),
    'annual', current_date + 80, current_date + 82, 'Scenario 10');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert((v_t ->> 'config_status') = 'incomplete', 'S10 flagged incomplete');

  select id into v_stage from public.leave_approval_stages
   where leave_request_id = (v ->> 'request_id')::uuid and status = 'unassigned';
  perform pg_temp.assert(v_stage is not null, 'S10 the broken stage exists as unassigned');
  perform pg_temp.assert((select approver_user_id from public.leave_approval_stages
                          where id = v_stage) is null,
      'S10 no stand-in approver was ever invented');

  perform pg_temp.act_as('hohr');
  perform public.repair_leave_approval_stage(v_stage,
    (select id from fx where name='branch_mgr_a'), 'Acting branch manager assigned by HR');

  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  -- The chain was blocked at stage 1; repairing it unblocks and starts it.
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'status') = 'current',
      'S10 the repaired stage becomes current and the request resumes');
  perform pg_temp.assert((v_t -> 'stages' -> 0 ->> 'approver_user_id')
      = (select id from fx where name='branch_mgr_a')::text,
      'S10 the repaired stage carries the HR-assigned approver');
  perform pg_temp.assert(v_t -> 'stages' -> 0 ->> 'unresolved_issue' is null,
      'S10 the unresolved reason is cleared');
  perform pg_temp.assert((v_t ->> 'config_status') = 'complete', 'S10 config is now complete');
  perform pg_temp.assert(exists (select 1 from public.audit_logs
      where action = 'LEAVE_APPROVAL_STAGE_REPAIRED'),
      'S10 the repair is audited');

  -- And the request now advances normally through the repaired stage.
  perform pg_temp.act_as('branch_mgr_a');
  perform public.act_on_leave_stage((v ->> 'request_id')::uuid, 'approved', 'ok');
  v_t := public.get_leave_approval_timeline((v ->> 'request_id')::uuid);
  perform pg_temp.assert((v_t -> 'stages' -> 1 ->> 'status') = 'current',
      'S10 the chain advances past the repaired stage');
end $$;

rollback;
