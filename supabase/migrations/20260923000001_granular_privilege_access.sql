-- ============================================================================
-- PHASE — Granular Privilege & Access Management
-- ============================================================================
-- Run in Supabase SQL Editor after 20260922000013 (or the latest migration).
-- Idempotent / additive. Wrapped in a transaction.
--
-- Adds a SECOND authorization layer on top of the existing RBAC roles
-- (which are preserved untouched):
--
--   1. Catalog        — every stable permission identifier (dotted keys) that
--                       the platform (Web + Flutter + SARA + edge functions)
--                       is authorized against. Extends the existing
--                       `permissions` table (never duplicates it).
--   2. Role baseline  — role_permissions rows mirroring TODAY's exact
--                       role->permission access (generated from
--                       src/constants/roles.js). The granular engine honours
--                       this as the default, so implementing the layer does
--                       not change any existing access.
--   3. Role scopes    — role_permissions gains scope columns
--                       (global / branch / department / selected_users / self).
--   4. User overrides — user_permissions: explicit per-user ALLOW / DENY that
--                       override the role baseline.
--   5. Field rules    — permission_field_rules: column-level visibility
--                       (hide/show sensitive fields) per role or user.
--   6. Delegation     — permission_delegation: which roles/users may manage
--                       which modules' privileges, and at what scope.
--                       Nobody can grant a permission they do not themselves
--                       hold (holder rule) or a scope above their own.
--   7. Audit          — permission_audit: full history + who/when/reason.
--   8. Cache epoch    — permission_version: bumped on every change so
--                       clients (web, Flutter, SARA) can refresh & detect
--                       invalidation.
--
-- PRECEDENCE (documented, deterministic):
--
--   super_admin                                 -> ALLOW (system boundary)
--   explicit user DENY                          -> DENY
--   explicit user ALLOW                         -> ALLOW
--   role baseline (role_permissions, incl scope)-> ALLOW
--   default                                     -> DENY
--
-- Enforcement surface added in this phase:
--   * ALL privilege-management RPCs (fully delegation-guarded).
--   * `require_permission()` / `has_permission()` / `has_field_access()`
--     primitives available to every existing RPC, edge function and future
--     gate without touching RLS.
--   * salary / compensation surfaces (`list_payroll_master`,
--     `get_employee_compensation`, `preview_employee_compensation`,
--     `upsert_employee_compensation`, `calculate_employee_salary_breakdown`)
--     now enforce `payroll.salary.view` / `payroll.salary.edit`.
--
-- The existing RBAC roles, RLS policies and role-gates are NOT modified:
-- the granular layer can only ADD restrictions (explicit deny / field
-- hiding) and per-user allowances on top of them.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Catalog extensions (permissions table is the single permission surface)
-- ---------------------------------------------------------------------------
alter table public.permissions
  drop constraint if exists permissions_category_check;

alter table public.permissions
  add column if not exists module text,
  add column if not exists resource text,
  add column if not exists action text,
  add column if not exists sensitive boolean not null default false,
  add column if not exists scope_modes text[] not null default array['global'],
  add column if not exists sort_order int,
  add column if not exists is_system boolean not null default false;

alter table public.permissions
  add constraint permissions_category_check check (
    category in (
      'customers', 'loans', 'documents', 'hr', 'admin', 'support', 'reports',
      'branches', 'bankone', 'reconciliation', 'performance', 'appraisal',
      'hr_config', 'hr_org', 'workforce', 'attendance', 'payroll', 'messaging',
      'communications', 'sara', 'training', 'medical', 'work', 'settings',
      'users', 'data', 'administration', 'leave', 'onboarding'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Role baseline scopes  (role_permissions.cols are additive)
-- ---------------------------------------------------------------------------
alter table public.role_permissions
  add column if not exists scope_type text not null default 'global'
    check (scope_type in ('global', 'branch', 'department', 'selected_users', 'self')),
  add column if not exists scope_branch_id uuid,
  add column if not exists scope_department text,
  add column if not exists scope_user_ids uuid[] not null default '{}',
  add column if not exists updated_at timestamptz default now(),
  add column if not exists updated_by uuid;

-- ---------------------------------------------------------------------------
-- 3. New tables
-- ---------------------------------------------------------------------------
create table if not exists public.user_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  permission_key text not null references public.permissions (permission_key) on delete cascade,
  effect text not null default 'allow' check (effect in ('allow', 'deny')),
  scope_type text not null default 'global'
    check (scope_type in ('global', 'branch', 'department', 'selected_users', 'self')),
  scope_branch_id uuid,
  scope_department text,
  scope_user_ids uuid[] not null default '{}',
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz default now(),
  granted_reason text,
  source text not null default 'web' check (source in ('web', 'mobile', 'sara', 'edge')),
  correlation_id text,
  unique (user_id, permission_key)
);
alter table public.user_permissions enable row level security;

create table if not exists public.permission_field_rules (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('role', 'user')),
  target_key text not null,
  table_name text not null,
  column_name text not null,
  effect text not null check (effect in ('show', 'hide')),
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz default now(),
  granted_reason text,
  source text not null default 'web' check (source in ('web', 'mobile', 'sara', 'edge')),
  correlation_id text,
  unique (target_type, target_key, table_name, column_name)
);
alter table public.permission_field_rules enable row level security;

create table if not exists public.permission_delegation (
  id uuid primary key default gen_random_uuid(),
  grantee_type text not null check (grantee_type in ('role', 'user')),
  grantee_key text not null,
  module text not null,
  max_scope text not null default 'global'
    check (max_scope in ('global', 'branch', 'department', 'selected_users', 'self')),
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz default now(),
  granted_reason text,
  unique (grantee_type, grantee_key, module)
);
alter table public.permission_delegation enable row level security;

create table if not exists public.permission_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users (id) on delete set null,
  actor_role text,
  actor_name text,
  target_type text check (target_type in ('role', 'user')),
  target_key text,
  target_name text,
  permission_key text,
  action text not null,
  previous_value jsonb,
  new_value jsonb,
  scope jsonb,
  reason text,
  source text not null default 'web' check (source in ('web', 'mobile', 'sara', 'edge')),
  correlation_id text,
  created_at timestamptz default now()
);
alter table public.permission_audit enable row level security;
create index if not exists permission_audit_actor_idx on public.permission_audit (actor_id);
create index if not exists permission_audit_target_idx on public.permission_audit (target_key);
create index if not exists permission_audit_key_idx on public.permission_audit (permission_key);
create index if not exists permission_audit_created_idx on public.permission_audit (created_at desc);

create table if not exists public.permission_version (
  id int primary key default 1,
  epoch bigint not null default 1,
  updated_at timestamptz default now()
);
insert into public.permission_version (id, epoch) values (1, 1) on conflict (id) do nothing;
alter table public.permission_version enable row level security;

-- 5. Seed helpers (consumed by the generated catalog + role matrix block)
-- ---------------------------------------------------------------------------
create or replace function public.seed_permission(
  p_permission_key text,
  p_description text,
  p_module text,
  p_resource text,
  p_action text,
  p_sensitive boolean,
  p_category text
) returns void
language sql security definer set search_path = public as $$
  insert into public.permissions (permission_key, description, category, module, resource, action, sensitive, is_system)
  values (p_permission_key, p_description, p_category, p_module, p_resource, p_action, p_sensitive, true)
  on conflict (permission_key)
  do update set
    description = excluded.description,
    category = excluded.category,
    module = excluded.module,
    resource = excluded.resource,
    action = excluded.action,
    sensitive = excluded.sensitive,
    is_system = true;
$$;
grant execute on function public.seed_permission(text, text, text, text, text, boolean, text) to authenticated;

create or replace function public.seed_role_permission(p_role_name text, p_permission_key text)
returns void
language sql security definer set search_path = public as $$
  insert into public.role_permissions (role_id, permission_id, updated_by)
  select r.id, p.id, auth.uid()
  from public.roles r
  join public.permissions p on p.permission_key = p_permission_key
  where r.role_name = p_role_name
  on conflict on constraint role_permissions_role_id_permission_id_key do nothing;
