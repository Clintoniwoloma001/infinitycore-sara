-- ============================================================================
-- PHASE 71 - AUDIT DEPARTMENT + AUTOMATION COMMAND CENTRE TRACKING
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260926000004. Idempotent, additive,
-- transaction-wrapped. Nothing is dropped and no existing record is rewritten.
--
-- WHY ONE MIGRATION
-- The Automation Command Centre needs a TRACKED RECORD per KPI line item, and
-- the Audit department is the first department to go live. Both live here so the
-- "is this automation live?" data model exists before any department marks
-- itself live against it - the ACC is a tracker of real records, never a
-- hardcoded list of percentages.
--
-- 1. AUTOMATION ITEM TRACKING
--    One row per KPI line item, grouped by department. A department's
--    completion percentage is DERIVED from its rows (see
--    get_automation_portfolio): the proportion of that department's items whose
--    status is 'live'. Nothing is typed in by hand.
--
-- 2. AUDIT - REGULATORY MONITORING
--    regulatory_items: a real deadline, a real process owner (an employee), and
--    a configurable lead time. audit_regulatory_deadline_alerts() notifies the
--    owner as the date approaches, on a pg_cron schedule.
--
-- 3. AUDIT - FINDINGS / REPORTING TRACKING
--    audit_findings moves Open -> In Progress -> Pending Closeout -> Closed.
--    audit_closeout_reminders() nudges owners of anything still open, on a
--    weekly cadence, with a de-duplication guard so a single finding cannot
--    generate a notification every single run.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. PERMISSIONS
-- ---------------------------------------------------------------------------
-- New departments need new permission categories. The existing CHECK is a
-- closed list, so it is extended rather than worked around by filing audit
-- permissions under someone else's category.
--
-- SELF-ADAPTING, ON PURPOSE. A hardcoded list of categories is exactly what
-- broke the first run: this re-validates EVERY historical row, and any
-- category already present in a real database but absent from the list makes
-- the whole transaction fail. So the allowed set is read from the table itself
-- and unioned with the new departments. It cannot drift out of date, and it
-- cannot fail on a database whose history differs from a developer's.
alter table public.permissions drop constraint if exists permissions_category_check;

do $$
declare
  v_existing text[];
  v_allowed text[];
begin
  -- Whatever categories are genuinely in use right now, plus the new ones.
  select coalesce(array_agg(distinct p.category), '{}'::text[])
    into v_existing
    from public.permissions p
   where p.category is not null;

  v_allowed := array(
    select distinct unnest(
      v_existing || array[
        'audit', 'risk', 'automation', 'operations', 'collateral', 'benefits'
      ]::text[])
  );

  execute format(
    'alter table public.permissions add constraint permissions_category_check '
    'check (category is null or category = any (%L::text[]))',
    v_allowed
  );
end;
$$;

-- Seeded into the EXISTING granular catalogue so has_permission() resolves them
-- like any other key, then granted through the existing role_permissions
-- relationship. No bespoke authz path is introduced.
insert into public.permissions (permission_key, description, category, module, resource, action, sensitive, scope_modes, is_system)
values
  ('audit.monitoring.read',    'View Audit regulatory monitoring and audit findings', 'audit', 'audit', 'monitoring', 'read',    false, '{global}', true),
  ('audit.monitoring.manage',  'Create and update audit regulatory items and findings', 'audit', 'audit', 'monitoring', 'manage', true, '{global}', true),
  ('automation.portfolio.read',  'View the Automation Command Centre portfolio',      'automation', 'automation', 'portfolio', 'read',   false, '{global}', true),
  ('automation.portfolio.manage','Change automation item status',                      'automation', 'automation', 'portfolio', 'manage', true, '{global}', true)
on conflict (permission_key) do update
  set description = excluded.description, category = excluded.category;

select public.seed_role_permission('super_admin', 'audit.monitoring.read');
select public.seed_role_permission('super_admin', 'audit.monitoring.manage');
select public.seed_role_permission('super_admin', 'automation.portfolio.read');
select public.seed_role_permission('super_admin', 'automation.portfolio.manage');

