-- ============================================================================
-- schema_phase36_biometric_webauthn_direct.sql
-- ============================================================================
-- Purpose:
--   Enables direct client-side WebAuthn registration, device mapping, and
--   biometric lookup RPCs for the Attendance Terminal and Biometrics page,
--   allowing devices with fingerprint scanners / passkeys to map and clock in
--   instantly without requiring external edge functions.
--
-- Idempotent / safe to re-run.
-- ============================================================================

-- 1. RPC: register_employee_webauthn_credential
CREATE OR REPLACE FUNCTION public.register_employee_webauthn_credential(
  p_employee_id uuid,
  p_credential_id text,
  p_public_key text,
  p_device_name text DEFAULT 'Device Passkey',
  p_authenticator_type text DEFAULT 'platform'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.current_role() NOT IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
     AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = p_employee_id AND e.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to register biometric credential';
  END IF;

  INSERT INTO public.employee_auth_credentials (
    employee_id, external_id, public_key, device_name, authenticator_type, created_by, created_at
  ) VALUES (
    p_employee_id, p_credential_id, p_public_key, p_device_name, p_authenticator_type, auth.uid(), now()
  )
  ON CONFLICT (employee_id, external_id) DO UPDATE SET
    public_key = EXCLUDED.public_key,
    device_name = EXCLUDED.device_name,
    revoked_at = NULL,
    revoked_by = NULL;

  INSERT INTO public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  VALUES (
    'BIOMETRIC_CREDENTIAL_REGISTERED',
    'EmployeeAuthCredential',
    p_employee_id::text,
    coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), 'System'),
    format('Biometric device %s registered for employee %s', p_device_name, p_employee_id),
    'info'
  );

  RETURN jsonb_build_object('ok', true, 'employee_id', p_employee_id);
END; $$;

GRANT EXECUTE ON FUNCTION public.register_employee_webauthn_credential(uuid, text, text, text, text) TO authenticated;

-- 2. RPC: lookup_employee_by_webauthn_credential
CREATE OR REPLACE FUNCTION public.lookup_employee_by_webauthn_credential(
  p_credential_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cred record;
  v_emp record;
BEGIN
  SELECT * INTO v_cred FROM public.employee_auth_credentials
  WHERE external_id = p_credential_id AND revoked_at IS NULL
  LIMIT 1;

  IF v_cred.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'error', 'Biometric credential not mapped to an active employee');
  END IF;

  SELECT id, full_name, employee_number, employee_code, staff_id, department, branch, branch_id, position, employment_status
  INTO v_emp FROM public.employees WHERE id = v_cred.employee_id;

  IF v_emp.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'error', 'Linked employee record not found');
  END IF;

  UPDATE public.employee_auth_credentials SET last_used_at = now() WHERE id = v_cred.id;

  RETURN jsonb_build_object(
    'found', true,
    'employee', row_to_json(v_emp),
    'credential_id', v_cred.id,
    'device_name', v_cred.device_name
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.lookup_employee_by_webauthn_credential(text) TO anon, authenticated;

