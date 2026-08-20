import { createClient } from '@supabase/supabase-js'

// Reads Supabase credentials from environment variables (Vite exposes VITE_* to the client).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Failsafe: if the required env vars are missing, `envMissing` is true and the
// app renders a configuration error screen instead of a blank/broken UI.
export const envMissing = !supabaseUrl || !supabaseAnonKey

export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder', {
  auth: { persistSession: true, autoRefreshToken: true },
})