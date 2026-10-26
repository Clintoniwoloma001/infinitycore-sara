-- ============================================================================
-- Phase 4 — Audit reminder sweep + send pipeline (Zoho)
-- Migration: 20261123000003_zoho_reminder_sweep.sql
-- Idempotent / additive. Run in Supabase SQL Editor.
-- ============================================================================

begin;

-- 1. Sweep run log -----------------------------------------------------------
create table if not exists public.audit_sweep_log (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null unique,
  mode          text not null check (mode in ('preview','run')),
  reason        text,
  daily_cap     int  not null default 100,
  is_sweep_call boolean not null default false,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  candidate_count int default 0,
  sent_count    int default 0,
  failed_count  int default 0,
  skipped_count int default 0
);

-- 2. Sweep targets / config ---------------------------------------------------
create table if not exists public.audit_sweep_targets (
  id            uuid primary key default gen_random_uuid(),
  target_name   text not null default 'default',
  edge_url      text not null,
  edge_api_key  text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 3. pg_net extension (for HTTP calls from cron) ----------------------------
create extension if not exists pg_net with schema extensions;

-- 4. audit_sweep_cron() — invoked by pg_cron at 07:00 Africa/Lagos ----------
create or replace function public.audit_sweep_cron()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_target record;
  v_edge_url text;
  v_edge_key text;
  v_request_id bigint;
begin
  select edge_url, edge_api_key into v_edge_url, v_edge_key
  from public.audit_sweep_targets
  where is_active = true
  order by created_at asc
  limit 1;

  if v_edge_url is null then
    raise notice 'audit_sweep_cron: no active target configured';
    return;
  end if;

  -- Fire the edge function via pg_net (async). The edge function performs
  -- the actual DB + Zoho send work and writes to audit_sweep_log.
  select net.http_post(
    url := v_edge_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(v_edge_key, '')
    ),
    body := jsonb_build_object('mode', 'run', 'reason', 'scheduled_cron')
  ) into v_request_id;

  raise notice 'audit_sweep_cron: dispatched request %', v_request_id;
end;
$$;

-- 5. pg_cron job at 07:00 Africa/Lagos (= 06:00 UTC) -----------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Remove any prior job with the same name (ignore errors if not present)
    begin
      perform cron.unschedule('infinitycore-audit-sweep');
    exception when others then
      null;
    end;

    perform cron.schedule(
      'infinitycore-audit-sweep',
      '0 6 * * *',  -- 06:00 UTC = 07:00 Africa/Lagos
      $cron$select public.audit_sweep_cron();$cron$
    );
  else
    raise notice 'pg_cron extension not installed; skipping job registration';
  end if;
end
$$;

commit;