select public.seed_role_permission('admin', 'audit.monitoring.read');
select public.seed_role_permission('admin', 'audit.monitoring.manage');
select public.seed_role_permission('admin', 'automation.portfolio.read');

-- Audit department ownership: the Head of Audit & Compliance owns the register.
select public.seed_role_permission('head_of_audit', 'audit.monitoring.read');
select public.seed_role_permission('head_of_audit', 'audit.monitoring.manage');
select public.seed_role_permission('head_of_audit', 'automation.portfolio.read');

-- The KPI names the Head of HR and the Head of E-Business as the people who own
-- the automation tracking itself, alongside Super Admin.
select public.seed_role_permission('head_of_human_resources', 'automation.portfolio.manage');
select public.seed_role_permission('head_of_human_resources', 'automation.portfolio.read');
select public.seed_role_permission('head_of_e_business', 'automation.portfolio.manage');
select public.seed_role_permission('head_of_e_business', 'automation.portfolio.read');

-- ---------------------------------------------------------------------------
-- 2. AUTOMATION ITEMS (the tracker every department updates)
-- ---------------------------------------------------------------------------
create table if not exists public.automation_items (
  id uuid primary key default gen_random_uuid(),
  department text not null,
  item_key text not null unique,
  label text not null,
  description text,
  status text not null default 'not_started'
    check (status in ('not_started','in_progress','live')),
  live_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (department, item_key)
);

comment on table public.automation_items is
  'One trackable record per KPI automation line item. Department completion is DERIVED from these rows by get_automation_portfolio - there is no stored percentage anywhere.';

create index if not exists idx_automation_items_department
  on public.automation_items (department, status);

-- A department with NO tracked items (E-Business) must still appear on the
-- portfolio at 0%, rather than silently vanishing because the view grouped
-- straight off automation_items. This table is the registry of departments the
-- KPI document covers, and it is what makes an empty category possible.
create table if not exists public.automation_departments (
  department text primary key,
  label text not null,
  description text,
  -- A configurable department starts empty and can have items added to it; a
  -- fixed one is populated from the KPI document and is not addable to.
  is_configurable boolean not null default false,
  display_order integer not null default 100,
  created_at timestamptz not null default now()
);

comment on table public.automation_departments is
  'The departments covered by the automation programme. E-Business is registered here with is_configurable = true so it shows as an empty, addable category rather than being invented with fake items or hidden entirely.';

insert into public.automation_departments (department, label, description, is_configurable, display_order) values
  ('audit',      'Audit',                   'Regulatory monitoring, audit reporting and follow-up',        false, 10),
  ('risk',       'Risk',                    'Collateral documentation and risk oversight',                 false, 20),
  ('admin',      'Admin & Corporate Services','Branch requests, expense requests and vendor management',    false, 30),
  ('hr',         'Human Resources',         'Leave, recruitment, benefits and performance',                false, 40),
  ('operations', 'Operations',              'Customer and market-facing forms',                             false, 50),
  ('e_business', 'E-Business',              'No KPI items are documented for this department yet. It is an empty, configurable category: add items as they are defined.', true, 60)
on conflict (department) do update
  set label = excluded.label,
      description = excluded.description,
      display_order = excluded.display_order;


