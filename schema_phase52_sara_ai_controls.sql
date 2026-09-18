-- ============================================================
-- PHASE 52: SARA AI USAGE CONTROL
--
-- Additive and idempotent. The Edge Function also has an in-memory
-- fallback so SARA remains safe while this migration is being deployed.
-- ============================================================

create table if not exists public.sara_ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  call_count integer not null default 0 check (call_count >= 0),
  last_called_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create index if not exists idx_sara_ai_usage_date
  on public.sara_ai_usage(usage_date);

alter table public.sara_ai_usage enable row level security;

drop policy if exists "sara_ai_usage_self_read" on public.sara_ai_usage;
create policy "sara_ai_usage_self_read"
  on public.sara_ai_usage for select
  using (auth.uid() = user_id);

create or replace function public.consume_sara_ai_usage(
  p_daily_limit integer default 40,
  p_min_interval_seconds integer default 2
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := current_date;
  v_row public.sara_ai_usage%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_daily_limit, 40), 100));
  v_interval integer := greatest(0, least(coalesce(p_min_interval_seconds, 2), 60));
  v_elapsed numeric;
begin
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'error', 'forbidden');
  end if;

  insert into public.sara_ai_usage (user_id, usage_date)
  values (v_user_id, v_today)
  on conflict (user_id, usage_date) do nothing;

  select * into v_row
  from public.sara_ai_usage
  where user_id = v_user_id and usage_date = v_today
  for update;

  if v_row.call_count >= v_limit then
    return jsonb_build_object('allowed', false, 'error', 'rate_limited', 'retry_after_seconds', 3600);
  end if;

  if v_row.last_called_at is not null then
    v_elapsed := extract(epoch from (now() - v_row.last_called_at));
    if v_elapsed < v_interval then
      return jsonb_build_object(
        'allowed', false,
        'error', 'rate_limited',
        'retry_after_seconds', greatest(1, ceil(v_interval - v_elapsed)::integer)
      );
    end if;
  end if;

  update public.sara_ai_usage
  set call_count = call_count + 1,
      last_called_at = now(),
      updated_at = now()
  where user_id = v_user_id and usage_date = v_today;

  return jsonb_build_object('allowed', true, 'remaining', v_limit - v_row.call_count - 1);
end;
$$;

revoke all on function public.consume_sara_ai_usage(integer, integer) from public;
grant execute on function public.consume_sara_ai_usage(integer, integer) to authenticated;
