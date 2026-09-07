-- ============================================================
-- PHASE 8e: REAL INTERVIEW SCHEDULING + MEETING INTEGRATION
--
-- Adds columns to hr_interviews for external meeting tracking,
-- notification status, and email override tracking.
-- Creates integration_connections table for OAuth token storage.
--
-- ALL ADDITIVE. Safe to re-run. Non-destructive.
-- ============================================================

-- ============================================================
-- 1. HR INTERVIEWS — add scheduling + notification columns
-- ============================================================
alter table public.hr_interviews add column if not exists external_provider text;
alter table public.hr_interviews add column if not exists external_event_id text;
alter table public.hr_interviews add column if not exists external_meeting_id text;
alter table public.hr_interviews add column if not exists meeting_start_at timestamptz;
alter table public.hr_interviews add column if not exists meeting_end_at timestamptz;
alter table public.hr_interviews add column if not exists duration_minutes int default 30;
alter table public.hr_interviews add column if not exists notification_status text default 'pending' check (notification_status in ('pending', 'sent', 'failed', 'not_configured'));
alter table public.hr_interviews add column if not exists notification_sent_at timestamptz;
alter table public.hr_interviews add column if not exists notification_error text;
alter table public.hr_interviews add column if not exists email_override boolean default false;
alter table public.hr_interviews add column if not exists original_candidate_email text;
alter table public.hr_interviews add column if not exists interview_instructions text;

-- Expand status to include confirmed, rescheduled, no_show
alter table public.hr_interviews drop constraint if exists hr_interviews_status_check;
alter table public.hr_interviews add constraint hr_interviews_status_check
  check (status in ('scheduled', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'no_show'));

create index if not exists idx_hr_interviews_notification on public.hr_interviews(notification_status);
create index if not exists idx_hr_interviews_external on public.hr_interviews(external_provider);

-- ============================================================
-- 2. INTEGRATION CONNECTIONS — OAuth token storage
-- Tokens stored here are ONLY accessible via service role
-- (RLS denies all direct client access).
-- ============================================================
create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google_calendar', 'zoom')),
  connected boolean default false,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  provider_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.integration_connections enable row level security;

-- NO policies = no client access. Only service role (Edge Functions) can read/write.
-- This ensures OAuth tokens never reach the browser.

create index if not exists idx_integration_connections_user on public.integration_connections(user_id);
create index if not exists idx_integration_connections_provider on public.integration_connections(provider);

-- ============================================================
-- 3. INTERVIEW REMINDERS — scheduled reminder tracking
-- Reminders are sent by a scheduled Edge Function (cron), not client timers.
-- ============================================================
create table if not exists public.interview_reminders (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid references public.hr_interviews(id) on delete cascade,
  reminder_type text check (reminder_type in ('24h', '1h')),
  recipient text not null,
  recipient_email text,
  status text default 'pending' check (status in ('pending', 'sent', 'failed')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  created_at timestamptz default now()
);

alter table public.interview_reminders enable row level security;

-- Service role only — reminders are processed server-side
create index if not exists idx_interview_reminders_interview on public.interview_reminders(interview_id);
create index if not exists idx_interview_reminders_status on public.interview_reminders(status);
create index if not exists idx_interview_reminders_scheduled on public.interview_reminders(scheduled_for);