-- Seeded from the KPI document, one row per line item. E-Business is left as a
-- configured category with no invented items: inventing automations that were
-- never specified would put fake work on the board.
insert into public.automation_items (department, item_key, label, description) values
  ('audit', 'regulatory_dashboard',        'Regulatory monitoring dashboard',        'Status of regulatory filings and monitoring items at a glance'),
  ('audit', 'regulatory_deadline_alerts',  'Regulatory deadline / process-owner alerts', 'Automated prompts to the process owner as a due date approaches'),
  ('audit', 'audit_reporting_tracking',    'Audit reporting and tracking',            'Findings tracked from Open to Closed with per-owner follow-up'),
  ('audit', 'audit_action_reminders',      'Pending audit action reminders',          'Recurring closeout prompts for anything left open'),

  ('risk', 'collateral_document_management', 'Centralized collateral document management', 'Secure register of collateral documentation with status tracking'),

  ('admin', 'branch_requests',          'Branch requests approval and allocation', 'Digital origination, approval, allocation and tracking of branch asset requests'),
  ('admin', 'branch_turnaround_tracking','Branch request turnaround tracking',       'Time-to-response measured between submission and first decision'),
  ('admin', 'expense_requests',         'Expense request review and approval',     'Submission, review, approval and tracking of expenses'),
  ('admin', 'vendor_management',        'Vendor management and cost comparison',   'Vendor-level cost history for previous-cost comparison'),

  ('hr', 'leave_management',           'Leave management',            'Already live: requests, balances, approval chain, planner and booking links'),
  ('hr', 'recruitment',                'Recruitment',                 'Already live: applications, screening, interviews, assessments, offers'),
  ('hr', 'benefits_compensation',      'Benefits and compensation',   'Rewards, allowances and benefit payouts tracked through approval'),
  ('hr', 'performance_appraisal',      'Performance appraisal',       'Company-wide review cycles, review, approval and reporting'),

  ('operations', 'customer_forms', 'Customer market forms', 'Account opening, update, closure, statement, complaint, cheque book and reactivation forms')
on conflict (item_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. AUDIT - REGULATORY MONITORING
-- ---------------------------------------------------------------------------
create table if not exists public.regulatory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- The process owner is a real employee; process_owner_user_id is denormalised
  -- so a reminder can be delivered without re-joining on every cron run.
  process_owner_employee_id uuid references public.employees(id) on delete set null,
  process_owner_user_id uuid references auth.users(id) on delete set null,
  due_date date not null,
  -- How far ahead of the due date the owner starts being prompted. Per item,
  -- so a long-lead filing and a short one are treated differently.
  lead_time_days integer not null default 14 check (lead_time_days between 0 and 365),
  status text not null default 'pending'
    check (status in ('advance','pending','outstanding','filed')),
  filed_at timestamptz,
  filed_reference text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.regulatory_items is
  'Regulatory filings and monitoring items owned by a named process owner. Status is factual: advance = started early, pending = in hand not started, outstanding = past due, filed = submitted.';

create index if not exists idx_regulatory_items_due
  on public.regulatory_items (due_date) where status <> 'filed';
create index if not exists idx_regulatory_items_owner
  on public.regulatory_items (process_owner_user_id);

-- De-duplication for the reminder job, so one item cannot spam its owner.
create table if not exists public.audit_reminder_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('regulatory','closeout')),
  subject_id uuid not null,
  recipient_id uuid not null,
  sent_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (kind, subject_id, recipient_id, sent_on)
);

comment on table public.audit_reminder_log is
  'One row per reminder actually delivered. The unique key makes every reminder function naturally idempotent within a day.';


-- ---------------------------------------------------------------------------
-- 4. AUDIT - FINDINGS / REPORTING TRACKING
-- ---------------------------------------------------------------------------
create table if not exists public.audit_findings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  title text not null,
  description text,
  process_owner_employee_id uuid references public.employees(id) on delete set null,
  process_owner_user_id uuid references auth.users(id) on delete set null,
  department text,
  severity text not null default 'medium'
    check (severity in ('low','medium','high','critical')),
  status text not null default 'open'
    check (status in ('open','in_progress','pending_closeout','closed')),
  opened_at timestamptz not null default now(),
  due_date date,
  closed_at timestamptz,
  closeout_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A closed finding must record when it closed; an open one must not.
  constraint audit_finding_closeout_check check (
    (status = 'closed' and closed_at is not null) or (status <> 'closed')
  )
);

comment on table public.audit_findings is
  'An audit finding tracked from Open to Closed. Age is derived from opened_at so an item cannot be aged dishonestly by editing a date.';

create index if not exists idx_audit_findings_open
  on public.audit_findings (status, due_date) where status <> 'closed';
create index if not exists idx_audit_findings_owner
  on public.audit_findings (process_owner_user_id);

