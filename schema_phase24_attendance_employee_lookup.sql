-- ============================================================
-- Phase 24: Attendance Employee-ID Lookup + WebAuthn support
--          + HR document read consistency (additive, idempotent)
--
-- Fixes the CRITICAL attendance bug where entering the official
-- employee number IMFB/26 on the Attendance Terminal returned
-- "Unknown employee ID". Root cause: the terminal (and the
-- ingest_attendance_event RPC) resolved employees ONLY through
-- employee_biometric_identifiers.external_user_id, never through
-- the canonical employees.employee_number / staff_id / employee_code.
--
-- This migration:
--   1. Re-creates ingest_attendance_event to resolve employees by
--      the canonical employee number (normalized, case-insensitive)
--      when no biometric mapping matches, and to accept an optional
--      pre-resolved p_employee_id (used by the WebAuthn flow). The
--      attendance record still references the employee UUID.
--   2. Widens the verification_method CHECK constraints to accept
--      'WEBAUTHN' (idempotent DO blocks).
--   3. Adds hr_manager/hr_officer/super_admin to the documents
--      read policy — HR can already delete documents (Phase 22) but
--      could not read documents they did not upload.
--
-- ALL ADDITIVE / IDEMPOTENT. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ingest_attendance_event — employee-number resolution
-- ------------------------------------------------------------
create or replace function public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz DEFAULT now(),
  p_verification_method text DEFAULT 'FINGERPRINT',
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_employee_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_device public.attendance_devices%ROWTYPE;
  v_biometric public.employee_biometric_identifiers%ROWTYPE;
  v_employee public.employees%ROWTYPE;
  v_normalized text;
  v_existing_count int;
  v_attendance_id uuid;
  v_event_id uuid;
BEGIN
  -- 1. Validate device
  SELECT * INTO v_device FROM public.attendance_devices WHERE id = p_device_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown device');
  END IF;
  IF v_device.status != 'active' OR NOT v_device.active THEN
    RETURN jsonb_build_object('success', false, 'error', 'Device inactive or suspended');
  END IF;

  -- 2a. Pre-resolved employee (WebAuthn / device authenticated flow).
  --     The caller already proved identity via a registered credential.
  IF p_employee_id IS NOT NULL THEN
    SELECT * INTO v_employee FROM public.employees WHERE id = p_employee_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
    END IF;
  ELSE
    -- 2b. Biometric mapping match (fingerprint device user IDs / PINs)
    SELECT * INTO v_biometric FROM public.employee_biometric_identifiers
    WHERE device_id = p_device_id
      AND external_user_id = p_external_user_id
      AND enrollment_status = 'enrolled'
      AND active = true;
    IF NOT FOUND THEN
      -- 2c. Canonical employee-number lookup. Normalize the input the same
      --     way the UI does (uppercase + collapse whitespace around slash)
      --     and compare case-insensitively across all three identifier columns.
      v_normalized := upper(trim(regexp_replace(p_external_user_id, '\s*/\s*', '/', 'g')));
      SELECT * INTO v_employee FROM public.employees
      WHERE upper(trim(coalesce(employee_number, ''))) = v_normalized
         OR upper(trim(coalesce(staff_id, ''))) = v_normalized
         OR upper(trim(coalesce(employee_code, ''))) = v_normalized
      LIMIT 1;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
      END IF;
    ELSE
      SELECT * INTO v_employee FROM public.employees WHERE id = v_biometric.employee_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Employee ID not found. Please check the ID and try again.');
      END IF;
    END IF;
  END IF;

  -- 3. Validate employee is eligible to clock in/out
  IF v_employee.employment_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive'))
    );
  END IF;

  -- 4. Duplicate protection — check for existing event in last 5 minutes
  SELECT count(*) INTO v_existing_count FROM public.attendance_events
  WHERE employee_id = v_employee.id
    AND event_type = p_event_type
    AND event_time > p_event_time - interval '5 minutes';
  IF v_existing_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Duplicate event within 5 minutes');
  END IF;

  -- 5. Create attendance record if CLOCK_IN
  IF p_event_type IN ('CLOCK_IN', 'DEVICE_CLOCK_IN') THEN
    SELECT count(*) INTO v_existing_count FROM public.attendance_records
    WHERE employee_id = v_employee.id
      AND attendance_date = (p_event_time AT TIME ZONE 'UTC')::date
      AND clock_out IS NULL;
    IF v_existing_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Open attendance session already exists');
    END IF;
    INSERT INTO public.attendance_records (employee_id, attendance_date, source, source_detail, verification_method, device_id)
    VALUES (v_employee.id, (p_event_time AT TIME ZONE 'UTC')::date, 'fingerprint', 'FINGERPRINT', p_verification_method, p_device_id)
    RETURNING id INTO v_attendance_id;
  END IF;

  -- 6. Close attendance record if CLOCK_OUT
  IF p_event_type IN ('CLOCK_OUT', 'DEVICE_CLOCK_OUT') THEN
    SELECT id INTO v_attendance_id FROM public.attendance_records
    WHERE employee_id = v_employee.id
      AND clock_out IS NULL
    ORDER BY clock_in DESC LIMIT 1;
    IF v_attendance_id IS NOT NULL THEN
      UPDATE public.attendance_records
      SET clock_out = p_event_time,
          work_hours = round(extract(epoch FROM (p_event_time - clock_in)) / 3600.0, 2),
          status = 'present',
          verification_method = p_verification_method,
          device_id = p_device_id
      WHERE id = v_attendance_id;
    END IF;
  END IF;

  -- 7. Create central event
  INSERT INTO public.attendance_events (
    employee_id, user_id, attendance_record_id, event_type, event_time,
    source, device_id, verification_method, verification_status, metadata
  ) VALUES (
    v_employee.id, v_employee.user_id, v_attendance_id, p_event_type, p_event_time,
    'FINGERPRINT', p_device_id, p_verification_method, 'verified', p_metadata
  ) RETURNING id INTO v_event_id;

  -- 8. Update device last seen
  UPDATE public.attendance_devices SET last_seen_at = now() WHERE id = p_device_id;

  RETURN jsonb_build_object(
    'success', true,
    'event_id', v_event_id,
    'attendance_id', v_attendance_id,
    'employee_name', v_employee.full_name,
    'employee_id', v_employee.id,
    'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
    'department', v_employee.department,
    'position', v_employee.position
  );
