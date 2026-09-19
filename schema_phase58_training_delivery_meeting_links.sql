-- ============================================================
-- PHASE 58: TRAINING DELIVERY TYPE + REAL MEETING LINKS
-- ------------------------------------------------------------
-- PURPOSE
--   Replaces the free-text venue/virtual-link behaviour on
--   training_sessions with an explicit delivery model:
--
--   * delivery_type = 'physical' | 'virtual'  (required)
--   * physical venues come from the authoritative branches table
--     (venue_id + cached venue_name/venue_address)
--   * virtual sessions carry a REAL provider-created meeting
--     (meeting_platform / meeting_url / meeting_provider_id /
--     meeting_created_at) produced by the existing
--     create-google-meet / create-zoom-meeting edge functions.
--
--   Provider secrets/start-urls are never stored here — the join
--   URL is persisted so participants/attendance can use it.
--   The existing training_sessions RLS (training_is_hr manage,
--   participant read) and the training_sessions_audit trigger
--   continue to govern these new columns.
--
--   Idempotent + additive — safe to re-run.
-- ============================================================

alter table public.training_sessions
  add column if not exists delivery_type text not null default 'physical'
    check (delivery_type in ('physical', 'virtual')),
  add column if not exists venue_id uuid references public.branches(id) on delete set null,
  add column if not exists venue_name text,
  add column if not exists venue_address text,
  add column if not exists meeting_platform text
    check (meeting_platform is null or meeting_platform in ('google_meet', 'zoom')),
  add column if not exists meeting_url text,
  add column if not exists meeting_provider_id text,
  add column if not exists meeting_created_at timestamptz;

create index if not exists idx_training_sessions_delivery on public.training_sessions(delivery_type);

-- Backfill: pre-existing sessions with a virtual link are treated as virtual,
-- everything else stays physical. Idempotent — only touches default rows.
update public.training_sessions
set delivery_type = 'virtual',
    meeting_url = virtual_link,
    meeting_created_at = updated_at
where delivery_type = 'physical'
  and virtual_link is not null
  and trim(virtual_link) <> '';

-- Backfill venue identity for sessions already referencing a branch venue.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'branches' and column_name = 'location') then
    update public.training_sessions s
    set venue_name = coalesce(nullif(trim(s.venue_name), ''), b.branch_name),
        venue_address = coalesce(nullif(trim(s.venue_address), ''), b.location)
    from public.branches b
    where s.venue_id = b.id
      and (s.venue_name is distinct from b.branch_name
           or s.venue_address is distinct from b.location);
  else
    update public.training_sessions s
    set venue_name = coalesce(nullif(trim(s.venue_name), ''), b.branch_name)
    from public.branches b
    where s.venue_id = b.id
      and s.venue_name is distinct from b.branch_name;
  end if;
end $$;

-- Existing physical-location text stays as the venue label when no branch was picked.
update public.training_sessions
set venue_name = location
where delivery_type = 'physical'
  and venue_name is null
  and venue_id is null
  and coalesce(nullif(trim(location), ''), '') <> '';