// Supabase Edge Function: google-oauth-start
//
// NOTE: This function is INTENTIONALLY NOT DEPLOYED as a live function.
// The Google OAuth authorize step is built CLIENT-SIDE by
// `connectGoogleCalendar()` in src/services/interviewService.js, which opens
// the Google consent URL in a popup:
//
//   https://accounts.google.com/o/oauth2/v2/auth
//     ?client_id=<VITE_GOOGLE_CLIENT_ID>
//     &redirect_uri=<SUPABASE_URL>/functions/v1/oauth-callback?provider=google_calendar
//     &response_type=code
//     &scope=<calendar + userinfo.email>
//     &access_type=offline&prompt=consent
//     &state=google_calendar:<userId>
//
// Google redirects back to the DEPLOYED `oauth-callback` function, which
// exchanges the code using the SERVER-side Supabase secrets GOOGLE_CLIENT_ID
// / GOOGLE_CLIENT_SECRET and stores the tokens in integration_connections.
//
// WHY THIS FILE EXISTS
// An empty `supabase/functions/google-oauth-start/` directory ships in the
// repo (leftover stub). An empty directory with no index.ts is NOT a valid
// function — `supabase functions deploy google-oauth-start` fails, and if a
// half-deployed stub ever existed it would shadow nothing but confuse every
// future deploy. This placeholder pins the directory's purpose so nobody
// "finishes" it into a second, divergent authorize path: there must be ONE
// authorize URL builder (the client) and ONE token exchanger
// (oauth-callback). DO NOT deploy this as a function.
//
// LINKING CHECKLIST (all three must agree or the exchange fails):
//   1. Supabase dashboard → Project Settings → Edge Functions → Secrets:
//      GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (server-side,
//      used by oauth-callback for the code exchange AND by create-google-meet
//      for refresh_token rotation). The VITE_GOOGLE_CLIENT_ID app secret
//      alone is NOT enough for the token exchange.
//   2. Google Cloud console → APIs & Services → Credentials → OAuth 2.0
//      Client → Authorized redirect URIs must contain EXACTLY:
//        <SUPABASE_URL>/functions/v1/oauth-callback?provider=google_calendar
//      (byte-equal to the redirect_uri the client sends; a mismatch yields
//      redirect_uri_mismatch even with correct secrets).
//   3. Env: VITE_GOOGLE_CLIENT_ID (client authorize step) must be the same
//      OAuth client as the server-side GOOGLE_CLIENT_ID/SECRET pair.
//
// See also: supabase/functions/oauth-callback/index.ts (the exchanger),
// supabase/functions/create-google-meet/index.ts (the Meet creator).
export default {};
