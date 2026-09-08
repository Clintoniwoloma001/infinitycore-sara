-- ============================================================
-- PHASE 11: INFINITYCORE ATTENDANCE ENGINE
-- Centralized attendance with geofencing, device registry,
-- biometric mapping, terminal mode, and audit trail.
--
-- ALL ADDITIVE. Safe to re-run (IF NOT EXISTS / OR REPLACE).
-- Extends existing attendance_records — does NOT replace them.
-- ============================================================

-- ============================================================
-- 1. ATTENDANCE GEOFENCES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.attendance_geofences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  branch_id text,
  location_name text,
  latitude numeric(10, 7) NOT NULL,
  longitude numeric(10, 7) NOT NULL,
  radius_meters integer NOT NULL DEFAULT 150,
  active boolean DEFAULT true,
  clock_in_allowed boolean DEFAULT true,
  clock_out_allowed boolean DEFAULT true,
  department text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geofence_active ON public.attendance_geofences(active);
CREATE INDEX IF NOT EXISTS idx_geofence_branch ON public.attendance_geofences(branch_id);

ALTER TABLE public.attendance_geofences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "geofence_read" ON public.attendance_geofences;
CREATE POLICY "geofence_read" ON public.attendance_geofences
  FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "geofence_manage" ON public.attendance_geofences;
CREATE POLICY "geofence_manage" ON public.attendance_geofences
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager'));

-- ============================================================
-- 2. ATTENDANCE DEVICES (fingerprint, terminal, biometric)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.attendance_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name text NOT NULL,
  device_type text NOT NULL DEFAULT 'fingerprint'
    CHECK (device_type IN ('fingerprint', 'face', 'biometric', 'attendance_terminal', 'kiosk')),
  manufacturer text,
  model text,
  serial_number text,
  branch_id text,
  location_id uuid REFERENCES public.attendance_geofences(id) ON DELETE SET NULL,
  api_endpoint text,
  integration_type text DEFAULT 'api'
    CHECK (integration_type IN ('api', 'webhook', 'local_agent', 'manual_import')),
  status text DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended', 'offline')),
  last_seen_at timestamptz,
  device_token text, -- hashed token for device auth (never raw)
  active boolean DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_status ON public.attendance_devices(status);
CREATE INDEX IF NOT EXISTS idx_device_branch ON public.attendance_devices(branch_id);

ALTER TABLE public.attendance_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "device_read" ON public.attendance_devices;
CREATE POLICY "device_read" ON public.attendance_devices
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "device_manage" ON public.attendance_devices;
CREATE POLICY "device_manage" ON public.attendance_devices
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager'));

