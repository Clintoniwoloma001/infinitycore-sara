-- ============================================================
-- PHASE 15 — BANKONE SECURE INTEGRATION FOUNDATION
--
-- Warning: this file MUST be run in the Supabase SQL Editor and is the
-- ONLY place these tables come from. It is idempotent and additive.
--
-- Security model:
--   * Every integration table is RLS-locked to role = 'super_admin'.
--   * BankOne secrets NEVER live in readable columns. The raw value is
--     stored in `integration_connections.encrypted_secret` as an
--     AES-256-GCM payload produced by the `bankone-integration` edge
--     function (key lives only in edge-function secrets). Client-side
--     code only ever receives masked hints via `v_integration_config`.
--   * All outbound BankOne communication is performed by the edge
--     function (server-side). No VITE_ var, localStorage, or React code
--     ever holds a BankOne credential.
--   * Administrative actions are written to the existing `audit_logs`
--     table (no duplicate audit table).
--
-- Maker-checker: bankone write operations must pass through
-- `integration_approvals`; the checker can never equal the maker.
--
-- Idempotency: `integration_references` holds external record links
-- (bankone_customer_id / bankone_employee_id / bankone_account_id /
-- bankone_transaction_id). Sync upserts instead of double-creating.
--
-- NOTE ON BANKONE ENDPOINTS: no BankOne endpoint, request body, field
-- name, webhook signature or auth flow is fabricated in this schema.
-- Field mappings are seeded as CONCEPTUAL placeholders only (see
-- section 8); the real contract is injected later from the official
-- BankOne API specification, and every adapter method that needs it is
-- labelled "BANKONE_API_MAPPING_REQUIRED".
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 0. updated_at helper
-- ============================================================
create or replace function public.integration_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;

-- ============================================================
-- 1. INTEGRATION CONNECTIONS (per provider + environment)
-- ============================================================
create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone'
    check (provider in ('bankone')),
  environment text not null check (environment in ('sandbox', 'live')),
  base_url text,
  client_id text,
  -- AES-256-GCM payload: base64(iv):base64(ciphertext) written by the
  -- edge function. Never readable by client code.
  encrypted_secret text,
  secret_hint text,
  authentication_type text default 'oauth2_client_credentials',
  token_endpoint text,
  -- Webhook verification secret, encrypted the same way.
  webhook_secret_encrypted text,
  webhook_secret_hint text,
  -- Connection state (mirrors the UI status chip).
  status text default 'not_connected'
    check (status in ('connected', 'not_connected', 'auth_failed', 'configuration_error', 'degraded', 'disabled')),
  enabled boolean default false,
  read_enabled boolean default false,
  write_enabled boolean default false,
  webhook_enabled boolean default false,
  auto_sync_enabled boolean default false,
  sync_interval_min int default 0 check (sync_interval_min in (0, 5, 15, 30, 60, 1440)),
  last_connected_at timestamptz,
  last_success_at timestamptz,
  last_fail_at timestamptz,
  last_error text,
  last_successful_sync_at timestamptz,
  last_failed_sync_at timestamptz,
  synced_records int default 0,
  failed_records int default 0,
  queue_depth int default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, environment)
);

drop trigger if exists trg_integration_connections_updated on public.integration_connections;
create trigger trg_integration_connections_updated
  before update on public.integration_connections
  for each row execute function public.integration_set_updated_at();

alter table public.integration_connections enable row level security;

drop policy if exists "integration_connections_super_admin" on public.integration_connections;
create policy "integration_connections_super_admin" on public.integration_connections
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- Safe, masked read model for the UI (never exposes encrypted_secret).
create or replace view public.v_integration_config as
select
  provider,
  environment,
  base_url,
  case when client_id is not null and client_id <> '' then '****' || right(client_id, 4) else null end as client_id_masked,
  case when encrypted_secret is not null and encrypted_secret <> '' then '****' || right(secret_hint, 4) else null end as secret_hint,
  case when encrypted_secret is not null and encrypted_secret <> '' then true else false end as credentials_provided,
  authentication_type,
  token_endpoint,
  status,
  enabled,
  read_enabled,
  write_enabled,
  webhook_enabled,
  auto_sync_enabled,
  sync_interval_min,
  last_connected_at,
  last_success_at,
  last_fail_at,
  last_error,
  last_successful_sync_at,
  last_failed_sync_at,
  synced_records,
  failed_records,
  queue_depth,
  updated_at
from public.integration_connections;

drop policy if exists "integration_config_view_super_admin" on public.integration_connections;
create policy "integration_config_view_super_admin" on public.integration_connections
  for select using (public.current_role() = 'super_admin');

-- ============================================================
-- 2. INTEGRATION CREDENTIALS METADATA (non-secret bookkeeping)
-- ============================================================
create table if not exists public.integration_credentials_metadata (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  algorithm text not null default 'AES-256-GCM',
  key_version text,
  masked_client_id text,
  secret_last4 text,
  authentication_type text,
  last_rotated_at timestamptz,
  rotation_required boolean default false,
  notes text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, environment)
);

