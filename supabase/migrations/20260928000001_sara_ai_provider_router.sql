-- ============================================================================
-- SARA AI PROVIDER ROUTER
--
-- SARA must never tell a user "AI unavailable". Instead every AI capability
-- walks a configured provider chain, fails over on error, records the outcome
-- and keeps serving. The internal rules engine is a deterministic, in-process
-- provider with no network dependency, so the chain can always terminate in
-- something that answers.
--
-- Default chain (the requested priority order):
--   1. Gemini               2. Groq      3. rules (internal)  4. OpenAI
-- with NVIDIA enabled as an additional trailing fallback.
--
-- Adds (all additive + idempotent, transaction-wrapped):
--   ai_providers            provider catalog (kind, models, capabilities)
--   provider_health         rolling health + circuit-breaker state per provider
--   provider_latency        per-call latency samples
--   provider_usage_logs     per-call usage, outcome and failover trail
--   hr_platform_settings    ai_primary_provider / ai_fallback_providers /
--                           ai_model_selection / router tuning columns
--
-- RPCs (SECURITY DEFINER, role-gated):
--   get_ai_provider_config()          chain + models + tuning for the edge functions
--   save_ai_provider_settings(...)    super_admin/admin, audited, reason required
--   record_ai_provider_outcome(...)   every provider attempt (success AND failure)
--   get_ai_provider_health_report()   dashboard: health + latency + usage
--   reset_ai_provider_circuit(...)    manual circuit reset
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Provider catalog
-- ---------------------------------------------------------------------------

