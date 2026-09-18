-- ============================================================
-- PHASE 43 — BANKONE LIVE CHANNEL API (additive, idempotent)
--
-- Adds the server-side audit RPC used by the bankone-transaction-status
-- edge function. The edge function authenticates its caller (Supabase JWT),
-- authorizes via the existing can_manage_bankone role gate, calls the
-- documented BankOne Channel API endpoint, and records every attempt through
-- this RPC so the existing Phase 15 audit surfaces (integration_logs +
-- integration_connections + audit_logs) stay the single source of truth.
--
-- Security notes:
--   * This RPC is callable ONLY by the service-role runtime (or an actual
--     super_admin). It raises for any anonymous/authenticated caller, so an
--     arbitrary logged-in user cannot forge integration logs or connection
--     status. Secrets are never accepted by this function.
--   * Also hardens the pre-existing public.integration_apply_test_result()
--     (Phase 15) with the same gate — previously any authenticated user could
--     flip connection status / forge a connection TEST_CONNECTION log.
--   * No BankOne endpoint, request body or auth flow is fabricated here.
--
-- Run in the Supabase SQL Editor. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Harden integration_apply_test_result (Phase 15) with the
--    server-side-only gate. Signature unchanged.
-- ------------------------------------------------------------
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
  v_out public.v_integration_config;
begin
  -- Only the edge-function service runtime (or a dashboard super admin) may
  -- record a connection test outcome. This closes the Phase 15 gap where any
  -- authenticated user could forge TEST_CONNECTION logs / status.
  if auth.role() <> 'service_role' and public.current_role() <> 'super_admin' then
    raise exception 'Only the server-side integration runtime can record connection tests.';
  end if;

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

  select * into v_out from public.v_integration_config
    where provider = 'bankone' and environment = p_environment;
  return v_out;
end; $$;

-- ------------------------------------------------------------
-- 2. integration_record_provider_call — single server-side audit
--    entry point used by the edge function. Accepts only
--    non-sensitive metadata; the edge function ALWAYS passes a
--    masked_summary (never the BankOne token or PII).
-- ------------------------------------------------------------
drop function if exists public.integration_record_provider_call(text, text, text, text, text, int, int, text, text, text, text);

create or replace function public.integration_record_provider_call(
  p_environment text,
  p_operation text,
  p_endpoint text default null,
  p_direction text default 'out',
  p_status text default 'ok',
  p_http_status int default null,
  p_duration_ms int default null,
  p_correlation_id text default null,
  p_error_category text default null,
  p_masked_summary text default null,
  p_record_reference text default null,
  p_created_by uuid default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Server-side runtime only. p_masked_summary is a redacted string by
  -- construction; this guard is the second line of defence.
  if auth.role() <> 'service_role' and public.current_role() <> 'super_admin' then
    raise exception 'Only the server-side integration runtime can record provider calls.';
  end if;

  insert into public.integration_logs (
    environment, operation, endpoint, direction, status, http_status,
    duration_ms, record_reference, correlation_id, error_category, masked_summary,
    created_by
  ) values (
    p_environment, p_operation, p_endpoint, p_direction, p_status, p_http_status,
    p_duration_ms, p_record_reference, p_correlation_id, p_error_category,
    left(coalesce(p_masked_summary, ''), 2000),
    p_created_by
  );

  -- Keep the connection status surface current without leaking anything.
  if p_status = 'ok' then
    update public.integration_connections
    set status = 'connected',
        last_connected_at = now(),
        last_success_at = now(),
        last_error = null,
        last_fail_at = null
    where provider = 'bankone' and environment = p_environment;
  else
    update public.integration_connections
    set last_fail_at = now(),
        last_error = left(coalesce(p_error_category, 'request_failed'), 200)
    where provider = 'bankone' and environment = p_environment;
  end if;
end; $$;

grant execute on function public.integration_record_provider_call(text, text, text, text, text, int, int, text, text, text, text, uuid)
  to authenticated;
