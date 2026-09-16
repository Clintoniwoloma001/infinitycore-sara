-- ============================================================================
-- schema_phase33_hr_payroll_lifecycle.sql
-- ============================================================================
-- Completes the HR payroll lifecycle on top of the EXISTING architecture.
-- Nothing here duplicates an existing system:
--   * payroll / payroll_periods / payroll_config / compute_payroll are reused.
--   * documents + private `documents` storage bucket hold employment letters.
--   * integration_connections / integration_outbound_queue (Phase 15) hold the
--     BankOne API push. This migration only adds the payroll-specific request,
--     signature and approval objects that did not exist.
--
-- Additive and idempotent — safe to re-run.
-- ============================================================================


-- ============================================================================
-- 1. EMPLOYMENT LETTERS
--    Permanent record + link to the generated file stored in the private
--    `documents` storage bucket (via the existing documents table).
-- ============================================================================
create table if not exists public.employment_letters (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  version int not null default 1,
  status text not null default 'issued'
    check (status in ('draft', 'issued', 'superseded', 'revoked')),
  position text,
  department text,
  branch text,
  employment_type text,
  commencement_date date,
  salary numeric,
  allowances jsonb not null default '{}'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  document_id uuid references public.documents(id) on delete set null,
  generated_by uuid references auth.users(id) on delete set null,
  generated_by_name text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_employment_letters_employee on public.employment_letters(employee_id);
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'employment_letters_employee_version_key'
  ) then
    alter table public.employment_letters
      add constraint employment_letters_employee_version_key unique (employee_id, version);
  end if;
end $$;

alter table public.employment_letters enable row level security;

drop policy if exists employment_letters_read on public.employment_letters;
create policy employment_letters_read on public.employment_letters
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or exists (
      select 1 from public.employees e
      where e.id = employment_letters.employee_id and e.user_id = auth.uid()
    )
  );

drop policy if exists employment_letters_write on public.employment_letters;
create policy employment_letters_write on public.employment_letters
  for all using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  ) with check (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  );


-- ============================================================================
-- 2. PAYROLL PUSH REQUEST / APPROVAL / EVENT
--    The sender→HR-manager approval chain ahead of a BankOne API push.
-- ============================================================================
create table if not exists public.payroll_push_requests (
  id uuid primary key default gen_random_uuid(),
  period_label text not null,
  period_start date,
  period_end date,
  employee_count int not null default 0,
  gross_total numeric not null default 0,
  allowances_total numeric not null default 0,
  deductions_total numeric not null default 0,
  mid_month_total numeric not null default 0,
  month_end_total numeric not null default 0,
  total_payroll numeric not null default 0,
  currency text default 'NGN',
  calculation jsonb not null default '{}'::jsonb,
  config_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in (
      'draft', 'calculated', 'pending_hr_approval', 'approved',
      'sent_to_bankone', 'confirmed', 'rejected', 'correction_required', 'cancelled'
    )),
  sender_id uuid references auth.users(id) on delete set null,
  sender_name text,
  sender_email text,
  sender_employee_id text,
  sender_account_number text,
  sender_bank_name text,
  sender_signature text,
  sender_signed_at timestamptz,
  bankone_environment text not null default 'not_configured'
    check (bankone_environment in ('not_configured', 'sandbox', 'test', 'live')),
  api_status text not null default 'not_sent'
    check (api_status in ('not_sent', 'not_configured', 'queued', 'sending', 'sent', 'failed')),
  api_requested_at timestamptz,
  api_responded_at timestamptz,
  api_response jsonb,
  bankone_reference text,
  retry_count int not null default 0,
  reconciliation_status text not null default 'pending'
    check (reconciliation_status in ('pending', 'matched', 'mismatched', 'not_applicable')),
  rejection_reason text,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payroll_push_status on public.payroll_push_requests(status);
create index if not exists idx_payroll_push_period on public.payroll_push_requests(period_label);