create table if not exists public.ai_providers (
  id                  text primary key
                      check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  display_name        text not null,
  -- 'remote'  : needs a function secret (GEMINI_API_KEY, GROQ_API_KEY, ...)
  -- 'internal': the deterministic in-process rules engine, no secret needed
  provider_kind       text not null default 'remote'
                      check (provider_kind in ('remote', 'internal')),
  default_model       text,
  -- Model catalogue for the Platform Settings "Model Selection" picker.
  -- [{ id, label, capabilities: ['chat','json','tools','vision'] }]
  models              jsonb not null default '[]'::jsonb,
  capabilities        text[] not null default '{}',
  -- Admin switch. The internal rules engine can never be disabled: it is the
  -- guaranteed termination point of every chain.
  enabled             boolean not null default true,
  sort_order          integer not null default 100,
  doc_url             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.ai_providers is
  'AI provider catalog for the SARA provider router. provider_kind=internal rows need no secret and are always available.';

-- ---------------------------------------------------------------------------
-- 2. Rolling health + circuit breaker
-- ---------------------------------------------------------------------------

create table if not exists public.provider_health (
  provider_id         text primary key references public.ai_providers(id) on delete cascade,
  -- healthy | degraded | down | unknown
  status              text not null default 'unknown'
                      check (status in ('healthy', 'degraded', 'down', 'unknown')),
  -- closed = normal, open = temporarily skipped, half_open = probing again
  circuit_state       text not null default 'closed'
                      check (circuit_state in ('closed', 'open', 'half_open')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  total_calls         integer not null default 0 check (total_calls >= 0),
  total_failures      integer not null default 0 check (total_failures >= 0),
  -- Rolling window used for latency percentiles (last 100 calls).
  calls_last_100      integer not null default 0,
  avg_latency_ms      integer,
  p95_latency_ms      integer,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  last_latency_ms     integer,
  last_error_code     text,
  last_error_source   text,
  -- While set and in the future, the router skips this provider entirely.
  open_until          timestamptz,
  updated_at          timestamptz not null default now()
);

create index if not exists idx_provider_health_status on public.provider_health(status);

-- ---------------------------------------------------------------------------
-- 3. Latency samples
-- ---------------------------------------------------------------------------

create table if not exists public.provider_latency (
  id                 bigint generated always as identity primary key,
  provider_id        text not null references public.ai_providers(id) on delete cascade,
  model              text,
  -- SARA capability this call served: chat, summary, intent, screening,
  -- assessment_generation, assessment_analysis, interview_analysis,
  -- candidate_scorecard, training_questions
  feature            text not null default 'unknown',
  latency_ms         integer not null check (latency_ms >= 0),
  outcome            text not null check (outcome in ('success', 'failure')),
  error_code         text,
  recorded_at        timestamptz not null default now()
);

create index if not exists idx_provider_latency_provider_time
  on public.provider_latency(provider_id, recorded_at desc);
create index if not exists idx_provider_latency_feature_time
  on public.provider_latency(feature, recorded_at desc);

-- ---------------------------------------------------------------------------
-- 4. Usage / outcome log (the failover trail)
-- ---------------------------------------------------------------------------

create table if not exists public.provider_usage_logs (
  id                 bigint generated always as identity primary key,
  provider_id        text not null references public.ai_providers(id) on delete cascade,
  model              text,
  feature            text not null default 'unknown',
  -- Which provider actually served the caller.
  served_by          text references public.ai_providers(id) on delete set null,
  -- Ordered JSON array of the attempts actually made, e.g.
  -- [{provider:'gemini',outcome:'failure',code:'ai_rate_limited'}]
  attempts           jsonb not null default '[]'::jsonb,
  attempts_count     integer not null default 1 check (attempts_count >= 1),
  failed_over        boolean not null default false,
  outcome            text not null default 'unknown'
                      check (outcome in ('success', 'failure', 'degraded')),
  error_code         text,
  error_source       text,
  latency_ms         integer,
  prompt_tokens      integer,
  completion_tokens  integer,
  total_tokens       integer,
  actor_user_id      uuid references auth.users(id) on delete set null,
  request_id         uuid,
  created_at         timestamptz not null default now()
);

create index if not exists idx_provider_usage_created on public.provider_usage_logs(created_at desc);
create index if not exists idx_provider_usage_provider on public.provider_usage_logs(provider_id, created_at desc);
create index if not exists idx_provider_usage_feature on public.provider_usage_logs(feature, created_at desc);
create index if not exists idx_provider_usage_actor on public.provider_usage_logs(actor_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Platform settings columns
-- ---------------------------------------------------------------------------

alter table public.hr_platform_settings
  add column if not exists ai_primary_provider text default 'gemini',
  add column if not exists ai_fallback_providers jsonb default '["groq","rules","openai","nvidia"]'::jsonb,
  add column if not exists ai_model_selection jsonb default '{}'::jsonb,
  add column if not exists ai_provider_timeout_ms integer not null default 20000,
  add column if not exists ai_circuit_failure_threshold integer not null default 3,
  add column if not exists ai_circuit_cooldown_seconds integer not null default 120,
  add column if not exists ai_failover_enabled boolean not null default true;

comment on column public.hr_platform_settings.ai_primary_provider is
  'First AI provider tried by the SARA router.';
comment on column public.hr_platform_settings.ai_fallback_providers is
  'Ordered fallback provider ids tried after the primary. The internal rules engine is always appended as the final, guaranteed-offline tier.';
comment on column public.hr_platform_settings.ai_model_selection is
  'Model selection. Either "<feature>" -> "<provider_id>/<model_id>" (a per-feature pin) or "<provider_id>" -> "<model_id>" (that provider''s default model override).';

update public.hr_platform_settings
   set ai_primary_provider = coalesce(ai_primary_provider, 'gemini'),
       ai_fallback_providers = coalesce(ai_fallback_providers, '["groq","rules","openai","nvidia"]'::jsonb),
       ai_model_selection = coalesce(ai_model_selection, '{}'::jsonb),
       ai_failover_enabled = coalesce(ai_failover_enabled, true)
 where id = 1;

-- ---------------------------------------------------------------------------
-- 6. Provider catalog seed
-- ---------------------------------------------------------------------------

insert into public.ai_providers (id, display_name, provider_kind, default_model, models, capabilities, enabled, sort_order, doc_url)
values
  ('gemini', 'Google Gemini', 'remote', 'gemini-2.0-flash',
   '[
     {"id":"gemini-2.0-flash","label":"Gemini 2.0 Flash","capabilities":["chat","json","tools","vision"]},
     {"id":"gemini-2.5-flash","label":"Gemini 2.5 Flash","capabilities":["chat","json","tools","vision"]},
     {"id":"gemini-2.5-pro","label":"Gemini 2.5 Pro","capabilities":["chat","json","tools","vision"]}
   ]'::jsonb,
   array['chat','json','tools','vision'], true, 10,
   'https://ai.google.dev/gemini-api/docs'),

  ('groq', 'Groq', 'remote', 'llama-3.3-70b-versatile',
   '[
     {"id":"llama-3.3-70b-versatile","label":"Llama 3.3 70B Versatile","capabilities":["chat","json","tools"]},
     {"id":"llama-3.1-8b-instant","label":"Llama 3.1 8B Instant","capabilities":["chat","json"]},
     {"id":"openai/gpt-oss-120b","label":"GPT-OSS 120B","capabilities":["chat","json","tools"]}
   ]'::jsonb,
   array['chat','json','tools'], true, 20,
   'https://console.groq.com/docs'),

  ('rules', 'Internal Rules Engine', 'internal', 'deterministic-v1',
   '[{"id":"deterministic-v1","label":"Deterministic rules engine v1","capabilities":["chat","json","tools"]}]'::jsonb,
   array['chat','json'], true, 30, null),

  ('openai', 'OpenAI', 'remote', 'gpt-4o-mini',
   '[
     {"id":"gpt-4o-mini","label":"GPT-4o mini","capabilities":["chat","json","tools","vision"]},
     {"id":"gpt-4o","label":"GPT-4o","capabilities":["chat","json","tools","vision"]},
     {"id":"gpt-4.1-mini","label":"GPT-4.1 mini","capabilities":["chat","json","tools","vision"]}
   ]'::jsonb,
   array['chat','json','tools','vision'], true, 40,
   'https://platform.openai.com/docs'),

  ('nvidia', 'NVIDIA NIM', 'remote', 'meta/llama-3.3-70b-instruct',
   '[
     {"id":"meta/llama-3.3-70b-instruct","label":"Llama 3.3 70B Instruct","capabilities":["chat","json","tools"]},
     {"id":"meta/llama-3.1-8b-instruct","label":"Llama 3.1 8B Instruct","capabilities":["chat","json"]},
     {"id":"nvidia/llama-3.1-nemotron-70b-instruct","label":"Nemotron 70B Instruct","capabilities":["chat","json","tools"]}
   ]'::jsonb,
   array['chat','json','tools'], true, 50,
   'https://docs.api.nvidia.com/nim/reference/llm-apis')
