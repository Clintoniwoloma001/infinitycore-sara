# Deploying the auto-escalation Edge Function

This runs the escalation check on a real schedule, server-side — not
dependent on anyone having the app open.

## 1. Install the Supabase CLI (one-time, on your machine)

```
npm install -g supabase
```

## 2. Log in and link your project

```
supabase login
supabase link --project-ref atzomqicwjufuxhfexxd
```

(Your project ref is the subdomain in your Supabase URL —
`atzomqicwjufuxhfexxd.supabase.co` — already correct above based on
what we've been using all session. Double check it matches your
project's Settings > General > Reference ID.)

## 3. Deploy the function

From your project root (where the `supabase/` folder now lives):

```
supabase functions deploy escalate-leave-requests
```

This uploads `supabase/functions/escalate-leave-requests/index.ts` to
Supabase. It does NOT run automatically yet — that's the next step.

## 4. Schedule it to run automatically (every hour)

Run this in the Supabase SQL Editor. It enables the two extensions
needed to call the function on a timer, then schedules it:

```sql
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'escalate-leave-requests-hourly',
  '0 * * * *', -- every hour, on the hour
  $$
  select net.http_post(
    url := 'https://atzomqicwjufuxhfexxd.supabase.co/functions/v1/escalate-leave-requests',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SERVICE_ROLE_KEY'
    )
  );
  $$
);
```

Replace `YOUR_SERVICE_ROLE_KEY` with your project's service role key
(Settings > API > service_role key — NOT the anon key, and never put
this key in your frontend `.env` or any client-side code — it belongs
only in this server-side scheduled SQL call).

## 5. Verify it's scheduled

```sql
select * from cron.job;
```

You should see `escalate-leave-requests-hourly` listed.

## 6. Test it manually right now (don't wait an hour)

```
supabase functions invoke escalate-leave-requests
```

Or trigger it via curl with your service role key, same URL as above.
Check the response — `{"escalated": N}` tells you how many requests it
just bumped.

## What changes vs. the client-side version

The `LeaveRequests.jsx` page-load escalation check can stay as a
harmless, instant backstop for the demo (it does the same thing the
moment someone views the page) — but this Edge Function is now the
real mechanism. Feel free to mention in the board demo that the
in-app indicator is backed by an hourly server-side job, not just
something that happens to run when a page loads.