-- Align the environment vocabulary with Phase 15 integration_connections
-- ('sandbox' | 'live'). Applies to both fresh and previously-created tables.
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'payroll_push_requests_bankone_environment_check'
  ) then
    alter table public.payroll_push_requests
      drop constraint payroll_push_requests_bankone_environment_check;
  end if;
  alter table public.payroll_push_requests
    add constraint payroll_push_requests_bankone_environment_check
    check (bankone_environment in ('not_configured', 'sandbox', 'test', 'live'));
end $$;

create table if not exists public.payroll_push_approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.payroll_push_requests(id) on delete cascade,
  action text not null check (action in ('submit', 'approve', 'reject', 'resubmit', 'send')),
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text,
  actor_email text,
  actor_role text,
  signature text,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_payroll_push_approvals_request on public.payroll_push_approvals(request_id);

create table if not exists public.payroll_push_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.payroll_push_requests(id) on delete cascade,
  event_type text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_payroll_push_events_request on public.payroll_push_events(request_id);

alter table public.payroll_push_requests enable row level security;
alter table public.payroll_push_approvals enable row level security;
alter table public.payroll_push_events enable row level security;

-- HR leadership can read; writes always go through the SECURITY DEFINER RPCs.
drop policy if exists payroll_push_requests_read on public.payroll_push_requests;
create policy payroll_push_requests_read on public.payroll_push_requests
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'auditor')
  );

drop policy if exists payroll_push_approvals_read on public.payroll_push_approvals;
create policy payroll_push_approvals_read on public.payroll_push_approvals
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'auditor')
  );

drop policy if exists payroll_push_events_read on public.payroll_push_events;
create policy payroll_push_events_read on public.payroll_push_events
  for select using (
    public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'auditor')
  );


-- ============================================================================
-- 3. HELPERS
-- ============================================================================

-- Server-side, config-driven calculation for a period. Reads the rows produced
-- by the existing compute_payroll RPC and never trusts client-supplied totals.
-- mid_month_ratio comes from payroll_config; defaults to 0.5 (50%).
create or replace function public.payroll_push_calc(p_period_label text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_ratio numeric := 0.5;
  v_period record;
  v_currency text := 'NGN';
  v_employees jsonb;
  v_count int := 0;
  v_gross numeric := 0;
  v_allow numeric := 0;
  v_ded numeric := 0;
  v_net numeric := 0;
  v_mid numeric := 0;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to calculate payroll push';
  end if;

  select coalesce(config->>'mid_month_ratio', '0.5')::numeric into v_ratio
  from public.payroll_config where id = 1;
  if v_ratio is null or v_ratio <= 0 or v_ratio >= 1 then v_ratio := 0.5; end if;

  select coalesce(currency_code, 'NGN') into v_currency from public.hr_platform_settings limit 1;
  v_currency := coalesce(v_currency, 'NGN');

  select * into v_period from public.payroll_periods where period_label = p_period_label;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', p.employee_id,
      'employee_name', p.employee_name,
      'salary', coalesce(p.salary, 0),
      'allowances', coalesce(p.allowances, 0),
      'deductions', coalesce(p.deductions, 0),
      'net_pay', coalesce(p.net_pay, coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)),
      'mid_month', round(coalesce(p.net_pay, coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) * v_ratio, 2),
      'month_end', round(coalesce(p.net_pay, coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0)) * (1 - v_ratio), 2)
    ) order by p.employee_name), '[]'::jsonb),
    count(*),
    coalesce(sum(p.salary), 0),
    coalesce(sum(p.allowances), 0),
    coalesce(sum(p.deductions), 0),
    coalesce(sum(coalesce(p.net_pay, coalesce(p.salary, 0) + coalesce(p.allowances, 0) - coalesce(p.deductions, 0))), 0)
  into v_employees, v_count, v_gross, v_allow, v_ded, v_net
  from public.payroll p
  where p.payroll_period = p_period_label
    and p.status is distinct from 'cancelled';

  v_mid := round(v_net * v_ratio, 2);

  return jsonb_build_object(
    'period_label', p_period_label,
    'period_start', v_period.start_date,
    'period_end', v_period.end_date,
    'employee_count', v_count,
    'gross_total', v_gross,
    'allowances_total', v_allow,
    'deductions_total', v_ded,
    'net_total', v_net,
    'mid_month_total', v_mid,
    'month_end_total', round(v_net - v_mid, 2),
    'currency', v_currency,
    'mid_month_ratio', v_ratio,
    'employees', v_employees
  );
