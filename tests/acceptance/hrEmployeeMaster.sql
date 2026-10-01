-- Behavioural acceptance for the authoritative HR employee master.
-- Runs against a real Postgres. Every assertion RAISES, so any failure aborts
-- with a non-zero exit code. Wrapped in a transaction that is ROLLED BACK:
-- nothing here mutates production data.
--
--   psql -v ON_ERROR_STOP=1 -f tests/acceptance/hrEmployeeMaster.sql

begin;

create or replace function public.tmp_sign_in_as(p_email text) returns void
language plpgsql as $$
declare v_uid text;
begin
  select u.id::text into v_uid from auth.users u where u.email = p_email limit 1;
  -- auth.uid() reads request.jwt.claim.sub on some Supabase versions and the
  -- whole claims JSON on others, so set both.
  perform set_config('request.jwt.claims',
    json_build_object('role','authenticated','email',p_email,'sub',v_uid)::text, true);
  perform set_config('request.jwt.claim.sub', v_uid, true);
  perform set_config('request.jwt.claim.email', p_email, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixture. Declared OUTSIDE the plpgsql block: SET LOCAL is a utility command
-- and cannot be issued inside a DO block, and the fixture needs triggers
-- suspended so it can promote its own profiles past handle_new_user() and
-- enforce_role_change_policy. Those platform guards are NOT weakened — the
-- suspension is transaction-local and this whole file rolls back.
-- ---------------------------------------------------------------------------
set local session_replication_role = 'replica';
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'hr.lead@infinitymfb.com'),
  ('22222222-2222-2222-2222-222222222222', 'staff.one@infinitymfb.com')
  on conflict (id) do nothing;
insert into public.profiles (id, email, full_name, role, status) values
  ('11111111-1111-1111-1111-111111111111','hr.lead@infinitymfb.com','HR Lead','head_of_human_resources','active'),
  ('22222222-2222-2222-2222-222222222222','staff.one@infinitymfb.com','Staff One','loan_officer','active')
  on conflict (id) do update set role = excluded.role, status = excluded.status;
set local session_replication_role = 'origin';

-- Fail loudly if the fixture did not land, rather than silently testing with
-- the wrong authority.
do $$
begin
  if (select role from public.profiles where id='11111111-1111-1111-1111-111111111111')
     is distinct from 'head_of_human_resources' then
    raise exception 'FIXTURE FAILED: HR profile role is %',
      (select role from public.profiles where id='11111111-1111-1111-1111-111111111111');
  end if;
end;
$$;

do $$
declare
  v_session uuid;
  v_person_conflict uuid;
  v_person_new     uuid;
  v_person_ok      uuid;
  v_emp_new        uuid;
  v_emp_old        uuid;
  v_result         jsonb;
  v_name           text;
  v_code           text;
  v_n              int;
  v_auth_before    int;
begin

  -- An EXISTING employee that already has payroll history attached.
  insert into public.employees (id, full_name, employee_code, email, department, position, branch)
  values ('33333333-3333-3333-3333-333333333333','STALE NAME PENDING REWRITE','IMFB/11/0020',
          'o.olayemi@infinitymfb.com','CREDIT & MARKETING','LOAN OFFICER','KETU')
  on conflict (id) do nothing;

  -- The supervisor the workbook references (via a truncated label).
  insert into public.employees (id, full_name, employee_code)
  values ('44444444-4444-4444-4444-444444444444','UKUAGHE JUDE OAMEN','IMFB/09/0001')
  on conflict (id) do nothing;

  insert into public.employee_salary_snapshots (employee_id, period_label, gross_monthly)
  values ('33333333-3333-3333-3333-333333333333','2026-09',500000)
  on conflict do nothing;

  -- -------------------------------- TEST 1: a non-HR caller is refused
  select count(*) into v_auth_before from auth.users;
  perform public.tmp_sign_in_as('staff.one@infinitymfb.com');
  begin
    perform public.hr_master_stage_session('x.xlsx','hash-nope',current_date,'{}'::jsonb,'v1');
    raise exception 'TEST1 FAILED: a loan officer was allowed to import the employee master';
  exception when others then
    if sqlerrm like 'TEST1 FAILED%' then raise; end if;
  end;
  perform public.tmp_sign_in_as('hr.lead@infinitymfb.com');

  -- -------------------------------- TEST 2: stage a session
  select public.hr_master_stage_session(
    'IT AUTOMATION LIST REVIEWED-2.xlsx','test-hash-1',current_date,
    jsonb_build_object('people',3,'conflicts',1),'v1') into v_session;
  if v_session is null then raise exception 'TEST2 FAILED: no session created'; end if;