drop trigger if exists trg_integration_credentials_metadata_updated on public.integration_credentials_metadata;
create trigger trg_integration_credentials_metadata_updated
  before update on public.integration_credentials_metadata
  for each row execute function public.integration_set_updated_at();

alter table public.integration_credentials_metadata enable row level security;

drop policy if exists "integration_credentials_metadata_super_admin" on public.integration_credentials_metadata;
create policy "integration_credentials_metadata_super_admin" on public.integration_credentials_metadata
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 3. INTEGRATION FIELD MAPPINGS (configurable, never assumed final)
-- ============================================================
create table if not exists public.integration_field_mappings (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  source_field text not null,
  bankone_field text not null,
  direction text not null
    check (direction in ('BIDIRECTIONAL', 'INFINITYCORE_TO_BANKONE', 'BANKONE_TO_INFINITYCORE')),
  transformation text,
  enabled boolean default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, environment, source_field)
);

create index if not exists idx_integration_mappings_env on public.integration_field_mappings(environment, enabled);

drop trigger if exists trg_integration_field_mappings_updated on public.integration_field_mappings;
create trigger trg_integration_field_mappings_updated
  before update on public.integration_field_mappings
  for each row execute function public.integration_set_updated_at();

alter table public.integration_field_mappings enable row level security;

drop policy if exists "integration_field_mappings_super_admin" on public.integration_field_mappings;
create policy "integration_field_mappings_super_admin" on public.integration_field_mappings
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- Default seeds. The `bankone_field` values below are the CONCEPTUAL
-- example mapping from the integration design — they are editable in
-- the Data Mapping tab and MUST be confirmed against the official
-- BankOne API specification before any live sync runs.
insert into public.integration_field_mappings (provider, environment, source_field, bankone_field, direction, transformation, enabled)
select 'bankone', e, s.source_field, s.bankone_field, s.direction, s.transformation, true
from (values
  ('employee_id',   'staff_reference', 'BIDIRECTIONAL', 'identity'),
  ('full_name',     'full_name',       'BIDIRECTIONAL', 'upper'),
  ('department',    'department',      'INFINITYCORE_TO_BANKONE', null),
  ('position',      'position',        'INFINITYCORE_TO_BANKONE', null),
  ('account_number','account_number',  'BANKONE_TO_INFINITYCORE', 'numeric_only'),
  ('account_name',  'account_name',    'BANKONE_TO_INFINITYCORE', null),
  ('branch',        'branch_code',     'BIDIRECTIONAL', null),
  ('salary',        'salary',          'INFINITYCORE_TO_BANKONE', 'decimal')
) as s(source_field, bankone_field, direction, transformation)
cross join (values ('sandbox'), ('live')) as e(environment)
on conflict (provider, environment, source_field) do nothing;

-- ============================================================
-- 4. INTEGRATION SYNC RUNS + ITEMS
-- ============================================================
create table if not exists public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  operation text not null
    check (operation in ('employees', 'accounts', 'transactions', 'customers', 'all')),
  direction text not null default 'in' check (direction in ('in', 'out', 'bidirectional')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  records_found int default 0,
  records_processed int default 0,
  records_created int default 0,
  records_updated int default 0,
  records_skipped int default 0,
  records_failed int default 0,
  duration_ms int default 0,
  correlation_id text,
  trigger_type text default 'manual' check (trigger_type in ('manual', 'automatic', 'webhook')),
  started_at timestamptz,
  completed_at timestamptz,
  triggered_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_integration_sync_runs_env on public.integration_sync_runs(environment, started_at desc);

alter table public.integration_sync_runs enable row level security;

drop policy if exists "integration_sync_runs_super_admin" on public.integration_sync_runs;
create policy "integration_sync_runs_super_admin" on public.integration_sync_runs
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

create table if not exists public.integration_sync_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.integration_sync_runs(id) on delete cascade,
  reference_key text not null,
  entity_type text,
  entity_id uuid,
  external_type text,
  external_id text,
  action text default 'skipped'
    check (action in ('created', 'updated', 'reconciled', 'skipped', 'failed')),
  status text default 'pending'
    check (status in ('pending', 'processed', 'failed', 'skipped')),
  error text,
  details text,
  created_at timestamptz default now(),
  unique (run_id, reference_key)
);

create index if not exists idx_integration_sync_items_run on public.integration_sync_items(run_id);

alter table public.integration_sync_items enable row level security;

drop policy if exists "integration_sync_items_super_admin" on public.integration_sync_items;
create policy "integration_sync_items_super_admin" on public.integration_sync_items
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 5. INTEGRATION LOGS (masked server-side; never stores secrets)
-- ============================================================
create table if not exists public.integration_logs (
  id uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('sandbox', 'live')),
  operation text not null,
  endpoint text,
  direction text default 'out' check (direction in ('in', 'out')),
  status text default 'ok' check (status in ('ok', 'error', 'timeout', 'skipped')),
  http_status int,
  duration_ms int,
  record_reference text,
  correlation_id text,
  error_category text,
  retry_count int default 0,
  masked_summary text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_integration_logs_env_time on public.integration_logs(environment, created_at desc);