end; $$;

grant execute on function public.payroll_push_calc(text) to authenticated;

-- Preview (read-only) used by the UI before a request is created.
create or replace function public.preview_payroll_push(p_period_label text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select public.payroll_push_calc(p_period_label);
$$;

grant execute on function public.preview_payroll_push(text) to authenticated;

-- BankOne configuration state, exposed to HR without leaking secrets.
create or replace function public.payroll_bankone_config_state()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_super boolean := public.current_role() = 'super_admin';
  v_row record;
  v_state text := 'NOT_CONFIGURED';
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to view BankOne configuration';
  end if;

  select * into v_row from public.integration_connections
  where provider = 'bankone' and enabled = true
  order by (environment = 'live') desc, updated_at desc nulls last
  limit 1;

  if v_row.id is not null then
    v_state := case
      when v_row.environment = 'live' then 'PRODUCTION_ENABLED'
      else 'TEST_MODE'
    end;
  elsif exists (select 1 from public.integration_connections where provider = 'bankone') then
    v_state := 'NOT_CONFIGURED';
  end if;

  return jsonb_build_object(
    'state', v_state,
    'environment', coalesce(v_row.environment, 'none'),
    'base_url', case when v_super then coalesce(v_row.base_url, '') else null end,
    'write_enabled', coalesce(v_row.write_enabled, false),
    'read_enabled', coalesce(v_row.read_enabled, false)
  );
end; $$;

grant execute on function public.payroll_bankone_config_state() to authenticated;

-- Notify every HR approver. Reuses the existing notifications table.
create or replace function public.payroll_push_notify_hr(
  p_request_id uuid, p_title text, p_message text
) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, title, message, type, link)
  select id, p_title, p_message, 'payroll', '/payroll'
  from public.profiles
  where role in ('super_admin', 'admin', 'hr_manager');
$$;

-- Notify the original sender.
create or replace function public.payroll_push_notify_sender(
  p_request_id uuid, p_title text, p_message text
) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, title, message, type, link)
  select sender_id, p_title, p_message, 'payroll', '/payroll'
  from public.payroll_push_requests
  where id = p_request_id and sender_id is not null;
$$;


-- ============================================================================
-- 4. RPCs
-- ============================================================================