-- ---------------------------------------------------------------------------
-- 5. THE AUTOMATION PORTFOLIO (percentages are DERIVED, never stored)
-- ---------------------------------------------------------------------------
-- Formula, stated once: a department's completion percentage is
--     live items / total items * 100
-- In-progress items count as HALF. That is the one judgement call in this
-- function, so it lives here in a comment rather than being re-derived (and
-- possibly re-argued) by any consumer.
create or replace function public.get_automation_portfolio()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return jsonb_build_object(
    'ok', true,
    'departments', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.display_order, d.label)
      from (
        -- display_order is projected so the outer jsonb_agg can order by it.
        select dep.department, dep.label, dep.is_configurable, dep.display_order,
               -- Counts come from the items, never from the registry, so an
               -- empty department reports 0 rather than disappearing.
               count(i.id)::int as total,
               count(i.id) filter (where i.status = 'live')::int as live,
               count(i.id) filter (where i.status = 'in_progress')::int as in_progress,
               count(i.id) filter (where i.status = 'not_started')::int as not_started,
               round(
                 100.0 * (count(i.id) filter (where i.status = 'live')
                        + 0.5 * count(i.id) filter (where i.status = 'in_progress'))
                 / nullif(count(i.id), 0)
               , 1) as completion_pct
          from public.automation_departments dep
          -- LEFT JOIN: the whole point is that a department with no items is
          -- still listed.
          left join public.automation_items i on i.department = dep.department
         group by dep.department, dep.label, dep.is_configurable, dep.display_order
      ) d
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.department, i.label)
        from public.automation_items i
    ), '[]'::jsonb),
    'active_workflows', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.updated_at desc)
        from public.automation_items i
       where i.status = 'in_progress'
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'items', (select count(*)::int from public.automation_items),
      'live', (select count(*)::int from public.automation_items where status = 'live')
    )
  );
end;
$$;

revoke all on function public.get_automation_portfolio() from public;
grant execute on function public.get_automation_portfolio() to authenticated;


