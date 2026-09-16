-- ============================================================
-- Phase 25: Employee WebAuthn / FIDO2 credential management
--          (additive, idempotent)
--
-- Implements secure biometric enrollment for the Attendance
-- Terminal (and HR-managed employee credentials).
--
-- Security model:
--   * We NEVER store raw biometrics (fingerprints / Face ID data).
--     We store only the WebAuthn public key + credential ID that a
--     user's authenticator (phone, laptop, YubiKey) created locally.
--     The biometric itself never leaves the device.
--   * No plaintext challenges; one-time challenges expire in 10 min.
--   * Credentials are created/authenticated through Supabase Edge
--     Functions (service role). Direct table access is blocked by RLS.
--   * Credential revocation is a soft revoke via a SECURITY DEFINER
--     RPC that only HR or the owning employee can call.
--
-- Tables:
--   employee_auth_credentials — public keys + metadata per employee.
--   webauthn_challenges       — one-time, short-lived challenges.
--
-- ALL ADDITIVE / IDEMPOTENT. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. employee_auth_credentials
-- ------------------------------------------------------------
create table if not exists public.employee_auth_credentials (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  external_id text not null,
  public_key text not null,
  counter bigint not null default 0,
  device_name text,
  authenticator_type text default 'platform' check (authenticator_type in ('platform', 'cross-platform')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null,
  unique (employee_id, external_id)
);

create index if not exists idx_ea_creds_employee ON public.employee_auth_credentials(employee_id);
create unique index if not exists idx_ea_creds_external ON public.employee_auth_credentials(external_id) where revoked_at is null;

alter table public.employee_auth_credentials enable row level security;

-- SELECT: HR/managers see all; employees see their own credentials only
drop policy if exists "ea_cred_read" on public.employee_auth_credentials;
create policy "ea_cred_read" on public.employee_auth_credentials
  for select using (
    auth.role() = 'authenticated' AND (
      public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
      OR employee_id IN (
        select e.id from public.employees e where e.user_id = auth.uid()
      )
    )
  );

-- INSERT/UPDATE/DELETE are NOT granted to clients. Only the WebAuthn
-- Edge Functions (service role, bypasses RLS) write credentials, and
-- revocation goes through the revoke_employee_credential RPC below.

-- ------------------------------------------------------------
-- 2. webauthn_challenges — one-time, short-lived
-- ------------------------------------------------------------
create table if not exists public.webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null unique,
  employee_id uuid references public.employees(id) on delete cascade,
  purpose text not null check (purpose in ('register', 'authenticate')),
  created_by uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz,
  consumed_external_id text,
  created_at timestamptz default now()
);

create index if not exists idx_wa_challenges_expires ON public.webauthn_challenges(expires_at);
create index if not exists idx_wa_challenges_used ON public.webauthn_challenges(used_at);

alter table public.webauthn_challenges enable row level security;

-- No direct client access — challenges are created and consumed only
-- by the Edge Functions (service role). No SELECT/INSERT/UPDATE policies.

-- ------------------------------------------------------------
-- 3. RPC: revoke_employee_credential (HR or owning employee)
-- ------------------------------------------------------------
create or replace function public.revoke_employee_credential(
  p_credential_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cred public.employee_auth_credentials%ROWTYPE;
  v_actor_employee_id uuid;
  v_owns boolean;
BEGIN
  select * into v_cred from public.employee_auth_credentials where id = p_credential_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Credential not found');
  end if;

  -- Actor must be HR/manager, or the employee who owns the credential
  select e.id into v_actor_employee_id from public.employees e where e.user_id = auth.uid();

  v_owns := v_actor_employee_id is not null and v_actor_employee_id = v_cred.employee_id;

  if not (
    public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or v_owns
  ) then
    return jsonb_build_object('success', false, 'error', 'Not authorized to revoke this credential');
  end if;

  if v_cred.revoked_at is not null then
    return jsonb_build_object('success', true, 'already_revoked', true, 'credential_id', v_cred.id);
  end if;

  update public.employee_auth_credentials
    set revoked_at = now(), revoked_by = auth.uid()
  where id = p_credential_id;

  insert into public.audit_logs (
    action, entity_type, entity_id, user_name,
    details, severity
  ) values (
    'CREDENTIAL_REVOKED',
    'EmployeeCredential',
    v_cred.id::text,
    (select full_name from public.profiles where id = auth.uid()),
    format('WebAuthn credential %s for employee %s revoked', v_cred.external_id, v_cred.employee_id),
    'warning'
  );

  return jsonb_build_object('success', true, 'credential_id', v_cred.id);
END; $$;

grant execute on function public.revoke_employee_credential(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. RPC: list my own credentials (self-service, RLS-safe)
-- ------------------------------------------------------------
create or replace function public.list_my_auth_credentials()
RETURNS setof public.employee_auth_credentials
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  select c.* from public.employee_auth_credentials c
  join public.employees e on e.id = c.employee_id
  where e.user_id = auth.uid()
    and c.revoked_at is null
  order by c.created_at desc;
$$;

grant execute on function public.list_my_auth_credentials() to authenticated;

-- ============================================================
-- DONE.
-- ============================================================