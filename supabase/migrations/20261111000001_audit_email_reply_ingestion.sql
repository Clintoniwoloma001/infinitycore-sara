-- ============================================================================
-- PHASE 6 - EMAIL REPLY INGESTION (audit mailbox)
-- ============================================================================
-- Idempotent, additive. Creates the reply thread storage and the unmatched
-- replies queue used by the scheduled edge function that polls the audit
-- mailbox (Zoho READ) every 5 minutes.
--
-- Deduplication key: zoho_message_id (unique per table).
-- Source of every ingested reply: 'email'.
-- ============================================================================

begin;

create table if not exists public.audit_email_replies (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid references public.audit_findings(id) on delete cascade,
  zoho_message_id text not null unique,
  in_reply_to text,
  from_email text,
  from_name text,
  subject text,
  body_sanitised text,
  attachments jsonb not null default '[]'::jsonb,
  source text not null default 'email',
  matched_by text,
  assignee_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_email_replies_finding
  on public.audit_email_replies (finding_id, created_at desc);
create index if not exists idx_audit_email_replies_zoho
  on public.audit_email_replies (zoho_message_id);

comment on table public.audit_email_replies is
  'Ingested email replies (source=email) matched to an audit finding thread.';

-- Unmatched replies queue: replies whose sender is not the active assignee,
-- or which could not be matched to a finding. Reviewed by HR/audit staff.
create table if not exists public.audit_unmatched_replies (
  id uuid primary key default gen_random_uuid(),
  zoho_message_id text not null unique,
  in_reply_to text,
  from_email text,
  from_name text,
  subject text,
  body_sanitised text,
  attachments jsonb not null default '[]'::jsonb,
  source text not null default 'email',
  reason text,
  status text not null default 'pending'
    check (status in ('pending','reviewed','resolved')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz
);

create index if not exists idx_audit_unmatched_replies_status
  on public.audit_unmatched_replies (status, created_at desc);

comment on table public.audit_unmatched_replies is
  'Queue of email replies that could not be matched to an active assignee.';

-- Convenience aliases for older/alternate naming used by callers and tests.
create table if not exists public.unmatched_replies (
  id uuid primary key default gen_random_uuid(),
  zoho_message_id text not null unique,
  in_reply_to text,
  from_email text,
  from_name text,
  subject text,
  body_sanitised text,
  attachments jsonb not null default '[]'::jsonb,
  source text not null default 'email',
  reason text,
  status text not null default 'pending'
    check (status in ('pending','reviewed','resolved')),
  created_at timestamptz not null default now()
);

create table if not exists public.unmatched_email_replies (
  id uuid primary key default gen_random_uuid(),
  zoho_message_id text not null unique,
  in_reply_to text,
  from_email text,
  from_name text,
  subject text,
  body_sanitised text,
  attachments jsonb not null default '[]'::jsonb,
  source text not null default 'email',
  reason text,
  status text not null default 'pending'
    check (status in ('pending','reviewed','resolved')),
  created_at timestamptz not null default now()
);

-- RLS: service role only writes; authenticated managers can read.
alter table public.audit_email_replies enable row level security;
alter table public.audit_unmatched_replies enable row level security;
alter table public.unmatched_replies enable row level security;
alter table public.unmatched_email_replies enable row level security;

drop policy if exists "audit_email_replies_read" on public.audit_email_replies;
create policy "audit_email_replies_read" on public.audit_email_replies
  for select to authenticated
  using (public.has_permission('audit.monitoring.read') or public.current_role() in ('super_admin','admin','head_of_audit'));

drop policy if exists "audit_unmatched_replies_read" on public.audit_unmatched_replies;
create policy "audit_unmatched_replies_read" on public.audit_unmatched_replies
  for select to authenticated
  using (public.has_permission('audit.monitoring.read') or public.current_role() in ('super_admin','admin','head_of_audit'));

-- pg_cron registration (every 5 minutes) when available. The edge function
-- is invoked via pg_net; the URL is supplied by the platform at deploy time.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'infinitycore-audit-email-reply-ingestion') then
      perform cron.unschedule('infinitycore-audit-email-reply-ingestion');
    end if;
    perform cron.schedule(
      'infinitycore-audit-email-reply-ingestion',
      '*/5 * * * *',
      $$select net.http_post(url := coalesce(current_setting('app.settings.edge_url', true), '') || '/functions/v1/ingest-audit-email-replies', headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb)$$
    );
  end if;
end;
$$;

commit;