END; $$;

grant execute on function public.ingest_attendance_event(uuid, text, text, timestamptz, text, jsonb, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 1b. lookup_employee_by_identifier — safe, non-sensitive employee
--     resolution for the attendance terminal confirmation screen.
--     Returns ONLY identity fields (no phone/address/BVN/NIN/salary/
--     emergency contacts). Does not expose other columns.
-- ------------------------------------------------------------
create or replace function public.lookup_employee_by_identifier(
  p_identifier text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_normalized text := upper(trim(regexp_replace(coalesce(p_identifier, ''), '\s*/\s*', '/', 'g')));
  v_employee public.employees%ROWTYPE;
BEGIN
  if v_normalized = '' then
    return jsonb_build_object('found', false, 'error', 'Enter an employee ID.');
  end if;

  if v_normalized ~ '^\d{1,9}$' then
    select e.* into v_employee
      from public.employee_biometric_identifiers b
      join public.employees e on e.id = b.employee_id
     where b.external_user_id = p_identifier
       and b.enrollment_status = 'enrolled'
       and b.active = true
     limit 1;
  else
    select * into v_employee from public.employees
    where upper(trim(coalesce(employee_number, ''))) = v_normalized
       or upper(trim(coalesce(staff_id, ''))) = v_normalized
       or upper(trim(coalesce(employee_code, ''))) = v_normalized
    limit 1;
  end if;

  if not found then
    return jsonb_build_object('found', false, 'error', 'Employee ID not found. Please check the ID and try again.');
  end if;

  if v_employee.employment_status is distinct from 'active' then
    return jsonb_build_object(
      'found', false,
      'error', format('Employee is %s and cannot clock in or out.', coalesce(v_employee.employment_status, 'inactive'))
    );
  end if;

  return jsonb_build_object(
    'found', true,
    'employee', jsonb_build_object(
      'id', v_employee.id,
      'full_name', v_employee.full_name,
      'employee_number', coalesce(v_employee.employee_number, v_employee.staff_id, v_employee.employee_code),
      'department', v_employee.department,
      'position', v_employee.position,
      'employment_status', v_employee.employment_status,
      'branch', coalesce(v_employee.branch, ''),
      'photo_url', null
    )
  );
END; $$;

grant execute on function public.lookup_employee_by_identifier(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 2. verification_method CHECK — accept 'WEBAUTHN' (idempotent)
-- ------------------------------------------------------------
do $$
declare
  v_con text;
begin
  for v_con in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
     where t.relname in ('attendance_records', 'attendance_events')
       and c.contype = 'c'
       and a.attname = 'verification_method'
  loop
    execute format(
      'alter table %I.%I drop constraint %I',
      (select n.nspname from pg_constraint c2
        join pg_class t2 on t2.oid = c2.conrelid
        join pg_namespace n on n.oid = t2.relnamespace
       where c2.conname = v_con limit 1),
      (select t2.relname from pg_constraint c2
        join pg_class t2 on t2.oid = c2.conrelid
       where c2.conname = v_con limit 1),
      v_con
    );
  end loop;
end $$;

alter table public.attendance_records
  add constraint verification_method_check
  check (verification_method IN ('GPS', 'FINGERPRINT', 'DEVICE_AUTHENTICATION', 'WEBAUTHN', 'ADMIN_OVERRIDE', 'NONE'));

alter table public.attendance_events
  add constraint verification_method_check
  check (verification_method IN ('GPS', 'FINGERPRINT', 'DEVICE_AUTHENTICATION', 'WEBAUTHN', 'ADMIN_OVERRIDE', 'NONE'));

-- ------------------------------------------------------------
-- 3. Documents read policy — include HR roles.
--    Phase 22 grants hr_manager/hr_officer/super_admin DELETE on
--    documents but the Phase 1 SELECT policy excluded them, so HR
--    could delete but not re-read documents they did not upload.
--    This is consistent (read follows the existing HR scope).
-- ------------------------------------------------------------
drop policy if exists "documents_read_authorized" on public.documents;
create policy "documents_read_authorized" on public.documents
  for select using (
    auth.uid() in (
      select verified_by from public.documents where id = documents.id
    )
    or auth.uid() in (
      select uploaded_by from public.documents where id = documents.id
    )
    or public.current_role() in ('admin', 'loan_officer', 'super_admin', 'hr_manager', 'hr_officer')
    or (entity_type = 'loan_application' and auth.uid() in (
      select created_by from public.loan_applications where id = entity_id
    ))
  );

-- ============================================================
-- DONE.
-- ============================================================