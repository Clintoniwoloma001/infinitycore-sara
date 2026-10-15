-- Phase — Employee-ID authentication foundation (sign-up + sign-in backend)
-- Idempotent + additive. Service-role-only privileged helpers.
-- The frontend NEVER sees resolved emails or employee identity: these functions
-- are callable ONLY by the service role (Edge Functions), never anon/authenticated.

begin;

-- ---------------------------------------------------------------------------
-- 1) Privileged resolver: map a normalized Employee ID to exactly one active,
--    non-archived employee. Returns NO ROW unless exactly one match exists
--    (ambiguous matches are rejected safely, never guessed).
-- ---------------------------------------------------------------------------
create or replace function public.resolve_employee_for_auth(p_norm_id text)
returns table(employee_id uuid, user_id uuid, full_name text, auth_email text, claimed boolean)
language sql
security definer
set search_path = public
stable
as $$
  with matched as (
    select
      e.id as employee_id,
      e.user_id,
      e.full_name,
      e.employment_status,
      -- first non-empty of work_email, email, personal_email (lower/trim)
      nullif(lower(btrim(coalesce(
        nullif(btrim(e.work_email), ''),
        nullif(btrim(e.email), ''),
        nullif(btrim(e.personal_email), '')
      ))), '') as auth_email
    from public.employees e
    where e.employment_status = 'active'
      and coalesce(e.is_archived, false) is distinct from true
      and (
        public.normalize_employee_id(e.employee_number) = p_norm_id
        or public.normalize_employee_id(e.employee_code) = p_norm_id
        or public.normalize_employee_id(e.staff_id) = p_norm_id
      )
  )
  select
    m.employee_id,
    m.user_id,
    m.full_name,
    m.auth_email,
    (m.user_id is not null) as claimed
  from matched m
  where (select count(*) from matched) = 1;   -- exactly one match only
$$;

comment on function public.resolve_employee_for_auth(text) is
  'Service-role only. Resolves a normalized Employee ID to a single active, non-archived employee. Returns no row unless exactly one employee matches (ambiguous matches rejected). auth_email = first non-empty of work_email, email, personal_email.';

revoke all on function public.resolve_employee_for_auth(text) from public;
revoke all on function public.resolve_employee_for_auth(text) from anon;
revoke all on function public.resolve_employee_for_auth(text) from authenticated;
grant execute on function public.resolve_employee_for_auth(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Atomic rate limiter keyed by an arbitrary string (IP, employee id, ...).
--    Returns true when the attempt is allowed, false when the limit is hit.
-- ---------------------------------------------------------------------------
create table if not exists public.auth_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  attempts integer not null default 0
);

alter table public.auth_rate_limits enable row level security;
-- No policies: only the service role (which bypasses RLS) can read/write.

create or replace function public.auth_rate_limit_hit(p_key text, p_max int, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_attempts integer;
begin
  if p_key is null or btrim(p_key) = '' then
    return true; -- cannot rate limit without a key; allow
  end if;

  insert into public.auth_rate_limits as r (key, window_start, attempts)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case
          when r.window_start + p_window <= now() then now()
          else r.window_start
        end,
        attempts = case
          when r.window_start + p_window <= now() then 1
          else r.attempts + 1
        end
  returning r.window_start, r.attempts into v_start, v_attempts;

  return v_attempts <= p_max;
end;
$$;

comment on function public.auth_rate_limit_hit(text, int, interval) is
  'Service-role only. Atomic sliding-window rate limiter. Returns true = allowed, false = limit exceeded.';

revoke all on function public.auth_rate_limit_hit(text, int, interval) from public;
revoke all on function public.auth_rate_limit_hit(text, int, interval) from anon;
revoke all on function public.auth_rate_limit_hit(text, int, interval) from authenticated;
grant execute on function public.auth_rate_limit_hit(text, int, interval) to service_role;

commit;