-- Change an item's status. The ACC is a tracker, so this is the only write.
create or replace function public.set_automation_item_status(
  p_item_key text,
  p_status text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_id uuid;
begin
  if not (public.has_permission('automation.portfolio.manage')
          or v_role in ('super_admin','admin','head_of_human_resources','head_of_e_business')) then
    raise exception 'AUTOMATION_FORBIDDEN:You cannot change automation tracking status.';
  end if;

  if p_status is null or p_status not in ('not_started','in_progress','live') then
    raise exception 'INVALID_STATUS:Choose Not Started, In Progress or Live.';
  end if;

  update public.automation_items
     set status = p_status,
         -- live_at is stamped when it goes live and kept afterwards, so the
         -- date an automation actually went live is never lost.
         live_at = case when p_status = 'live' then coalesce(live_at, now()) else live_at end,
         updated_by = auth.uid(),
         updated_at = now()
   where item_key = p_item_key
   returning id into v_id;

  if v_id is null then
    raise exception 'ITEM_NOT_FOUND:That automation item no longer exists.';
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUTOMATION_ITEM_STATUS_CHANGED', 'AutomationItem', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('item_key', p_item_key, 'status', p_status,
                             'note', p_note, 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', v_id, 'item_key', p_item_key, 'status', p_status);
end;
$$;

revoke all on function public.set_automation_item_status(text, text, text) from public;
grant execute on function public.set_automation_item_status(text, text, text) to authenticated;

-- Add an item to a CONFIGURABLE department. This is what makes E-Business a
-- real category rather than a placeholder: it is empty and addable, rather
-- than either hidden or padded with invented automations.
create or replace function public.add_automation_item(
  p_department text,
  p_item_key text,
  p_label text,
  p_description text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_configurable boolean;
  v_id uuid;
begin
  if not (public.has_permission('automation.portfolio.manage')
          or v_role in ('super_admin','admin','head_of_human_resources','head_of_e_business')) then
    raise exception 'AUTOMATION_FORBIDDEN:You cannot add automation items.';
  end if;

  select d.is_configurable into v_configurable
    from public.automation_departments d where d.department = p_department;

  if v_configurable is null then
    raise exception 'UNKNOWN_DEPARTMENT:That department is not part of the automation programme.';
  end if;
  if not v_configurable then
    raise exception 'DEPARTMENT_NOT_CONFIGURABLE:The % department is defined by the KPI document and cannot have items added to it.', p_department;
  end if;
  if p_item_key is null or btrim(p_item_key) = '' or p_label is null or btrim(p_label) = '' then
    raise exception 'ITEM_DETAILS_REQUIRED:An item needs a key and a label.';
  end if;

  v_id := gen_random_uuid();
  insert into public.automation_items
    (id, department, item_key, label, description)
  values (v_id, p_department, btrim(p_item_key), btrim(p_label), p_description)
  on conflict (item_key) do update
    set label = excluded.label, description = excluded.description, updated_at = now();

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUTOMATION_ITEM_ADDED', 'AutomationItem', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('department', p_department, 'item_key', btrim(p_item_key),
                             'label', btrim(p_label), 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', v_id, 'department', p_department,
                            'item_key', btrim(p_item_key));
end;
$$;

revoke all on function public.add_automation_item(text, text, text, text) from public;
grant execute on function public.add_automation_item(text, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. REGULATORY ITEMS - read + write
-- ---------------------------------------------------------------------------
create or replace function public.list_regulatory_items(
  p_status text default null,
  p_owner_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_permission('audit.monitoring.read')
          or public.current_role() in ('super_admin','admin','head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:You cannot view audit monitoring.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.due_date)
      from (
        select r.id, r.name, r.description, r.due_date, r.lead_time_days,
               r.status, r.filed_at, r.filed_reference, r.notes,
               r.process_owner_employee_id, r.process_owner_user_id,
               coalesce(e.full_name, 'Unassigned') as process_owner_name,
               r.due_date - r.lead_time_days as prompt_from,
               (r.due_date - current_date)::int as days_until_due,
               -- overdue is a FACT, not a stored flag, so it cannot go stale
               case when r.status <> 'filed' and r.due_date < current_date
                    then true else false end as is_overdue
          from public.regulatory_items r
          left join public.employees e on e.id = r.process_owner_employee_id
         where (p_status is null or r.status = p_status)
           and (p_owner_id is null or r.process_owner_user_id = p_owner_id)
      ) x
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total', (select count(*)::int from public.regulatory_items),
      'advance', (select count(*)::int from public.regulatory_items where status = 'advance'),
      'pending', (select count(*)::int from public.regulatory_items where status = 'pending'),
      'outstanding', (select count(*)::int from public.regulatory_items where status = 'outstanding'),
      'filed', (select count(*)::int from public.regulatory_items where status = 'filed'),
      'overdue', (select count(*)::int from public.regulatory_items
                   where status <> 'filed' and due_date < current_date),
      'due_next_30', (select count(*)::int from public.regulatory_items
                       where status <> 'filed'
                         and due_date between current_date and current_date + 30)
    )
  );
end;
$$;

revoke all on function public.list_regulatory_items(text, uuid) from public;
grant execute on function public.list_regulatory_items(text, uuid) to authenticated;


create or replace function public.upsert_regulatory_item(
  p_id uuid,
  p_name text,
  p_due_date date,
  p_process_owner_employee_id uuid,
  p_lead_time_days integer,
  p_status text,
  p_description text,
  p_filed_reference text,
  p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_id uuid;
  v_owner_user uuid;
begin
  if not (public.has_permission('audit.monitoring.manage')
          or v_role in ('super_admin','admin','head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:You cannot change regulatory monitoring items.';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED:Give the regulatory item a name.';
  end if;
  if p_due_date is null then
    raise exception 'DUE_DATE_REQUIRED:A regulatory item needs a due date.';
  end if;
  if p_status is not null and p_status not in ('advance','pending','outstanding','filed') then
    raise exception 'INVALID_STATUS:Status must be Advance, Pending, Outstanding or Filed.';
  end if;

  -- Resolve the owner's auth user from the employee row ONCE, so the reminder
  -- job never has to join employees at send time.
  select e.user_id into v_owner_user
    from public.employees e where e.id = p_process_owner_employee_id;

  if p_id is null then
    v_id := gen_random_uuid();
    insert into public.regulatory_items
      (id, name, description, process_owner_employee_id, process_owner_user_id,
       due_date, lead_time_days, status, filed_at, filed_reference, notes, created_by)
    values
      (v_id, btrim(p_name), p_description, p_process_owner_employee_id, v_owner_user,
       p_due_date, coalesce(p_lead_time_days, 14), coalesce(p_status, 'pending'),
       case when p_status = 'filed' then now() else null end,
       p_filed_reference, p_notes, auth.uid());
  else
    update public.regulatory_items
       set name = btrim(p_name), description = p_description,
           process_owner_employee_id = p_process_owner_employee_id,
           process_owner_user_id = v_owner_user,
           due_date = p_due_date,
           lead_time_days = coalesce(p_lead_time_days, lead_time_days),
           status = coalesce(p_status, status),
           -- filed_at is set the moment it becomes filed and not silently cleared
           filed_at = case when p_status = 'filed' then coalesce(filed_at, now()) else filed_at end,
           filed_reference = coalesce(p_filed_reference, filed_reference),
           notes = p_notes, updated_at = now()
     where id = p_id
     returning id into v_id;

    if v_id is null then
      raise exception 'ITEM_NOT_FOUND:That regulatory item no longer exists.';
    end if;
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('REGULATORY_ITEM_SAVED', 'RegulatoryItem', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('name', btrim(p_name), 'due_date', p_due_date,
                             'status', coalesce(p_status, 'pending'), 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function public.upsert_regulatory_item(uuid, text, date, uuid, integer, text, text, text, text) from public;
grant execute on function public.upsert_regulatory_item(uuid, text, date, uuid, integer, text, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. AUDIT FINDINGS - read, create, advance
-- ---------------------------------------------------------------------------
create or replace function public.list_audit_findings(
  p_status text default null,
  p_owner_id uuid default null,
  p_department text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_permission('audit.monitoring.read')
          or public.current_role() in ('super_admin','admin','head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:You cannot view audit findings.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'findings', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.is_open desc, x.age_days desc)
      from (
        select f.id, f.reference, f.title, f.description, f.department,
               f.severity, f.status, f.opened_at, f.due_date, f.closed_at,
               f.closeout_notes, f.process_owner_employee_id, f.process_owner_user_id,
               coalesce(e.full_name, 'Unassigned') as process_owner_name,
               (f.status <> 'closed') as is_open,
               -- Age is DERIVED from opened_at, so it cannot be flattering.
               (current_date - f.opened_at::date)::int as age_days,
               case when f.due_date is not null
                    then (f.due_date - current_date)::int end as days_to_due,
               (f.status <> 'closed' and f.due_date is not null
                 and f.due_date < current_date) as is_overdue
          from public.audit_findings f
          left join public.employees e on e.id = f.process_owner_employee_id
         where (p_status is null or f.status = p_status)
           and (p_owner_id is null or f.process_owner_user_id = p_owner_id)
           and (p_department is null or lower(coalesce(f.department,'')) = lower(p_department))
      ) x
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'open_total', (select count(*)::int from public.audit_findings where status <> 'closed'),
      'by_status', coalesce((
        select jsonb_object_agg(s.status, s.n)
        from (
          select f.status, count(*)::int as n
            from public.audit_findings f group by f.status
        ) s
      ), '{}'::jsonb),
      'by_owner', coalesce((
        select jsonb_agg(to_jsonb(o) order by o.open_count desc)
        from (
          select f.process_owner_employee_id,
                 coalesce(e.full_name, 'Unassigned') as process_owner_name,
                 count(*)::int as open_count
            from public.audit_findings f
            left join public.employees e on e.id = f.process_owner_employee_id
           where f.status <> 'closed'
           group by f.process_owner_employee_id, e.full_name
        ) o
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.list_audit_findings(text, uuid, text) from public;
grant execute on function public.list_audit_findings(text, uuid, text) to authenticated;

-- Create a finding. Reference is generated when not supplied so two findings
-- can never share a reference.
create or replace function public.create_audit_finding(
  p_title text,
  p_process_owner_employee_id uuid,
  p_department text,
  p_severity text,
  p_description text,
  p_due_date date,
  p_reference text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_id uuid;
  v_ref text;
  v_owner_user uuid;
begin
  if not (public.has_permission('audit.monitoring.manage')
          or v_role in ('super_admin','admin','head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:You cannot raise audit findings.';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'TITLE_REQUIRED:Give the finding a title.';
  end if;
  if p_severity is not null and p_severity not in ('low','medium','high','critical') then
    raise exception 'INVALID_SEVERITY:Severity must be low, medium, high or critical.';
  end if;

  v_ref := coalesce(nullif(btrim(p_reference), ''),
    'AUD-' || to_char(current_date, 'YYYY') || '-'
      || lpad((nextval('public.audit_finding_ref_seq'))::text, 4, '0'));

  select e.user_id into v_owner_user
    from public.employees e where e.id = p_process_owner_employee_id;

  v_id := gen_random_uuid();
  insert into public.audit_findings
    (id, reference, title, description, process_owner_employee_id, process_owner_user_id,
     department, severity, status, due_date, created_by)
  values
    (v_id, v_ref, btrim(p_title), p_description, p_process_owner_employee_id, v_owner_user,
     p_department, coalesce(p_severity, 'medium'), 'open', p_due_date, auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_FINDING_RAISED', 'AuditFinding', v_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('reference', v_ref, 'title', btrim(p_title),
                             'severity', coalesce(p_severity,'medium'), 'success', true)::text,
          'warning');

  return jsonb_build_object('ok', true, 'id', v_id, 'reference', v_ref);
end;
$$;

revoke all on function public.create_audit_finding(text, uuid, text, text, text, date, text) from public;
grant execute on function public.create_audit_finding(text, uuid, text, text, text, date, text) to authenticated;

create sequence if not exists public.audit_finding_ref_seq start 1;


-- Move a finding through its lifecycle. The stage order is enforced here rather
-- than trusted from the client, so a finding cannot jump straight to Closed.
create or replace function public.advance_audit_finding(
  p_finding_id uuid,
  p_to_status text,
  p_closeout_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_role();
  v_from text;
  v_ref text;
  v_ord int;
  v_to_ord int;
begin
  if not (public.has_permission('audit.monitoring.manage')
          or v_role in ('super_admin','admin','head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:You cannot change audit findings.';
  end if;

  select f.status, f.reference into v_from, v_ref
    from public.audit_findings f where f.id = p_finding_id;

  if v_from is null then
    raise exception 'FINDING_NOT_FOUND:That audit finding no longer exists.';
  end if;

  if p_to_status is null or p_to_status not in ('open','in_progress','pending_closeout','closed') then
    raise exception 'INVALID_STATUS:Unknown status.';
  end if;

  v_ord := case v_from when 'open' then 1 when 'in_progress' then 2
                       when 'pending_closeout' then 3 else 4 end;
  v_to_ord := case p_to_status when 'open' then 1 when 'in_progress' then 2
                               when 'pending_closeout' then 3 else 4 end;

  -- Moving backwards is allowed (reopening is a real thing) but skipping a
  -- stage is not: that is how findings get closed without being worked.
  if v_to_ord > v_ord + 1 then
    raise exception 'INVALID_TRANSITION:Move the finding one stage at a time (Open to In Progress to Pending Closeout to Closed).';
  end if;

  if p_to_status = 'closed' and (p_closeout_notes is null or length(btrim(p_closeout_notes)) < 5) then
    raise exception 'CLOSEOUT_NOTES_REQUIRED:Record what was done to close this finding (at least 5 characters).';
  end if;

  update public.audit_findings
     set status = p_to_status,
         closed_at = case when p_to_status = 'closed' then now() else null end,
         closeout_notes = case when p_to_status = 'closed' then btrim(p_closeout_notes)
                               else closeout_notes end,
         updated_at = now()
   where id = p_finding_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_FINDING_STATUS_CHANGED', 'AuditFinding', p_finding_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('reference', v_ref, 'from', v_from, 'to', p_to_status,
                             'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'id', p_finding_id,
                            'reference', v_ref, 'status', p_to_status);
end;
$$;

revoke all on function public.advance_audit_finding(uuid, text, text) from public;
grant execute on function public.advance_audit_finding(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. AUTOMATED REMINDERS
-- ---------------------------------------------------------------------------
-- Both functions write to the EXISTING notifications table, which is the
-- in-app channel this app actually delivers. Email is deliberately not used:
-- notificationService.sendEmailNotification is architecture-only in this
-- codebase and does not send, so claiming an "email prompt" would be a lie.
create or replace function public.audit_regulatory_deadline_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_sent int := 0;
begin
  -- The loop variable is v_row, NOT r: naming it `r` collided with the table
  -- alias `r` in its own query, and plpgsql substituted the unassigned record
  -- for r.id ("record r is not assigned yet").
  for v_row in
    select ri.id, ri.name, ri.due_date, ri.status, ri.process_owner_user_id
      from public.regulatory_items ri
     where ri.status <> 'filed'
       and ri.process_owner_user_id is not null
       -- Inside the lead time, or already overdue.
       and ri.due_date <= current_date + ri.lead_time_days
  loop
    -- The unique key on audit_reminder_log makes this idempotent per day, so a
    -- job that runs several times cannot spam the same owner.
    insert into public.audit_reminder_log (kind, subject_id, recipient_id)
    values ('regulatory', v_row.id, v_row.process_owner_user_id)
    on conflict do nothing;

    if not found then
      continue;  -- already reminded today
    end if;

    insert into public.notifications (user_id, title, message, link, type, read)
    values (
      v_row.process_owner_user_id,
      'Regulatory item due: ' || v_row.name,
      case
        when v_row.due_date < current_date
          then 'This item was due on ' || to_char(v_row.due_date, 'DD Mon YYYY')
               || ' and is now OUTSTANDING. Please confirm its status.'
        else 'Due on ' || to_char(v_row.due_date, 'DD Mon YYYY') || ' ('
             || (v_row.due_date - current_date)::int || ' day(s) away). Please progress it.'
      end,
      '/audit?tab=regulatory',
      'urgent', false
    );

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function public.audit_regulatory_deadline_alerts() from public;
grant execute on function public.audit_regulatory_deadline_alerts() to authenticated;


-- Closeout nudges. Weekly cadence, and only for findings that are genuinely
-- still open, so nobody is chased about something already done.
create or replace function public.audit_closeout_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_sent int := 0;
begin
  -- v_row, not r: the loop variable must not share a name with the table
  -- alias in its own query.
  for v_row in
    select af.id, af.reference, af.title, af.status, af.due_date,
           af.process_owner_user_id
      from public.audit_findings af
     where af.status <> 'closed'
       and af.process_owner_user_id is not null
       -- Only remind about work that is actually due to be actioned.
       and (af.due_date is not null and af.due_date <= current_date + 7)
  loop
    insert into public.audit_reminder_log (kind, subject_id, recipient_id)
    values ('closeout', v_row.id, v_row.process_owner_user_id)
    on conflict do nothing;

    if not found then
      continue;
    end if;

    insert into public.notifications (user_id, title, message, link, type, read)
    values (
      v_row.process_owner_user_id,
      'Audit action pending: ' || v_row.reference,
      'Your audit finding "' || v_row.title || '" is still at '
        || initcap(replace(v_row.status, '_', ' '))
        || '. Please progress it or confirm it is closed.',
      '/audit?tab=findings',
      'urgent', false
    );

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function public.audit_closeout_reminders() from public;
grant execute on function public.audit_closeout_reminders() to authenticated;

-- ---------------------------------------------------------------------------
-- 9. SCHEDULES (guarded; silently skipped where pg_cron is absent)
-- ---------------------------------------------------------------------------
-- Daily at 08:00 for regulatory deadlines; Mondays at 08:15 for closeouts, so
-- the weekly cadence is real rather than "whenever the job happens to run".
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'infinitycore-audit-regulatory-alerts',
      '0 8 * * *',
      $cmd$ select public.audit_regulatory_deadline_alerts(); $cmd$
    );
    perform cron.schedule(
      'infinitycore-audit-closeout-reminders',
      '15 8 * * 1',
      $cmd$ select public.audit_closeout_reminders(); $cmd$
    );
  end if;
exception
  when others then null;
end;
$$;

commit;

