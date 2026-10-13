# Zoho Mail OAuth — Audit Automation (Server-Based Flow)

Secure, **server-side** OAuth 2.0 (authorization-code) foundation for the Head
of Audit's Zoho Mail account, using the **`.com` (US) data center**.

> **No email is sent by any of this code.** This phase only connects the mailbox
> and lets the Head of Audit verify the sending account + From address. Sending
> stays disabled until an explicit later decision (requirement 9).

## Why server-side (not browser OAuth)

Unlike the Google Calendar/Zoom flows (which build the authorize URL in the
browser), this integration is a **Server-based Application** flow:

- `zoho-oauth-start` builds the Zoho authorize URL **on the server** and issues
  a single-use CSRF `state`. The browser only *opens* that URL.
- `zoho-oauth-callback` (a browser redirect target) validates + consumes the
  state, exchanges the code for tokens **on the server**, and stores the refresh
  token **AES-256-GCM encrypted**. It never returns a token or secret.
- `zoho-mail-status` is a backend-only status/test function (JWT + role gated).

The Client Secret, refresh token, and encryption key never reach the frontend,
logs, API responses, or the mobile app.

## Edge Functions

| Function | verify_jwt | Purpose |
|---|---|---|
| `zoho-oauth-start` | true | Builds the authorize URL server-side; issues single-use state. Head of Audit / admin only. |
| `zoho-oauth-callback` | **false** | Zoho redirect target. Validates + consumes state, exchanges code, stores encrypted refresh token. No JWT (security = single-use state). |
| `zoho-mail-status` | true | Backend-only status + no-send verification test. Head of Audit / admin only. |

Shared pure logic: `supabase/functions/_shared/zoho-mail.mjs` (endpoints,
scopes, state, token bodies, account parser, AES-256-GCM crypto). Unit-tested
in `tests/zohoMailOauth.test.mjs`.

Migration: `supabase/migrations/20261114000000_zoho_mail_oauth_foundation.sql`
(widens `integration_connections.provider` to `zoho_mail`, adds
`provider_account_id`, creates the RLS-locked `zoho_oauth_states` table).

## 1. Callback URL to register in the Zoho API Console

The callback URL is **derived** from the live Supabase project URL (never
hard-coded). For this project (`atzomqicwjufuxhfexxd`) it is:

```
https://atzomqicwjufuxhfexxd.supabase.co/functions/v1/zoho-oauth-callback
```

In the Zoho API Console → your **Server-based Application** → **Authorized
redirect URIs**, add **exactly** the URL above. It must be byte-identical to the
`redirect_uri` the server sends (both use `buildRedirectUri()`), or Zoho rejects
the exchange with `redirect_uri_mismatch`.

If you ever point the functions at a different public URL, set
`OAUTH_REDIRECT_BASE` to that origin on **all three** functions so authorize and
token-exchange stay in sync. Leave it unset to use `SUPABASE_URL` (recommended).


## 2. Required server-side secrets

Set these with the Supabase CLI (they must **never** go in `.env`,
`VITE_*`, or the client bundle):

```
supabase secrets set ZOHO_CLIENT_ID=1000.XXXXXXXX
supabase secrets set ZOHO_CLIENT_SECRET=xxxxxxxxxxxxxxxx
supabase secrets set ZOHO_TOKEN_ENCRYPTION_KEY=<32-byte key, base64 or 64-char hex>
```

- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` — from the Zoho API Console app.
- `ZOHO_TOKEN_ENCRYPTION_KEY` — **you generate this**; it encrypts the stored
  refresh token at rest. Generate 32 random bytes, e.g.:
  `openssl rand -base64 32` (or `openssl rand -hex 32`). Store it once; if it is
  lost, the stored refresh token cannot be decrypted and the mailbox must be
  re-connected.

Verify with `supabase secrets list` (values are never printed by this repo).

## 3. Exact scopes requested (least privilege)

```
ZohoMail.messages.CREATE,ZohoMail.accounts.READ
```

- `ZohoMail.messages.CREATE` — the "Send an Email" API
  (`POST /api/accounts/{accountId}/messages`). `.CREATE`, **not** `.ALL`.
- `ZohoMail.accounts.READ` — the "Get All Accounts of a User" API
  (`GET /api/accounts`), used to read the sending `accountId` and permitted From
  addresses. `.READ` is the least-privileged account scope; `.ALL` is broader and
  not requested.

Both scopes must be enabled for the client in the Zoho API Console.

## 4. Endpoints used (`.com`)

- Authorize: `https://accounts.zoho.com/oauth/v2/auth`
  (`access_type=offline`, `prompt=consent` → refresh token)
- Token: `https://accounts.zoho.com/oauth/v2/token`
  (`grant_type=authorization_code`, then `refresh_token`)
- Mail API base: `https://mail.zoho.com/api/`
- Get All Accounts: `GET https://mail.zoho.com/api/accounts`

## 5. Deploy

```
supabase link --project-ref atzomqicwjufuxhfexxd
supabase functions deploy zoho-oauth-start
supabase functions deploy zoho-oauth-callback
supabase functions deploy zoho-mail-status
```

Apply the migration in the Supabase SQL Editor (idempotent, additive):

```
-- run supabase/migrations/20261114000000_zoho_mail_oauth_foundation.sql
```

## 6. Safe test procedure (no email is sent)

1. Confirm secrets are set: `supabase secrets list` shows `ZOHO_CLIENT_ID`,
   `ZOHO_CLIENT_SECRET`, `ZOHO_TOKEN_ENCRYPTION_KEY`.
2. Sign in to InfinityCore as the **Head of Audit** (or admin).
3. Trigger **Connect Zoho Mail** (calls `zoho-oauth-start`, opens the Zoho
   consent popup). Approve the two scopes.
4. The popup shows "✓ Zoho Mail Connected" and closes. The callback has stored
   the **encrypted** refresh token; `audit_logs` gains `ZOHO_MAIL_CONNECTED`.
5. Click **Test connection** (calls `zoho-mail-status` with `{ test: true }`).
   It refreshes the token server-side and reads `/api/accounts`. It reports the
   `accountId`, `primaryEmail`, and permitted `fromAddresses` so the Head of
   Audit can confirm the sending mailbox. **No email is sent.**
6. Expected result: `ok: true`, `readyToSend: false`, and a real `accountId` /
   From address. If it returns `not_configured`, the secrets are missing; if
   `accounts_api_failed`, the `ZohoMail.accounts.READ` scope is not granted.

### Negative checks (security)

- Re-using the callback URL, or replaying the same `state`, is rejected
  (`ZOHO_OAUTH_STATE_REJECTED`).
- An expired `state` (10-minute TTL) is rejected.
- A non-Head-of-Audit/non-admin caller cannot start the flow or read status
  (403).
- No response, log, or table column readable by the client ever contains the
  Client Secret, refresh token, access token, or encryption key.

## Frontend

`src/services/zohoMailService.js` is intentionally thin: `connectZohoMail()`
opens the server-built URL in a popup and awaits the result message;
`getZohoMailStatus()` / `testZohoMailConnection()` read the masked status. It
never builds a Zoho URL and never handles a secret.