-- Create a CALCULATED request from the server-side calculation. Idempotent on
-- idempotency_key so a double click / retry cannot create two requests.
create or replace function public.create_payroll_push_request(
  p_period_label text,
  p_idempotency_key text default null
)
returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_actor_name text;
  v_actor_email text;
  v_emp record;
  v_calc jsonb;
  v_existing public.payroll_push_requests;
  v_row public.payroll_push_requests;
  v_key text;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to create a payroll push request';
  end if;
  if p_period_label is null or length(trim(p_period_label)) = 0 then
    raise exception 'A payroll period is required.';
  end if;

  v_key := coalesce(nullif(p_idempotency_key, ''), gen_random_uuid()::text);

  select * into v_existing from public.payroll_push_requests where idempotency_key = v_key;
  if v_existing.id is not null then
    return v_existing;  -- idempotent replay
  end if;

  v_calc := public.payroll_push_calc(p_period_label);
  if coalesce((v_calc->>'employee_count')::int, 0) = 0 then
    raise exception 'No calculated payroll rows exist for period "%". Run Calculate first.', p_period_label;
  end if;

  select full_name, email into v_actor_name, v_actor_email from public.profiles where id = auth.uid();
  select employee_code, employee_number, account_number, bank_name into v_emp
  from public.employees where user_id = auth.uid() limit 1;

  insert into public.payroll_push_requests (
    period_label, period_start, period_end, employee_count,
    gross_total, allowances_total, deductions_total,
    mid_month_total, month_end_total, total_payroll, currency,
    calculation, config_snapshot, status,
    sender_id, sender_name, sender_email, sender_employee_id,
    sender_account_number, sender_bank_name, idempotency_key
  ) values (
    p_period_label,
    (v_calc->>'period_start')::date,
    (v_calc->>'period_end')::date,
    (v_calc->>'employee_count')::int,
    coalesce((v_calc->>'gross_total')::numeric, 0),
    coalesce((v_calc->>'allowances_total')::numeric, 0),
    coalesce((v_calc->>'deductions_total')::numeric, 0),
    coalesce((v_calc->>'mid_month_total')::numeric, 0),
    coalesce((v_calc->>'month_end_total')::numeric, 0),
    coalesce((v_calc->>'net_total')::numeric, 0),
    coalesce(v_calc->>'currency', 'NGN'),
    v_calc, jsonb_build_object('mid_month_ratio', v_calc->'mid_month_ratio'),
    'calculated',
    auth.uid(), v_actor_name, v_actor_email,
    coalesce(v_emp.employee_code, v_emp.employee_number),
    v_emp.account_number, v_emp.bank_name,
    v_key
  ) returning * into v_row;

  perform public.payroll_push_event(v_row.id, 'REQUEST_CREATED', v_actor_name,
    jsonb_build_object('period_label', p_period_label));

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_REQUEST_CREATED', 'PayrollPushRequest', v_row.id::text, v_actor_name,
          format('Payroll push request created for %s', p_period_label), 'info');

  return v_row;
end; $$;

grant execute on function public.create_payroll_push_request(text, text) to authenticated;