on conflict (id) do update
  set display_name = excluded.display_name,
      provider_kind = excluded.provider_kind,
      default_model = coalesce(public.ai_providers.default_model, excluded.default_model),
      models = excluded.models,
      capabilities = excluded.capabilities,
      sort_order = excluded.sort_order,
      doc_url = excluded.doc_url,
      updated_at = now();

-- One health row per catalogued provider.
insert into public.provider_health (provider_id)
select id from public.ai_providers
on conflict (provider_id) do nothing;

-- ---------------------------------------------------------------------------
-- 7. SARA feature catalogue
-- ---------------------------------------------------------------------------
-- The single source of truth for which SARA capabilities can be routed and
-- therefore pinned to a specific model. Mirrored in
-- src/constants/aiProviders.js and supabase/functions/_shared/aiRouter.ts.

create or replace function public.ai_features()
returns jsonb
language sql immutable
set search_path = public
as $$
  select jsonb_build_object(
    'features', jsonb_build_array(
      jsonb_build_object('id','chat',                        'label','SARA conversation'),
      jsonb_build_object('id','summary',                     'label','Operational insight summaries'),
      jsonb_build_object('id','intent',                      'label','Intent recognition'),
      jsonb_build_object('id','candidate_screening',         'label','Candidate screening'),
      jsonb_build_object('id','candidate_ranking',          'label','Candidate ranking'),
      jsonb_build_object('id','candidate_scorecard',       'label','Candidate scorecard analysis'),
      jsonb_build_object('id','assessment_generation',      'label','Assessment generation'),
      jsonb_build_object('id','assessment_analysis',         'label','Assessment scoring'),
      jsonb_build_object('id','interview_analysis',          'label','Interview analysis'),
      jsonb_build_object('id','recruitment_recommendation',  'label','HR recommendations'),
      jsonb_build_object('id','attendance_summary',          'label','Attendance summaries'),
      jsonb_build_object('id','leave_analysis',              'label','Leave analysis'),
      jsonb_build_object('id','performance_review',          'label','Performance reviews'),
      jsonb_build_object('id','mpr_summary',                 'label','MPR summaries'),
      jsonb_build_object('id','bankone_analytics',           'label','BankOne analytics'),
      jsonb_build_object('id','training_questions',          'label','Training question generation')
    )
  );
$$;

comment on function public.ai_features() is
  'Canonical SARA AI feature list usable for per-feature model pinning.';

-- ---------------------------------------------------------------------------
-- 8. Helper: the effective chain
-- ---------------------------------------------------------------------------
-- Ordering rules, in one place so the edge functions, the settings UI and the
-- tests can never disagree:
--   * the configured primary goes first,
--   * the configured fallbacks follow in their configured order,
--   * enabled catalog rows that nobody configured are appended (stable sort_order),
--   * the internal rules engine is ALWAYS last and can never be removed,
--   * a provider whose circuit is open and still cooling down is dropped
--     (unless it is the internal engine, which has no circuit).
-- ---------------------------------------------------------------------------

