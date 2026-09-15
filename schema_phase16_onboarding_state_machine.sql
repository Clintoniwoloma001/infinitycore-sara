-- ============================================================
-- PHASE 16 — ONBOARDING COMPLETION STATE MACHINE
--
-- Single source of truth: employee_onboarding_submissions.onboarding_status
--   (set by HR approve/reject RPCs or the new self-service RPC below).
--
-- Sync targets:
--   1. employee_digital_files.onboarding_completed  -> candidate home gate
--      (App.jsx Home() reads this; employees can read their own row via RLS)
--   2. A trigger keeps the digital file in lockstep whenever a submission
--      transitions to 'completed', so HR approval automatically stops the
--      candidate from seeing the self-service wizard again.
--
-- Back-fills existing completed submissions + guarantees every employee
-- record has a completed digital file (employees are only ever created once
-- onboarding is effectively done: link submission, self-service, or manual).
--
-- Idempotent + additive. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Trigger function: sync a completed submission to the digital file
-- ------------------------------------------------------------
create or replace function public.sync_onboarding_to_digital_file()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.onboarding_status = 'completed' and new.employee_id is not null then
    insert into public.employee_digital_files (
      employee_id, user_id, onboarding_completed, onboarding_completed_at
    )
    values (
      new.employee_id,
      (select user_id from public.employees where id = new.employee_id limit 1),
      true,
      coalesce(new.reviewed_at, new.updated_at, now())
    )
    on conflict (employee_id) do update
      set onboarding_completed = true,
          onboarding_completed_at = excluded.onboarding_completed_at,
          updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_onboarding_to_digital_file on public.employee_onboarding_submissions;
create trigger trg_onboarding_to_digital_file
  after insert or update of onboarding_status on public.employee_onboarding_submissions
  for each row
  when (new.onboarding_status = 'completed')
  execute function public.sync_onboarding_to_digital_file();

-- ------------------------------------------------------------
-- 2. Trigger: give every new employee a completed digital file.
--    Employee records are only created once onboarding is done
--    (link submission, self-service completion, or HR manual).
--    This keeps the home-gate consistent for HR-created staff and
--    prevents a manual employee from being forced through the wizard.
-- ------------------------------------------------------------
create or replace function public.ensure_employee_digital_file()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.employee_digital_files (
    employee_id, user_id, onboarding_completed, onboarding_completed_at, profile_completion_pct
  )
  values (new.id, new.user_id, true, now(), 100)
  on conflict (employee_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_employee_digital_file on public.employees;
create trigger trg_employee_digital_file
  after insert on public.employees
  for each row
  execute function public.ensure_employee_digital_file();

-- ------------------------------------------------------------
-- 3. Back-fill: digital files for existing employees that lack one
-- ------------------------------------------------------------
insert into public.employee_digital_files (
  employee_id, user_id, onboarding_completed, onboarding_completed_at, profile_completion_pct
)
select e.id, e.user_id, true,
       coalesce((
         select s.reviewed_at from public.employee_onboarding_submissions s
         where s.employee_id = e.id and s.onboarding_status = 'completed'
         order by s.reviewed_at desc limit 1
       ), e.updated_at, e.created_at, now()),
       100
from public.employees e
where not exists (
  select 1 from public.employee_digital_files d where d.employee_id = e.id
)
on conflict (employee_id) do nothing;

-- Back-fill any digital files left behind by the older approve_onboarding RPC
-- (submission completed but digital file still false).
update public.employee_digital_files d
   set onboarding_completed = true,
       onboarding_completed_at = s.reviewed_at,
       updated_at = now()
  from public.employee_onboarding_submissions s
 where s.employee_id = d.employee_id
   and s.onboarding_status = 'completed'
   and d.onboarding_completed = false;

-- ------------------------------------------------------------
-- 4. RPC: complete_self_onboarding (authenticated)
--    Called by the candidate's OnboardingFlow after their record
--    is saved. Records the completion in employee_onboarding_submissions
--    so the Back Office review centre reflects the completed profile,
--    and marks the digital file complete. Idempotent.
-- ------------------------------------------------------------
create or replace function public.complete_self_onboarding(
  p_employee_id uuid default null,
  p_link_id uuid default null,
  p_payload jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp_id uuid;
  v_emp public.employees%rowtype;
  v_sub_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_emp_id := coalesce(
    p_employee_id,
    (select id from public.employees where user_id = auth.uid() order by created_at desc limit 1)
  );
  if v_emp_id is null then
    raise exception 'No employee record found for current user.';
  end if;

  select * into v_emp from public.employees where id = v_emp_id;

  -- 1. Mark the digital file complete
  insert into public.employee_digital_files (
    employee_id, user_id, onboarding_completed, onboarding_completed_at, profile_completion_pct
  )
  values (v_emp_id, v_emp.user_id, true, now(), 100)
  on conflict (employee_id) do update
    set onboarding_completed = true,
        onboarding_completed_at = now(),
        user_id = excluded.user_id,
        updated_at = now();

  -- 2. Create or update the submission row so BO review centre reflects it
  select id into v_sub_id
  from public.employee_onboarding_submissions
  where employee_id = v_emp_id
  order by created_at desc
  limit 1;

  if v_sub_id is null then
    insert into public.employee_onboarding_submissions (
      link_id, employee_id, candidate_name, email, phone, "position", department,
      employment_type, payload, declaration_accepted, signature_data,
      status, onboarding_status, reviewed_by, reviewed_at, review_comments, submitted_at
    )
    values (
      p_link_id, v_emp_id, v_emp.full_name, v_emp.email, v_emp.phone,
      v_emp.position, v_emp.department, v_emp.employment_type,
      p_payload, true, null,
      'approved', 'completed', auth.uid(), now(),
      'Completed via self-service onboarding', now()
    )
    returning id into v_sub_id;
  else
    update public.employee_onboarding_submissions
       set onboarding_status = 'completed',
           status = 'approved',
           payload = coalesce(p_payload, payload),
           reviewed_by = auth.uid(),
           reviewed_at = now()
     where id = v_sub_id;
  end if;

  -- 3. Audit trail
  insert into public.onboarding_events (onboarding_link_id, event_type, details, actor)
  values (
    coalesce(p_link_id, (select link_id from public.employee_onboarding_submissions where id = v_sub_id)),
    'SELF_SERVICE_COMPLETED',
    format('Onboarding completed by %s', coalesce(v_emp.full_name, 'employee')),
    coalesce(v_emp.full_name, 'employee')
  )
  on conflict do nothing;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'SELF_SERVICE_ONBOARDING_COMPLETED', 'OnboardingSubmission', v_sub_id::text,
    coalesce(v_emp.full_name, ''), format('Self-service onboarding completed by %s', coalesce(v_emp.full_name, 'employee')), 'info'
  );

  return jsonb_build_object('ok', true, 'employee_id', v_emp_id, 'submission_id', v_sub_id);
end;
$$;

grant execute on function public.complete_self_onboarding(uuid, uuid, jsonb) to authenticated;