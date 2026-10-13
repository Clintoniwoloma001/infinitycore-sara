-- ============================================================================
-- ZOHO MAIL OAUTH FOUNDATION (Audit Automation)
-- ============================================================================
-- Additive + idempotent. Safe to re-run. Non-destructive.
--
-- Purpose: the secure server-side OAuth foundation for the Head of Audit's
-- Zoho Mail account (.com data center). This migration ONLY prepares storage:
--   * widens integration_connections.provider to admit 'zoho_mail'
--   * adds provider_account_id (the Zoho sending accountId, for verification)
--   * creates zoho_oauth_states — server-generated, short-lived CSRF state
--
-- It stores NO secrets in plaintext-readable columns and grants NO client
-- access. The refresh token is written AES-256-GCM encrypted by the
-- zoho-oauth-callback Edge Function (key lives only in function secrets);
-- the raw token is never inserted by this migration.
--
-- Run AFTER 20261111000004 (latest). No message is ever sent by this work.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Widen the provider CHECK to admit 'zoho_mail' (drop + re-add by the
--    auto-generated name; keeps any existing bankone/google_calendar/zoom rows).
-- ---------------------------------------------------------------------------
alter table public.integration_connections
  drop constraint if exists integration_connections_provider_check;
alter table public.integration_connections
  add constraint integration_connections_provider_check
  check (provider in ('bankone', 'google_calendar', 'zoom', 'zoho_mail'));

-- Zoho Mail needs to remember the verified sending accountId so the Head of
-- Audit can confirm WHICH mailbox would send before any send is enabled.
alter table public.integration_connections
  add column if not exists provider_account_id text;

comment on column public.integration_connections.provider_account_id is
  'Provider-specific account identifier. For zoho_mail this is the Zoho sending accountId returned by GET /api/accounts.';

-- ---------------------------------------------------------------------------
-- 2. Server-generated OAuth state store (CSRF protection, requirement 3).
--    RLS enabled with NO policies => no client access. Only the service role
--    (Edge Functions) can read/write. The callback atomically consumes a state
--    (consumed_at IS NULL AND expires_at > now()) so an invalid, expired or
--    replayed state is rejected.
-- ---------------------------------------------------------------------------
create table if not exists public.zoho_oauth_states (
  state       text primary key,
  created_by  uuid references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create index if not exists zoho_oauth_states_expires_idx
  on public.zoho_oauth_states (expires_at);

alter table public.zoho_oauth_states enable row level security;

-- Explicitly revoke from the client roles for clarity (service_role bypasses
-- RLS and is what the Edge Functions use).
revoke all on public.zoho_oauth_states from anon, authenticated;

comment on table public.zoho_oauth_states is
  'One row per issued Zoho OAuth authorize request. Short-lived, single-use CSRF state validated by zoho-oauth-callback.';

commit;
