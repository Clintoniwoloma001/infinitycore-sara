-- ============================================================================
-- ZOHO MAIL — PER-USER MULTI-MAILBOX
-- ============================================================================
-- Idempotent / additive. Replaces the SINGLE-SLOT zoho connection with one row
-- per user, so the Head of Audit AND an admin can each connect their OWN mailbox
-- without overwriting each other.
--
-- The old constraint UNIQUE(provider, environment) forced exactly ONE zoho_mail
-- row. It is split into two partial unique indexes:
--   * non-zoho providers keep their single-row guarantee (unchanged)
--   * zoho_mail becomes unique per (provider, environment, user_id)

begin;

-- 1. Drop the old global single-row constraint.
alter table public.integration_connections
  drop constraint if exists integration_connections_provider_environment_key;

-- 2. Restore the single-row guarantee for every NON-zoho provider.
create unique index if not exists uq_ic_provider_env_nonzoho
  on public.integration_connections (provider, environment)
  where provider <> 'zoho_mail';

-- 3. zoho_mail: ONE ROW PER USER (the per-user mailbox slot).
create unique index if not exists uq_ic_zoho_env_user
  on public.integration_connections (provider, environment, user_id)
  where provider = 'zoho_mail';

comment on index public.uq_ic_zoho_env_user is
  'Zoho Mail is per-user: each account may store its own mailbox connection.';

commit;
