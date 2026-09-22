-- Performance Improvement Plan (PIP) module
-- Idempotent/additive. Run in Supabase SQL Editor after existing performance migrations.

-- 1. PIP header table
 create table if not exists public.performance_improvement_plans (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  start_date date not null,
  end_date date not null,
  period_months int not null default 3,
  next_steps text,
  verdict text check (verdict in ('upgrade', 'downgrade')),
  verdict_at timestamptz,
  verdict_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Metrics selected for a PIP
 create table if not exists public.pip_metrics (
  id uuid primary key default gen_random_uuid(),
  pip_id uuid not null references public.performance_improvement_plans(id) on delete cascade,
  metric_id uuid references public.performance_metrics(id) on delete set null,
  metric_name text not null,
  target_value numeric not null default 0,
  unique (pip_id, metric_id)
);

-- 3. Audit trail for allowance adjustments applied at verdict
 create table if not exists public.pip_allowance_adjustments (
  id uuid primary key default gen_random_uuid(),
  pip_id uuid not null references public.performance_improvement_plans(id) on delete cascade,
  component_name text not null,
  component_type text not null default 'allowance',
  old_value numeric not null default 0,
  new_value numeric not null default 0,
  basis text not null default 'manual' check (basis in ('manual', 'percent_achievement', 'percent_previous')),
  percent numeric,
  achievement_pct numeric,
  reason text,
  adjusted_by uuid references public.profiles(id) on delete set null,
  adjusted_at timestamptz default now()
);

-- 4. Indexes
 create index if not exists idx_pip_employee on public.performance_improvement_plans(employee_id);
 create index if not exists idx_pip_status on public.performance_improvement_plans(status);
 create index if not exists idx_pip_dates on public.performance_improvement_plans(start_date, end_date);
 create index if not exists idx_pip_metrics_pip on public.pip_metrics(pip_id);
 create index if not exists idx_pip_adjustments_pip on public.pip_allowance_adjustments(pip_id);

-- 5. RLS enablement (policies rely on current_role)
 alter table public.performance_improvement_plans enable row level security;
 alter table public.pip_metrics enable row level security;
 alter table public.pip_allowance_adjustments enable row level security;

-- Read: HR roles + admin + super_admin + the employee themselves
 drop policy if exists "pips_read_authorized" on public.performance_improvement_plans;
 create policy "pips_read_authorized"
   on public.performance_improvement_plans for select
   using (
     public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
     or exists (
       select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()
     )
   );

 drop policy if exists "pip_metrics_read_authorized" on public.pip_metrics;
 create policy "pip_metrics_read_authorized"
   on public.pip_metrics for select
   using (
     public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
     or exists (
       select 1 from public.performance_improvement_plans p
       join public.employees e on e.id = p.employee_id
       where p.id = pip_id and e.user_id = auth.uid()
     )
   );

 drop policy if exists "pip_adjustments_read_authorized" on public.pip_allowance_adjustments;
 create policy "pip_adjustments_read_authorized"
   on public.pip_allowance_adjustments for select
   using (
     public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer')
     or exists (
       select 1 from public.performance_improvement_plans p
       join public.employees e on e.id = p.employee_id
       where p.id = pip_id and e.user_id = auth.uid()
     )
   );

-- Write: HR roles + admin + super_admin only
 drop policy if exists "pips_write_hr" on public.performance_improvement_plans;
 create policy "pips_write_hr"
   on public.performance_improvement_plans for all
   using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
   with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));

 drop policy if exists "pip_metrics_write_hr" on public.pip_metrics;
 create policy "pip_metrics_write_hr"
   on public.pip_metrics for all
   using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
   with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));

 drop policy if exists "pip_adjustments_write_hr" on public.pip_allowance_adjustments;
 create policy "pip_adjustments_write_hr"
   on public.pip_allowance_adjustments for all
   using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'))
   with check (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer'));

-- 6. Helper to close PIP and record verdict (audited)
 create or replace function public.close_performance_improvement_plan(
   p_pip_id uuid,
   p_verdict text,
   p_reason text default null
 ) returns jsonb
 language plpgsql
 security definer
 set search_path = public
 as $$
 declare
   v_role text := public.current_role();
   v_actor text := coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text);
   v_pip record;
 begin
   if v_role not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
     raise exception 'Not authorized to close a performance improvement plan';
   end if;

   if p_verdict not in ('upgrade', 'downgrade') then
     raise exception 'Verdict must be upgrade or downgrade';
   end if;

   select * into v_pip from public.performance_improvement_plans where id = p_pip_id;
   if v_pip is null then raise exception 'PIP not found'; end if;

   update public.performance_improvement_plans
      set status = 'completed',
          verdict = p_verdict,
          verdict_at = now(),
          verdict_by = auth.uid(),
          updated_at = now()
    where id = p_pip_id;

   insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
   values (
     'PIP_CLOSED',
     'PerformanceImprovementPlan',
     p_pip_id::text,
     v_actor,
     jsonb_build_object(
       'employee_id', v_pip.employee_id,
       'verdict', p_verdict,
       'reason', p_reason,
       'actor_role', v_role
     )::text,
     'info'
   );

   return jsonb_build_object('ok', true, 'pip_id', p_pip_id);
 end;
 $$;

 grant execute on function public.close_performance_improvement_plan(uuid, text, text) to authenticated;