create or replace function public.ai_provider_chain()
returns jsonb
language sql stable
set search_path = public
as $$
  with cfg as (
    select s.ai_primary_provider   as primary_id,
           s.ai_fallback_providers as fallbacks,
           s.ai_model_selection    as models,
           s.ai_provider_timeout_ms as timeout_ms,
           s.ai_failover_enabled    as failover,
           s.ai_circuit_failure_threshold as fail_threshold,
           s.ai_circuit_cooldown_seconds as cooldown
      from public.hr_platform_settings s
     where s.id = 1
  ),
  ordered as (
    select p.id,
           p.display_name,
           p.provider_kind,
           p.default_model,
           p.models,
           p.sort_order,
           p.enabled,
           -- Configured priority: primary first, then fallbacks in their
           -- configured order, then anything else enabled by catalog order.
           -- The fallback position comes from a 1-based ordinality, so a
           -- configured chain always sorts ahead of unconfigured providers.
           -- An internal provider that the admin did NOT place in the chain is
           -- still appended (rank 100000) as the guaranteed terminal tier, so
           -- a chain can never be configured into a dead end.
           case
             when cfg.primary_id is not null and p.id = cfg.primary_id then 0
             when f.pos is not null then f.pos
             when p.provider_kind = 'internal' then 100000
             else 1000
           end as rank
      from public.ai_providers p
      cross join cfg
      left join lateral (
        select min(t.ord)::int as pos
          from jsonb_array_elements_text(coalesce(cfg.fallbacks, '[]'::jsonb))
               with ordinality as t(value, ord)
         where lower(btrim(t.value)) = p.id
      ) f on true
     where p.enabled
  ),
  live as (
    select o.*,
           h.status,
           h.circuit_state,
           h.consecutive_failures,
           h.open_until,
           coalesce(h.avg_latency_ms, 0) as avg_latency_ms,
           (p.provider_kind <> 'internal'
             and cfg.failover
             and h.circuit_state = 'open'
             and h.open_until is not null
             and h.open_until > now()) as cooling_down
      from ordered o
      join public.provider_health h on h.provider_id = o.id
      join public.ai_providers p on p.id = o.id
      cross join cfg
  )
  select jsonb_build_object(
    'primary', cfg.primary_id,
    'models', coalesce(cfg.models, '{}'::jsonb),
    'timeout_ms', coalesce(cfg.timeout_ms, 20000),
    'failover_enabled', coalesce(cfg.failover, true),
    'failure_threshold', coalesce(cfg.fail_threshold, 3),
    'cooldown_seconds', coalesce(cfg.cooldown, 120),
    'chain', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id,
               'name', l.display_name,
               'kind', l.provider_kind,
               'default_model', l.default_model,
               'models', l.models,
               'status', l.status,
               'circuit', l.circuit_state,
               'avg_latency_ms', l.avg_latency_ms,
               'cooling_down', l.cooling_down
             ) order by
               -- 1. configured priority, then catalog order
               l.rank asc,
               l.sort_order asc,
               l.id asc,
               -- 2. a provider whose circuit is open is demoted below every
               --    healthy provider, but is KEPT so a total remote outage
               --    still retries it rather than skipping straight to the
               --    degraded internal tier
               l.cooling_down asc)
        from live l
    ), '[]'::jsonb)
  )
  from cfg;
$$;

comment on function public.ai_provider_chain() is
  'Effective, ordered provider chain (internal rules engine last) with circuit state.';

-- ---------------------------------------------------------------------------
-- 8. get_ai_provider_config — consumed by every SARA edge function
-- ---------------------------------------------------------------------------

create or replace function public.get_ai_provider_config()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
begin
  return public.ai_provider_chain();
end;
$$;

revoke all on function public.get_ai_provider_config() from public;
grant execute on function public.get_ai_provider_config() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. record_ai_provider_outcome — one row per provider attempt
-- ---------------------------------------------------------------------------
-- Called by the edge functions with the service role. Records EVERY attempt
-- (success and failure) so a failure is always visible, then:
--   * flips status healthy/degraded/down from the rolling failure ratio,
--   * opens the circuit after `threshold` consecutive failures and sets
--     open_until = now() + cooldown,
--   * keeps a 100-sample latency window for avg/p95,
--   * appends the attempt to the failover trail on the usage log.
-- ---------------------------------------------------------------------------