-- -------------------------------- TEST 3: stage three people
  perform public.hr_master_stage_people(v_session, jsonb_build_array(
    jsonb_build_object('staff_id','IMFB/11/0020','full_name','OLAYEMI ODUNOLA MULIKAT',
      'confirmed','CONFIRMED','designation','BRANCH MANAGER','department','CREDIT & MARKETING',
      'email','o.olayemi@infinitymfb.com','sheets',jsonb_build_array('FRONT END'),
      'identity_kind','match_existing','match_key','staff_id',
      'employee_id','33333333-3333-3333-3333-333333333333','needs_review',false),
    jsonb_build_object('staff_id','IMFB/20/0147','full_name','SIMON TUNDE ADEMOLA',
      'confirmed','CONFIRMED','designation','DRIVER','department','ADMINISTRATION',
      'email','N/A','sheets',jsonb_build_array('BACKEND'),
      'identity_kind','staff_id_conflict','reason','staff id used by two people','needs_review',true),
    jsonb_build_object('staff_id','IMFB/99/9001','full_name','BRAND NEW PERSON',
      'confirmed','UNCONFIRMED','designation','OFFICE ASSISTANT','department','OPERATIONS',
      'email','N/A','sheets',jsonb_build_array('BACKEND'),
      'identity_kind','new_employee','needs_review',false)
  ));
  select id into v_person_ok      from public.hr_master_people where session_id=v_session and staff_id='IMFB/11/0020';
  select id into v_person_conflict from public.hr_master_people where session_id=v_session and staff_id='IMFB/20/0147';
  select id into v_person_new     from public.hr_master_people where session_id=v_session and staff_id='IMFB/99/9001';
  if v_person_ok is null or v_person_conflict is null or v_person_new is null then
    raise exception 'TEST3 FAILED: staged people missing';
  end if;

  -- ------------------------- TEST 4: ONE person with TWO branch assignments
  perform public.hr_master_stage_person_branches(v_session, jsonb_build_array(
    jsonb_build_object('person_id',v_person_ok,'branch_label','KETU','source_sheet','FRONT END','ordinal',0),
    jsonb_build_object('person_id',v_person_ok,'branch_label','HEAD OFFICE','source_sheet','BACKEND','ordinal',1),
    jsonb_build_object('person_id',v_person_new,'branch_label','ALABA','source_sheet','BACKEND','ordinal',0)
  ));

  -- ------------------------- TEST 5: stage supervisor links
  perform public.hr_master_stage_supervisor_links(v_session, jsonb_build_array(
    jsonb_build_object('person_id',v_person_ok,'level',1,'label','UKUAGHE JUDE',
      'tier','prefix_truncated','supervisor_employee_id','44444444-4444-4444-4444-444444444444','status','applied'),
    jsonb_build_object('person_id',v_person_conflict,'level',1,'label','UKUAGHE JUDE',
      'tier','prefix_truncated','supervisor_employee_id','44444444-4444-4444-4444-444444444444','status','applied'),
    -- an ORGANISATION BODY must never be written as a person
    jsonb_build_object('person_id',v_person_ok,'level',2,'label','BOD',
      'tier','organisation_body','status','organisation_body')
  ));

  -- ------------------------- TEST 6: apply
  v_result := public.hr_master_apply_session(v_session);
  if not (v_result->>'ok')::boolean then raise exception 'TEST6 FAILED: apply not ok'; end if;
  if (v_result->>'employees_updated')::int <> 1 then
    raise exception 'TEST6 FAILED: expected 1 updated employee, got %', v_result->>'employees_updated';
  end if;
  if (v_result->>'employees_created')::int <> 1 then
    raise exception 'TEST6 FAILED: expected 1 created employee, got %', v_result->>'employees_created';
  end if;