-- ============================================================
-- 3. EMPLOYEE BIOMETRIC IDENTIFIERS
-- Maps InfinityCore employees to external biometric device identities
-- ============================================================
CREATE TABLE IF NOT EXISTS public.employee_biometric_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.attendance_devices(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  enrollment_status text DEFAULT 'not_enrolled'
    CHECK (enrollment_status IN ('not_enrolled', 'pending', 'enrolled', 'disabled')),
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (device_id, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_biometric_emp ON public.employee_biometric_identifiers(employee_id);
CREATE INDEX IF NOT EXISTS idx_biometric_device ON public.employee_biometric_identifiers(device_id);

ALTER TABLE public.employee_biometric_identifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "biometric_read" ON public.employee_biometric_identifiers;
CREATE POLICY "biometric_read" ON public.employee_biometric_identifiers
  FOR SELECT USING (auth.role() = 'authenticated' AND public.current_role() NOT IN ('customer'));
DROP POLICY IF EXISTS "biometric_manage" ON public.employee_biometric_identifiers;
CREATE POLICY "biometric_manage" ON public.employee_biometric_identifiers
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager'));

-- ============================================================
-- 4. ATTENDANCE EVENTS (central event log)
-- All clocking channels feed into this table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  attendance_record_id uuid REFERENCES public.attendance_records(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END',
    'MANUAL_ADJUSTMENT', 'DEVICE_CLOCK_IN', 'DEVICE_CLOCK_OUT'
  )),
  event_time timestamptz DEFAULT now(),
  source text NOT NULL DEFAULT 'WEB' CHECK (source IN (
    'WEB', 'MOBILE', 'FINGERPRINT', 'BIOMETRIC_DEVICE',
    'ATTENDANCE_TERMINAL', 'ADMIN', 'API', 'IMPORT'
  )),
  device_id uuid REFERENCES public.attendance_devices(id) ON DELETE SET NULL,
  terminal_id text,
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  geofence_id uuid REFERENCES public.attendance_geofences(id) ON DELETE SET NULL,
  geofence_distance numeric(10, 2),
  location_status text CHECK (location_status IN ('inside', 'outside', 'unknown', 'not_applicable')),
  verification_method text DEFAULT 'NONE' CHECK (verification_method IN (
    'GPS', 'FINGERPRINT', 'DEVICE_AUTHENTICATION', 'ADMIN_OVERRIDE', 'NONE'
  )),
  verification_status text DEFAULT 'pending' CHECK (verification_status IN (
    'verified', 'unverified', 'failed', 'pending', 'bypassed'
  )),
  late_status boolean DEFAULT false,
  late_reason text,
  late_minutes integer,
  early_departure_minutes integer,
  issue_status text,
  ip_address text,
  user_agent text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_emp ON public.attendance_events(employee_id);
CREATE INDEX IF NOT EXISTS idx_event_time ON public.attendance_events(event_time);
CREATE INDEX IF NOT EXISTS idx_event_source ON public.attendance_events(source);
CREATE INDEX IF NOT EXISTS idx_event_device ON public.attendance_events(device_id);

ALTER TABLE public.attendance_events ENABLE ROW LEVEL SECURITY;
-- Employees see their own events; HR/managers see all
DROP POLICY IF EXISTS "event_read_self" ON public.attendance_events;
CREATE POLICY "event_read_self" ON public.attendance_events
  FOR SELECT USING (
    auth.role() = 'authenticated' AND (
      public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
      OR user_id = auth.uid()
      OR employee_id IN (
        SELECT e.id FROM public.employees e WHERE e.user_id = auth.uid()
      )
    )
  );
DROP POLICY IF EXISTS "event_insert_self" ON public.attendance_events;
CREATE POLICY "event_insert_self" ON public.attendance_events
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' AND (
      user_id = auth.uid()
      OR employee_id IN (
        SELECT e.id FROM public.employees e WHERE e.user_id = auth.uid()
      )
      OR public.current_role() IN ('super_admin', 'admin', 'hr_manager')
    )
  );
DROP POLICY IF EXISTS "event_manage" ON public.attendance_events;
CREATE POLICY "event_manage" ON public.attendance_events
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager'));

