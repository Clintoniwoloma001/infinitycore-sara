-- Phase 66 — Assessment template anti_cheat: default + NULL backfill.
--
-- Background:
--   schema_phase41_hr_career_lifecycle.sql defines
--     anti_cheat jsonb not null default '{"max_flags":3,...}'::jsonb
--   but the live DB has this column as `not null` WITHOUT a default (the
--   column predates the DEFAULT added to the migration file).  Template
--   creation intentionally omits anti_cheat when the caller doesn't supply
--   one, so the INSERT relies on the column DEFAULT.  With no DEFAULT present
--   the insert fails with:
--     null value in column "anti_cheat" of relation "assessment_templates"
--     violates not-null constraint
--
--   Even though assessmentService.createTemplate now always sends an explicit
--   anti_cheat value, this migration makes the database self-defending so no
--   future code path can reintroduce the failure:
--     1. Backfills any legacy NULL rows with the canonical default config.
--     2. Gives the column a proper DEFAULT (so omitted inserts succeed).
--     3. (Re-)asserts NOT NULL — safe once backfill has run.
--
-- Idempotent/additive — safe to re-run in Supabase SQL Editor.  On a DB that
-- already has the DEFAULT it is effectively a no-op.

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'assessment_templates'
       and column_name = 'anti_cheat'
  ) then
    -- Backfill rows created before the default existed.
    update public.assessment_templates
       set anti_cheat = jsonb_build_object(
             'max_flags', 3,
             'flag_severity', 'high',
             'close_on_flag', true,
             'require_hr_review', false,
             'retake_limit', 0,
             'retake_time_hours', 48,
             'keep_previous_attempt', true,
             'track_copy_paste', true,
             'track_context_menu', true,
             'track_fullscreen', true,
             'inactivity_timeout_minutes', 10
           )
     where anti_cheat is null;

    -- Proper DEFAULT for every future insert path.
    alter table public.assessment_templates
      alter column anti_cheat set default
      '{"max_flags":3,"flag_severity":"high","close_on_flag":true,"require_hr_review":false,"retake_limit":0,"retake_time_hours":48,"keep_previous_attempt":true,"track_copy_paste":true,"track_context_menu":true,"track_fullscreen":true,"inactivity_timeout_minutes":10}'::jsonb;

    -- Assert the constraint now that NULLs are gone.
    alter table public.assessment_templates
      alter column anti_cheat set not null;
  end if;
end;
$$;