-- Small helper used by the RPCs above/below.
create or replace function public.payroll_push_event(
  p_request_id uuid, p_event_type text, p_actor_name text, p_details jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into public.payroll_push_events (request_id, event_type, actor_id, actor_name, details)
  values (p_request_id, p_event_type, auth.uid(), p_actor_name, coalesce(p_details, '{}'::jsonb));
$$;

-- Sender signs and submits for HR approval.
create or replace function public.submit_payroll_push_request(
  p_request_id uuid, p_signature text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_row public.payroll_push_requests;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to submit a payroll push request';
  end if;
  if p_signature is null or length(trim(p_signature)) < 20 then
    raise exception 'A signature is required before submitting.';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status not in ('calculated', 'draft', 'correction_required', 'rejected') then
    raise exception 'Request cannot be submitted from status "%".', v_row.status;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.payroll_push_requests set
    status = 'pending_hr_approval',
    sender_signature = p_signature,
    sender_signed_at = now(),
    rejection_reason = null, rejected_by = null, rejected_at = null,
    updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_email, actor_role, signature)
  values (p_request_id, 'submit', auth.uid(), v_actor_name, v_row.sender_email, public.current_role(), p_signature);

  perform public.payroll_push_event(p_request_id, 'SUBMITTED_FOR_APPROVAL', v_actor_name, '{}'::jsonb);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_SUBMITTED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s submitted for HR approval', v_row.period_label), 'info');

  perform public.payroll_push_notify_hr(p_request_id, 'Payroll approval required',
    format('A payroll push for %s (%s employees) needs your approval.', v_row.period_label, v_row.employee_count));

  return v_row;
end; $$;

grant execute on function public.submit_payroll_push_request(uuid, text) to authenticated;

-- HR manager approves with signature. Segregation of duties: the sender cannot
-- approve their own request.
create or replace function public.approve_payroll_push_request(
  p_request_id uuid, p_signature text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text; v_actor_email text;
  v_row public.payroll_push_requests;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Only an HR manager or admin can approve a payroll push request';
  end if;
  if p_signature is null or length(trim(p_signature)) < 20 then
    raise exception 'An HR manager signature is required to approve.';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status <> 'pending_hr_approval' then
    raise exception 'Request is not awaiting HR approval (status "%").', v_row.status;
  end if;
  if v_row.sender_id = auth.uid() then
    raise exception 'Segregation of duties: the sender cannot approve their own payroll request.';
  end if;

  select full_name, email into v_actor_name, v_actor_email from public.profiles where id = auth.uid();

  update public.payroll_push_requests set
    status = 'approved', updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_email, actor_role, signature)
  values (p_request_id, 'approve', auth.uid(), v_actor_name, v_actor_email, public.current_role(), p_signature);

  perform public.payroll_push_event(p_request_id, 'APPROVED', v_actor_name, '{}'::jsonb);
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_APPROVED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s approved', v_row.period_label), 'info');

  perform public.payroll_push_notify_sender(p_request_id, 'Payroll request approved',
    format('Your payroll push for %s has been approved.', v_row.period_label));

  return v_row;
end; $$;

grant execute on function public.approve_payroll_push_request(uuid, text) to authenticated;

-- HR manager rejects with a reason. Returns the request to the sender.
create or replace function public.reject_payroll_push_request(
  p_request_id uuid, p_reason text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_row public.payroll_push_requests;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Only an HR manager or admin can reject a payroll push request';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A rejection reason is required.';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status <> 'pending_hr_approval' then
    raise exception 'Request is not awaiting HR approval (status "%").', v_row.status;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  update public.payroll_push_requests set
    status = 'correction_required',
    rejection_reason = p_reason, rejected_by = auth.uid(), rejected_at = now(),
    updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_email, actor_role, reason)
  values (p_request_id, 'reject', auth.uid(), v_actor_name, v_row.sender_email, public.current_role(), p_reason);

  perform public.payroll_push_event(p_request_id, 'REJECTED', v_actor_name, jsonb_build_object('reason', p_reason));
  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_REJECTED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s rejected: %s', v_row.period_label, p_reason), 'warning');

  perform public.payroll_push_notify_sender(p_request_id, 'Payroll request returned for correction',
    format('Your payroll push for %s was returned: %s', v_row.period_label, p_reason));

  return v_row;
end; $$;

grant execute on function public.reject_payroll_push_request(uuid, text) to authenticated;

-- Sender re-signs and resubmits after correction. Returns to HR approval.
create or replace function public.resubmit_payroll_push_request(
  p_request_id uuid, p_signature text
) returns public.payroll_push_requests
language plpgsql security definer set search_path = public as $$
begin
  if p_signature is null or length(trim(p_signature)) < 20 then
    raise exception 'A signature is required to resubmit.';
  end if;
  return public.submit_payroll_push_request(p_request_id, p_signature);
end; $$;

grant execute on function public.resubmit_payroll_push_request(uuid, text) to authenticated;

-- Queue the approved request to the BankOne integration outbound queue.
-- Idempotent: an already-queued/sent request is returned unchanged. When the
-- integration is not configured it records the state and NEVER pretends the
-- payment was sent.
create or replace function public.send_payroll_push_to_bankone(p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_row public.payroll_push_requests;
  v_env text;
  v_state text;
  v_ref text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to send payroll to BankOne';
  end if;

  select * into v_row from public.payroll_push_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;

  -- Idempotency: never submit twice.
  if v_row.api_status in ('queued', 'sent') then
    return jsonb_build_object('ok', true, 'idempotent', true, 'api_status', v_row.api_status,
                              'reference', v_row.bankone_reference);
  end if;
  if v_row.status <> 'approved' then
    raise exception 'Only an approved request can be sent to BankOne (status "%").', v_row.status;
  end if;

  select full_name into v_actor_name from public.profiles where id = auth.uid();

  select environment, case when enabled then environment else null end
  into v_env, v_state
  from public.integration_connections
  where provider = 'bankone' and enabled = true
  order by (environment = 'live') desc, updated_at desc nulls last
  limit 1;

  if v_env is null then
    update public.payroll_push_requests
    set api_status = 'not_configured', bankone_environment = 'not_configured',
        api_response = jsonb_build_object('state', 'NOT_CONFIGURED'),
        updated_at = now()
    where id = p_request_id;
    perform public.payroll_push_event(p_request_id, 'BANKONE_NOT_CONFIGURED', v_actor_name, '{}'::jsonb);
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values ('PAYROLL_PUSH_NOT_CONFIGURED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
            'BankOne API is not configured; nothing was sent.', 'warning');
    return jsonb_build_object('ok', false, 'state', 'NOT_CONFIGURED',
                              'message', 'BankOne API is not configured. Approval and export remain available; nothing was sent.');
  end if;

  v_ref := 'PUSH-' || v_row.period_label || '-' || substr(p_request_id::text, 1, 8);

  -- Reuse the Phase 15 outbound queue (existing BankOne integration architecture).
  insert into public.integration_outbound_queue (
    provider, environment, event_type, entity_reference, payload, created_by, status
  ) values (
    'bankone', v_env, 'payroll_disbursement', p_request_id::text,
    jsonb_build_object(
      'request_id', p_request_id,
      'period_label', v_row.period_label,
      'employee_count', v_row.employee_count,
      'total_payroll', v_row.total_payroll,
      'mid_month_total', v_row.mid_month_total,
      'month_end_total', v_row.month_end_total,
      'currency', v_row.currency,
      'reference', v_ref
    ),
    auth.uid(), 'queued'
  );

  update public.payroll_push_requests set
    status = 'sent_to_bankone',
    api_status = 'queued',
    api_requested_at = now(),
    bankone_environment = v_env,
    bankone_reference = v_ref,
    updated_at = now()
  where id = p_request_id
  returning * into v_row;

  insert into public.payroll_push_approvals (request_id, action, actor_id, actor_name, actor_role)
  values (p_request_id, 'send', auth.uid(), v_actor_name, public.current_role());

  perform public.payroll_push_event(p_request_id, 'QUEUED_TO_BANKONE', v_actor_name,
    jsonb_build_object('environment', v_env, 'reference', v_ref));

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('PAYROLL_PUSH_QUEUED', 'PayrollPushRequest', p_request_id::text, v_actor_name,
          format('Payroll push for %s queued to BankOne (%s), ref %s', v_row.period_label, v_env, v_ref), 'info');

  perform public.payroll_push_notify_sender(p_request_id, 'Payroll queued to BankOne',
    format('Payroll push for %s was queued to BankOne (%s).', v_row.period_label, v_env));

  return jsonb_build_object('ok', true, 'state', 'QUEUED', 'environment', v_env, 'reference', v_ref);
end; $$;

grant execute on function public.send_payroll_push_to_bankone(uuid) to authenticated;


-- ============================================================================
-- 5. PAYROLL MASTER — active roster with bank + salary + eligibility.
--    Sourced from the existing employees / payroll tables; no new master.
-- ============================================================================
create or replace function public.list_payroll_master()
returns table (
  employee_id uuid,
  employee_name text,
  employee_code text,
  department text,
  "position" text,
  branch text,
  bank_name text,
  account_name text,
  account_number text,
  bank_sort_code text,
  salary numeric,
  allowances numeric,
  employment_status text,
  effective_date date,
  bankone_employee_number text,
  payroll_eligible boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized to view the payroll master';
  end if;

  return query
  select
    e.id, e.full_name,
    coalesce(e.employee_code, e.employee_number, e.staff_id),
    e.department, e.position, e.branch,
    e.bank_name, e.account_name, e.account_number, e.bank_sort_code,
    coalesce(e.salary, e.basic_salary, 0),
    coalesce(e.allowances, 0),
    e.employment_status,
    e.hire_date,
    bi.bankone_employee_number,
    (e.employment_status = 'active' and e.account_number is not null and e.bank_name is not null)
  from public.employees e
  left join public.employee_bankone_identifiers bi on bi.employee_id = e.id
  where e.employment_status in ('active', 'probation', 'on_leave')
  order by e.full_name;
end; $$;

grant execute on function public.list_payroll_master() to authenticated;