-- ============================================================
-- 5. EXTEND attendance_records with geofence + source columns
-- ============================================================
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS geofence_id uuid REFERENCES public.attendance_geofences(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS geofence_distance numeric(10, 2),
  ADD COLUMN IF NOT EXISTS location_status text DEFAULT 'unknown'
    CHECK (location_status IN ('inside', 'outside', 'unknown', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS verification_method text DEFAULT 'NONE'
    CHECK (verification_method IN ('GPS', 'FINGERPRINT', 'DEVICE_AUTHENTICATION', 'ADMIN_OVERRIDE', 'NONE')),
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES public.attendance_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS late_status boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_reason text,
  ADD COLUMN IF NOT EXISTS late_minutes integer,
  ADD COLUMN IF NOT EXISTS early_departure_minutes integer,
  ADD COLUMN IF NOT EXISTS source_detail text DEFAULT 'WEB'
    CHECK (source_detail IN ('WEB', 'MOBILE', 'FINGERPRINT', 'BIOMETRIC_DEVICE', 'ATTENDANCE_TERMINAL', 'ADMIN', 'API', 'IMPORT'));

-- Update the source check constraint to include new sources
ALTER TABLE public.attendance_records DROP CONSTRAINT IF EXISTS attendance_records_source_check;
ALTER TABLE public.attendance_records ADD CONSTRAINT attendance_records_source_check
  CHECK (source IN ('web', 'mobile', 'flutter', 'admin', 'fingerprint', 'biometric_device', 'terminal', 'api', 'import'));

-- ============================================================
-- 6. EMPLOYEE QUERIES (digital file — queries/grievances)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.employee_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  subject text NOT NULL,
  category text DEFAULT 'general'
    CHECK (category IN ('general', 'payroll', 'attendance', 'leave', 'performance', 'grievance', 'policy', 'other')),
  description text,
  status text DEFAULT 'open'
    CHECK (status IN ('open', 'under_review', 'resolved', 'closed', 'rejected')),
  priority text DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution text,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_query_emp ON public.employee_queries(employee_id);
CREATE INDEX IF NOT EXISTS idx_query_status ON public.employee_queries(status);

ALTER TABLE public.employee_queries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "query_read" ON public.employee_queries;
CREATE POLICY "query_read" ON public.employee_queries
  FOR SELECT USING (
    auth.role() = 'authenticated' AND (
      public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
      OR user_id = auth.uid()
      OR employee_id IN (SELECT e.id FROM public.employees e WHERE e.user_id = auth.uid())
    )
  );
DROP POLICY IF EXISTS "query_insert" ON public.employee_queries;
CREATE POLICY "query_insert" ON public.employee_queries
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "query_manage" ON public.employee_queries;
CREATE POLICY "query_manage" ON public.employee_queries
  FOR UPDATE USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ============================================================
-- 7. EMPLOYEE APPRAISALS (extends existing appraisal_results)
-- Adds a richer appraisal record linked to employee digital file
-- ============================================================
CREATE TABLE IF NOT EXISTS public.employee_appraisals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  period_name text NOT NULL,
  period_start date,
  period_end date,
  overall_score numeric(5, 2),
  kpi_score numeric(5, 2),
  behavioral_score numeric(5, 2),
  rating text DEFAULT 'pending'
    CHECK (rating IN ('pending', 'submitted', 'reviewed', 'approved', 'rejected')),
  strengths text,
  areas_for_improvement text,
  goals text,
  reviewer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewer_name text,
  comments text,
  status text DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'reviewed', 'approved', 'rejected')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appraisal_emp ON public.employee_appraisals(employee_id);
CREATE INDEX IF NOT EXISTS idx_appraisal_status ON public.employee_appraisals(status);

ALTER TABLE public.employee_appraisals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "emp_appraisal_read" ON public.employee_appraisals;
CREATE POLICY "emp_appraisal_read" ON public.employee_appraisals
  FOR SELECT USING (
    auth.role() = 'authenticated' AND (
      public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
      OR user_id = auth.uid()
      OR employee_id IN (SELECT e.id FROM public.employees e WHERE e.user_id = auth.uid())
    )
  );
DROP POLICY IF EXISTS "emp_appraisal_manage" ON public.employee_appraisals;
CREATE POLICY "emp_appraisal_manage" ON public.employee_appraisals
  FOR ALL USING (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'))
  WITH CHECK (public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer'));

-- ============================================================
-- 8. EMPLOYEE DIGITAL FILE — onboarding completion tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS public.employee_digital_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  onboarding_completed boolean DEFAULT false,
  onboarding_completed_at timestamptz,
  profile_completion_pct integer DEFAULT 0,
  setup_steps jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (employee_id)
);

ALTER TABLE public.employee_digital_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "digital_file_read" ON public.employee_digital_files;
CREATE POLICY "digital_file_read" ON public.employee_digital_files
  FOR SELECT USING (
    auth.role() = 'authenticated' AND (
      public.current_role() IN ('super_admin', 'admin', 'hr_manager', 'hr_officer', 'branch_manager')
      OR user_id = auth.uid()
      OR employee_id IN (SELECT e.id FROM public.employees e WHERE e.user_id = auth.uid())
    )
  );
DROP POLICY IF EXISTS "digital_file_upsert" ON public.employee_digital_files;
CREATE POLICY "digital_file_upsert" ON public.employee_digital_files
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "digital_file_update" ON public.employee_digital_files;
CREATE POLICY "digital_file_update" ON public.employee_digital_files
  FOR UPDATE USING (auth.role() = 'authenticated');

-- ============================================================
-- 9. ATTENDANCE SETTINGS — extend existing config
-- ============================================================
ALTER TABLE public.attendance_config
  ADD COLUMN IF NOT EXISTS geofence_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS early_departure_threshold_minutes integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS break_allowed boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS break_duration_minutes integer DEFAULT 60,
  ADD COLUMN IF NOT EXISTS overtime_threshold_hours numeric(4, 2) DEFAULT 8.0,
  ADD COLUMN IF NOT EXISTS manual_correction_requires_reason boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_admin_override boolean DEFAULT true;

-- ============================================================
-- 10. RPC: Ingest device attendance event
-- Validates device, resolves employee, creates attendance event
-- ============================================================
CREATE OR REPLACE FUNCTION public.ingest_attendance_event(
  p_device_id uuid,
  p_external_user_id text,
  p_event_type text,
  p_event_time timestamptz DEFAULT now(),
  p_verification_method text DEFAULT 'FINGERPRINT',
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_device public.attendance_devices%ROWTYPE;
  v_biometric public.employee_biometric_identifiers%ROWTYPE;
  v_employee public.employees%ROWTYPE;
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

  -- 2. Resolve employee from biometric mapping
  SELECT * INTO v_biometric FROM public.employee_biometric_identifiers
  WHERE device_id = p_device_id
    AND external_user_id = p_external_user_id
    AND enrollment_status = 'enrolled'
    AND active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown biometric employee ID');
  END IF;

  -- 3. Validate employee
  SELECT * INTO v_employee FROM public.employees WHERE id = v_biometric.employee_id;
  IF NOT FOUND OR v_employee.employment_status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Employee not found or inactive');
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
    -- Check for open session
    SELECT count(*) INTO v_existing_count FROM public.attendance_records
    WHERE employee_id = v_employee.id
      AND attendance_date = (p_event_time AT TIME ZONE 'UTC')::date
      AND clock_out IS NULL;
    IF v_existing_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'Open attendance session already exists');
    END IF;
    INSERT INTO public.attendance_records (employee_id, attendance_date, source, source_detail, verification_method, device_id)
    VALUES (v_employee.id, (p_event_time AT TIME ZONE 'UTC')::date, 'fingerprint', 'FINGERPRINT', 'FINGERPRINT', p_device_id)
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
          verification_method = 'FINGERPRINT',
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
    'employee_name', v_employee.full_name
  );
END; $$;

-- ============================================================
-- 11. RPC: Geofence verification
-- Returns nearest geofence and whether employee is inside
-- ============================================================
CREATE OR REPLACE FUNCTION public.verify_geofence(
  p_latitude numeric,
  p_longitude numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_geofences jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'latitude', g.latitude,
    'longitude', g.longitude,
    'radius_meters', g.radius_meters,
    'distance', round(
      6371000 * acos(
        least(1, greatest(-1,
          cos(radians(p_latitude)) * cos(radians(g.latitude)) * cos(radians(g.longitude) - radians(p_longitude))
          + sin(radians(p_latitude)) * sin(radians(g.latitude))
        ))
      )
    ),
    'inside', round(
      6371000 * acos(
        least(1, greatest(-1,
          cos(radians(p_latitude)) * cos(radians(g.latitude)) * cos(radians(g.longitude) - radians(p_longitude))
          + sin(radians(p_latitude)) * sin(radians(g.latitude))
        ))
      )
    ) <= g.radius_meters
  )), '[]'::jsonb)
  INTO v_geofences
  FROM public.attendance_geofences g
  WHERE g.active = true;

  RETURN jsonb_build_object('geofences', v_geofences);