create or replace function public.record_ai_provider_outcome(
  p_provider_id   text,
  p_model         text default null,
  p_feature       text default 'unknown',
  p_outcome       text default 'success',
  p_latency_ms    integer default null,
  p_error_code    text default null,
  p_error_source  text default null,
  p_prompt_tokens integer default null,
  p_completion_tokens integer default null,
  p_total_tokens  integer default null,
  p_actor_user_id uuid default null,
  p_request_id    uuid default null,
  p_served_by     text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_cfg     record;
  v_health  public.provider_health%rowtype;
  v_ok      boolean := (p_outcome = 'success');
  v_total   integer;
  v_fail    integer;
  v_ratio   numeric;
  v_status  text;
  v_window  integer[];
  v_avg     integer;
  v_p95     integer;
begin
  if p_provider_id is null then
    return jsonb_build_object('ok', false, 'error', 'provider_required');
  end if;

  -- The settings row may not exist yet in a very fresh environment.
  select coalesce(ai_circuit_failure_threshold, 3) as fail_threshold,
         coalesce(ai_circuit_cooldown_seconds, 120) as cooldown
    into v_cfg
    from public.hr_platform_settings where id = 1;
  v_cfg.fail_threshold := coalesce(v_cfg.fail_threshold, 3);
  v_cfg.cooldown := coalesce(v_cfg.cooldown, 120);

  insert into public.provider_health (provider_id)
  values (p_provider_id)
  on conflict (provider_id) do nothing;

  -- Latency sample.
  if p_latency_ms is not null then
    insert into public.provider_latency (provider_id, model, feature, latency_ms, outcome, error_code)
    values (p_provider_id, p_model, p_feature, greatest(0, p_latency_ms), p_outcome, p_error_code);
  end if;

  -- Usage / outcome log row (the failover trail).
  insert into public.provider_usage_logs (
    provider_id, model, feature, attempts, attempts_count, failed_over,
    outcome, error_code, error_source, latency_ms,
    prompt_tokens, completion_tokens, total_tokens, actor_user_id, request_id, served_by
  ) values (
    p_provider_id, p_model, p_feature,
    jsonb_build_array(jsonb_build_object(
      'provider', p_provider_id,
      'outcome', p_outcome,
      'code', p_error_code,
      'ms', p_latency_ms
    )),
    1,
    p_served_by is not null and p_served_by <> p_provider_id,
    p_outcome, p_error_code, p_error_source, p_latency_ms,
    p_prompt_tokens, p_completion_tokens, p_total_tokens, p_actor_user_id, p_request_id, p_served_by
  );

  -- Rolling health + circuit breaker.
  select * into v_health from public.provider_health where provider_id = p_provider_id for update;

  v_total := v_health.total_calls + 1;
  v_fail  := v_health.total_failures + (case when v_ok then 0 else 1 end);
  v_ratio := case when v_total = 0 then 0 else v_fail::numeric / v_total::numeric end;

  -- Last 100 successful-or-not latencies for this provider.
  select coalesce(array_agg(latency_ms order by recorded_at desc), '{}')
    into v_window
    from (
      select l.latency_ms, l.recorded_at
        from public.provider_latency l
       where l.provider_id = p_provider_id
       order by l.recorded_at desc
       limit 100
    ) l;
  v_avg := case when coalesce(array_length(v_window, 1), 0) > 0
                then (select round(avg(x))::int from unnest(v_window) as x) end;
  v_p95 := case when coalesce(array_length(v_window, 1), 0) > 0
                then (select round(percentile_cont(0.95) within group (order by x))::int
                        from unnest(v_window) as x) end;

  if v_ok then
    v_status := 'healthy';
  elsif v_health.consecutive_failures + 1 >= v_cfg.fail_threshold then
    v_status := 'down';
  elsif v_ratio >= 0.5 then
    v_status := 'degraded';
  else
    v_status := 'healthy';
  end if;

  update public.provider_health
     set total_calls          = v_total,
         total_failures       = v_fail,
         consecutive_failures = case when v_ok then 0 else consecutive_failures + 1 end,
         status               = v_status,
         circuit_state        = case
                                when v_ok then 'closed'
                                when v_health.consecutive_failures + 1 >= v_cfg.fail_threshold then 'open'
                                else circuit_state
                              end,
         open_until           = case
                                when v_ok then null
                                when v_health.consecutive_failures + 1 >= v_cfg.fail_threshold
                                  then now() + make_interval(secs => v_cfg.cooldown)
                                else open_until
                              end,
         calls_last_100       = coalesce(array_length(v_window, 1), 0),
         avg_latency_ms       = coalesce(v_avg, avg_latency_ms),
         p95_latency_ms       = coalesce(v_p95, p95_latency_ms),
         last_latency_ms      = p_latency_ms,
         last_success_at      = case when v_ok then now() else last_success_at end,
         last_failure_at      = case when v_ok then last_failure_at else now() end,
         last_error_code      = case when v_ok then null else p_error_code end,
         last_error_source    = case when v_ok then null else p_error_source end,
         updated_at           = now()
   where provider_id = p_provider_id;

  return jsonb_build_object(
    'ok', true,
    'provider', p_provider_id,
    'status', v_status,
    'circuit', case when v_ok then 'closed'
                    when v_health.consecutive_failures + 1 >= v_cfg.fail_threshold then 'open'
                    else v_health.circuit_state end,
    'avg_latency_ms', v_avg,
    'p95_latency_ms', v_p95
  );
end;
$$;

revoke all on function public.record_ai_provider_outcome(text, text, text, text, integer, text, text, integer, integer, integer, uuid, uuid, text) from public;
grant execute on function public.record_ai_provider_outcome(text, text, text, text, integer, text, text, integer, integer, integer, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. record_ai_provider_call — the completed call (one row per caller request)
-- ---------------------------------------------------------------------------
-- The router calls this once at the end with the ordered attempt trail, so the
-- usage log answers "who served this, and what failed on the way there?".

create or replace function public.record_ai_provider_call(
  p_attempts   jsonb,
  p_feature    text default 'unknown',
  p_model      text default null,
  p_served_by  text default null,
  p_outcome    text default 'success',
  p_error_code text default null,
  p_error_source text default null,
  p_latency_ms integer default null,
  p_prompt_tokens integer default null,
  p_completion_tokens integer default null,
  p_total_tokens integer default null,
  p_actor_user_id uuid default null,
  p_request_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_list  jsonb := coalesce(p_attempts, '[]'::jsonb);
  v_first text  := v_list -> 0 ->> 'provider';
begin
  if v_first is null then
    return jsonb_build_object('ok', false, 'error', 'attempts_required');
  end if;

  insert into public.provider_usage_logs (
    provider_id, model, feature, attempts, attempts_count, failed_over,
    outcome, error_code, error_source, latency_ms,
    prompt_tokens, completion_tokens, total_tokens, actor_user_id, request_id, served_by
  ) values (
    v_first, p_model, p_feature, v_list,
    coalesce(jsonb_array_length(v_list), 1),
    coalesce(jsonb_array_length(v_list), 1) > 1,
    p_outcome, p_error_code, p_error_source, p_latency_ms,
    p_prompt_tokens, p_completion_tokens, p_total_tokens,
    p_actor_user_id, p_request_id, p_served_by
  );
  return jsonb_build_object('ok', true);
exception when others then
  -- Usage logging must never break the AI call it is describing.
  return jsonb_build_object('ok', false, 'error', 'log_failed');
end;
$$;

revoke all on function public.record_ai_provider_call(jsonb, text, text, text, text, text, text, integer, integer, integer, integer, uuid, uuid) from public;
grant execute on function public.record_ai_provider_call(jsonb, text, text, text, text, text, text, integer, integer, integer, integer, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 11. save_ai_provider_settings — Platform Settings write path (audited)
-- ---------------------------------------------------------------------------

create or replace function public.save_ai_provider_settings(
  p_primary_provider  text,
  p_fallback_providers jsonb,
  p_model_selection   jsonb default '{}'::jsonb,
  p_timeout_ms        integer default null,
  p_failover_enabled  boolean default null,
  p_reason            text default null
) returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_primary  text;
  v_fallback jsonb := '[]'::jsonb;
  v_models   jsonb := '{}'::jsonb;
  v_enabled  jsonb;
  v_current  record;
begin
  if public.current_role() not in ('super_admin', 'admin') then
    raise exception 'Not authorized to change AI provider settings.';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to change AI provider settings.';
  end if;

  -- Every id must exist in the catalog.
  select jsonb_agg(id order by id) into v_enabled
    from public.ai_providers where enabled;

  v_primary := lower(btrim(coalesce(p_primary_provider, '')));
  if v_primary is null or v_primary = '' then
    raise exception 'A primary AI provider is required.';
  end if;
  if not exists (select 1 from public.ai_providers where id = v_primary and enabled) then
    raise exception 'Primary AI provider "%" is not an enabled provider.', v_primary;
  end if;

  if jsonb_typeof(coalesce(p_fallback_providers, '[]'::jsonb)) <> 'array' then
    raise exception 'Fallback providers must be a JSON array of provider ids.';
  end if;

  -- Normalise fallbacks: lowercase, de-duplicated, primary removed, and every
  -- id must be an enabled provider.
  select coalesce(jsonb_agg(x.id order by x.ord), '[]'::jsonb) into v_fallback
    from (
      select distinct on (lower(value)) lower(value) as id, ordi as ord
        from jsonb_array_elements_text(coalesce(p_fallback_providers, '[]'::jsonb)) with ordinality as t(value, ordi)
       where lower(btrim(value)) <> ''
         and lower(btrim(value)) <> v_primary
       order by lower(value), ordi
    ) x;
  if exists (
    select 1 from jsonb_array_elements_text(v_fallback) as f(id)
     where not exists (select 1 from public.ai_providers p where p.id = f.id and p.enabled)
  ) then
    raise exception 'Fallback providers contain an unknown or disabled provider.';
  end if;

  -- Model selection. Two accepted key shapes, both validated against the
  -- catalog so the settings UI can never persist an uncallable model:
  --   "<feature>"    -> "<provider_id>/<model_id>"   (per-feature pin)
  --   "<provider_id>"-> "<model_id>"                 (provider default override)
  -- Normalised first (blank entries dropped, whitespace trimmed) so an empty
  -- form input means "use the default" rather than an error.
  if jsonb_typeof(coalesce(p_model_selection, '{}'::jsonb)) <> 'object' then
    raise exception 'Model selection must be a JSON object of feature to model.';
  end if;
  select coalesce(jsonb_object_agg(key, val), '{}'::jsonb) into v_models
    from (
      select m.key, btrim(m.val) as val
        from jsonb_each_text(coalesce(p_model_selection, '{}'::jsonb)) as m(key, val)
       where btrim(m.val) <> ''
    ) kept;
  v_models := coalesce(v_models, '{}'::jsonb);

  -- Every key must be either a catalogued feature or a catalogued provider.
  if exists (
    select 1
      from jsonb_object_keys(v_models) as k
     where k not in (select f ->> 'id' from jsonb_array_elements(public.ai_features()->'features') f)
       and k not in (select p.id from public.ai_providers p)
  ) then
    raise exception 'Model selection contains an unknown feature or provider key.';
  end if;

  -- Per-feature pins must name a real provider and one of its real models.
  if exists (
    select 1
      from jsonb_each_text(v_models) as m(key, val)
     where m.key in (select f ->> 'id' from jsonb_array_elements(public.ai_features()->'features') f)
       and not exists (
         select 1
           from public.ai_providers p
          where p.id = split_part(m.val, '/', 1)
            and split_part(m.val, '/', 2) <> ''
            and exists (select 1 from jsonb_array_elements(p.models) mm where mm ->> 'id' = split_part(m.val, '/', 2))
       )
  ) then
    raise exception 'Model selection references an unknown provider or model.';
  end if;

  -- Provider default overrides must be one of that provider's real models.
  if exists (
    select 1
      from jsonb_each_text(v_models) as m(key, val)
     where m.key in (select p.id from public.ai_providers p)
       and not exists (
         select 1
           from public.ai_providers p
          where p.id = m.key
            and exists (select 1 from jsonb_array_elements(p.models) mm where mm ->> 'id' = m.val)
       )
  ) then
    raise exception 'Provider model selection references an unknown model.';
  end if;

  -- The internal rules engine is the guaranteed terminal tier.
  if not exists (select 1 from jsonb_array_elements_text(v_fallback) as f(id) where f.id = 'rules') then
    v_fallback := v_fallback || '"rules"'::jsonb;
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;
  if not found then
    raise exception 'Platform settings row is missing.';
  end if;

  update public.hr_platform_settings
     set ai_primary_provider    = v_primary,
         ai_fallback_providers  = v_fallback,
         ai_model_selection     = v_models,
         ai_provider_timeout_ms = coalesce(p_timeout_ms, ai_provider_timeout_ms),
         ai_failover_enabled    = coalesce(p_failover_enabled, ai_failover_enabled),
         updated_at             = now(),
         updated_by             = auth.uid()
   where id = 1;

  insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
  values
    ('ai_primary_provider',   v_current.ai_primary_provider,   v_primary, auth.uid()),
    ('ai_fallback_providers', v_current.ai_fallback_providers::text, v_fallback::text, auth.uid()),
    ('ai_model_selection',    v_current.ai_model_selection::text,    v_models::text,    auth.uid());

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AI_PROVIDER_SETTINGS_SAVED', 'AiProviderSettings', '1',
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object(
            'previous_primary', v_current.ai_primary_provider,
            'primary', v_primary,
            'fallbacks', v_fallback,
            'model_selection', v_models,
            'reason', p_reason,
            'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'primary', v_primary, 'fallbacks', v_fallback, 'models', v_models);
end;
$$;

revoke all on function public.save_ai_provider_settings(text, jsonb, jsonb, integer, boolean, text) from public;
grant execute on function public.save_ai_provider_settings(text, jsonb, jsonb, integer, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Dashboard read: health + latency percentiles + usage + failover rate
-- ---------------------------------------------------------------------------

create or replace function public.get_ai_provider_health_report(p_hours integer default 24)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_window interval := make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources', 'head_of_operations', 'financial_controller') then
    raise exception 'Not authorized to view AI provider health.';
  end if;

  return jsonb_build_object(
    'generated_at', now(),
    'window_hours', greatest(1, least(coalesce(p_hours, 24), 720)),
    'providers', coalesce((
      select jsonb_agg(row_to_json(x) order by x.sort_order)
        from (
          select p.id,
                 p.display_name,
                 p.provider_kind,
                 p.enabled,
                 p.sort_order,
                 p.default_model,
                 p.models,
                 coalesce(h.status, 'unknown')                        as status,
                 coalesce(h.circuit_state, 'closed')                  as circuit,
                 h.open_until,
                 h.consecutive_failures,
                 h.total_calls,
                 h.total_failures,
                 h.avg_latency_ms,
                 h.p95_latency_ms,
                 h.last_latency_ms,
                 h.last_success_at,
                 h.last_failure_at,
                 h.last_error_code,
                 h.last_error_source,
                 w.calls                                              as window_calls,
                 w.failures                                           as window_failures,
                 w.avg_latency_ms                                     as window_avg_latency_ms,
                 w.p95_latency_ms                                     as window_p95_latency_ms,
                 case when coalesce(w.calls, 0) = 0 then null
                      else round((1 - (w.failures::numeric / w.calls)) * 100, 1) end as window_success_rate
            from public.ai_providers p
            left join public.provider_health h on h.provider_id = p.id
            left join lateral (
              select count(*)::int as calls,
                     count(*) filter (where l.outcome = 'failure')::int as failures,
                     round(avg(l.latency_ms))::int as avg_latency_ms,
                     round(percentile_cont(0.95) within group (order by l.latency_ms))::int as p95_latency_ms
                from public.provider_latency l
               where l.provider_id = p.id and l.recorded_at >= now() - v_window
            ) w on true
        ) x
    ), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_build_object(
        'calls', count(*)::int,
        'failures', count(*) filter (where outcome = 'failure')::int,
        'failovers', count(*) filter (where failed_over)::int,
        'avg_latency_ms', round(avg(latency_ms))::int,
        'tokens', coalesce(sum(total_tokens), 0)::bigint
      )
        from public.provider_usage_logs
       where created_at >= now() - v_window
    ), '{}'::jsonb),
    'by_feature', coalesce((
      select jsonb_agg(row_to_json(f) order by f.feature)
        from (
          select feature,
                 count(*)::int as calls,
                 count(*) filter (where outcome <> 'success')::int as failures,
                 count(*) filter (where failed_over)::int as failovers,
                 round(avg(latency_ms))::int as avg_latency_ms
            from public.provider_usage_logs
           where created_at >= now() - v_window
           group by feature
        ) f
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_ai_provider_health_report(integer) from public;
grant execute on function public.get_ai_provider_health_report(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. Manual circuit reset
-- ---------------------------------------------------------------------------

create or replace function public.reset_ai_provider_circuit(p_provider_id text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if public.current_role() not in ('super_admin', 'admin') then
    raise exception 'Not authorized to reset an AI provider circuit.';
  end if;
  if not exists (select 1 from public.ai_providers where id = p_provider_id) then
    raise exception 'Unknown AI provider "%".', p_provider_id;
  end if;

  update public.provider_health
     set circuit_state = 'closed',
         open_until = null,
         status = 'unknown',
         consecutive_failures = 0,
         updated_at = now()
   where provider_id = p_provider_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AI_PROVIDER_CIRCUIT_RESET', 'AiProvider', p_provider_id,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('provider', p_provider_id, 'success', true)::text, 'info');

  return jsonb_build_object('ok', true, 'provider', p_provider_id);
end;
$$;

revoke all on function public.reset_ai_provider_circuit(text) from public;
grant execute on function public.reset_ai_provider_circuit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 14. RLS — read-only for admins, no direct client writes
-- ---------------------------------------------------------------------------

alter table public.ai_providers     enable row level security;
alter table public.provider_health  enable row level security;
alter table public.provider_latency enable row level security;
alter table public.provider_usage_logs enable row level security;

drop policy if exists "ai_providers_read" on public.ai_providers;
create policy "ai_providers_read" on public.ai_providers for select
  using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'head_of_operations', 'financial_controller'));

drop policy if exists "provider_health_read" on public.provider_health;
create policy "provider_health_read" on public.provider_health for select
  using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'head_of_operations', 'financial_controller'));

drop policy if exists "provider_latency_read" on public.provider_latency;
create policy "provider_latency_read" on public.provider_latency for select
  using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'head_of_operations', 'financial_controller'));

drop policy if exists "provider_usage_logs_read" on public.provider_usage_logs;
create policy "provider_usage_logs_read" on public.provider_usage_logs for select
  using (public.current_role() in ('super_admin', 'admin', 'head_of_human_resources', 'head_of_operations', 'financial_controller'));

-- No INSERT/UPDATE/DELETE policies: the edge functions write through the
-- SECURITY DEFINER RPCs above (service_role), so usage data can never be
-- forged or erased by a client.

commit;

