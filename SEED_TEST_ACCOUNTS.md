# Seeding a Full 4-Stage Chain for Tonight's Rehearsal

`created_by` on leave_requests has a foreign-key constraint to
`auth.users`, so it MUST be a real signed-up account — fake/placeholder
IDs will fail. This takes about 5 minutes total.

## Step 1 — Sign up 4 real (throwaway) accounts

In your app's signup screen, create 4 accounts. Fastest way if you use
Gmail: Gmail treats `you+anything@gmail.com` as your own inbox, but
Supabase treats each as a distinct account. Use:

- `youremail+branchmgr@gmail.com`
- `youremail+areamgr@gmail.com`
- `youremail+headofbiz@gmail.com`
- `youremail+hr@gmail.com`

Any password is fine — you won't need to remember them individually if
you use one shared password for all 4 test accounts.

## Step 2 — Assign each one their role

Run this once, adjusting the emails to match what you actually used:

```sql
update public.profiles set role = 'branch_manager' where email = 'youremail+branchmgr@gmail.com';
update public.profiles set role = 'area_manager'   where email = 'youremail+areamgr@gmail.com';
update public.profiles set role = 'head_of_business' where email = 'youremail+headofbiz@gmail.com';
update public.profiles set role = 'hr_manager'      where email = 'youremail+hr@gmail.com';
```

## Step 3 — Seed their leave balances for this year

```sql
select public.reset_annual_leave_balances(2026);
```

(Safe to re-run — it only fills in balances that don't already exist.)

## Step 4 — Submit a real test request

Log in as your main Super Admin account (or any staff account), go to
Leave Requests, and submit a real request — e.g. 2 days Sick leave.
This is more convincing live than a SQL-inserted fake row, and avoids
any RLS/ownership edge cases entirely.

## Step 5 — Walk it through the chain live

1. Log in as the **Branch Manager** test account (separate browser or
   incognito window) → approve it → watch it forward to Area Manager.
2. Log in as **Area Manager** → approve → forwards to Head of Business.
3. Log in as **Head of Business** → approve → forwards to HR.
4. Log in as **HR** → approve → status flips to fully **Approved**, and
   the requester's leave balance visibly decreases.
5. Open "View approval trail" on the request at any point to show the
   full signed history — this is a strong visual for the board.

## Optional — test the cancellation-requires-reapproval flow

Once a request is fully Approved (step 4 above), go back to it as the
original requester and click **Request Cancellation**. It re-enters
the SAME 4-stage chain (starting at Branch Manager again) — walk it
through once more to show that a cancellation can't just be forced
through, and that the balance is only restored once HR gives final
sign-off on the cancellation too.

## If you're short on time before the board meeting

Steps 1–3 are the only setup you truly need done in advance. Steps 4–5
can be performed live, in front of the board, as the actual demo —
that's more compelling than a pre-baked example anyway.