END; $$;

-- ============================================================
-- 12. AUDIT: log attendance config changes
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_attendance_config_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (action, entity_type, entity_id, details, user_id)
  VALUES (
    'ATTENDANCE_CONFIG_CHANGE',
    'AttendanceConfig',
    NEW.id,
    jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW)),
    auth.uid()
  );
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS attendance_config_audit ON public.attendance_config;
CREATE TRIGGER attendance_config_audit
  AFTER UPDATE ON public.attendance_config
  FOR EACH ROW EXECUTE FUNCTION public.log_attendance_config_change();

-- ============================================================
-- 13. HR METRICS VIEW — hire rate, fire rate, cost per hire
-- ============================================================
CREATE OR REPLACE VIEW public.hr_metrics_view AS
SELECT
  count(*) FILTER (WHERE employment_status = 'active') AS active_employees,
  count(*) FILTER (WHERE employment_status = 'terminated') AS terminated_employees,
  count(*) FILTER (WHERE hire_date >= date_trunc('month', now())) AS hired_this_month,
  count(*) FILTER (WHERE employment_status = 'terminated' AND updated_at >= date_trunc('month', now())) AS terminated_this_month,
  count(*) FILTER (WHERE hire_date >= date_trunc('year', now())) AS hired_this_year,
  count(*) FILTER (WHERE employment_status = 'terminated' AND updated_at >= date_trunc('year', now())) AS terminated_this_year,
  count(*) AS total_employees,
  coalesce(avg(salary) FILTER (WHERE employment_status = 'active'), 0) AS avg_salary
FROM public.employees;

ALTER TABLE public.hr_metrics_view OWNER TO postgres;
GRANT SELECT ON public.hr_metrics_view TO authenticated;
