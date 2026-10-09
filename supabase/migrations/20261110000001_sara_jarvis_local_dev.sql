-- ============================================================================
-- SARA → local Jarvis (OpenAI-compatible) — LOCAL DEV ONLY
--
-- Routes SARA to your local endpoint:
--   BASE_URL http://localhost:20128/v1
--   MODEL    Jarvis
--   AUTH_TOKEN -> OPENAI_API_KEY function secret (never in git, never client)
--
-- WHAT THIS DOES (idempotent, additive, transaction-wrapped):
--   * sets ai_primary_provider='openai' on hr_platform_settings id=1
--   * sets ai_model_selection jsonb {"openai":"Jarvis"} so resolveModel()
--     returns Jarvis for the openai provider (DB pin wins over env default)
--   * keeps failover ON with the existing fallback chain intact
--   * registers the Jarvis model id on the openai catalog row (display only)
--
-- WHAT THIS DOES NOT DO:
--   * never writes any API key/token (keys live ONLY in function secrets)
--   * never touches DEFAULT_CHAIN in code (production failover unchanged)
--
-- RUN:
--   Local Supabase:  supabase db reset  (or apply this file in SQL editor)
--   Hosted project:  run in Supabase SQL Editor ONLY for local-dev testing.
--                    Revert primary to 'cleanapis' before production use.
--
-- PREREQUISITES (server-side, never client):
--   supabase/functions/.env.local (for `supabase functions serve`):
--     OPENAI_BASE_URL=http://localhost:20128/v1
--     OPENAI_MODEL=Jarvis
--     OPENAI_API_KEY=<your Jarvis AUTH_TOKEN>
--   Hosted: supabase secrets set OPENAI_BASE_URL=... OPENAI_MODEL=Jarvis
--           + set OPENAI_API_KEY via node scripts/set-supabase-secret.mjs
--
-- NOTE: http://localhost:20128 is reachable from `supabase functions serve`
-- on YOUR machine only. Hosted Edge Functions cannot reach your laptop's
-- localhost — for hosted testing expose Jarvis via a tunnel and set that URL
-- as OPENAI_BASE_URL instead.
-- ============================================================================

begin;

-- Ensure the singleton settings row exists (same shape as the router seed).
insert into public.hr_platform_settings (id)
values (1)
on conflict (id) do nothing;

-- Point SARA at the local Jarvis endpoint first; keep failover intact.
update public.hr_platform_settings
   set ai_primary_provider = 'openai',
       ai_fallback_providers = coalesce(
         ai_fallback_providers,
         '["groq","rules","openai","nvidia"]'::jsonb
       ),
       ai_model_selection = coalesce(ai_model_selection, '{}'::jsonb)
                              || '{"openai":"Jarvis"}'::jsonb,
       ai_failover_enabled = true
 where id = 1;

-- Register the Jarvis model id on the openai catalog row so the Platform
-- Settings picker can display it (display only — routing uses the pin above
-- plus the OPENAI_MODEL env fallback in aiRouter.ts).
update public.ai_providers
   set models = case
         when models::text like '%Jarvis%' then models
         else coalesce(models, '[]'::jsonb)
              || '{"id":"Jarvis","label":"Jarvis (local)","capabilities":["chat","json","tools"]}'::jsonb
       end,
       updated_at = now()
 where id = 'openai';

-- One health row for openai (no-op if already present).
insert into public.provider_health (provider_id)
select 'openai'
where exists (select 1 from public.ai_providers where id = 'openai')
on conflict (provider_id) do nothing;

commit;
