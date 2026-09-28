-- ============================================================================
-- Work Management & KPI Engine Overhaul - step 7: SLA breach detection
-- ============================================================================
-- Flags work submissions that blew their review SLA and writes a durable
-- audit row for HR performance reporting. Idempotent: a breached task is
-- recorded ONCE (the second call is a no-op), so re-running or a duplicate
-- cron tick cannot spam the log.
begin;

create or replace function public.work_task_sla_breaches()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r     record;
  v_count integer := 0;
begin
  for r in
    select t.id, t.title, t.sla_review_deadline, t.assigned_to_user_id,
           h.id as already_logged
      from public.work_tasks t
     where t.sla_review_deadline is not null
       and t.sla_review_deadline < now()
       and t.status = 'under_review'
       -- never logged before for this task
       and not exists (
         select 1 from public.audit_logs a
          where a.action = 'WORK_TASK_SLA_BREACHED'
            and a.entity_id = t.id::text)
  loop
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('WORK_TASK_SLA_BREACHED','work_task', r.id::text, 'system',
            jsonb_build_object(
              'title', r.title,
              'assignee', r.assigned_to_user_id,
              'deadline', r.sla_review_deadline,
              'hours_overdue', round(extract(epoch from (now() - r.sla_review_deadline)) / 3600.0, 1)
            )::text,
            'warning');

    update public.work_tasks set status = 'overdue', updated_at = now() where id = r.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.work_task_sla_breaches is
  'Marks review-SLA-breached submissions as overdue and audits each one exactly once. Returns how many were newly flagged.';

-- Hourly sweep, guarded on pg_cron being installed (hosted Supabase has it;
-- a plain scratch Postgres does not).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'infinitycore-work-task-sla';
    perform cron.schedule('infinitycore-work-task-sla', '7 * * * *',
                          'select public.work_task_sla_breaches()');
  end if;
exception when others then
  raise notice 'pg_cron not available - SLA breach sweep must be run manually: %', sqlerrm;
end;
$$;

commit;
