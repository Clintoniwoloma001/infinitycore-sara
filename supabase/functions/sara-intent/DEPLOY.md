# Deploying the SARA NLU Edge Function (sara-intent)

This gives SARA hybrid understanding: the deterministic parser in the
browser handles fast, offline phrases; when it fails, the app asks this
function, which authenticates the caller, re-derives their allowed
intents server-side, and calls OpenAI for a structured parse.

The OpenAI key NEVER leaves the server. It is read from function
secrets only — it must NOT be added to the frontend `.env` or any
client bundle.

## 1. Install the Supabase CLI (one-time)

```
npm install -g supabase
```

## 2. Link to your project

```
supabase login
supabase link --project-ref atzomqicwjufuxhfexxd
```

(Project ref = subdomain of your Supabase URL —
`atzomqicwjufuxhfexxd.supabase.co`.)

## 3. Set the server-side secret

```
supabase secrets set OPENAI_API_KEY=sk-your-key-here
```

Do NOT put this in `.env`. Verify with:

```
supabase secrets list
```

## 4. Deploy

```
supabase functions deploy sara-intent
```

## 5. Test it (must be signed in to Supabase for the JWT)

```
supabase functions invoke sara-intent --env-file .env.local --body '{"text":"how many leave approvals do I have","route":"/leave-requests","permissions":["SHOW_PENDING","APPROVE_LEAVE"]}'
```

Or from the app UI: open SARA, try a sentence the regex parser can't
parse (e.g. "give me today's operational summary"). If the function
isn't deployed, SARA degrades gracefully and keeps working.

## Behavior notes

- The function authenticates the caller via their Bearer JWT
  (`supabase.auth.getUser()`). A missing/invalid JWT → 401/403.
- Allowed intents are derived server-side from `v_user_permissions`
  (RLS-scoped to the user's own row), intersected with what the client
  asked for. `APPROVE_LEAVE`/`REJECT_LEAVE` require `hr.leave.manage` or
  an approver role.
- The function records nothing and executes nothing. Consequential
  execution remains the responsibility of `agentService` +
  `executeLeaveDecision` + RLS, exactly as before.