-- ------------------- TEST 7: identity and history preserved in place
  select employee_code, full_name into v_code, v_name
    from public.employees where id='33333333-3333-3333-3333-333333333333';
  if v_code is distinct from 'IMFB/11/0020' then raise exception 'TEST7 FAILED: employee_code changed'; end if;
  if v_name is distinct from 'OLAYEMI ODUNOLA MULIKAT' then
    raise exception 'TEST7 FAILED: full_name not rewritten to the workbook value (got %)', v_name;
  end if;
  if not exists (select 1 from public.employee_salary_snapshots
                  where employee_id='33333333-3333-3333-3333-333333333333') then
    raise exception 'TEST7 FAILED: payroll history lost';
  end if;

  -- ------------------- TEST 8: auth identities untouched
  select count(*) into v_n from auth.users;
  if v_n <> v_auth_before then
    raise exception 'TEST8 FAILED: auth.users changed % -> %', v_auth_before, v_n;
  end if;
  if not exists (select 1 from auth.users where id='11111111-1111-1111-1111-111111111111') then
    raise exception 'TEST8 FAILED: the HR auth identity disappeared';
  end if;

  -- ------------------- TEST 9: multi-branch is ONE identity
  select count(*) into v_n from public.employee_branch_assignments
   where employee_id='33333333-3333-3333-3333-333333333333' and is_active;
  if v_n <> 2 then raise exception 'TEST9 FAILED: expected 2 assignments, got %', v_n; end if;
  select count(*) into v_n from public.employee_branch_assignments
   where employee_id='33333333-3333-3333-3333-333333333333' and is_primary;
  if v_n <> 1 then raise exception 'TEST9 FAILED: must be exactly one primary assignment'; end if;
  select id into v_emp_old from public.employees where employee_code='IMFB/11/0020';
  select id into v_emp_new from public.employees where employee_code='IMFB/99/9001';
  if v_emp_old = v_emp_new then raise exception 'TEST9 FAILED: identities were merged'; end if;

  -- ------------------- TEST 10: an org body is not a supervisor
  if exists (select 1 from public.employee_supervisors
              where employee_id='33333333-3333-3333-3333-333333333333' and level=2) then
    raise exception 'TEST10 FAILED: an organisational body was written as a supervisor';
  end if;
  if not exists (select 1 from public.employee_supervisors
                  where employee_id='33333333-3333-3333-3333-333333333333' and level=1
                    and supervisor_employee_id='44444444-4444-4444-4444-444444444444') then
    raise exception 'TEST10 FAILED: the resolved level-1 supervisor was not applied';
  end if;

  -- ------------------- TEST 11: the conflicting person stays unresolved
  if exists (select 1 from public.employees where employee_code='IMFB/20/0147') then
    raise exception 'TEST11 FAILED: a conflicting staff id created an employee';
  end if;
  if not exists (select 1 from public.hr_master_people
                  where id=v_person_conflict and needs_review) then
    raise exception 'TEST11 FAILED: the conflict must stay in the review queue';
  end if;

  -- ------------------- TEST 12: re-apply is idempotent
  v_result := public.hr_master_apply_session(v_session);
  if (v_result->>'employees_created')::int <> 0 then
    raise exception 'TEST12 FAILED: re-apply created another employee';
  end if;
  select count(*) into v_n from public.employees where employee_code='IMFB/99/9001';
  if v_n <> 1 then raise exception 'TEST12 FAILED: re-apply duplicated the new employee'; end if;
  select count(*) into v_n from public.employee_branch_assignments
   where employee_id='33333333-3333-3333-3333-333333333333' and is_active;
  if v_n <> 2 then raise exception 'TEST12 FAILED: re-apply duplicated branch assignments'; end if;
  select count(*) into v_n from public.employee_supervisors
   where employee_id='33333333-3333-3333-3333-333333333333';
  if v_n <> 1 then raise exception 'TEST12 FAILED: re-apply duplicated the supervisor link'; end if;

  -- ------------------- TEST 13: the same file reuses its session
  if public.hr_master_stage_session('IT AUTOMATION LIST REVIEWED-2.xlsx','test-hash-1',
       current_date,'{}'::jsonb,'v1') <> v_session then
    raise exception 'TEST13 FAILED: the same file must reuse its session';
  end if;

  -- ------------------- TEST 14: no self-supervision
  if exists (select 1 from public.employee_supervisors
              where employee_id = supervisor_employee_id) then
    raise exception 'TEST14 FAILED: an employee supervises themselves';
  end if;

  -- ------------------- TEST 15: the apply was audited
  if not exists (select 1 from public.audit_logs where action='HR_MASTER_IMPORT_APPLIED') then
    raise exception 'TEST15 FAILED: apply was not audited';
  end if;

  -- ------------------- TEST 16: DB normalisation matches the JS rules
  if public.hr_normalize_name('ORUSOSO  ISIOMA-NWALIGBE') <> 'ORUSOSO ISIOMA NWALIGBE' then
    raise exception 'TEST16 FAILED: name normalisation';
  end if;
  if public.hr_normalize_branch('LAGOS ISLAND2') <> 'LAGOS ISLAND 2' then
    raise exception 'TEST16 FAILED: branch normalisation';
  end if;

  raise notice 'ALL HR EMPLOYEE MASTER ACCEPTANCE TESTS PASSED';
end;
$$;

rollback;