$$;
grant execute on function public.seed_role_permission(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Enforcement engine
-- ---------------------------------------------------------------------------
create or replace function public.bump_privilege_epoch()
returns bigint
language plpgsql security definer set search_path = public as $$
begin
  insert into public.permission_version (id, epoch)
  values (1, 1)
  on conflict (id)
  do update set epoch = public.permission_version.epoch + 1, updated_at = now();
  return (select epoch from public.permission_version where id = 1);
end; $$;
grant execute on function public.bump_privilege_epoch() to authenticated;

-- Resolve ONE permission for ONE user to its final state (precedence applied).
create or replace function public._permission_state(
  p_user_id uuid,
  p_permission_key text,
  out allowed boolean,
  out source text,
  out effect text,
  out scope_type text,
  out scope_branch_id uuid,
  out scope_department text,
  out scope_user_ids uuid[]
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
  v_override public.user_permissions;
  v_row public.role_permissions;
begin
  v_role := coalesce((select role from public.profiles where id = p_user_id), 'staff');

  -- 1. super_admin is the system boundary.
  if v_role = 'super_admin' then
    allowed := true; source := 'system'; effect := 'allow';
    scope_type := 'global'; scope_user_ids := '{}'::uuid[];
    return;
  end if;

  -- 2. Explicit per-user override (DENY wins over ALLOW; a single row per key).
  select * into v_override
  from public.user_permissions
  where user_id = p_user_id and permission_key = p_permission_key;
  if v_override.id is not null then
    allowed := (v_override.effect = 'allow');
    source := 'user'; effect := v_override.effect;
    scope_type := coalesce(v_override.scope_type, 'global');
    scope_branch_id := v_override.scope_branch_id;
    scope_department := v_override.scope_department;
    scope_user_ids := coalesce(v_override.scope_user_ids, '{}'::uuid[]);
    return;
  end if;

  -- 3. Role baseline.
  select rp.* into v_row
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  where r.role_name = v_role
    and rp.permission_id = (select p2.id from public.permissions p2 where p2.permission_key = p_permission_key);
  if v_row.id is not null then
    allowed := true; source := 'role'; effect := 'allow';
    scope_type := coalesce(v_row.scope_type, 'global');
    scope_branch_id := v_row.scope_branch_id;
    scope_department := v_row.scope_department;
    scope_user_ids := coalesce(v_row.scope_user_ids, '{}'::uuid[]);
    return;
  end if;

  -- 4. Default deny.
  allowed := false; source := 'none'; effect := null;
  scope_type := 'global'; scope_user_ids := '{}'::uuid[];
end; $$;

create or replace function public.has_permission(p_permission_key text)
returns boolean
language sql stable security definer set search_path = public as $$
  select (public._permission_state(auth.uid(), p_permission_key)).allowed;
$$;
grant execute on function public.has_permission(text) to authenticated;

create or replace function public.has_permission_for(p_user_id uuid, p_permission_key text)
returns boolean
language sql stable security definer set search_path = public as $$
  select (public._permission_state(p_user_id, p_permission_key)).allowed;
$$;
grant execute on function public.has_permission_for(uuid, text) to authenticated;

create or replace function public.require_permission(p_permission_key text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_permission(p_permission_key) then
    raise exception 'insufficient_permissions: %', p_permission_key;
  end if;
end; $$;
grant execute on function public.require_permission(text) to authenticated;

-- Effective field visibility: super_admin sees everything; explicit 'hide'
-- (user overrides role) removes a column from the response.
create or replace function public.has_field_access(p_table_name text, p_column_name text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_effect text;
begin
  if v_role = 'super_admin' then return true; end if;
  select effect into v_effect
  from public.permission_field_rules
  where target_type = 'user' and target_key = auth.uid()::text
    and table_name = p_table_name and column_name = p_column_name;
  if v_effect is not null then return v_effect = 'show'; end if;
  select effect into v_effect
  from public.permission_field_rules
  where target_type = 'role' and target_key = v_role
    and table_name = p_table_name and column_name = p_column_name;
  return coalesce(v_effect = 'show', true);
end; $$;
grant execute on function public.has_field_access(text, text) to authenticated;

create or replace function public.require_field_access(p_table_name text, p_column_name text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_field_access(p_table_name, p_column_name) then
    raise exception 'insufficient_field_access: %.%', p_table_name, p_column_name;
  end if;
end; $$;
grant execute on function public.require_field_access(text, text) to authenticated;

-- Effective ALLOW/DENY maps for a user (consumer for get_my_permissions and
-- the Effective Access admin viewer).
create or replace function public._effective_maps(p_user_id uuid)
returns table (out_allowed jsonb, out_denied jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_allowed jsonb := '{}'::jsonb;
  v_denied jsonb := '{}'::jsonb;
  v_super boolean;
  c record;
  v_state record;
begin
  v_super := (coalesce((select role from public.profiles where id = p_user_id), 'staff') = 'super_admin');
  for c in select permission_key from public.permissions order by permission_key loop
    if v_super then
      v_allowed := jsonb_set(v_allowed, array[c.permission_key],
        jsonb_build_object('source', 'system', 'effect', 'allow', 'scope', jsonb_build_object('type', 'global')));
      continue;
    end if;
    select * into v_state from public._permission_state(p_user_id, c.permission_key);
    if v_state.allowed then
      v_allowed := jsonb_set(v_allowed, array[c.permission_key],
        jsonb_build_object(
          'source', v_state.source, 'effect', 'allow',
          'scope', jsonb_build_object(
            'type', v_state.scope_type,
            'branch_id', v_state.scope_branch_id,
            'department', v_state.scope_department,
            'user_ids', v_state.scope_user_ids
          )
        ));
    else
      v_denied := jsonb_set(v_denied, array[c.permission_key],
        jsonb_build_object('source', v_state.source, 'effect', v_state.effect));
    end if;
  end loop;
  out_allowed := v_allowed;
  out_denied := v_denied;
  return next;
end; $$;

create or replace function public._effective_fields(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := coalesce((select role from public.profiles where id = p_user_id), 'staff');
  v_out jsonb;
begin
  if v_role = 'super_admin' then return '{}'::jsonb; end if;
  select coalesce(jsonb_object_agg(k, effect), '{}'::jsonb) into v_out
  from (
    select distinct on (x.table_name, x.column_name)
      x.table_name || '.' || x.column_name as k, x.effect
    from (
      select table_name, column_name, effect, 0 as prio
      from public.permission_field_rules
      where target_type = 'user' and target_key = p_user_id::text
      union all
      select table_name, column_name, effect, 1
      from public.permission_field_rules
      where target_type = 'role' and target_key = v_role
    ) x
    order by x.table_name, x.column_name, x.prio
  ) y;
  return coalesce(v_out, '{}'::jsonb);
end; $$;

-- THE authority document every client (Web, Flutter, SARA) consumes.
create or replace function public.get_my_permissions()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.current_role();
  v_epoch bigint;
  v_allowed jsonb;
  v_denied jsonb;
  v_fields jsonb;
  v_modules text[];
begin
  if v_uid is null then return null; end if;
  select coalesce(max(epoch), 1) into v_epoch from public.permission_version;
  select out_allowed, out_denied into v_allowed, v_denied from public._effective_maps(v_uid);
  select array_agg(m order by m) into v_modules
  from (select distinct split_part(k, '.', 1) as m from jsonb_object_keys(v_allowed) k) t;
  v_fields := public._effective_fields(v_uid);
  return jsonb_build_object(
    'epoch', v_epoch,
    'role', v_role,
    'is_super_user', (v_role = 'super_admin'),
    'allowed', v_allowed,
    'denied', v_denied,
    'fields', v_fields,
    'modules', coalesce(v_modules, '{}'::text[])
  );
end; $$;
grant execute on function public.get_my_permissions() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Delegation authority
-- ---------------------------------------------------------------------------
create or replace function public._scope_rank(p_scope_type text)
returns int language sql immutable as $$
  select case p_scope_type
    when 'global' then 100
    when 'selected_users' then 60
    when 'branch' then 55
    when 'department' then 50
    when 'self' then 10
    else 0
  end;
$$;

-- Can the current actor manage (grant/revoke/deny) `p_permission_key` at
-- `p_scope_type`? Rules (documented):
--   * super_admin may manage everything.
--   * the actor must hold administration.privileges.manage
--   * a delegation row must cover the permission's module (or '*')
--   * the requested scope must be <= the delegation's max_scope
--   * the actor must THEMSELVES hold the permission being managed
--     (the holder rule — nobody can delegate what they do not possess).
create or replace function public._can_manage_permission(p_permission_key text, p_scope_type text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_module text := split_part(p_permission_key, '.', 1);
  v_managed boolean;
  v_own_scope int;
  v_grant_scope int;
begin
  if v_role = 'super_admin' then return true; end if;
  if not public.has_permission('administration.privileges.manage') then return false; end if;
  if not public.has_permission(p_permission_key) then return false; end if;

  select true into v_managed
  from public.permission_delegation
  where (grantee_type = 'role' and grantee_key = v_role
         or grantee_type = 'user' and grantee_key = auth.uid()::text)
    and (module = '*' or module = v_module)
  limit 1;
  if v_managed is null then return false; end if;

  v_grant_scope := public._scope_rank(coalesce(p_scope_type, 'global'));
  -- Keep the actor honest: they can only hand out scopes at or below their own
  -- delegation ceiling.
  select max(public._scope_rank(coalesce(max_scope, 'global'))) into v_own_scope
  from public.permission_delegation
  where (grantee_type = 'role' and grantee_key = v_role
         or grantee_type = 'user' and grantee_key = auth.uid()::text)
    and (module = '*' or module = v_module);
  return coalesce(v_own_scope, 0) >= v_grant_scope;
end; $$;

-- Scope ceiling + modules the caller may manage (drives the privilege UI).
create or replace function public.get_privilege_authority()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_uid uuid := auth.uid();
  v_managed text[];
  v_max int;
  v_max_scope text;
begin
  if v_role = 'super_admin' then
    return jsonb_build_object(
      'is_super_user', true,
      'can_manage_privileges', true,
      'modules', jsonb_build_array('*'),
      'max_scope', 'global',
      'effective', public.get_my_permissions()
    );
  end if;
  if not public.has_permission('administration.privileges.manage') then
    return jsonb_build_object(
      'is_super_user', false,
      'can_manage_privileges', false,
      'modules', jsonb_build_array(),
      'max_scope', 'self',
      'effective', public.get_my_permissions()
    );
  end if;
  select coalesce(array_agg(distinct module order by module), '{}'::text[]) into v_managed
  from public.permission_delegation
  where (grantee_type = 'role' and grantee_key = v_role
         or grantee_type = 'user' and grantee_key = v_uid::text);
  select max(public._scope_rank(coalesce(max_scope, 'global'))) into v_max
  from public.permission_delegation
  where (grantee_type = 'role' and grantee_key = v_role
         or grantee_type = 'user' and grantee_key = v_uid::text);
  v_max_scope := case when v_max >= 90 then 'global'
                      when v_max >= 55 then 'branch'
                      when v_max >= 50 then 'department'
                      when v_max >= 10 then 'self'
                      else 'self' end;
  return jsonb_build_object(
    'is_super_user', false,
    'can_manage_privileges', true,
    'modules', coalesce(v_managed, '{}'::text[]),
    'max_scope', v_max_scope,
    'effective', public.get_my_permissions()
  );
end; $$;
grant execute on function public.get_privilege_authority() to authenticated;
-- ---------------------------------------------------------------------------
-- 4. RLS on the new tables
-- ---------------------------------------------------------------------------
-- Direct writes are denied (no INSERT/UPDATE/DELETE policies). Every write
-- goes through the SECURITY DEFINER management RPCs below. Reads are limited
-- to the affected user or privilege managers.
create or replace function public.is_privilege_manager()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_role() = 'super_admin'
     or public.has_permission('administration.privileges.manage');
$$;

drop policy if exists user_permissions_self_read on public.user_permissions;
create policy user_permissions_self_read on public.user_permissions
  for select using (user_id = auth.uid() or public.is_privilege_manager());

drop policy if exists permission_field_rules_read on public.permission_field_rules;
create policy permission_field_rules_read on public.permission_field_rules
  for select using (
    public.is_privilege_manager()
    or (target_type = 'user' and target_key = auth.uid()::text)
  );

drop policy if exists permission_delegation_read on public.permission_delegation;
create policy permission_delegation_read on public.permission_delegation
  for select using (
    public.is_privilege_manager()
    or (grantee_type = 'user' and grantee_key = auth.uid()::text)
  );

drop policy if exists permission_audit_read on public.permission_audit;
create policy permission_audit_read on public.permission_audit
  for select using (public.is_privilege_manager());

drop policy if exists permission_version_read on public.permission_version;
create policy permission_version_read on public.permission_version
  for select using (auth.role() = 'authenticated');


-- BEGIN GENERATED PRIVILEGE SEED --
select public.seed_permission('admin.manage_config', 'Manage config on Administration (admin.manage_config)', 'administration', 'admin', 'manage_config', false, 'administration');
select public.seed_permission('admin.manage_users', 'Manage users on Administration (admin.manage_users)', 'administration', 'admin', 'manage_users', false, 'administration');
select public.seed_permission('admin.platform.reset', 'Reset on platform (admin.platform.reset)', 'administration', 'platform', 'reset', false, 'administration');
select public.seed_permission('admin.view_audit', 'View audit on Administration (admin.view_audit)', 'administration', 'admin', 'view_audit', false, 'administration');
select public.seed_permission('administration.audit.view', 'View on audit (administration.audit.view)', 'administration', 'audit', 'view', false, 'administration');
select public.seed_permission('administration.platform.reset', 'Reset on platform (administration.platform.reset)', 'administration', 'platform', 'reset', true, 'administration');
select public.seed_permission('administration.privileges.manage', 'Manage on privileges (administration.privileges.manage)', 'administration', 'privileges', 'manage', false, 'administration');
select public.seed_permission('administration.privileges.view', 'View on privileges (administration.privileges.view)', 'administration', 'privileges', 'view', false, 'administration');
select public.seed_permission('administration.roles.edit', 'Edit on roles (administration.roles.edit)', 'administration', 'roles', 'edit', false, 'administration');
select public.seed_permission('administration.roles.view', 'View on roles (administration.roles.view)', 'administration', 'roles', 'view', false, 'administration');
select public.seed_permission('administration.settings.edit', 'Edit on settings (administration.settings.edit)', 'administration', 'settings', 'edit', false, 'administration');
select public.seed_permission('administration.settings.view', 'View on settings (administration.settings.view)', 'administration', 'settings', 'view', false, 'administration');
select public.seed_permission('administration.users.configure', 'Configure on users (administration.users.configure)', 'administration', 'users', 'configure', false, 'administration');
select public.seed_permission('administration.users.edit', 'Edit on users (administration.users.edit)', 'administration', 'users', 'edit', false, 'administration');
select public.seed_permission('administration.users.manage_privileges', 'Manage privileges on users (administration.users.manage_privileges)', 'administration', 'users', 'manage_privileges', false, 'administration');
select public.seed_permission('administration.users.suspend', 'Suspend on users (administration.users.suspend)', 'administration', 'users', 'suspend', false, 'administration');
select public.seed_permission('administration.users.view', 'View on users (administration.users.view)', 'administration', 'users', 'view', false, 'administration');
select public.seed_permission('appraisal.edit', 'Edit on Appraisals (appraisal.edit)', 'appraisal', 'appraisal', 'edit', false, 'appraisal');
select public.seed_permission('appraisal.manage', 'Manage on Appraisals (appraisal.manage)', 'appraisal', 'appraisal', 'manage', false, 'appraisal');
select public.seed_permission('appraisal.read', 'Read on Appraisals (appraisal.read)', 'appraisal', 'appraisal', 'read', false, 'appraisal');
select public.seed_permission('appraisal.view', 'View on Appraisals (appraisal.view)', 'appraisal', 'appraisal', 'view', false, 'appraisal');
select public.seed_permission('attendance.audit.view', 'View on audit (attendance.audit.view)', 'attendance', 'audit', 'view', false, 'attendance');
select public.seed_permission('attendance.bindings.unbind', 'Unbind on bindings (attendance.bindings.unbind)', 'attendance', 'bindings', 'unbind', false, 'attendance');
select public.seed_permission('attendance.bindings.view', 'View on bindings (attendance.bindings.view)', 'attendance', 'bindings', 'view', false, 'attendance');
select public.seed_permission('attendance.clock_in', 'Clock in on Attendance (attendance.clock_in)', 'attendance', 'attendance', 'clock_in', false, 'attendance');
select public.seed_permission('attendance.clock_out', 'Clock out on Attendance (attendance.clock_out)', 'attendance', 'attendance', 'clock_out', false, 'attendance');
select public.seed_permission('attendance.config.manage', 'Manage on config (attendance.config.manage)', 'attendance', 'config', 'manage', false, 'attendance');
select public.seed_permission('attendance.devices.manage', 'Manage on devices (attendance.devices.manage)', 'attendance', 'devices', 'manage', false, 'attendance');
select public.seed_permission('attendance.devices.unbind', 'Unbind on devices (attendance.devices.unbind)', 'attendance', 'devices', 'unbind', false, 'attendance');
select public.seed_permission('attendance.devices.view', 'View on devices (attendance.devices.view)', 'attendance', 'devices', 'view', false, 'attendance');
select public.seed_permission('attendance.geofence.edit', 'Edit on geofence (attendance.geofence.edit)', 'attendance', 'geofence', 'edit', false, 'attendance');
select public.seed_permission('attendance.history', 'History on Attendance (attendance.history)', 'attendance', 'attendance', 'history', false, 'attendance');
select public.seed_permission('attendance.manage.edit', 'Edit on manage (attendance.manage.edit)', 'attendance', 'manage', 'edit', false, 'attendance');
select public.seed_permission('attendance.manage.view', 'View on manage (attendance.manage.view)', 'attendance', 'manage', 'view', false, 'attendance');
select public.seed_permission('attendance.records.edit', 'Edit on records (attendance.records.edit)', 'attendance', 'records', 'edit', false, 'attendance');
select public.seed_permission('attendance.records.export', 'Export on records (attendance.records.export)', 'attendance', 'records', 'export', false, 'attendance');
select public.seed_permission('attendance.records.view', 'View on records (attendance.records.view)', 'attendance', 'records', 'view', false, 'attendance');
select public.seed_permission('attendance.settings.edit', 'Edit on settings (attendance.settings.edit)', 'attendance', 'settings', 'edit', false, 'attendance');
select public.seed_permission('attendance.terminal', 'Terminal on Attendance (attendance.terminal)', 'attendance', 'attendance', 'terminal', false, 'attendance');
select public.seed_permission('attendance.view', 'View on Attendance (attendance.view)', 'attendance', 'attendance', 'view', false, 'attendance');
select public.seed_permission('bankone.import', 'Import on BankOne (bankone.import)', 'bankone', 'bankone', 'import', false, 'bankone');
select public.seed_permission('bankone.read', 'Read on BankOne (bankone.read)', 'bankone', 'bankone', 'read', false, 'bankone');
select public.seed_permission('branches.read', 'Read on Branches (branches.read)', 'branches', 'branches', 'read', false, 'branches');
select public.seed_permission('communications.announce', 'Announce on Communications (communications.announce)', 'communications', 'communications', 'announce', false, 'communications');
select public.seed_permission('communications.broadcast', 'Broadcast on Communications (communications.broadcast)', 'communications', 'communications', 'broadcast', false, 'communications');
select public.seed_permission('customers.create', 'Create on Customers (customers.create)', 'customers', 'customers', 'create', false, 'customers');
select public.seed_permission('customers.delete', 'Delete on Customers (customers.delete)', 'customers', 'customers', 'delete', false, 'customers');
select public.seed_permission('customers.read', 'Read on Customers (customers.read)', 'customers', 'customers', 'read', false, 'customers');
select public.seed_permission('customers.update', 'Update on Customers (customers.update)', 'customers', 'customers', 'update', false, 'customers');
select public.seed_permission('data.import.execute', 'Execute on import (data.import.execute)', 'data', 'import', 'execute', false, 'data');
select public.seed_permission('data.import.view', 'View on import (data.import.view)', 'data', 'import', 'view', false, 'data');
select public.seed_permission('documents.delete', 'Delete on Documents (documents.delete)', 'documents', 'documents', 'delete', false, 'documents');
select public.seed_permission('documents.read', 'Read on Documents (documents.read)', 'documents', 'documents', 'read', false, 'documents');
select public.seed_permission('documents.upload', 'Upload on Documents (documents.upload)', 'documents', 'documents', 'upload', false, 'documents');
select public.seed_permission('documents.verify', 'Verify on Documents (documents.verify)', 'documents', 'documents', 'verify', false, 'documents');
select public.seed_permission('hr.applications.read', 'Read on applications (hr.applications.read)', 'hr', 'applications', 'read', false, 'hr');
select public.seed_permission('hr.applications.screen', 'Screen on applications (hr.applications.screen)', 'hr', 'applications', 'screen', false, 'hr');
select public.seed_permission('hr.assessments.create', 'Create on assessments (hr.assessments.create)', 'hr', 'assessments', 'create', false, 'hr');
select public.seed_permission('hr.attendance.manage', 'Manage on attendance (hr.attendance.manage)', 'hr', 'attendance', 'manage', false, 'hr');
select public.seed_permission('hr.attendance.self', 'Self on attendance (hr.attendance.self)', 'hr', 'attendance', 'self', false, 'hr');
select public.seed_permission('hr.employee.read', 'Read on employee (hr.employee.read)', 'hr', 'employee', 'read', false, 'hr');
select public.seed_permission('hr.employee.update', 'Update on employee (hr.employee.update)', 'hr', 'employee', 'update', false, 'hr');
select public.seed_permission('hr.hire', 'Hire on HR (hr.hire)', 'hr', 'hr', 'hire', false, 'hr');
select public.seed_permission('hr.interviews.schedule', 'Schedule on interviews (hr.interviews.schedule)', 'hr', 'interviews', 'schedule', false, 'hr');
select public.seed_permission('hr.jobs.create', 'Create on jobs (hr.jobs.create)', 'hr', 'jobs', 'create', false, 'hr');
select public.seed_permission('hr.jobs.manage', 'Manage on jobs (hr.jobs.manage)', 'hr', 'jobs', 'manage', false, 'hr');
select public.seed_permission('hr.leave.approve', 'Approve on leave (hr.leave.approve)', 'hr', 'leave', 'approve', false, 'hr');
select public.seed_permission('hr.leave.manage', 'Manage on leave (hr.leave.manage)', 'hr', 'leave', 'manage', false, 'hr');
select public.seed_permission('hr.leave.request', 'Request on leave (hr.leave.request)', 'hr', 'leave', 'request', false, 'hr');
select public.seed_permission('hr.leave.view', 'View on leave (hr.leave.view)', 'hr', 'leave', 'view', false, 'hr');
select public.seed_permission('hr.offer_letters.read', 'Read on offer letters (hr.offer_letters.read)', 'hr', 'offer_letters', 'read', false, 'hr');
select public.seed_permission('hr.onboarding.manage', 'Manage on onboarding (hr.onboarding.manage)', 'hr', 'onboarding', 'manage', false, 'hr');
select public.seed_permission('hr.onboarding.read', 'Read on onboarding (hr.onboarding.read)', 'hr', 'onboarding', 'read', false, 'hr');
select public.seed_permission('hr.org.manage', 'Manage on org (hr.org.manage)', 'hr', 'org', 'manage', false, 'hr');
select public.seed_permission('hr.payroll.read', 'Read on payroll (hr.payroll.read)', 'hr', 'payroll', 'read', false, 'hr');
select public.seed_permission('hr.settings.manage', 'Manage on settings (hr.settings.manage)', 'hr', 'settings', 'manage', false, 'hr');
select public.seed_permission('hr.training.manage', 'Manage on training (hr.training.manage)', 'hr', 'training', 'manage', false, 'hr');
select public.seed_permission('hr.training.read', 'Read on training (hr.training.read)', 'hr', 'training', 'read', false, 'hr');
select public.seed_permission('hr_config.manage', 'Manage on HR Configuration (hr_config.manage)', 'hr_config', 'hr_config', 'manage', false, 'hr_config');
select public.seed_permission('loans.approve_high', 'Approve high on Loans (loans.approve_high)', 'loans', 'loans', 'approve_high', false, 'loans');
select public.seed_permission('loans.approve_low', 'Approve low on Loans (loans.approve_low)', 'loans', 'loans', 'approve_low', false, 'loans');
select public.seed_permission('loans.approve_medium', 'Approve medium on Loans (loans.approve_medium)', 'loans', 'loans', 'approve_medium', false, 'loans');
select public.seed_permission('loans.assess', 'Assess on Loans (loans.assess)', 'loans', 'loans', 'assess', false, 'loans');
select public.seed_permission('loans.create', 'Create on Loans (loans.create)', 'loans', 'loans', 'create', false, 'loans');
select public.seed_permission('loans.disburse', 'Disburse on Loans (loans.disburse)', 'loans', 'loans', 'disburse', false, 'loans');
select public.seed_permission('loans.read', 'Read on Loans (loans.read)', 'loans', 'loans', 'read', false, 'loans');
select public.seed_permission('medical.manage', 'Manage on Medical Screening (medical.manage)', 'medical', 'medical', 'manage', false, 'medical');
select public.seed_permission('medical.read', 'Read on Medical Screening (medical.read)', 'medical', 'medical', 'read', false, 'medical');
select public.seed_permission('messaging.attachments.upload', 'Upload on attachments (messaging.attachments.upload)', 'messaging', 'attachments', 'upload', false, 'messaging');
select public.seed_permission('messaging.send', 'Send on Messaging (messaging.send)', 'messaging', 'messaging', 'send', false, 'messaging');
select public.seed_permission('messaging.view', 'View on Messaging (messaging.view)', 'messaging', 'messaging', 'view', false, 'messaging');
select public.seed_permission('payroll.approve', 'Approve on Payroll (payroll.approve)', 'payroll', 'payroll', 'approve', false, 'payroll');
select public.seed_permission('payroll.export', 'Export on Payroll (payroll.export)', 'payroll', 'payroll', 'export', false, 'payroll');
select public.seed_permission('payroll.manage', 'Manage on Payroll (payroll.manage)', 'payroll', 'payroll', 'manage', false, 'payroll');
select public.seed_permission('payroll.push', 'Push on Payroll (payroll.push)', 'payroll', 'payroll', 'push', false, 'payroll');
select public.seed_permission('payroll.run', 'Run on Payroll (payroll.run)', 'payroll', 'payroll', 'run', false, 'payroll');
select public.seed_permission('payroll.salary.edit', 'Edit on salary (payroll.salary.edit)', 'payroll', 'salary', 'edit', true, 'payroll');
select public.seed_permission('payroll.salary.view', 'View on salary (payroll.salary.view)', 'payroll', 'salary', 'view', true, 'payroll');
select public.seed_permission('payroll.view', 'View on Payroll (payroll.view)', 'payroll', 'payroll', 'view', false, 'payroll');
select public.seed_permission('performance.edit', 'Edit on Performance (performance.edit)', 'performance', 'performance', 'edit', false, 'performance');
select public.seed_permission('performance.manage', 'Manage on Performance (performance.manage)', 'performance', 'performance', 'manage', false, 'performance');
select public.seed_permission('performance.read', 'Read on Performance (performance.read)', 'performance', 'performance', 'read', false, 'performance');
select public.seed_permission('performance.settings', 'Settings on Performance (performance.settings)', 'performance', 'performance', 'settings', false, 'performance');
select public.seed_permission('performance.view', 'View on Performance (performance.view)', 'performance', 'performance', 'view', false, 'performance');
select public.seed_permission('reconciliation.manage', 'Manage on Reconciliation (reconciliation.manage)', 'reconciliation', 'reconciliation', 'manage', false, 'reconciliation');
select public.seed_permission('reconciliation.read', 'Read on Reconciliation (reconciliation.read)', 'reconciliation', 'reconciliation', 'read', false, 'reconciliation');
select public.seed_permission('reports.read', 'Read on Reports (reports.read)', 'reports', 'reports', 'read', false, 'reports');
select public.seed_permission('sara.admin_actions', 'Admin actions on SARA (sara.admin_actions)', 'sara', 'sara', 'admin_actions', false, 'sara');
select public.seed_permission('sara.reports', 'Reports on SARA (sara.reports)', 'sara', 'sara', 'reports', false, 'sara');
select public.seed_permission('sara.use', 'Use on SARA (sara.use)', 'sara', 'sara', 'use', false, 'sara');
select public.seed_permission('support.create', 'Create on Support (support.create)', 'support', 'support', 'create', false, 'support');
select public.seed_permission('support.read', 'Read on Support (support.read)', 'support', 'support', 'read', false, 'support');
select public.seed_permission('support.resolve', 'Resolve on Support (support.resolve)', 'support', 'support', 'resolve', false, 'support');
select public.seed_permission('work.kpis.manage', 'Manage on kpis (work.kpis.manage)', 'work', 'kpis', 'manage', false, 'work');
select public.seed_permission('work.plans.manage', 'Manage on plans (work.plans.manage)', 'work', 'plans', 'manage', false, 'work');
select public.seed_permission('work.reports.review', 'Review on reports (work.reports.review)', 'work', 'reports', 'review', false, 'work');
select public.seed_permission('work.targets.manage', 'Manage on targets (work.targets.manage)', 'work', 'targets', 'manage', false, 'work');
select public.seed_permission('work.tasks.manage', 'Manage on tasks (work.tasks.manage)', 'work', 'tasks', 'manage', false, 'work');
select public.seed_permission('work.team.performance', 'Performance on team (work.team.performance)', 'work', 'team', 'performance', false, 'work');
select public.seed_permission('workforce.manhour.read', 'Read on manhour (workforce.manhour.read)', 'workforce', 'manhour', 'read', false, 'workforce');
select public.seed_role_permission('super_admin', 'customers.read');
select public.seed_role_permission('super_admin', 'customers.create');
select public.seed_role_permission('super_admin', 'customers.update');
select public.seed_role_permission('super_admin', 'customers.delete');
select public.seed_role_permission('super_admin', 'loans.read');
select public.seed_role_permission('super_admin', 'loans.create');
select public.seed_role_permission('super_admin', 'loans.assess');
select public.seed_role_permission('super_admin', 'loans.approve_low');
select public.seed_role_permission('super_admin', 'loans.approve_medium');
select public.seed_role_permission('super_admin', 'loans.approve_high');
select public.seed_role_permission('super_admin', 'loans.disburse');
select public.seed_role_permission('super_admin', 'documents.upload');
select public.seed_role_permission('super_admin', 'documents.read');
select public.seed_role_permission('super_admin', 'documents.verify');
select public.seed_role_permission('super_admin', 'documents.delete');
select public.seed_role_permission('super_admin', 'hr.jobs.create');
select public.seed_role_permission('super_admin', 'hr.jobs.manage');
select public.seed_role_permission('super_admin', 'hr.applications.read');
select public.seed_role_permission('super_admin', 'hr.applications.screen');
select public.seed_role_permission('super_admin', 'hr.assessments.create');
select public.seed_role_permission('super_admin', 'hr.interviews.schedule');
select public.seed_role_permission('super_admin', 'hr.hire');
select public.seed_role_permission('super_admin', 'hr.leave.manage');
select public.seed_role_permission('super_admin', 'hr.payroll.read');
select public.seed_role_permission('super_admin', 'hr.offer_letters.read');
select public.seed_role_permission('super_admin', 'hr.onboarding.read');
select public.seed_role_permission('super_admin', 'hr.onboarding.manage');
select public.seed_role_permission('super_admin', 'hr.employee.read');
select public.seed_role_permission('super_admin', 'hr.employee.update');
select public.seed_role_permission('super_admin', 'hr.attendance.self');
select public.seed_role_permission('super_admin', 'hr.attendance.manage');
select public.seed_role_permission('super_admin', 'hr.settings.manage');
select public.seed_role_permission('super_admin', 'payroll.manage');
select public.seed_role_permission('super_admin', 'payroll.push');
select public.seed_role_permission('super_admin', 'payroll.approve');
select public.seed_role_permission('super_admin', 'data.import.view');
select public.seed_role_permission('super_admin', 'data.import.execute');
select public.seed_role_permission('super_admin', 'branches.read');
select public.seed_role_permission('super_admin', 'support.create');
select public.seed_role_permission('super_admin', 'support.read');
select public.seed_role_permission('super_admin', 'support.resolve');
select public.seed_role_permission('super_admin', 'admin.manage_users');
select public.seed_role_permission('super_admin', 'admin.view_audit');
select public.seed_role_permission('super_admin', 'admin.manage_config');
select public.seed_role_permission('super_admin', 'admin.platform.reset');
select public.seed_role_permission('super_admin', 'reports.read');
select public.seed_role_permission('super_admin', 'bankone.import');
select public.seed_role_permission('super_admin', 'bankone.read');
select public.seed_role_permission('super_admin', 'reconciliation.manage');
select public.seed_role_permission('super_admin', 'reconciliation.read');
select public.seed_role_permission('super_admin', 'performance.manage');
select public.seed_role_permission('super_admin', 'performance.read');
select public.seed_role_permission('super_admin', 'appraisal.manage');
select public.seed_role_permission('super_admin', 'appraisal.read');
select public.seed_role_permission('super_admin', 'hr_config.manage');
select public.seed_role_permission('super_admin', 'work.tasks.manage');
select public.seed_role_permission('super_admin', 'work.kpis.manage');
select public.seed_role_permission('super_admin', 'work.targets.manage');
select public.seed_role_permission('super_admin', 'work.plans.manage');
select public.seed_role_permission('super_admin', 'work.reports.review');
select public.seed_role_permission('super_admin', 'work.team.performance');
select public.seed_role_permission('super_admin', 'attendance.config.manage');
select public.seed_role_permission('super_admin', 'hr.org.manage');
select public.seed_role_permission('super_admin', 'medical.read');
select public.seed_role_permission('super_admin', 'medical.manage');
select public.seed_role_permission('super_admin', 'hr.training.read');
select public.seed_role_permission('super_admin', 'hr.training.manage');
select public.seed_role_permission('super_admin', 'workforce.manhour.read');
select public.seed_role_permission('super_admin', 'attendance.terminal');
select public.seed_role_permission('super_admin', 'attendance.view');
select public.seed_role_permission('super_admin', 'attendance.clock_in');
select public.seed_role_permission('super_admin', 'attendance.clock_out');
select public.seed_role_permission('super_admin', 'attendance.history');
select public.seed_role_permission('super_admin', 'attendance.records.view');
select public.seed_role_permission('super_admin', 'attendance.records.edit');
select public.seed_role_permission('super_admin', 'attendance.records.export');
select public.seed_role_permission('super_admin', 'attendance.manage.view');
select public.seed_role_permission('super_admin', 'attendance.manage.edit');
select public.seed_role_permission('super_admin', 'attendance.audit.view');
select public.seed_role_permission('super_admin', 'attendance.bindings.view');
select public.seed_role_permission('super_admin', 'attendance.bindings.unbind');
select public.seed_role_permission('super_admin', 'attendance.settings.edit');
select public.seed_role_permission('super_admin', 'attendance.geofence.edit');
select public.seed_role_permission('super_admin', 'attendance.devices.view');
select public.seed_role_permission('super_admin', 'attendance.devices.manage');
select public.seed_role_permission('super_admin', 'attendance.devices.unbind');
select public.seed_role_permission('super_admin', 'payroll.view');
select public.seed_role_permission('super_admin', 'payroll.salary.view');
select public.seed_role_permission('super_admin', 'payroll.salary.edit');
select public.seed_role_permission('super_admin', 'payroll.run');
select public.seed_role_permission('super_admin', 'payroll.export');
select public.seed_role_permission('super_admin', 'performance.view');
select public.seed_role_permission('super_admin', 'performance.edit');
select public.seed_role_permission('super_admin', 'performance.settings');
select public.seed_role_permission('super_admin', 'appraisal.view');
select public.seed_role_permission('super_admin', 'appraisal.edit');
select public.seed_role_permission('super_admin', 'messaging.view');
select public.seed_role_permission('super_admin', 'messaging.send');
select public.seed_role_permission('super_admin', 'messaging.attachments.upload');
select public.seed_role_permission('super_admin', 'communications.announce');
select public.seed_role_permission('super_admin', 'communications.broadcast');
select public.seed_role_permission('super_admin', 'sara.use');
select public.seed_role_permission('super_admin', 'sara.reports');
select public.seed_role_permission('super_admin', 'sara.admin_actions');
select public.seed_role_permission('super_admin', 'administration.users.view');
select public.seed_role_permission('super_admin', 'administration.users.edit');
select public.seed_role_permission('super_admin', 'administration.users.suspend');
select public.seed_role_permission('super_admin', 'administration.users.configure');
select public.seed_role_permission('super_admin', 'administration.users.manage_privileges');
select public.seed_role_permission('super_admin', 'administration.roles.view');
select public.seed_role_permission('super_admin', 'administration.roles.edit');
select public.seed_role_permission('super_admin', 'administration.privileges.view');
select public.seed_role_permission('super_admin', 'administration.privileges.manage');
select public.seed_role_permission('super_admin', 'administration.audit.view');
select public.seed_role_permission('super_admin', 'administration.settings.view');
select public.seed_role_permission('super_admin', 'administration.settings.edit');
select public.seed_role_permission('super_admin', 'administration.platform.reset');
select public.seed_role_permission('super_admin', 'hr.leave.view');
select public.seed_role_permission('super_admin', 'hr.leave.request');
select public.seed_role_permission('super_admin', 'hr.leave.approve');
select public.seed_role_permission('admin', 'customers.read');
select public.seed_role_permission('admin', 'customers.create');
select public.seed_role_permission('admin', 'customers.update');
select public.seed_role_permission('admin', 'customers.delete');
select public.seed_role_permission('admin', 'loans.read');
select public.seed_role_permission('admin', 'loans.create');
select public.seed_role_permission('admin', 'loans.assess');
select public.seed_role_permission('admin', 'loans.approve_low');
select public.seed_role_permission('admin', 'loans.approve_medium');
select public.seed_role_permission('admin', 'loans.approve_high');
select public.seed_role_permission('admin', 'loans.disburse');
select public.seed_role_permission('admin', 'documents.upload');
select public.seed_role_permission('admin', 'documents.read');
select public.seed_role_permission('admin', 'documents.verify');
select public.seed_role_permission('admin', 'documents.delete');
select public.seed_role_permission('admin', 'hr.jobs.create');
select public.seed_role_permission('admin', 'hr.jobs.manage');
select public.seed_role_permission('admin', 'hr.applications.read');
select public.seed_role_permission('admin', 'hr.applications.screen');
select public.seed_role_permission('admin', 'hr.assessments.create');
select public.seed_role_permission('admin', 'hr.interviews.schedule');
select public.seed_role_permission('admin', 'hr.hire');
select public.seed_role_permission('admin', 'hr.leave.manage');
select public.seed_role_permission('admin', 'hr.payroll.read');
select public.seed_role_permission('admin', 'hr.offer_letters.read');
select public.seed_role_permission('admin', 'hr.onboarding.read');
select public.seed_role_permission('admin', 'hr.onboarding.manage');
select public.seed_role_permission('admin', 'hr.employee.read');
select public.seed_role_permission('admin', 'hr.employee.update');
select public.seed_role_permission('admin', 'hr.attendance.self');
select public.seed_role_permission('admin', 'hr.attendance.manage');
select public.seed_role_permission('admin', 'hr.settings.manage');
select public.seed_role_permission('admin', 'payroll.manage');
select public.seed_role_permission('admin', 'payroll.push');
select public.seed_role_permission('admin', 'payroll.approve');
select public.seed_role_permission('admin', 'data.import.view');
select public.seed_role_permission('admin', 'data.import.execute');
select public.seed_role_permission('admin', 'branches.read');
select public.seed_role_permission('admin', 'support.create');
select public.seed_role_permission('admin', 'support.read');
select public.seed_role_permission('admin', 'support.resolve');
select public.seed_role_permission('admin', 'admin.manage_users');
select public.seed_role_permission('admin', 'admin.view_audit');
select public.seed_role_permission('admin', 'admin.manage_config');
select public.seed_role_permission('admin', 'reports.read');
select public.seed_role_permission('admin', 'bankone.import');
select public.seed_role_permission('admin', 'bankone.read');
select public.seed_role_permission('admin', 'reconciliation.manage');
select public.seed_role_permission('admin', 'reconciliation.read');
select public.seed_role_permission('admin', 'performance.manage');
select public.seed_role_permission('admin', 'performance.read');
select public.seed_role_permission('admin', 'appraisal.manage');
select public.seed_role_permission('admin', 'appraisal.read');
select public.seed_role_permission('admin', 'hr_config.manage');
select public.seed_role_permission('admin', 'work.tasks.manage');
select public.seed_role_permission('admin', 'work.kpis.manage');
select public.seed_role_permission('admin', 'work.targets.manage');
select public.seed_role_permission('admin', 'work.plans.manage');
select public.seed_role_permission('admin', 'work.reports.review');
select public.seed_role_permission('admin', 'work.team.performance');
select public.seed_role_permission('admin', 'attendance.config.manage');
select public.seed_role_permission('admin', 'hr.org.manage');
select public.seed_role_permission('admin', 'medical.read');
select public.seed_role_permission('admin', 'medical.manage');
select public.seed_role_permission('admin', 'hr.training.read');
select public.seed_role_permission('admin', 'hr.training.manage');
select public.seed_role_permission('admin', 'workforce.manhour.read');
select public.seed_role_permission('admin', 'attendance.terminal');
select public.seed_role_permission('admin', 'attendance.view');
select public.seed_role_permission('admin', 'attendance.clock_in');
select public.seed_role_permission('admin', 'attendance.clock_out');
select public.seed_role_permission('admin', 'attendance.history');
select public.seed_role_permission('admin', 'attendance.records.view');
select public.seed_role_permission('admin', 'attendance.records.edit');
select public.seed_role_permission('admin', 'attendance.records.export');
select public.seed_role_permission('admin', 'attendance.manage.view');
select public.seed_role_permission('admin', 'attendance.manage.edit');
select public.seed_role_permission('admin', 'attendance.audit.view');
select public.seed_role_permission('admin', 'attendance.bindings.view');
select public.seed_role_permission('admin', 'attendance.bindings.unbind');
select public.seed_role_permission('admin', 'attendance.settings.edit');
select public.seed_role_permission('admin', 'attendance.geofence.edit');
select public.seed_role_permission('admin', 'attendance.devices.view');
select public.seed_role_permission('admin', 'attendance.devices.manage');
select public.seed_role_permission('admin', 'attendance.devices.unbind');
select public.seed_role_permission('admin', 'payroll.view');
select public.seed_role_permission('admin', 'payroll.salary.view');
select public.seed_role_permission('admin', 'payroll.salary.edit');
select public.seed_role_permission('admin', 'payroll.run');
select public.seed_role_permission('admin', 'payroll.export');
select public.seed_role_permission('admin', 'performance.view');
select public.seed_role_permission('admin', 'performance.edit');
select public.seed_role_permission('admin', 'performance.settings');
select public.seed_role_permission('admin', 'appraisal.view');
select public.seed_role_permission('admin', 'appraisal.edit');
select public.seed_role_permission('admin', 'messaging.view');
select public.seed_role_permission('admin', 'messaging.send');
select public.seed_role_permission('admin', 'messaging.attachments.upload');
select public.seed_role_permission('admin', 'communications.announce');
select public.seed_role_permission('admin', 'communications.broadcast');
select public.seed_role_permission('admin', 'sara.use');
select public.seed_role_permission('admin', 'sara.reports');
select public.seed_role_permission('admin', 'sara.admin_actions');
select public.seed_role_permission('admin', 'administration.users.view');
select public.seed_role_permission('admin', 'administration.users.edit');
select public.seed_role_permission('admin', 'administration.users.suspend');
select public.seed_role_permission('admin', 'administration.users.configure');
select public.seed_role_permission('admin', 'administration.users.manage_privileges');
select public.seed_role_permission('admin', 'administration.roles.view');
select public.seed_role_permission('admin', 'administration.roles.edit');
select public.seed_role_permission('admin', 'administration.privileges.view');
select public.seed_role_permission('admin', 'administration.privileges.manage');
select public.seed_role_permission('admin', 'administration.audit.view');
select public.seed_role_permission('admin', 'administration.settings.view');
select public.seed_role_permission('admin', 'administration.settings.edit');
select public.seed_role_permission('admin', 'hr.leave.view');
select public.seed_role_permission('admin', 'hr.leave.request');
select public.seed_role_permission('admin', 'hr.leave.approve');
select public.seed_role_permission('branch_manager', 'customers.read');
select public.seed_role_permission('branch_manager', 'customers.update');
select public.seed_role_permission('branch_manager', 'loans.read');
select public.seed_role_permission('branch_manager', 'loans.assess');
select public.seed_role_permission('branch_manager', 'loans.approve_medium');
select public.seed_role_permission('branch_manager', 'loans.disburse');
select public.seed_role_permission('branch_manager', 'documents.read');
select public.seed_role_permission('branch_manager', 'branches.read');
select public.seed_role_permission('branch_manager', 'reports.read');
select public.seed_role_permission('branch_manager', 'support.read');
select public.seed_role_permission('branch_manager', 'hr.leave.manage');
select public.seed_role_permission('branch_manager', 'hr.attendance.self');
select public.seed_role_permission('branch_manager', 'hr.attendance.manage');
select public.seed_role_permission('branch_manager', 'work.tasks.manage');
select public.seed_role_permission('branch_manager', 'work.kpis.manage');
select public.seed_role_permission('branch_manager', 'work.targets.manage');
select public.seed_role_permission('branch_manager', 'work.plans.manage');
select public.seed_role_permission('branch_manager', 'work.reports.review');
select public.seed_role_permission('branch_manager', 'work.team.performance');
select public.seed_role_permission('branch_manager', 'hr.training.read');
select public.seed_role_permission('branch_manager', 'workforce.manhour.read');
select public.seed_role_permission('branch_manager', 'attendance.terminal');
select public.seed_role_permission('branch_manager', 'attendance.view');
select public.seed_role_permission('branch_manager', 'attendance.clock_in');
select public.seed_role_permission('branch_manager', 'attendance.clock_out');
select public.seed_role_permission('branch_manager', 'attendance.history');
select public.seed_role_permission('branch_manager', 'attendance.records.view');
select public.seed_role_permission('branch_manager', 'attendance.records.edit');
select public.seed_role_permission('branch_manager', 'attendance.records.export');
select public.seed_role_permission('branch_manager', 'attendance.manage.view');
select public.seed_role_permission('branch_manager', 'attendance.manage.edit');
select public.seed_role_permission('branch_manager', 'attendance.audit.view');
select public.seed_role_permission('branch_manager', 'attendance.bindings.view');
select public.seed_role_permission('branch_manager', 'attendance.bindings.unbind');
select public.seed_role_permission('branch_manager', 'attendance.devices.view');
select public.seed_role_permission('branch_manager', 'attendance.devices.manage');
select public.seed_role_permission('branch_manager', 'attendance.devices.unbind');
select public.seed_role_permission('branch_manager', 'messaging.view');
select public.seed_role_permission('branch_manager', 'messaging.send');
select public.seed_role_permission('branch_manager', 'messaging.attachments.upload');
select public.seed_role_permission('branch_manager', 'communications.announce');
select public.seed_role_permission('branch_manager', 'sara.use');
select public.seed_role_permission('branch_manager', 'sara.reports');
select public.seed_role_permission('branch_manager', 'hr.leave.view');
select public.seed_role_permission('branch_manager', 'hr.leave.request');
select public.seed_role_permission('branch_manager', 'hr.leave.approve');
select public.seed_role_permission('area_manager', 'customers.read');
select public.seed_role_permission('area_manager', 'loans.read');
select public.seed_role_permission('area_manager', 'loans.approve_medium');
select public.seed_role_permission('area_manager', 'loans.disburse');
select public.seed_role_permission('area_manager', 'hr.leave.manage');
select public.seed_role_permission('area_manager', 'branches.read');
select public.seed_role_permission('area_manager', 'reports.read');
select public.seed_role_permission('area_manager', 'hr.attendance.self');
select public.seed_role_permission('area_manager', 'hr.training.read');
select public.seed_role_permission('area_manager', 'workforce.manhour.read');
select public.seed_role_permission('area_manager', 'attendance.terminal');
select public.seed_role_permission('area_manager', 'attendance.view');
select public.seed_role_permission('area_manager', 'attendance.clock_in');
select public.seed_role_permission('area_manager', 'attendance.clock_out');
select public.seed_role_permission('area_manager', 'attendance.history');
select public.seed_role_permission('area_manager', 'attendance.devices.view');
select public.seed_role_permission('area_manager', 'attendance.devices.manage');
select public.seed_role_permission('area_manager', 'attendance.devices.unbind');
select public.seed_role_permission('area_manager', 'messaging.view');
select public.seed_role_permission('area_manager', 'messaging.send');
select public.seed_role_permission('area_manager', 'messaging.attachments.upload');
select public.seed_role_permission('area_manager', 'communications.announce');
select public.seed_role_permission('area_manager', 'sara.use');
select public.seed_role_permission('area_manager', 'sara.reports');
select public.seed_role_permission('area_manager', 'hr.leave.view');
select public.seed_role_permission('area_manager', 'hr.leave.request');
select public.seed_role_permission('area_manager', 'hr.leave.approve');
select public.seed_role_permission('head_of_business', 'customers.read');
select public.seed_role_permission('head_of_business', 'loans.read');
select public.seed_role_permission('head_of_business', 'loans.approve_high');
select public.seed_role_permission('head_of_business', 'loans.disburse');
select public.seed_role_permission('head_of_business', 'hr.leave.manage');
select public.seed_role_permission('head_of_business', 'branches.read');
select public.seed_role_permission('head_of_business', 'reports.read');
select public.seed_role_permission('head_of_business', 'hr.attendance.self');
select public.seed_role_permission('head_of_business', 'hr.training.read');
select public.seed_role_permission('head_of_business', 'workforce.manhour.read');
select public.seed_role_permission('head_of_business', 'attendance.terminal');
select public.seed_role_permission('head_of_business', 'attendance.view');
select public.seed_role_permission('head_of_business', 'attendance.clock_in');
select public.seed_role_permission('head_of_business', 'attendance.clock_out');
select public.seed_role_permission('head_of_business', 'attendance.history');
select public.seed_role_permission('head_of_business', 'attendance.devices.view');
select public.seed_role_permission('head_of_business', 'attendance.devices.manage');
select public.seed_role_permission('head_of_business', 'attendance.devices.unbind');
select public.seed_role_permission('head_of_business', 'messaging.view');
select public.seed_role_permission('head_of_business', 'messaging.send');
select public.seed_role_permission('head_of_business', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_business', 'communications.announce');
select public.seed_role_permission('head_of_business', 'sara.use');
select public.seed_role_permission('head_of_business', 'sara.reports');
select public.seed_role_permission('head_of_business', 'hr.leave.view');
select public.seed_role_permission('head_of_business', 'hr.leave.request');
select public.seed_role_permission('head_of_business', 'hr.leave.approve');
select public.seed_role_permission('head_of_operations', 'customers.read');
select public.seed_role_permission('head_of_operations', 'loans.read');
select public.seed_role_permission('head_of_operations', 'hr.leave.manage');
select public.seed_role_permission('head_of_operations', 'branches.read');
select public.seed_role_permission('head_of_operations', 'reports.read');
select public.seed_role_permission('head_of_operations', 'hr.attendance.self');
select public.seed_role_permission('head_of_operations', 'hr.attendance.manage');
select public.seed_role_permission('head_of_operations', 'attendance.terminal');
select public.seed_role_permission('head_of_operations', 'hr.training.read');
select public.seed_role_permission('head_of_operations', 'workforce.manhour.read');
select public.seed_role_permission('head_of_operations', 'attendance.view');
select public.seed_role_permission('head_of_operations', 'attendance.clock_in');
select public.seed_role_permission('head_of_operations', 'attendance.clock_out');
select public.seed_role_permission('head_of_operations', 'attendance.history');
select public.seed_role_permission('head_of_operations', 'attendance.records.view');
select public.seed_role_permission('head_of_operations', 'attendance.records.edit');
select public.seed_role_permission('head_of_operations', 'attendance.records.export');
select public.seed_role_permission('head_of_operations', 'attendance.manage.view');
select public.seed_role_permission('head_of_operations', 'attendance.manage.edit');
select public.seed_role_permission('head_of_operations', 'attendance.audit.view');
select public.seed_role_permission('head_of_operations', 'attendance.bindings.view');
select public.seed_role_permission('head_of_operations', 'attendance.bindings.unbind');
select public.seed_role_permission('head_of_operations', 'attendance.devices.view');
select public.seed_role_permission('head_of_operations', 'attendance.devices.manage');
select public.seed_role_permission('head_of_operations', 'attendance.devices.unbind');
select public.seed_role_permission('head_of_operations', 'messaging.view');
select public.seed_role_permission('head_of_operations', 'messaging.send');
select public.seed_role_permission('head_of_operations', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_operations', 'communications.announce');
select public.seed_role_permission('head_of_operations', 'sara.use');
select public.seed_role_permission('head_of_operations', 'sara.reports');
select public.seed_role_permission('head_of_operations', 'hr.leave.view');
select public.seed_role_permission('head_of_operations', 'hr.leave.request');
select public.seed_role_permission('head_of_operations', 'hr.leave.approve');
select public.seed_role_permission('head_of_e_business', 'customers.read');
select public.seed_role_permission('head_of_e_business', 'loans.read');
select public.seed_role_permission('head_of_e_business', 'branches.read');
select public.seed_role_permission('head_of_e_business', 'reports.read');
select public.seed_role_permission('head_of_e_business', 'hr.attendance.self');
select public.seed_role_permission('head_of_e_business', 'attendance.terminal');
select public.seed_role_permission('head_of_e_business', 'bankone.read');
select public.seed_role_permission('head_of_e_business', 'hr.training.read');
select public.seed_role_permission('head_of_e_business', 'workforce.manhour.read');
select public.seed_role_permission('head_of_e_business', 'attendance.view');
select public.seed_role_permission('head_of_e_business', 'attendance.clock_in');
select public.seed_role_permission('head_of_e_business', 'attendance.clock_out');
select public.seed_role_permission('head_of_e_business', 'attendance.history');
select public.seed_role_permission('head_of_e_business', 'attendance.devices.view');
select public.seed_role_permission('head_of_e_business', 'attendance.devices.manage');
select public.seed_role_permission('head_of_e_business', 'attendance.devices.unbind');
select public.seed_role_permission('head_of_e_business', 'messaging.view');
select public.seed_role_permission('head_of_e_business', 'messaging.send');
select public.seed_role_permission('head_of_e_business', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_e_business', 'communications.announce');
select public.seed_role_permission('head_of_e_business', 'sara.use');
select public.seed_role_permission('head_of_e_business', 'sara.reports');
select public.seed_role_permission('head_of_e_business', 'hr.leave.view');
select public.seed_role_permission('head_of_e_business', 'hr.leave.request');
select public.seed_role_permission('financial_controller', 'customers.read');
select public.seed_role_permission('financial_controller', 'loans.read');
select public.seed_role_permission('financial_controller', 'branches.read');
select public.seed_role_permission('financial_controller', 'reports.read');
select public.seed_role_permission('financial_controller', 'hr.attendance.self');
select public.seed_role_permission('financial_controller', 'payroll.manage');
select public.seed_role_permission('financial_controller', 'bankone.read');
select public.seed_role_permission('financial_controller', 'reconciliation.read');
select public.seed_role_permission('financial_controller', 'hr.training.read');
select public.seed_role_permission('financial_controller', 'workforce.manhour.read');
select public.seed_role_permission('financial_controller', 'attendance.view');
select public.seed_role_permission('financial_controller', 'attendance.clock_in');
select public.seed_role_permission('financial_controller', 'attendance.clock_out');
select public.seed_role_permission('financial_controller', 'attendance.history');
select public.seed_role_permission('financial_controller', 'payroll.view');
select public.seed_role_permission('financial_controller', 'payroll.salary.view');
select public.seed_role_permission('financial_controller', 'payroll.salary.edit');
select public.seed_role_permission('financial_controller', 'payroll.run');
select public.seed_role_permission('financial_controller', 'messaging.view');
select public.seed_role_permission('financial_controller', 'messaging.send');
select public.seed_role_permission('financial_controller', 'messaging.attachments.upload');
select public.seed_role_permission('financial_controller', 'communications.announce');
select public.seed_role_permission('financial_controller', 'sara.use');
select public.seed_role_permission('financial_controller', 'sara.reports');
select public.seed_role_permission('financial_controller', 'hr.leave.view');
select public.seed_role_permission('financial_controller', 'hr.leave.request');
select public.seed_role_permission('head_of_risk_compliance', 'customers.read');
select public.seed_role_permission('head_of_risk_compliance', 'loans.read');
select public.seed_role_permission('head_of_risk_compliance', 'branches.read');
select public.seed_role_permission('head_of_risk_compliance', 'reports.read');
select public.seed_role_permission('head_of_risk_compliance', 'hr.attendance.self');
select public.seed_role_permission('head_of_risk_compliance', 'admin.view_audit');
select public.seed_role_permission('head_of_risk_compliance', 'hr.training.read');
select public.seed_role_permission('head_of_risk_compliance', 'workforce.manhour.read');
select public.seed_role_permission('head_of_risk_compliance', 'attendance.view');
select public.seed_role_permission('head_of_risk_compliance', 'attendance.clock_in');
select public.seed_role_permission('head_of_risk_compliance', 'attendance.clock_out');
select public.seed_role_permission('head_of_risk_compliance', 'attendance.history');
select public.seed_role_permission('head_of_risk_compliance', 'messaging.view');
select public.seed_role_permission('head_of_risk_compliance', 'messaging.send');
select public.seed_role_permission('head_of_risk_compliance', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_risk_compliance', 'communications.announce');
select public.seed_role_permission('head_of_risk_compliance', 'sara.use');
select public.seed_role_permission('head_of_risk_compliance', 'sara.reports');
select public.seed_role_permission('head_of_risk_compliance', 'administration.audit.view');
select public.seed_role_permission('head_of_risk_compliance', 'hr.leave.view');
select public.seed_role_permission('head_of_risk_compliance', 'hr.leave.request');
select public.seed_role_permission('head_of_legal', 'customers.read');
select public.seed_role_permission('head_of_legal', 'loans.read');
select public.seed_role_permission('head_of_legal', 'documents.read');
select public.seed_role_permission('head_of_legal', 'branches.read');
select public.seed_role_permission('head_of_legal', 'reports.read');
select public.seed_role_permission('head_of_legal', 'hr.attendance.self');
select public.seed_role_permission('head_of_legal', 'hr.training.read');
select public.seed_role_permission('head_of_legal', 'workforce.manhour.read');
select public.seed_role_permission('head_of_legal', 'attendance.view');
select public.seed_role_permission('head_of_legal', 'attendance.clock_in');
select public.seed_role_permission('head_of_legal', 'attendance.clock_out');
select public.seed_role_permission('head_of_legal', 'attendance.history');
select public.seed_role_permission('head_of_legal', 'messaging.view');
select public.seed_role_permission('head_of_legal', 'messaging.send');
select public.seed_role_permission('head_of_legal', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_legal', 'communications.announce');
select public.seed_role_permission('head_of_legal', 'sara.use');
select public.seed_role_permission('head_of_legal', 'sara.reports');
select public.seed_role_permission('head_of_legal', 'hr.leave.view');
select public.seed_role_permission('head_of_legal', 'hr.leave.request');
select public.seed_role_permission('head_of_audit', 'customers.read');
select public.seed_role_permission('head_of_audit', 'loans.read');
select public.seed_role_permission('head_of_audit', 'branches.read');
select public.seed_role_permission('head_of_audit', 'reports.read');
select public.seed_role_permission('head_of_audit', 'admin.view_audit');
select public.seed_role_permission('head_of_audit', 'hr.attendance.self');
select public.seed_role_permission('head_of_audit', 'hr.training.read');
select public.seed_role_permission('head_of_audit', 'workforce.manhour.read');
select public.seed_role_permission('head_of_audit', 'attendance.view');
select public.seed_role_permission('head_of_audit', 'attendance.clock_in');
select public.seed_role_permission('head_of_audit', 'attendance.clock_out');
select public.seed_role_permission('head_of_audit', 'attendance.history');
select public.seed_role_permission('head_of_audit', 'messaging.view');
select public.seed_role_permission('head_of_audit', 'messaging.send');
select public.seed_role_permission('head_of_audit', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_audit', 'communications.announce');
select public.seed_role_permission('head_of_audit', 'sara.use');
select public.seed_role_permission('head_of_audit', 'sara.reports');
select public.seed_role_permission('head_of_audit', 'administration.audit.view');
select public.seed_role_permission('head_of_audit', 'hr.leave.view');
select public.seed_role_permission('head_of_audit', 'hr.leave.request');
select public.seed_role_permission('loan_officer', 'customers.read');
select public.seed_role_permission('loan_officer', 'loans.read');
select public.seed_role_permission('loan_officer', 'loans.assess');
select public.seed_role_permission('loan_officer', 'loans.approve_low');
select public.seed_role_permission('loan_officer', 'loans.disburse');
select public.seed_role_permission('loan_officer', 'documents.upload');
select public.seed_role_permission('loan_officer', 'documents.read');
select public.seed_role_permission('loan_officer', 'documents.verify');
select public.seed_role_permission('loan_officer', 'support.read');
select public.seed_role_permission('loan_officer', 'hr.attendance.self');
select public.seed_role_permission('loan_officer', 'attendance.view');
select public.seed_role_permission('loan_officer', 'attendance.clock_in');
select public.seed_role_permission('loan_officer', 'attendance.clock_out');
select public.seed_role_permission('loan_officer', 'attendance.history');
select public.seed_role_permission('loan_officer', 'messaging.view');
select public.seed_role_permission('loan_officer', 'messaging.send');
select public.seed_role_permission('loan_officer', 'messaging.attachments.upload');
select public.seed_role_permission('loan_officer', 'sara.use');
select public.seed_role_permission('loan_officer', 'hr.leave.view');
select public.seed_role_permission('loan_officer', 'hr.leave.request');
select public.seed_role_permission('relationship_manager', 'customers.read');
select public.seed_role_permission('relationship_manager', 'customers.update');
select public.seed_role_permission('relationship_manager', 'loans.read');
select public.seed_role_permission('relationship_manager', 'documents.read');
select public.seed_role_permission('relationship_manager', 'support.create');
select public.seed_role_permission('relationship_manager', 'support.read');
select public.seed_role_permission('relationship_manager', 'hr.attendance.self');
select public.seed_role_permission('relationship_manager', 'attendance.view');
select public.seed_role_permission('relationship_manager', 'attendance.clock_in');
select public.seed_role_permission('relationship_manager', 'attendance.clock_out');
select public.seed_role_permission('relationship_manager', 'attendance.history');
select public.seed_role_permission('relationship_manager', 'messaging.view');
select public.seed_role_permission('relationship_manager', 'messaging.send');
select public.seed_role_permission('relationship_manager', 'messaging.attachments.upload');
select public.seed_role_permission('relationship_manager', 'sara.use');
select public.seed_role_permission('relationship_manager', 'hr.leave.view');
select public.seed_role_permission('relationship_manager', 'hr.leave.request');
select public.seed_role_permission('customer_service', 'customers.read');
select public.seed_role_permission('customer_service', 'support.create');
select public.seed_role_permission('customer_service', 'support.read');
select public.seed_role_permission('customer_service', 'support.resolve');
select public.seed_role_permission('customer_service', 'hr.attendance.self');
select public.seed_role_permission('customer_service', 'attendance.view');
select public.seed_role_permission('customer_service', 'attendance.clock_in');
select public.seed_role_permission('customer_service', 'attendance.clock_out');
select public.seed_role_permission('customer_service', 'attendance.history');
select public.seed_role_permission('customer_service', 'messaging.view');
select public.seed_role_permission('customer_service', 'messaging.send');
select public.seed_role_permission('customer_service', 'messaging.attachments.upload');
select public.seed_role_permission('customer_service', 'sara.use');
select public.seed_role_permission('customer_service', 'hr.leave.view');
select public.seed_role_permission('customer_service', 'hr.leave.request');
select public.seed_role_permission('head_of_human_resources', 'hr.jobs.create');
select public.seed_role_permission('head_of_human_resources', 'hr.jobs.manage');
select public.seed_role_permission('head_of_human_resources', 'hr.applications.read');
select public.seed_role_permission('head_of_human_resources', 'hr.applications.screen');
select public.seed_role_permission('head_of_human_resources', 'hr.assessments.create');
select public.seed_role_permission('head_of_human_resources', 'hr.interviews.schedule');
select public.seed_role_permission('head_of_human_resources', 'hr.hire');
select public.seed_role_permission('head_of_human_resources', 'hr.leave.manage');
select public.seed_role_permission('head_of_human_resources', 'hr.payroll.read');
select public.seed_role_permission('head_of_human_resources', 'hr.offer_letters.read');
select public.seed_role_permission('head_of_human_resources', 'hr.onboarding.read');
select public.seed_role_permission('head_of_human_resources', 'hr.onboarding.manage');
select public.seed_role_permission('head_of_human_resources', 'hr.employee.read');
select public.seed_role_permission('head_of_human_resources', 'hr.employee.update');
select public.seed_role_permission('head_of_human_resources', 'hr.attendance.self');
select public.seed_role_permission('head_of_human_resources', 'hr.attendance.manage');
select public.seed_role_permission('head_of_human_resources', 'hr.settings.manage');
select public.seed_role_permission('head_of_human_resources', 'payroll.manage');
select public.seed_role_permission('head_of_human_resources', 'payroll.push');
select public.seed_role_permission('head_of_human_resources', 'payroll.approve');
select public.seed_role_permission('head_of_human_resources', 'data.import.view');
select public.seed_role_permission('head_of_human_resources', 'branches.read');
select public.seed_role_permission('head_of_human_resources', 'reports.read');
select public.seed_role_permission('head_of_human_resources', 'bankone.import');
select public.seed_role_permission('head_of_human_resources', 'bankone.read');
select public.seed_role_permission('head_of_human_resources', 'reconciliation.manage');
select public.seed_role_permission('head_of_human_resources', 'reconciliation.read');
select public.seed_role_permission('head_of_human_resources', 'performance.manage');
select public.seed_role_permission('head_of_human_resources', 'performance.read');
select public.seed_role_permission('head_of_human_resources', 'appraisal.manage');
select public.seed_role_permission('head_of_human_resources', 'appraisal.read');
select public.seed_role_permission('head_of_human_resources', 'hr_config.manage');
select public.seed_role_permission('head_of_human_resources', 'work.tasks.manage');
select public.seed_role_permission('head_of_human_resources', 'work.kpis.manage');
select public.seed_role_permission('head_of_human_resources', 'work.targets.manage');
select public.seed_role_permission('head_of_human_resources', 'work.plans.manage');
select public.seed_role_permission('head_of_human_resources', 'work.reports.review');
select public.seed_role_permission('head_of_human_resources', 'work.team.performance');
select public.seed_role_permission('head_of_human_resources', 'hr.org.manage');
select public.seed_role_permission('head_of_human_resources', 'medical.read');
select public.seed_role_permission('head_of_human_resources', 'medical.manage');
select public.seed_role_permission('head_of_human_resources', 'hr.training.read');
select public.seed_role_permission('head_of_human_resources', 'hr.training.manage');
select public.seed_role_permission('head_of_human_resources', 'workforce.manhour.read');
select public.seed_role_permission('head_of_human_resources', 'attendance.terminal');
select public.seed_role_permission('head_of_human_resources', 'attendance.view');
select public.seed_role_permission('head_of_human_resources', 'attendance.clock_in');
select public.seed_role_permission('head_of_human_resources', 'attendance.clock_out');
select public.seed_role_permission('head_of_human_resources', 'attendance.history');
select public.seed_role_permission('head_of_human_resources', 'attendance.records.view');
select public.seed_role_permission('head_of_human_resources', 'attendance.records.edit');
select public.seed_role_permission('head_of_human_resources', 'attendance.records.export');
select public.seed_role_permission('head_of_human_resources', 'attendance.manage.view');
select public.seed_role_permission('head_of_human_resources', 'attendance.manage.edit');
select public.seed_role_permission('head_of_human_resources', 'attendance.audit.view');
select public.seed_role_permission('head_of_human_resources', 'attendance.bindings.view');
select public.seed_role_permission('head_of_human_resources', 'attendance.bindings.unbind');
select public.seed_role_permission('head_of_human_resources', 'attendance.devices.view');
select public.seed_role_permission('head_of_human_resources', 'attendance.devices.manage');
select public.seed_role_permission('head_of_human_resources', 'attendance.devices.unbind');
select public.seed_role_permission('head_of_human_resources', 'payroll.view');
select public.seed_role_permission('head_of_human_resources', 'payroll.salary.view');
select public.seed_role_permission('head_of_human_resources', 'payroll.salary.edit');
select public.seed_role_permission('head_of_human_resources', 'payroll.run');
select public.seed_role_permission('head_of_human_resources', 'payroll.export');
select public.seed_role_permission('head_of_human_resources', 'performance.view');
select public.seed_role_permission('head_of_human_resources', 'performance.edit');
select public.seed_role_permission('head_of_human_resources', 'performance.settings');
select public.seed_role_permission('head_of_human_resources', 'appraisal.view');
select public.seed_role_permission('head_of_human_resources', 'appraisal.edit');
select public.seed_role_permission('head_of_human_resources', 'messaging.view');
select public.seed_role_permission('head_of_human_resources', 'messaging.send');
select public.seed_role_permission('head_of_human_resources', 'messaging.attachments.upload');
select public.seed_role_permission('head_of_human_resources', 'communications.announce');
select public.seed_role_permission('head_of_human_resources', 'sara.use');
select public.seed_role_permission('head_of_human_resources', 'sara.reports');
select public.seed_role_permission('head_of_human_resources', 'administration.settings.view');
select public.seed_role_permission('head_of_human_resources', 'administration.settings.edit');
select public.seed_role_permission('head_of_human_resources', 'hr.leave.view');
select public.seed_role_permission('head_of_human_resources', 'hr.leave.request');
select public.seed_role_permission('head_of_human_resources', 'hr.leave.approve');
select public.seed_role_permission('hr_officer', 'hr.applications.read');
select public.seed_role_permission('hr_officer', 'hr.assessments.create');
select public.seed_role_permission('hr_officer', 'hr.interviews.schedule');
select public.seed_role_permission('hr_officer', 'hr.offer_letters.read');
select public.seed_role_permission('hr_officer', 'hr.onboarding.read');
select public.seed_role_permission('hr_officer', 'hr.employee.read');
select public.seed_role_permission('hr_officer', 'hr.attendance.self');
select public.seed_role_permission('hr_officer', 'hr.attendance.manage');
select public.seed_role_permission('hr_officer', 'hr.payroll.read');
select public.seed_role_permission('hr_officer', 'payroll.push');
select public.seed_role_permission('hr_officer', 'bankone.read');
select public.seed_role_permission('hr_officer', 'reconciliation.read');
select public.seed_role_permission('hr_officer', 'performance.read');
select public.seed_role_permission('hr_officer', 'appraisal.read');
select public.seed_role_permission('hr_officer', 'medical.read');
select public.seed_role_permission('hr_officer', 'hr.training.read');
select public.seed_role_permission('hr_officer', 'attendance.view');
select public.seed_role_permission('hr_officer', 'attendance.clock_in');
select public.seed_role_permission('hr_officer', 'attendance.clock_out');
select public.seed_role_permission('hr_officer', 'attendance.history');
select public.seed_role_permission('hr_officer', 'attendance.records.view');
select public.seed_role_permission('hr_officer', 'attendance.records.edit');
select public.seed_role_permission('hr_officer', 'attendance.records.export');
select public.seed_role_permission('hr_officer', 'attendance.manage.view');
select public.seed_role_permission('hr_officer', 'attendance.manage.edit');
select public.seed_role_permission('hr_officer', 'attendance.audit.view');
select public.seed_role_permission('hr_officer', 'attendance.bindings.view');
select public.seed_role_permission('hr_officer', 'attendance.bindings.unbind');
select public.seed_role_permission('hr_officer', 'payroll.view');
select public.seed_role_permission('hr_officer', 'payroll.salary.view');
select public.seed_role_permission('hr_officer', 'payroll.run');
select public.seed_role_permission('hr_officer', 'payroll.export');
select public.seed_role_permission('hr_officer', 'performance.view');
select public.seed_role_permission('hr_officer', 'appraisal.view');
select public.seed_role_permission('hr_officer', 'messaging.view');
select public.seed_role_permission('hr_officer', 'messaging.send');
select public.seed_role_permission('hr_officer', 'messaging.attachments.upload');
select public.seed_role_permission('hr_officer', 'sara.use');
select public.seed_role_permission('hr_officer', 'hr.leave.view');
select public.seed_role_permission('hr_officer', 'hr.leave.request');
select public.seed_role_permission('staff', 'customers.read');
select public.seed_role_permission('staff', 'loans.read');
select public.seed_role_permission('staff', 'documents.upload');
select public.seed_role_permission('staff', 'hr.attendance.self');
select public.seed_role_permission('staff', 'attendance.view');
select public.seed_role_permission('staff', 'attendance.clock_in');
select public.seed_role_permission('staff', 'attendance.clock_out');
select public.seed_role_permission('staff', 'attendance.history');
select public.seed_role_permission('staff', 'messaging.view');
select public.seed_role_permission('staff', 'messaging.send');
select public.seed_role_permission('staff', 'messaging.attachments.upload');
select public.seed_role_permission('staff', 'sara.use');
select public.seed_role_permission('staff', 'hr.leave.view');
select public.seed_role_permission('staff', 'hr.leave.request');
select public.seed_role_permission('customer', 'customers.read');
select public.seed_role_permission('customer', 'loans.read');
select public.seed_role_permission('customer', 'documents.upload');
select public.seed_role_permission('customer', 'support.create');
select public.seed_role_permission('customer', 'support.read');
select public.seed_role_permission('customer', 'messaging.attachments.upload');
select public.seed_role_permission('customer', 'sara.use');
-- END GENERATED PRIVILEGE SEED --

-- ============================================================================
-- PART C — MANAGEMENT RPCS + DELEGATION SEEDS + ENFORCIBLE RETROFITS
-- ============================================================================
-- Spliced after the GENERATED PRIVILEGE SEED block. Continues the transaction.
--
--   8.  _write_privilege_audit      single audit writer (permission_audit +
--                                   audit_logs) for every management action.
--   9.  Management RPCs (delegation-guarded via _can_manage_permission):
--         grant_role_permission / revoke_role_permission
--         set_user_permission   / clear_user_permission
--         set_field_rule        / clear_field_rule
--         set_delegation        / revoke_delegation    (super_admin only)
--  10.  Read RPCs for the management UIs + Flutter/SARA:
--         get_permission_epoch, get_role_permission_map, get_user_permissions_map,
--         search_permissions, list_delegations, get_permission_audit,
--         get_permissions_state_for_user, list_sensitive_fields
--  11.  Delegation seed rows + Head-of-HR privilege-manager grant.
--  12.  Payroll retrofit: salary/compensation surfaces now also require the
--         granular payroll.salary.view / payroll.salary.edit permission.
--       * list_payroll_master is fully re-issued (bank columns are redacted
--         per has_field_access('employees','bank_account')).
--       * calculate_employee_salary_breakdown / get_employee_compensation /
--         preview_employee_compensation / upsert_employee_compensation are
--         guarded by renaming each existing implementation to a private
--         `_*_impl` and placing a permission-checking wrapper over it (the
--         implementation bodies stay byte-for-byte identical → zero risk).
--         Authenticated/anon EXECUTE is revoked from every `_*_impl`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 8. Single audit writer
-- ---------------------------------------------------------------------------
create or replace function public._write_privilege_audit(
  p_action text,
  p_target_type text,
  p_target_key text,
  p_target_name text,
  p_permission_key text,
  p_previous_value jsonb,
  p_new_value jsonb,
  p_scope jsonb,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_role text := public.current_role();
  v_name text;
begin
  select coalesce(full_name, email, v_actor::text) into v_name from public.profiles where id = v_actor;

  insert into public.permission_audit
    (actor_id, actor_role, actor_name, target_type, target_key, target_name,
     permission_key, action, previous_value, new_value, scope, reason)
  values
    (v_actor, v_role, v_name, p_target_type, p_target_key, p_target_name,
     p_permission_key, p_action, p_previous_value, p_new_value, p_scope, p_reason);

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    p_action, coalesce(p_target_type, 'permission'), coalesce(p_target_key, p_permission_key), v_name,
    jsonb_build_object(
      'target', jsonb_build_object('type', p_target_type, 'key', p_target_key, 'name', p_target_name),
      'permission', p_permission_key,
      'scope', p_scope,
      'before', p_previous_value,
      'after', p_new_value,
      'reason', p_reason
    )::text,
    'info'
  );
end; $$;
grant execute on function public._write_privilege_audit(text, text, text, text, text, jsonb, jsonb, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Management RPCs (delegation-guarded)
-- ---------------------------------------------------------------------------
create or replace function public.grant_role_permission(
  p_role_name text,
  p_permission_key text,
  p_reason text,
  p_scope_type text default 'global',
  p_scope_branch_id uuid default null,
  p_scope_department text default null,
  p_scope_user_ids uuid[] default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_role_id uuid;
  v_perm_id uuid;
  v_new jsonb;
begin
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if not public._can_manage_permission(p_permission_key, p_scope_type) then
    raise exception 'insufficient_permission_authority: % at scope %', p_permission_key, p_scope_type;
  end if;

  select id into v_role_id from public.roles where role_name = p_role_name;
  if v_role_id is null then raise exception 'Role not found: %', p_role_name; end if;
  select id into v_perm_id from public.permissions where permission_key = p_permission_key;
  if v_perm_id is null then raise exception 'Permission not found: %', p_permission_key; end if;

  insert into public.role_permissions
    (role_id, permission_id, scope_type, scope_branch_id, scope_department, scope_user_ids, updated_at, updated_by)
  values
    (v_role_id, v_perm_id, p_scope_type, p_scope_branch_id, p_scope_department,
     coalesce(p_scope_user_ids, '{}'), now(), auth.uid())
  on conflict on constraint role_permissions_role_id_permission_id_key
  do update set
    scope_type = excluded.scope_type,
    scope_branch_id = excluded.scope_branch_id,
    scope_department = excluded.scope_department,
    scope_user_ids = excluded.scope_user_ids,
    updated_at = now(),
    updated_by = auth.uid();

  v_new := jsonb_build_object(
    'role', p_role_name,
    'permission', p_permission_key,
    'scope', jsonb_build_object(
      'type', p_scope_type,
      'branch_id', p_scope_branch_id,
      'department', p_scope_department,
      'user_ids', p_scope_user_ids
    )
  );

  perform public._write_privilege_audit('ROLE_PERMISSION_GRANTED', 'role', p_role_name, null,
    p_permission_key, null, v_new, v_new -> 'scope', p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.grant_role_permission(text, text, text, text, uuid, text, uuid[]) to authenticated;

create or replace function public.revoke_role_permission(
  p_role_name text,
  p_permission_key text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb;
begin
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if not public._can_manage_permission(p_permission_key, 'global') then
    raise exception 'insufficient_permission_authority: %', p_permission_key;
  end if;

  select jsonb_build_object(
    'permission', p_permission_key,
    'scope', jsonb_build_object(
      'type', rp.scope_type,
      'branch_id', rp.scope_branch_id,
      'department', rp.scope_department,
      'user_ids', rp.scope_user_ids
    )
  ) into v_prev
  from public.role_permissions rp
  join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id
  where r.role_name = p_role_name and p.permission_key = p_permission_key;

  if v_prev is null then
    raise exception 'This permission is not currently assigned to role %', p_role_name;
  end if;

  delete from public.role_permissions rp
  using public.roles r, public.permissions p
  where rp.role_id = r.id and rp.permission_id = p.id
    and r.role_name = p_role_name and p.permission_key = p_permission_key;

  perform public._write_privilege_audit('ROLE_PERMISSION_REVOKED', 'role', p_role_name, null,
    p_permission_key, v_prev, null, v_prev -> 'scope', p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.revoke_role_permission(text, text, text) to authenticated;

create or replace function public.set_user_permission(
  p_user_id uuid,
  p_permission_key text,
  p_effect text,
  p_reason text,
  p_scope_type text default 'global',
  p_scope_branch_id uuid default null,
  p_scope_department text default null,
  p_scope_user_ids uuid[] default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_target_role text;
  v_new jsonb;
begin
  if p_effect not in ('allow', 'deny') then
    raise exception 'Effect must be ''allow'' or ''deny''';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if p_user_id = auth.uid() and p_effect = 'deny' then
    raise exception 'Cannot deny your own access';
  end if;
  select role into v_target_role from public.profiles where id = p_user_id;
  if v_target_role = 'super_admin' then
    raise exception 'Cannot override a super_admin account';
  end if;
  if v_target_role is null then
    raise exception 'User has no profile record';
  end if;
  if not public._can_manage_permission(p_permission_key, p_scope_type) then
    raise exception 'insufficient_permission_authority: % at scope %', p_permission_key, p_scope_type;
  end if;
  if not exists (select 1 from public.permissions where permission_key = p_permission_key) then
    raise exception 'Permission not found: %', p_permission_key;
  end if;

  insert into public.user_permissions
    (user_id, permission_key, effect, scope_type, scope_branch_id, scope_department,
     scope_user_ids, granted_by, granted_at, granted_reason, source)
  values
    (p_user_id, p_permission_key, p_effect, p_scope_type, p_scope_branch_id, p_scope_department,
     coalesce(p_scope_user_ids, '{}'), auth.uid(), now(), p_reason, 'web')
  on conflict (user_id, permission_key)
  do update set
    effect = excluded.effect,
    scope_type = excluded.scope_type,
    scope_branch_id = excluded.scope_branch_id,
    scope_department = excluded.scope_department,
    scope_user_ids = excluded.scope_user_ids,
    granted_by = excluded.granted_by,
    granted_at = now(),
    granted_reason = excluded.granted_reason,
    source = 'web';

  v_new := jsonb_build_object(
    'user_id', p_user_id,
    'permission', p_permission_key,
    'effect', p_effect,
    'scope', jsonb_build_object(
      'type', p_scope_type,
      'branch_id', p_scope_branch_id,
      'department', p_scope_department,
      'user_ids', p_scope_user_ids
    )
  );

  perform public._write_privilege_audit('USER_PERMISSION_SET', 'user', p_user_id::text, null,
    p_permission_key, null, v_new, v_new -> 'scope', p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.set_user_permission(uuid, text, text, text, text, uuid, text, uuid[]) to authenticated;

create or replace function public.clear_user_permission(
  p_user_id uuid,
  p_permission_key text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb;
begin
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if not public._can_manage_permission(p_permission_key, 'global') then
    raise exception 'insufficient_permission_authority: %', p_permission_key;
  end if;

  select jsonb_build_object(
    'permission', permission_key, 'effect', effect,
    'scope', jsonb_build_object('type', scope_type, 'branch_id', scope_branch_id,
      'department', scope_department, 'user_ids', scope_user_ids)
  ) into v_prev
  from public.user_permissions
  where user_id = p_user_id and permission_key = p_permission_key;

  if v_prev is null then
    raise exception 'No override currently exists for % on this user', p_permission_key;
  end if;

  delete from public.user_permissions
  where user_id = p_user_id and permission_key = p_permission_key;

  perform public._write_privilege_audit('USER_PERMISSION_CLEARED', 'user', p_user_id::text, null,
    p_permission_key, v_prev, null, v_prev -> 'scope', p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.clear_user_permission(uuid, text, text) to authenticated;

create or replace function public.set_field_rule(
  p_target_type text,
  p_target_key text,
  p_table_name text,
  p_column_name text,
  p_effect text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_new jsonb;
begin
  if p_target_type not in ('role', 'user') then
    raise exception 'Target type must be ''role'' or ''user''';
  end if;
  if p_effect not in ('show', 'hide') then
    raise exception 'Effect must be ''show'' or ''hide''';
  end if;
  if p_table_name !~ '^[a-z0-9_]+$' or p_column_name !~ '^[a-z0-9_]+$' then
    raise exception 'Table/column names may only contain lowercase letters, digits and underscores';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if not public._can_manage_permission('administration.privileges.manage', 'global') then
    raise exception 'insufficient_permission_authority: field rules';
  end if;

  insert into public.permission_field_rules
    (target_type, target_key, table_name, column_name, effect, granted_by, granted_at, granted_reason, source)
  values
    (p_target_type, p_target_key, p_table_name, p_column_name, p_effect, auth.uid(), now(), p_reason, 'web')
  on conflict (target_type, target_key, table_name, column_name)
  do update set
    effect = excluded.effect,
    granted_by = excluded.granted_by,
    granted_at = now(),
    granted_reason = excluded.granted_reason,
    source = 'web';

  v_new := jsonb_build_object(
    'target_type', p_target_type, 'target_key', p_target_key,
    'table', p_table_name, 'column', p_column_name, 'effect', p_effect
  );

  perform public._write_privilege_audit('FIELD_RULE_SET', p_target_type, p_target_key, null,
    null, null, v_new, null, p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.set_field_rule(text, text, text, text, text, text) to authenticated;

create or replace function public.clear_field_rule(
  p_target_type text,
  p_target_key text,
  p_table_name text,
  p_column_name text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb;
begin
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if not public._can_manage_permission('administration.privileges.manage', 'global') then
    raise exception 'insufficient_permission_authority: field rules';
  end if;

  select jsonb_build_object(
    'target_type', target_type, 'target_key', target_key,
    'table', table_name, 'column', column_name, 'effect', effect
  ) into v_prev
  from public.permission_field_rules
  where target_type = p_target_type and target_key = p_target_key
    and table_name = p_table_name and column_name = p_column_name;

  if v_prev is null then
    raise exception 'No field rule currently exists for %.%', p_table_name, p_column_name;
  end if;

  delete from public.permission_field_rules
  where target_type = p_target_type and target_key = p_target_key
    and table_name = p_table_name and column_name = p_column_name;

  perform public._write_privilege_audit('FIELD_RULE_CLEARED', p_target_type, p_target_key, null,
    null, v_prev, null, null, p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.clear_field_rule(text, text, text, text, text) to authenticated;

create or replace function public.set_delegation(
  p_grantee_type text,
  p_grantee_key text,
  p_module text,
  p_max_scope text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_new jsonb;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only super_admin may configure delegations';
  end if;
  if p_grantee_type not in ('role', 'user') then
    raise exception 'Grantee type must be ''role'' or ''user''';
  end if;
  if p_module <> '*' and p_module !~ '^[a-z0-9_]+$' then
    raise exception 'Module must be ''*'' or a lowercase module name';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;
  if p_grantee_type = 'role' and not exists (select 1 from public.roles where role_name = p_grantee_key) then
    raise exception 'Role not found: %', p_grantee_key;
  end if;
  if p_grantee_type = 'user' and not exists (select 1 from public.profiles where id = p_grantee_key::uuid) then
    raise exception 'User not found';
  end if;

  insert into public.permission_delegation
    (grantee_type, grantee_key, module, max_scope, granted_by, granted_at, granted_reason)
  values
    (p_grantee_type, p_grantee_key, p_module, p_max_scope, auth.uid(), now(), p_reason)
  on conflict (grantee_type, grantee_key, module)
  do update set
    max_scope = excluded.max_scope,
    granted_by = excluded.granted_by,
    granted_at = now(),
    granted_reason = excluded.granted_reason;

  v_new := jsonb_build_object(
    'grantee_type', p_grantee_type, 'grantee_key', p_grantee_key,
    'module', p_module, 'max_scope', p_max_scope
  );

  perform public._write_privilege_audit('PRIVILEGE_DELEGATION_SET', p_grantee_type, p_grantee_key, null,
    p_module, null, v_new, null, p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.set_delegation(text, text, text, text, text) to authenticated;

create or replace function public.revoke_delegation(
  p_grantee_type text,
  p_grantee_key text,
  p_module text,
  p_reason text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_prev jsonb;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only super_admin may configure delegations';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;

  select jsonb_build_object(
    'grantee_type', grantee_type, 'grantee_key', grantee_key,
    'module', module, 'max_scope', max_scope
  ) into v_prev
  from public.permission_delegation
  where grantee_type = p_grantee_type and grantee_key = p_grantee_key and module = p_module;

  if v_prev is null then
    raise exception 'No delegation currently exists for % / % / %', p_grantee_type, p_grantee_key, p_module;
  end if;

  delete from public.permission_delegation
  where grantee_type = p_grantee_type and grantee_key = p_grantee_key and module = p_module;

  perform public._write_privilege_audit('PRIVILEGE_DELEGATION_REVOKED', p_grantee_type, p_grantee_key, null,
    p_module, v_prev, null, null, p_reason);
  perform public.bump_privilege_epoch();
  return true;
end; $$;
grant execute on function public.revoke_delegation(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Read RPCs (privilege manager UI + Flutter/SARA)
-- ---------------------------------------------------------------------------
create or replace function public.get_permission_epoch()
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select epoch from public.permission_version where id = 1), 1);
$$;
grant execute on function public.get_permission_epoch() to authenticated;

create or replace function public.get_role_permission_map()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if not public.is_privilege_manager() then
    raise exception 'insufficient_permissions: administration.privileges.manage';
  end if;
  select coalesce(jsonb_object_agg(x.role_name, x.perms), '{}'::jsonb) into v_out
  from (
    select r.role_name,
      coalesce(jsonb_object_agg(p.permission_key, jsonb_build_object(
        'scope_type', rp.scope_type,
        'scope_branch_id', rp.scope_branch_id,
        'scope_department', rp.scope_department,
        'scope_user_ids', rp.scope_user_ids
      )), '{}'::jsonb) as perms
    from public.roles r
    left join public.role_permissions rp on rp.role_id = r.id
    left join public.permissions p on p.id = rp.permission_id
    group by r.role_name
  ) x;
  return v_out;
end; $$;
grant execute on function public.get_role_permission_map() to authenticated;

create or replace function public.get_user_permissions_map(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if not public.is_privilege_manager() and p_user_id <> auth.uid() then
    raise exception 'insufficient_permissions: administration.privileges.manage';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', user_id, 'permission_key', permission_key, 'effect', effect,
    'scope_type', scope_type, 'scope_branch_id', scope_branch_id,
    'scope_department', scope_department, 'scope_user_ids', scope_user_ids,
    'granted_by', granted_by, 'granted_at', granted_at, 'granted_reason', granted_reason
  )), '[]'::jsonb) into v_out
  from public.user_permissions
  where user_id = p_user_id;
  return v_out;
end; $$;
grant execute on function public.get_user_permissions_map(uuid) to authenticated;

create or replace function public.search_permissions(
  p_module text default null,
  p_search text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if not public.is_privilege_manager() then
    raise exception 'insufficient_permissions: administration.privileges.manage';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'permission_key', permission_key, 'description', description, 'category', category,
    'module', module, 'resource', resource, 'action', action,
    'sensitive', sensitive, 'scope_modes', scope_modes,
    'holder_count', coalesce((select count(*) from public.role_permissions rp where rp.permission_id = p.id), 0)
  ) order by permission_key), '[]'::jsonb) into v_out
  from public.permissions p
  where (p_module is null or module = p_module)
    and (p_search is null or permission_key ilike '%' || p_search || '%'
         or description ilike '%' || p_search || '%');
  return v_out;
end; $$;
grant execute on function public.search_permissions(text, text) to authenticated;

create or replace function public.list_delegations()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if not public.is_privilege_manager() then
    raise exception 'insufficient_permissions: administration.privileges.manage';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'grantee_type', d.grantee_type, 'grantee_key', d.grantee_key,
    'module', d.module, 'max_scope', d.max_scope,
    'granted_by', d.granted_by, 'granted_at', d.granted_at, 'granted_reason', d.granted_reason,
    'grantee_name', coalesce(
      (select display_name from public.roles r where d.grantee_type = 'role' and r.role_name = d.grantee_key),
      (select coalesce(full_name, email) from public.profiles p where d.grantee_type = 'user' and p.id = d.grantee_key::uuid),
      d.grantee_key
    )
  ) order by d.grantee_type, d.grantee_key, d.module), '[]'::jsonb) into v_out
  from public.permission_delegation d;
  return v_out;
end; $$;
grant execute on function public.list_delegations() to authenticated;

create or replace function public.get_permission_audit(
  p_limit int default 200,
  p_target_type text default null,
  p_target_key text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb;
begin
  if not public.is_privilege_manager() then
    raise exception 'insufficient_permissions: administration.privileges.manage';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'actor_id', actor_id, 'actor_role', actor_role, 'actor_name', actor_name,
    'target_type', target_type, 'target_key', target_key, 'target_name', target_name,
    'permission_key', permission_key, 'action', action,
    'previous_value', previous_value, 'new_value', new_value,
    'scope', scope, 'reason', reason, 'source', source, 'created_at', created_at
  ) order by created_at desc), '[]'::jsonb) into v_out
  from (
    select *
    from public.permission_audit
    where (p_target_type is null or target_type = p_target_type)
      and (p_target_key is null or target_key = p_target_key)
    order by created_at desc
    limit least(coalesce(p_limit, 200), 1000)
  ) q;
  return v_out;
end; $$;
grant execute on function public.get_permission_audit(int, text, text) to authenticated;

-- Full effective document for ONE user (the admin "Effective Access" viewer).
create or replace function public.get_permissions_state_for_user(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
  v_epoch bigint;
  v_allowed jsonb;
  v_denied jsonb;
  v_fields jsonb;
  v_modules text[];
begin
  if not public.is_privilege_manager() then
    raise exception 'insufficient_permissions: administration.privileges.manage';
  end if;
  v_role := coalesce((select role from public.profiles where id = p_user_id), 'staff');
  select coalesce((select epoch from public.permission_version where id = 1), 1) into v_epoch;
  select out_allowed, out_denied into v_allowed, v_denied from public._effective_maps(p_user_id);
  select array_agg(m order by m) into v_modules
  from (select distinct split_part(k, '.', 1) as m from jsonb_object_keys(v_allowed) k) t;
  v_fields := public._effective_fields(p_user_id);
  return jsonb_build_object(
    'user_id', p_user_id,
    'epoch', v_epoch,
    'role', v_role,
    'is_super_user', (v_role = 'super_admin'),
    'allowed', v_allowed,
    'denied', v_denied,
    'fields', v_fields,
    'modules', coalesce(v_modules, '{}'::text[])
  );
end; $$;
grant execute on function public.get_permissions_state_for_user(uuid) to authenticated;

-- Static catalogue guiding the Field Rules UI. Sensitive columns live in the
-- payroll.salary.* / employees.* sensitive catalog keys; this list is the
-- column-level vocabulary the builder offers.
create or replace function public.list_sensitive_fields()
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_privilege_manager() then
    '[
      {"table":"employees","column":"salary","label":"Basic salary"},
      {"table":"employees","column":"allowances","label":"Allowances aggregate"},
      {"table":"employees","column":"account_number","label":"Bank account number"},
      {"table":"employees","column":"account_name","label":"Bank account name"},
      {"table":"employees","column":"bank_name","label":"Bank name"},
      {"table":"employees","column":"bank_sort_code","label":"Bank sort code"},
      {"table":"employees","column":"bvn","label":"BVN"},
      {"table":"employees","column":"nin","label":"National ID (NIN)"},
      {"table":"customers","column":"account_number","label":"Customer account number"},
      {"table":"customers","column":"bvn","label":"Customer BVN"}
    ]'::jsonb
  else
    '[]'::jsonb
  end;
$$;
grant execute on function public.list_sensitive_fields() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Delegation seeds + Head-of-HR privilege-manager grant
-- ---------------------------------------------------------------------------
select public.seed_role_permission('head_of_human_resources', 'administration.privileges.manage');

insert into public.permission_delegation
  (grantee_type, grantee_key, module, max_scope, granted_by, granted_reason)
values
  ('role', 'super_admin', '*', 'global', null, 'System bootstrap: super_admin may manage every module at global scope'),
  ('role', 'admin', '*', 'global', null, 'System bootstrap: admin may manage every module at global scope'),
  ('role', 'head_of_human_resources', 'attendance', 'global', null, 'HR delegation: attendance'),
  ('role', 'head_of_human_resources', 'appraisal', 'global', null, 'HR delegation: appraisals'),
  ('role', 'head_of_human_resources', 'communications', 'global', null, 'HR delegation: communications'),
  ('role', 'head_of_human_resources', 'hr', 'global', null, 'HR delegation: HR core'),
  ('role', 'head_of_human_resources', 'hr_config', 'global', null, 'HR delegation: HR configuration'),
  ('role', 'head_of_human_resources', 'medical', 'global', null, 'HR delegation: medical screening'),
  ('role', 'head_of_human_resources', 'messaging', 'global', null, 'HR delegation: messaging'),
  ('role', 'head_of_human_resources', 'payroll', 'global', null, 'HR delegation: payroll'),
  ('role', 'head_of_human_resources', 'performance', 'global', null, 'HR delegation: performance'),
  ('role', 'head_of_human_resources', 'reports', 'global', null, 'HR delegation: reports'),
  ('role', 'head_of_human_resources', 'sara', 'global', null, 'HR delegation: SARA'),
  ('role', 'head_of_human_resources', 'work', 'global', null, 'HR delegation: work & KPIs'),
  ('role', 'head_of_human_resources', 'workforce', 'global', null, 'HR delegation: workforce intelligence')
on conflict (grantee_type, grantee_key, module) do nothing;

-- ---------------------------------------------------------------------------
-- 12. Payroll retrofit — granular enforcement on salary/compensation surfaces
-- ---------------------------------------------------------------------------
-- (a) list_payroll_master — full re-issue: role gate UNCHANGED, granular
--     require + bank-column redaction for actors without field access.
-- ---------------------------------------------------------------------------
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
  gross numeric,
  deductions_total numeric,
  tax_paye numeric,
  pension numeric,
  other_deductions numeric,
  net numeric,
  mid_month numeric,
  end_month numeric,
  has_compensation boolean,
  employment_status text,
  effective_date date,
  bankone_employee_number text,
  payroll_eligible boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_ratio numeric := 0.5;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to view the payroll master';
  end if;
  perform public.require_permission('payroll.salary.view');

  select coalesce((config ->> 'mid_month_ratio')::numeric, 0.5) into v_ratio
  from public.payroll_config where id = 1;

  return query
  with comp as (
    select
      p.employee_id,
      coalesce(sum(case when p.snapshot ->> 'component_type' = 'allowance' then p.amount else 0 end), 0) as allowances,
      coalesce(sum(case when p.snapshot ->> 'component_type' <> 'allowance' then p.amount else 0 end), 0) as component_deductions,
      bool_or(p.active) as has_packages
    from public.employee_salary_packages p
    where p.active
    group by p.employee_id
  ),
  snap as (
    select distinct on (s.employee_id)
      s.employee_id, s.basic_monthly, s.allowances_total, s.gross_monthly,
      s.deductions_total, s.tax_paye, s.pension, s.other_deductions,
      s.net_monthly, s.mid_month, s.end_month
    from public.employee_salary_snapshots s
    where s.period_label = 'CURRENT'
    order by s.employee_id, s.calc_timestamp desc
  )
  select
    e.id,
    e.full_name,
    coalesce(e.employee_code, e.employee_number, e.staff_id),
    e.department, e.position, e.branch,
    case when public.has_field_access('employees', 'bank_account') then e.bank_name else null end as bank_name,
    case when public.has_field_access('employees', 'bank_account') then e.account_name else null end as account_name,
    case when public.has_field_access('employees', 'bank_account') then e.account_number else null end as account_number,
    case when public.has_field_access('employees', 'bank_account') then e.bank_sort_code else null end as bank_sort_code,
    coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) as salary,
    coalesce(sn.allowances_total, c.allowances, e.allowances, 0) as allowances,
    coalesce(e.payroll_gross_override, sn.gross_monthly,
      coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0)) as gross,
    coalesce(sn.deductions_total,
      coalesce(sn.tax_paye, 0) + coalesce(sn.pension, 0) + coalesce(sn.other_deductions, 0) + coalesce(c.component_deductions, 0)) as deductions_total,
    coalesce(sn.tax_paye, 0) as tax_paye,
    coalesce(sn.pension, 0) as pension,
    coalesce(sn.other_deductions, 0) as other_deductions,
    coalesce(e.payroll_net_override, sn.net_monthly,
      greatest(0, coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) as net,
    coalesce(e.payroll_mid_override, sn.mid_month,
      round(greatest(0, coalesce(e.payroll_net_override, sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2)) as mid_month,
    coalesce(e.payroll_end_override, sn.end_month,
      greatest(0, coalesce(e.payroll_net_override, sn.net_monthly,
        coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
        - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))
        - round(greatest(0, coalesce(sn.net_monthly,
          coalesce(sn.gross_monthly, coalesce(e.salary, e.basic_salary, 0) + coalesce(c.allowances, 0))
          - coalesce(sn.tax_paye, 0) - coalesce(sn.pension, 0) - coalesce(sn.other_deductions, 0) - coalesce(c.component_deductions, 0))) * v_ratio, 2))) as end_month,
    (coalesce(sn.basic_monthly, e.salary, e.basic_salary, 0) > 0
     or coalesce(c.has_packages, false)
     or coalesce(c.allowances, 0) > 0) as has_compensation,
    e.employment_status,
    e.hire_date,
    bi.bankone_employee_number,
    (e.employment_status = 'active' and e.account_number is not null and e.bank_name is not null)
  from public.employees e
  left join comp c on c.employee_id = e.id
  left join snap sn on sn.employee_id = e.id
  left join public.employee_bankone_identifiers bi on bi.employee_id = e.id
  where e.employment_status in ('active', 'probation', 'on_leave')
  order by e.full_name;
end; $$;

grant execute on function public.list_payroll_master() to authenticated;

-- ---------------------------------------------------------------------------
-- (b) Rename-and-wrap guard for the four read/derive + write compensation
--     surfaces. The implementation bodies are untouched (renamed to `_*_impl`)
--     and authenticated EXECUTE is revoked from them so the guarded wrappers
--     are the only callable path. The renames are guarded so a re-run skips an
--     impl that already exists (the guarded wrapper is independently (re)issued
--     below via `create or replace`) — keeping the migration idempotent.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_calculate_employee_salary_breakdown_impl'
  ) then
    alter function public.calculate_employee_salary_breakdown(uuid, text) rename to _calculate_employee_salary_breakdown_impl;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_get_employee_compensation_impl'
  ) then
    alter function public.get_employee_compensation(uuid) rename to _get_employee_compensation_impl;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_preview_employee_compensation_impl'
  ) then
    alter function public.preview_employee_compensation(uuid, numeric, jsonb, jsonb) rename to _preview_employee_compensation_impl;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '_upsert_employee_compensation_impl'
  ) then
    alter function public.upsert_employee_compensation(uuid, numeric, jsonb, jsonb, text, text, text, numeric, numeric, numeric, numeric) rename to _upsert_employee_compensation_impl;
  end if;
end
$$;

revoke execute on function public._calculate_employee_salary_breakdown_impl(uuid, text) from public, authenticated;
revoke execute on function public._get_employee_compensation_impl(uuid) from public, authenticated;
revoke execute on function public._preview_employee_compensation_impl(uuid, numeric, jsonb, jsonb) from public, authenticated;
revoke execute on function public._upsert_employee_compensation_impl(uuid, numeric, jsonb, jsonb, text, text, text, numeric, numeric, numeric, numeric) from public, authenticated;

-- (b1) calculate_employee_salary_breakdown — derive + persist the CURRENT
--      snapshot. Needs salary view OR edit (view OR edit because the
--      SalaryStructure viewer computes snapshots without editing).
create or replace function public.calculate_employee_salary_breakdown(p_employee_id uuid, p_period_label text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (public.has_permission('payroll.salary.view') or public.has_permission('payroll.salary.edit')) then
    raise exception 'insufficient_permissions: payroll.salary.view';
  end if;
  return public._calculate_employee_salary_breakdown_impl(p_employee_id, p_period_label);
end; $$;
grant execute on function public.calculate_employee_salary_breakdown(uuid, text) to authenticated;

-- (b2) get_employee_compensation — read-only salary bundle.
create or replace function public.get_employee_compensation(p_employee_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_permission('payroll.salary.view');
  return public._get_employee_compensation_impl(p_employee_id);
end; $$;
grant execute on function public.get_employee_compensation(uuid) to authenticated;

-- (b3) preview_employee_compensation — derived-totals preview, no writes.
create or replace function public.preview_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (public.has_permission('payroll.salary.view') or public.has_permission('payroll.salary.edit')) then
    raise exception 'insufficient_permissions: payroll.salary.view';
  end if;
  return public._preview_employee_compensation_impl(p_employee_id, p_basic, p_allowances, p_deductions);
end; $$;
grant execute on function public.preview_employee_compensation(uuid, numeric, jsonb, jsonb) to authenticated;

-- (b4) upsert_employee_compensation (canonical Phase 66 signature) — WRITE.
--      Legacy role gate preserved (super_admin / head_of_human_resources /
--      hr_officer) AND granular edit-or-view (the granular layer can only
--      ADD restrictions — a trusted role's existing edit path is preserved,
--      while an explicit deny now blocks the write).
create or replace function public.upsert_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb,
  p_reason text,
  p_signature text default null,
  p_ip_address text default null,
  p_gross_override numeric default null,
  p_net_override numeric default null,
  p_mid_override numeric default null,
  p_end_override numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role() not in ('super_admin', 'head_of_human_resources', 'hr_officer') then
    raise exception 'Not authorized to edit employee compensation';
  end if;
  if not (public.has_permission('payroll.salary.edit') or public.has_permission('payroll.salary.view')) then
    raise exception 'insufficient_permissions: payroll.salary.edit';
  end if;
  return public._upsert_employee_compensation_impl(
    p_employee_id, p_basic, p_allowances, p_deductions, p_reason,
    p_signature, p_ip_address, p_gross_override, p_net_override, p_mid_override, p_end_override);
end; $$;
grant execute on function public.upsert_employee_compensation(uuid, numeric, jsonb, jsonb, text, text, text, numeric, numeric, numeric, numeric) to authenticated;

-- (b5) Legacy 5-arg upsert overload — preserved verbatim behaviour (allows
--      admin) with the granular guard added, delegating to the canonical impl.
create or replace function public.upsert_employee_compensation(
  p_employee_id uuid,
  p_basic numeric,
  p_allowances jsonb,
  p_deductions jsonb,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_emp public.employees;
  v_entry jsonb;
  v_comp_id uuid;
  v_comp_name text;
  v_amount numeric;
  v_actor text;
  v_before_deductions numeric := 0;
  v_before_allowances numeric := 0;
  v_before_net numeric;
  v_result jsonb;
  v_component public.payroll_salary_components;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_role not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to edit employee compensation';
  end if;
  if not (public.has_permission('payroll.salary.edit') or public.has_permission('payroll.salary.view')) then
    raise exception 'insufficient_permissions: payroll.salary.edit';
  end if;
  if coalesce(btrim(p_reason), '') = '' or length(btrim(p_reason)) < 5 then
    raise exception 'A reason is required (at least 5 characters)';
  end if;

  select coalesce(full_name, email, auth.uid()::text) into v_actor from public.profiles where id = auth.uid();
  select * into v_emp from public.employees where id = p_employee_id;
  if v_emp.id is null then raise exception 'Employee not found'; end if;

  select coalesce(sum(amount), 0) into v_before_allowances
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance';
  select coalesce(sum(amount), 0) into v_before_deductions
  from public.employee_salary_packages
  where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'deduction';
  select net_monthly into v_before_net
  from public.employee_salary_snapshots
  where employee_id = p_employee_id and period_label = 'CURRENT'
  order by calc_timestamp desc limit 1;

  update public.employees set salary = coalesce(p_basic, 0) where id = p_employee_id;

  for v_entry in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'allowance' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'allowance', 'fixed', null, true, true, 'both',
              coalesce(nullif(v_entry ->> 'category', ''), 'other'), true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  for v_entry in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_comp_name := nullif(btrim(coalesce(v_entry ->> 'name', '')), '');
    v_amount := coalesce((v_entry ->> 'amount')::numeric, 0);
    v_comp_id := null;

    if coalesce(v_entry ->> 'component_id', '') ~ v_uuid_re then
      select * into v_component from public.payroll_salary_components
        where id = (v_entry ->> 'component_id')::uuid limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
        v_comp_name := coalesce(v_comp_name, v_component.name);
      end if;
    end if;
    if v_comp_id is null and v_comp_name is not null then
      select * into v_component from public.payroll_salary_components
        where name = v_comp_name and component_type = 'deduction' limit 1;
      if v_component.id is not null then
        v_comp_id := v_component.id;
      end if;
    end if;
    if v_comp_id is null then
      if v_comp_name is null then
        continue;
      end if;
      insert into public.payroll_salary_components
        (name, component_type, basis, rate, taxable, recurring, payment_schedule, category, active, created_by)
      values (v_comp_name, 'deduction', 'fixed', null, false, true, 'both', 'other', true, auth.uid())
      returning * into v_component;
      v_comp_id := v_component.id;
    end if;

    if v_amount <= 0 then
      update public.employee_salary_packages set active = false
      where employee_id = p_employee_id and component_id = v_comp_id;
    else
      insert into public.employee_salary_packages
        (employee_id, component_id, amount, rate, snapshot, active, created_by)
      values (p_employee_id, v_comp_id, round(v_amount, 2), 0, to_jsonb(v_component), true, auth.uid())
      on conflict (employee_id, component_id)
      do update set amount = excluded.amount, rate = excluded.rate,
                    snapshot = excluded.snapshot, active = true, effective_date = current_date;
    end if;
  end loop;

  update public.employees e set allowances = coalesce(x.total, 0)
  from (
    select coalesce(sum(amount), 0) as total
    from public.employee_salary_packages
    where employee_id = p_employee_id and active and snapshot ->> 'component_type' = 'allowance'
  ) x
  where e.id = p_employee_id;

  v_result := public.calculate_employee_salary_breakdown(p_employee_id, 'CURRENT');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_COMPENSATION_UPDATED', 'Employee', p_employee_id::text, v_actor,
    jsonb_build_object(
      'reason', p_reason,
      'before', jsonb_build_object(
        'basic_monthly', coalesce(v_emp.salary, 0),
        'allowances', v_before_allowances,
        'component_deductions', v_before_deductions,
        'net_monthly', coalesce(v_before_net, 0)
      ),
      'after', v_result -> 'breakdown'
    )::text,
    'info'
  );

  return v_result;
end; $$;
grant execute on function public.upsert_employee_compensation(uuid, numeric, jsonb, jsonb, text) to authenticated;

commit;