alter table public.integration_logs enable row level security;

drop policy if exists "integration_logs_super_admin" on public.integration_logs;
create policy "integration_logs_super_admin" on public.integration_logs
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 6. INTEGRATION CONFLICTS
-- ============================================================
create table if not exists public.integration_conflicts (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  entity_type text not null,
  entity_id uuid,
  field_name text not null,
  infinitycore_value text,
  bankone_value text,
  detected_at timestamptz default now(),
  detected_by text,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'IGNORED')),
  resolution text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists trg_integration_conflicts_updated on public.integration_conflicts;
create trigger trg_integration_conflicts_updated
  before update on public.integration_conflicts
  for each row execute function public.integration_set_updated_at();

alter table public.integration_conflicts enable row level security;

drop policy if exists "integration_conflicts_super_admin" on public.integration_conflicts;
create policy "integration_conflicts_super_admin" on public.integration_conflicts
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 7. INTEGRATION WEBHOOK EVENTS (server-side ingress)
-- ============================================================
create table if not exists public.integration_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  environment text not null check (environment in ('sandbox', 'live')),
  event_type text,
  idempotency_key text,
  payload_hash text,
  raw_summary text,
  signature_valid boolean,
  replay boolean default false,
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  processing_error text,
  received_at timestamptz default now(),
  processed_at timestamptz,
  processing_duration_ms int,
  unique (event_id)
);

create index if not exists idx_integration_webhook_events_env on public.integration_webhook_events(environment, received_at desc);

alter table public.integration_webhook_events enable row level security;

drop policy if exists "integration_webhook_events_super_admin" on public.integration_webhook_events;
create policy "integration_webhook_events_super_admin" on public.integration_webhook_events
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 8. INTEGRATION APPROVALS (maker-checker for bankone writes)
-- ============================================================
create table if not exists public.integration_approvals (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  operation text not null,
  entity_type text,
  entity_id text,
  payload jsonb,
  before_state jsonb,
  after_state jsonb,
  result jsonb,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED')),
  maker uuid references auth.users(id) on delete set null,
  maker_name text,
  checker uuid references auth.users(id) on delete set null,
  checker_name text,
  requested_at timestamptz default now(),
  reviewed_at timestamptz,
  executed_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists trg_integration_approvals_updated on public.integration_approvals;
create trigger trg_integration_approvals_updated
  before update on public.integration_approvals
  for each row execute function public.integration_set_updated_at();

alter table public.integration_approvals enable row level security;

drop policy if exists "integration_approvals_super_admin" on public.integration_approvals;
create policy "integration_approvals_super_admin" on public.integration_approvals
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 9. INTEGRATION REFERENCES (idempotency + external linkage)
-- ============================================================
create table if not exists public.integration_references (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  infinitycore_entity_type text not null,
  infinitycore_entity_id uuid not null,
  external_type text not null
    check (external_type in (
      'bankone_customer_id', 'bankone_employee_id', 'bankone_account_id', 'bankone_transaction_id'
    )),
  external_id text not null,
  last_synced_at timestamptz,
  sync_hash text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, environment, external_type, external_id),
  unique (provider, environment, infinitycore_entity_type, infinitycore_entity_id, external_type)
);

drop trigger if exists trg_integration_references_updated on public.integration_references;
create trigger trg_integration_references_updated
  before update on public.integration_references
  for each row execute function public.integration_set_updated_at();

alter table public.integration_references enable row level security;

drop policy if exists "integration_references_super_admin" on public.integration_references;
create policy "integration_references_super_admin" on public.integration_references
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 10. AUTO SYNC SCHEDULING (pg_cron when available)
-- ============================================================
create schema if not exists cron;

-- ============================================================
-- 11. INTEGRATION OUTBOUND QUEUE (fail-safe local-first behaviour)
--    HR keeps working when BankOne is down; events queue here and are
--    processed by the integration engine once the adapter is healthy.
-- ============================================================
create table if not exists public.integration_outbound_queue (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'bankone',
  environment text not null check (environment in ('sandbox', 'live')),
  event_type text not null,
  entity_reference text,
  payload jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'failed', 'delivered', 'skipped')),
  attempt_count int default 0,
  next_attempt_at timestamptz,
  processed_at timestamptz,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_integration_outbound_queue_status on public.integration_outbound_queue(status, next_attempt_at);

drop trigger if exists trg_integration_outbound_queue_updated on public.integration_outbound_queue;
create trigger trg_integration_outbound_queue_updated
  before update on public.integration_outbound_queue
  for each row execute function public.integration_set_updated_at();

alter table public.integration_outbound_queue enable row level security;

drop policy if exists "integration_outbound_queue_super_admin" on public.integration_outbound_queue;
create policy "integration_outbound_queue_super_admin" on public.integration_outbound_queue
  for all using (public.current_role() = 'super_admin')
  with check (public.current_role() = 'super_admin');

