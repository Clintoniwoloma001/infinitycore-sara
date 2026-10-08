-- Idempotent SQL for web Google Calendar OAuth (run manually via psql/supabase)
-- Creates token storage table if missing; does NOT drop anything.
CREATE TABLE IF NOT EXISTS public.google_calendar_tokens (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token_encrypted TEXT,
  access_token_encrypted TEXT,
  email TEXT,
  connected_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.google_calendar_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "user_owns_token" ON public.google_calendar_tokens
  FOR ALL USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