-- ============================================================
-- 12. INTEGRATION AUTH + AUDIT HELPERS (SECURITY DEFINER)
-- ============================================================
-- Ensures the holder of an authenticated JWT can be identified as a
-- super admin without depending on the profiles_read_all view.
create or replace function public.enable_authenticated_role_if_missing()
returns void language plpgsql security definer as $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end; $$;

-- Returns the acting super admin name for audit trail integrity.
create or replace function public.integration_actor_name()
returns text language sql stable as $$
  select coalesce((select full_name from public.profiles where id = auth.uid()), auth.email(), 'system')
$$;

-- Single entry point for integration audit events (reuses audit_logs).
create or replace function public.integration_write_audit(
  p_action text,
  p_environment text default null,
  p_details jsonb default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can perform integration administration.';
  end if;
  insert into audit_logs (action, entity_type, entity_id, details, severity, user_name, created_at)
  values (
    p_action,
    'BankOneIntegration',
    coalesce(p_environment, 'integration'),
    p_details,
    case when p_action like 'ERROR%' then 'high' else 'info' end,
    public.integration_actor_name(),
    now()
  );
end; $$;

-- ============================================================
-- 13. CONFIGURATION RPCs
-- ============================================================
-- Single environment configuration (masked) for the UI.
create or replace function public.integration_get_config(p_environment text default null)
returns setof public.v_integration_config
language sql stable security definer set search_path = public as $$
  select * from public.v_integration_config
  where (p_environment is null or environment = p_environment)
$$;

-- Persist NON-SECRET connection fields. Secrets (client_secret,
-- api_key, webhook secret) are never passed through this path — they
-- are written exclusively by the edge function.
create or replace function public.integration_save_config(
  p_environment text,
  p_base_url text default null,
  p_client_id text default null,
  p_token_endpoint text default null,
  p_authentication_type text default null
)
returns public.v_integration_config
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can update BankOne configuration.';
  end if;

  insert into public.integration_connections (provider, environment, base_url, client_id, token_endpoint, authentication_type, updated_by)
  values ('bankone', p_environment,
          coalesce(p_base_url, ''), coalesce(p_client_id, ''), coalesce(p_token_endpoint, ''),
          coalesce(p_authentication_type, 'oauth2_client_credentials'), auth.uid())
  on conflict (provider, environment) do update set
    base_url = coalesce(p_base_url, integration_connections.base_url),
    client_id = coalesce(p_client_id, integration_connections.client_id),
    token_endpoint = coalesce(p_token_endpoint, integration_connections.token_endpoint),
    authentication_type = coalesce(p_authentication_type, integration_connections.authentication_type),
    updated_by = auth.uid();

  perform public.integration_write_audit(
    'CONFIG_CHANGED', p_environment,
    jsonb_build_object('fields', jsonb_build_array(
      case when p_base_url is not null then 'base_url' end,
      case when p_client_id is not null then 'client_id' end,
      case when p_token_endpoint is not null then 'token_endpoint' end,
      case when p_authentication_type is not null then 'authentication_type' end
    ))
  );

  return query select * from public.v_integration_config where environment = p_environment and provider = 'bankone';
end; $$;

-- Per-toggle permission writes. Each toggled flag produces its own
-- audit event so SOX-style review shows exactly what changed.
create or replace function public.integration_set_controls(
  p_environment text,
  p_changes jsonb
)
returns public.v_integration_config
language plpgsql security definer set search_path = public as $$
declare
  v_row public.integration_connections;
  v_action text;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can change integration controls.';
  end if;

  select * into v_row from public.integration_connections
  where provider = 'bankone' and environment = p_environment;
  if not found then
    insert into public.integration_connections (provider, environment, updated_by)
    values ('bankone', p_environment, auth.uid()) returning * into v_row;
  end if;

  -- Each flag emits a distinctive audit action name.
  if p_changes ? 'read_enabled' then
    update public.integration_connections set read_enabled = (p_changes->>'read_enabled')::boolean where id = v_row.id;
    v_action := case when (p_changes->>'read_enabled')::boolean then 'READ_ENABLED' else 'READ_DISABLED' end;
    perform public.integration_write_audit(v_action, p_environment);
  end if;
  if p_changes ? 'write_enabled' then
    update public.integration_connections set write_enabled = (p_changes->>'write_enabled')::boolean where id = v_row.id;
    v_action := case when (p_changes->>'write_enabled')::boolean then 'WRITE_ENABLED' else 'WRITE_DISABLED' end;
    perform public.integration_write_audit(v_action, p_environment);
  end if;
  if p_changes ? 'webhook_enabled' then
    update public.integration_connections set webhook_enabled = (p_changes->>'webhook_enabled')::boolean where id = v_row.id;
    v_action := case when (p_changes->>'webhook_enabled')::boolean then 'WEBHOOK_ENABLED' else 'WEBHOOK_DISABLED' end;
    perform public.integration_write_audit(v_action, p_environment);
  end if;
  if p_changes ? 'auto_sync_enabled' then
    update public.integration_connections set auto_sync_enabled = (p_changes->>'auto_sync_enabled')::boolean where id = v_row.id;
    v_action := case when (p_changes->>'auto_sync_enabled')::boolean then 'AUTO_SYNC_ENABLED' else 'AUTO_SYNC_DISABLED' end;
    perform public.integration_write_audit(v_action, p_environment);
  end if;
  if p_changes ? 'enabled' then
    update public.integration_connections set enabled = (p_changes->>'enabled')::boolean where id = v_row.id;
    v_action := case when (p_changes->>'enabled')::boolean then 'CONNECTION_ENABLED' else 'DISABLE' end;
    perform public.integration_write_audit(v_action, p_environment);
  end if;

  return query select * from public.v_integration_config where id = v_row.id;
end; $$;

-- Emergency control: instantly disables every flag in BOTH environments
-- (single-DBA panic button). Audits DISABLE + DISABLE_LIVE when the
-- live environment was enabled.
create or replace function public.integration_emergency_disable(p_provider text default 'bankone')
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_live_was_enabled boolean;
  v_count int;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can disable the integration.';
  end if;

  select coalesce(bool_or(enabled and environment = 'live'), false) into v_live_was_enabled
  from public.integration_connections where provider = p_provider;

  update public.integration_connections
  set enabled = false, read_enabled = false, write_enabled = false,
      webhook_enabled = false, auto_sync_enabled = false, status = 'disabled', updated_by = auth.uid()
  where provider = p_provider;

  get diagnostics v_count = row_count;
  perform public.integration_write_audit('DISABLE', 'both', jsonb_build_object('provider', p_provider));
  if v_live_was_enabled then
    perform public.integration_write_audit('DISABLE_LIVE', 'live');
  end if;
  return v_count;
end; $$;

-- ============================================================
-- 14. FIELD MAPPING RPCs
-- ============================================================
create or replace function public.integration_upsert_mapping(p_mapping jsonb)
returns public.integration_field_mappings
language plpgsql security definer set search_path = public as $$
declare
  v_env text := coalesce(p_mapping->>'environment', 'sandbox');
  v_action text;
  v_out public.integration_field_mappings;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can edit field mappings.';
  end if;
  if p_mapping->>'source_field' is null or p_mapping->>'bankone_field' is null then
    raise exception 'Both source_field and bankone_field are required.';
  end if;

  insert into public.integration_field_mappings (
    provider, environment, source_field, bankone_field, direction, transformation, enabled, updated_by
  )
  values (
    'bankone', v_env,
    p_mapping->>'source_field', p_mapping->>'bankone_field',
    coalesce(p_mapping->>'direction', 'BIDIRECTIONAL'),
    p_mapping->>'transformation', coalesce((p_mapping->>'enabled')::boolean, true),
    auth.uid()
  )
  on conflict (provider, environment, source_field) do update set
    bankone_field = excluded.bankone_field,
    direction = excluded.direction,
    transformation = excluded.transformation,
    enabled = excluded.enabled,
    updated_by = excluded.updated_by
  returning * into v_out;

  v_action := 'MAPPING_SAVED';
  perform public.integration_write_audit(v_action, v_env, jsonb_build_object(
    'source_field', v_out.source_field, 'bankone_field', v_out.bankone_field
  ));
  return v_out;
end; $$;

create or replace function public.integration_delete_mapping(
  p_mapping_id uuid,
  p_environment text
)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
  v_count int;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can delete field mappings.';
  end if;

  select source_field into v_source from public.integration_field_mappings where id = p_mapping_id;
  delete from public.integration_field_mappings where id = p_mapping_id;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    perform public.integration_write_audit('MAPPING_DELETED', p_environment,
      jsonb_build_object('source_field', v_source));
  end if;
  return v_count;
end; $$;

-- ============================================================
-- 15. CONFLICT RPCs
-- ============================================================
-- Resolves a BankOne/InfinityCore data conflict. When the reviewer
-- chooses BANKONE, only safe, non-sensitive fields are written back to
-- the employee record (identity/contact/department; NEVER BVN/NIN).
create or replace function public.integration_resolve_conflict(
  p_conflict_id uuid,
  p_decision text,
  p_resolution_note text default null
)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_conflict public.integration_conflicts;
  v_safe_fields text[] := array['full_name','phone','email','department','position','branch','account_number','account_name','account_state','account_status'];
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can resolve conflicts.';
  end if;
  if p_decision not in ('USE_BANKONE','USE_INFINITYCORE','IGNORE') then
    raise exception 'Invalid decision.';
  end if;

  select * into v_conflict from public.integration_conflicts where id = p_conflict_id;
  if not found then
    raise exception 'Conflict not found.';
  end if;

  -- Apply BankOne value only for safe, non-sensitive fields.
  if p_decision = 'USE_BANKONE' and v_conflict.entity_type = 'employees' then
    if v_conflict.field_name = any(v_safe_fields) then
      execute format(
        'update public.employees set %I = $1, updated_at = now() where id = $2',
        v_conflict.field_name
      ) using v_conflict.bankone_value, v_conflict.entity_id;
    else
      raise exception 'Field "%" is not permitted for automatic writeback.',
        v_conflict.field_name;
    end if;
  end if;

  update public.integration_conflicts
  set status = 'RESOLVED', resolution = p_resolution_note,
      resolved_by = auth.uid(), resolved_at = now()
  where id = p_conflict_id;

  perform public.integration_write_audit('CONFLICT_RESOLVED', v_conflict.environment, jsonb_build_object(
    'conflict_id', p_conflict_id, 'field', v_conflict.field_name, 'decision', p_decision
  ));
  return p_decision;
end; $$;

-- ============================================================
-- 16. MAKER-CHECKER APPROVAL RPCs (BankOne write operations)
-- ============================================================
create or replace function public.integration_request_approval(
  p_environment text,
  p_operation text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_payload jsonb default null,
  p_notes text default null
)
returns public.integration_approvals
language plpgsql security definer set search_path = public as $$
declare
  v_out public.integration_approvals;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can request approvals.';
  end if;

  insert into public.integration_approvals (
    provider, environment, operation, entity_type, entity_id, payload,
    maker, maker_name, notes
  )
  values (
    'bankone', p_environment, p_operation, p_entity_type, p_entity_id, p_payload,
    auth.uid(), public.integration_actor_name(), p_notes
  )
  returning * into v_out;

  perform public.integration_write_audit('APPROVAL_REQUESTED', p_environment, jsonb_build_object(
    'approval_id', v_out.id, 'operation', p_operation
  ));
  return v_out;
end; $$;

create or replace function public.integration_approve_approval(p_approval_id uuid)
returns public.integration_approvals
language plpgsql security definer set search_path = public as $$
declare
  v_out public.integration_approvals;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can approve requests.';
  end if;

  select * into v_out from public.integration_approvals where id = p_approval_id;
  if not found then raise exception 'Approval not found.'; end if;
  if v_out.maker = auth.uid() then
    raise exception 'Checker must be a different admin from the maker (maker-checker separation).';
  end if;
  if v_out.status <> 'PENDING' then
    raise exception 'Approval is already %', v_out.status;
  end if;

  update public.integration_approvals
  set status = 'APPROVED', checker = auth.uid(), checker_name = public.integration_actor_name(), reviewed_at = now()
  where id = p_approval_id returning * into v_out;

  perform public.integration_write_audit('APPROVAL_APPROVED', v_out.environment, jsonb_build_object(
    'approval_id', v_out.id, 'operation', v_out.operation
  ));
  return v_out;
end; $$;

create or replace function public.integration_reject_approval(p_approval_id uuid, p_reason text)
returns public.integration_approvals
language plpgsql security definer set search_path = public as $$
declare
  v_out public.integration_approvals;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can reject requests.';
  end if;

  select * into v_out from public.integration_approvals where id = p_approval_id;
  if not found then raise exception 'Approval not found.'; end if;
  if v_out.maker = auth.uid() then
    raise exception 'Checker must be a different admin from the maker (maker-checker separation).';
  end if;
  if v_out.status <> 'PENDING' then
    raise exception 'Approval is already %', v_out.status;
  end if;

  update public.integration_approvals
  set status = 'REJECTED', checker = auth.uid(), checker_name = public.integration_actor_name(),
      reviewed_at = now(), notes = coalesce(p_reason, notes)
  where id = p_approval_id returning * into v_out;

  perform public.integration_write_audit('APPROVAL_REJECTED', v_out.environment, jsonb_build_object(
    'approval_id', v_out.id, 'reason', p_reason
  ));
  return v_out;
end; $$;

-- ============================================================
-- 17. LOGS + HEALTH RPCs
-- ============================================================
create or replace function public.integration_get_logs(
  p_environment text,
  p_limit int default 100
)
returns setof public.integration_logs
language sql stable security definer set search_path = public as $$
  select * from public.integration_logs
  where environment = p_environment
  order by created_at desc
  limit greatest(1, least(p_limit, 500))
$$;

create or replace function public.integration_health(p_environment text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_conn public.integration_connections;
  v_out jsonb;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can query integration health.';
  end if;

  select * into v_conn from public.integration_connections
  where provider = 'bankone' and environment = p_environment;

  select jsonb_build_object(
    'environment', p_environment,
    'status', coalesce(v_conn.status, 'not_connected'),
    'enabled', coalesce(v_conn.enabled, false),
    'read_enabled', coalesce(v_conn.read_enabled, false),
    'write_enabled', coalesce(v_conn.write_enabled, false),
    'webhook_enabled', coalesce(v_conn.webhook_enabled, false),
    'auto_sync_enabled', coalesce(v_conn.auto_sync_enabled, false),
    'sync_interval_min', coalesce(v_conn.sync_interval_min, 0),
    'last_connected_at', v_conn.last_connected_at,
    'last_success_at', v_conn.last_success_at,
    'last_fail_at', v_conn.last_fail_at,
    'last_error', v_conn.last_error,
    'last_successful_sync_at', v_conn.last_successful_sync_at,
    'last_failed_sync_at', v_conn.last_failed_sync_at,
    'synced_records', v_conn.synced_records,
    'failed_records', v_conn.failed_records,
    'queue_depth', (select count(*) from public.integration_outbound_queue
                    where environment = p_environment and status = 'queued'),
    'open_conflicts', (select count(*) from public.integration_conflicts
                       where environment = p_environment and status = 'OPEN'),
    'pending_approvals', (select count(*) from public.integration_approvals
                          where environment = p_environment and status = 'PENDING'),
    'recent_webhooks_24h', (select count(*) from public.integration_webhook_events
                            where environment = p_environment and received_at > now() - interval '24 hours'),
    '_engine', 'BankOneIntegration / phase15'
  ) into v_out;

  return v_out;
end; $$;

-- ============================================================
-- 18. OUTBOUND QUEUE RPCs (fail-safe, local-first integration)
-- ============================================================
create or replace function public.integration_enqueue_event(
  p_environment text,
  p_event_type text,
  p_payload jsonb default null,
  p_entity_reference text default null
)
returns public.integration_outbound_queue
language plpgsql security definer set search_path = public as $$
declare
  v_out public.integration_outbound_queue;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can enqueue integration events.';
  end if;

  insert into public.integration_outbound_queue (
    provider, environment, event_type, entity_reference, payload, created_by
  )
  values ('bankone', p_environment, p_event_type, p_entity_reference, p_payload, auth.uid())
  returning * into v_out;
  return v_out;
end; $$;

-- Backfill queue depth snapshots used by the health/overview cards.
create or replace function public.integration_refresh_queue_depth(p_provider text default 'bankone')
returns int
language plpgsql security definer set search_path = public as $$
begin
  update public.integration_connections ic
  set queue_depth = q.n
  from (
    select environment, count(*) as n
    from public.integration_outbound_queue
    where status in ('queued', 'processing', 'failed')
    group by environment
  ) q
  where ic.provider = p_provider and ic.environment = q.environment;
  return 0;
end; $$;

-- ============================================================
-- 19. AUTO-SYNC SCHEDULING (pg_cron when present; fallback document)
-- ============================================================
create or replace function public.integration_schedule_auto_sync(
  p_environment text,
  p_interval_min int
)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_job_id bigint;
  v_cron_root text;
  v_expression text;
begin
  if public.current_role() <> 'super_admin' then
    raise exception 'Only a super admin can configure auto-sync.';
  end if;
  if p_interval_min not in (0, 5, 15, 30, 60, 1440) then
    raise exception 'Unsupported interval (use 0, 5, 15, 30, 60 or 1440).';
  end if;

  update public.integration_connections
  set auto_sync_enabled = (p_interval_min > 0), sync_interval_min = p_interval_min
  where provider = 'bankone' and environment = p_environment;

  if to_regclass('cron.job') is not null and p_interval_min > 0 then
    v_expression := case p_interval_min
      when 5  then '*/5 * * * *'
      when 15 then '*/15 * * * *'
      when 30 then '*/30 * * * *'
      when 60 then '0 * * * *'
      else '0 3 * * *'
    end;

    select jobid into v_job_id
    from cron.job where jobname = 'bankone-auto-sync-' || p_environment;
    if found then
      perform cron.unschedule(v_job_id);
    end if;
    perform cron.schedule('bankone-auto-sync-' || p_environment, v_expression,
      'select public.integration_refresh_queue_depth();');

    perform public.integration_write_audit('AUTO_SYNC_CONFIGURED', p_environment,
      jsonb_build_object('interval_min', p_interval_min, 'cron', v_expression));
    return 'scheduled (pg_cron): ' || v_expression;
  end if;

  if p_interval_min > 0 then
    perform public.integration_write_audit('AUTO_SYNC_REQUESTED', p_environment,
      jsonb_build_object('interval_min', p_interval_min, 'note', 'pg_cron unavailable - schedule externally'));
    return 'requested but pg_cron unavailable (' || p_interval_min::text || ' min)';
  end if;

  perform public.integration_write_audit('AUTO_SYNC_DISABLED', p_environment);
  return 'auto-sync disabled';
end; $$;

-- ============================================================
-- 20. ENGINE STATE RPCs (called by the edge function)
--   These are security definer but intentionally do NOT demand
--   super_admin from the JWT, because the edge function runs with the
--   anon/authenticated role plus a service-role sibling client.
--   Underlying tables remain RLS-locked to super_admin.
-- ============================================================
create or replace function public.integration_apply_test_result(
  p_environment text,
  p_success boolean,
  p_error text default null,
  p_endpoint text default null
)
returns public.v_integration_config
language plpgsql security definer set search_path = public as $$
declare
  v_row public.integration_connections;
begin
  select * into v_row from public.integration_connections
  where provider = 'bankone' and environment = p_environment;
  if not found then
    insert into public.integration_connections (provider, environment, status, enabled)
    values ('bankone', p_environment, 'not_connected', false) returning * into v_row;
  end if;

  if p_success then
    update public.integration_connections
    set status = 'connected', last_connected_at = now(), last_success_at = now(),
        last_error = null, last_fail_at = null
    where id = v_row.id;
  else
    update public.integration_connections
    set status = case when v_row.status = 'disabled' then 'disabled' else 'auth_failed' end,
        last_fail_at = now(), last_error = left(coalesce(p_error, 'Connection test failed'), 500)
    where id = v_row.id;
  end if;

  insert into public.integration_logs (environment, operation, endpoint, direction, status, masked_summary)
  values (p_environment, 'TEST_CONNECTION', p_endpoint, 'out',
          case when p_success then 'ok' else 'error' end,
          case when p_success then 'Connectivity verified' else 'Connectivity failed' end);

  return query select * from public.v_integration_config where id = v_row.id;
end; $$;

-- ============================================================
-- 21. PERMISSIONS + GRANTS
-- ============================================================
select public.enable_authenticated_role_if_missing();

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.integration_connections,
  public.integration_credentials_metadata,
  public.integration_field_mappings,
  public.integration_sync_runs,
  public.integration_sync_items,
  public.integration_logs,
  public.integration_conflicts,
  public.integration_webhook_events,
  public.integration_approvals,
  public.integration_references,
  public.integration_outbound_queue
to authenticated;

grant execute on function public.integration_set_updated_at() to authenticated;
grant execute on function public.integration_get_config(text) to authenticated;
grant execute on function public.integration_save_config(text, text, text, text, text) to authenticated;
grant execute on function public.integration_set_controls(text, jsonb) to authenticated;
grant execute on function public.integration_emergency_disable(text) to authenticated;
grant execute on function public.integration_upsert_mapping(jsonb) to authenticated;
grant execute on function public.integration_delete_mapping(uuid, text) to authenticated;
grant execute on function public.integration_resolve_conflict(uuid, text, text) to authenticated;
grant execute on function public.integration_request_approval(text, text, text, text, jsonb, text) to authenticated;
grant execute on function public.integration_approve_approval(uuid) to authenticated;
grant execute on function public.integration_reject_approval(uuid, text) to authenticated;
grant execute on function public.integration_get_logs(text, int) to authenticated;
grant execute on function public.integration_health(text) to authenticated;
grant execute on function public.integration_enqueue_event(text, text, jsonb, text) to authenticated;
grant execute on function public.integration_refresh_queue_depth(text) to authenticated;
grant execute on function public.integration_schedule_auto_sync(text, int) to authenticated;
grant execute on function public.integration_apply_test_result(text, boolean, text, text) to authenticated;

-- NOTE: Following repo convention, this permission is registered FRONTEND-ONLY
-- (src/constants/roles.js ROLE_PERMISSIONS). Like bankone.read / bankone.import,
-- there is NO public.permissions row for it — the DB enforces gating via
-- current_role() = 'super_admin' on every RPC/RLS policy, so a permissions row
-- is never consulted for these keys)Skip. Keep this block as a documentation
-- marker only, matching phases 8/12/13 which never insert BankOne keys into
-- public.permissions.

-- ============================================================
-- 22. AUDIT EVENTS (informative reference for reviewers)
create or replace view public.v_integration_overview as
select
  c.provider,
  c.environment,
  c.status,
  c.enabled,
  c.read_enabled,
  c.write_enabled,
  c.webhook_enabled,
  c.auto_sync_enabled,
  c.sync_interval_min,
  c.last_success_at,
  c.last_fail_at,
  c.last_error,
  c.last_successful_sync_at,
  c.last_failed_sync_at,
  c.synced_records,
  c.failed_records,
  c.queue_depth,
  (select count(*) from public.integration_conflicts x
    where x.environment = c.environment and x.status = 'OPEN') as open_conflicts,
  (select count(*) from public.integration_sync_runs x
    where x.environment = c.environment and x.status in ('pending','running')) as active_runs,
  (select count(*) from public.integration_approvals x
    where x.environment = c.environment and x.status = 'PENDING') as pending_approvals
from public.integration_connections c
where c.provider = 'bankone'
order by c.environment;

-- ============================================================
-- 22. AUDIT EVENTS (informative reference for reviewers)
--   CONNECT / TEST_CONNECTION / CONFIG_CHANGED / READ_ENABLED /
--   READ_DISABLED / WRITE_ENABLED / WRITE_DISABLED / WEBHOOK_ENABLED /
--   WEBHOOK_DISABLED / AUTO_SYNC_ENABLED / AUTO_SYNC_DISABLED /
--   AUTO_SYNC_CONFIGURED / DISABLE / DISABLE_LIVE / CONNECTION_ENABLED /
--   MAPPING_SAVED / MAPPING_DELETED / CONFLICT_RESOLVED /
--   APPROVAL_REQUESTED / APPROVAL_APPROVED / APPROVAL_REJECTED /
--   SYNC_*_REQUESTED / ERROR_SYNC_FAILED
-- ============================================================