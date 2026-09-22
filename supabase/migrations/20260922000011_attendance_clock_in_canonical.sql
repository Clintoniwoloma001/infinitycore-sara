-- ============================================================================
-- INFINITYCORE
-- CANONICAL ATTENDANCE CLOCK-IN / CLOCK-OUT FUNCTIONS
-- ============================================================================
--
-- Purpose:
--   1. Remove overloaded attendance_clock_in_for_employee functions.
--   2. Remove overloaded attendance_clock_out_for_employee functions.
--   3. Recreate one canonical signature for each function.
--   4. Preserve compatibility with existing callers through trailing defaults.
--   5. Prevent PostgreSQL overload ambiguity when NULL is passed.
--
-- IMPORTANT:
--   Run this migration in Supabase SQL Editor.
--
--   This migration intentionally drops/recreates the internal helper functions.
--   Existing SECURITY DEFINER wrapper functions should continue to call these
--   canonical functions.
--
-- ============================================================================


-- ============================================================================
-- 1. DROP ALL EXISTING CLOCK-IN OVERLOADS
-- ============================================================================

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n
          ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'attendance_clock_in_for_employee'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END
$$;


-- ============================================================================
-- 2. DROP ALL EXISTING CLOCK-OUT OVERLOADS
-- ============================================================================

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n
          ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'attendance_clock_out_for_employee'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END
$$;


-- ============================================================================
-- 3. CANONICAL CLOCK-IN FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.attendance_clock_in_for_employee(
    p_employee_id UUID,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION,
    p_source TEXT DEFAULT 'web',
    p_device_id UUID DEFAULT NULL,
    p_verification_method TEXT DEFAULT 'GPS',
    p_source_detail TEXT DEFAULT 'WEB',
    p_geofence_override UUID DEFAULT NULL,
    p_allow_outside BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee RECORD;
    v_settings RECORD;
    v_location JSONB;
    v_now TIMESTAMPTZ := clock_timestamp();
    v_today DATE;

    v_work_start TIME;
    v_grace INTEGER;
    v_late INTEGER;

    v_record RECORD;
    v_event_id UUID;

    v_actual_geofence_id UUID;
    v_distance DOUBLE PRECISION;
BEGIN

    -- ------------------------------------------------------------------------
    -- Employee validation
    -- ------------------------------------------------------------------------

    SELECT *
    INTO v_employee
    FROM public.employees
    WHERE id = p_employee_id
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Employee record not found.';
    END IF;


    -- Only active employees may clock in.
    IF v_employee.employment_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION '%',
            format(
                'Employee is %s and cannot clock in or out.',
                COALESCE(v_employee.employment_status, 'inactive')
            );
    END IF;


    -- ------------------------------------------------------------------------
    -- HR attendance settings
    -- ------------------------------------------------------------------------

    SELECT *
    INTO v_settings
    FROM public.hr_platform_settings
    WHERE id = 1
    LIMIT 1;


    -- ------------------------------------------------------------------------
    -- Attendance date
    --
    -- Calendar day based on the configured application timezone.
    -- ------------------------------------------------------------------------

    v_today :=
        (
            v_now AT TIME ZONE public.att_app_timezone()
        )::DATE;


    -- ------------------------------------------------------------------------
    -- Prevent duplicate attendance for the same employee on the same
    -- calendar day.
    -- ------------------------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM public.attendance_records
        WHERE employee_id = p_employee_id
          AND attendance_date = v_today
    ) THEN

        RAISE EXCEPTION
            'Attendance has already been recorded for this employee today.';

    END IF;


    -- ------------------------------------------------------------------------
    -- Location / geofence validation
    -- ------------------------------------------------------------------------

    v_location :=
        public.attendance_validate_location(
            p_employee_id,
            p_lat,
            p_lng,
            'clock_in',
            NULL,
            p_geofence_override,
            p_allow_outside
        );


    -- ------------------------------------------------------------------------
    -- Attendance timing
    -- ------------------------------------------------------------------------

    v_work_start :=
        (v_location ->> 'work_start_time')::TIME;

    v_grace :=
        (v_location ->> 'grace_period_minutes')::INTEGER;

    v_late :=
        GREATEST(
            0,
            ROUND(
                EXTRACT(
                    EPOCH FROM (
                        (
                            v_now AT TIME ZONE public.att_app_timezone()
                        )::TIME
                        - v_work_start
                    )
                ) / 60.0
                - v_grace
            )
        )::INTEGER;


    -- ------------------------------------------------------------------------
    -- Location values
    -- ------------------------------------------------------------------------

    v_distance :=
        NULLIF(
            v_location ->> 'distance',
            ''
        )::DOUBLE PRECISION;

    v_actual_geofence_id :=
        NULLIF(
            v_location ->> 'actual_geofence_id',
            ''
        )::UUID;


    -- ------------------------------------------------------------------------
    -- Create attendance record
    -- ------------------------------------------------------------------------

    INSERT INTO public.attendance_records (
        employee_id,
        attendance_date,
        source,
        source_detail,
        status,

        clock_in_lat,
        clock_in_lng,
        clock_in_accuracy,
        clock_in_distance,

        geofence_id,
        geofence_distance,
        geofence_status,
        location_status,

        verification_method,
        late_status,
        late_minutes,

        branch_id,
        device_id
    )
    VALUES (
        p_employee_id,
        v_today,

        LOWER(
            COALESCE(
                p_source,
                'web'
            )
        ),

        UPPER(
            COALESCE(
                p_source_detail,
                'WEB'
            )
        ),

        CASE
            WHEN v_late > 0 THEN 'late'
            ELSE 'present'
        END,

        p_lat,
        p_lng,
        p_accuracy,
        v_distance,

        v_actual_geofence_id,
        v_distance,

        v_location ->> 'geofence_status',
        v_location ->> 'location_status',

        COALESCE(
            NULLIF(
                p_verification_method,
                ''
            ),
            'GPS'
        ),

        v_late > 0,
        v_late,

        NULLIF(
            v_location ->> 'assigned_branch_id',
            ''
        )::UUID,

        p_device_id
    )
    RETURNING *
    INTO v_record;


    -- ------------------------------------------------------------------------
    -- Attendance event
    -- ------------------------------------------------------------------------

    INSERT INTO public.attendance_events (
        employee_id,
        user_id,
        attendance_record_id,
        event_type,
        event_time,

        source,
        device_id,
        geofence_id,
        geofence_distance,
        location_status,

        verification_method,
        verification_status,

        latitude,
        longitude,

        late_status,
        late_minutes,

        metadata
    )
    VALUES (
        p_employee_id,
        v_employee.user_id,
        v_record.id,

        'CLOCK_IN',
        v_record.clock_in,

        UPPER(
            COALESCE(
                p_source_detail,
                'WEB'
            )
        ),

        p_device_id,
        v_actual_geofence_id,
        v_distance,

        v_location ->> 'location_status',

        COALESCE(
            NULLIF(
                p_verification_method,
                ''
            ),
            'GPS'
        ),

        CASE
            WHEN LOWER(
                v_location ->> 'geofence_status'
            ) = 'inside'
            THEN 'verified'
            ELSE 'unverified'
        END,

        p_lat,
        p_lng,

        v_late > 0,
        v_late,

        jsonb_build_object(

            'assigned_branch_id',
            v_location ->> 'assigned_branch_id',

            'assigned_branch_name',
            v_location ->> 'assigned_branch_name',

            'actual_branch_id',
            v_location ->> 'actual_branch_id',

            'actual_geofence_id',
            v_location ->> 'actual_geofence_id',

            'actual_location_name',
            v_location ->> 'actual_location_name',

            'actual_location_type',
            v_location ->> 'actual_location_type',

            'location_difference',
            CASE
                WHEN v_location ? 'location_difference'
                THEN
                    CASE
                        WHEN LOWER(
                            v_location ->> 'location_difference'
                        ) IN ('true', 'false')
                        THEN
                            (v_location ->> 'location_difference')::BOOLEAN
                        ELSE NULL
                    END
                ELSE NULL
            END,

            'nearest_location_name',
            v_location ->> 'nearest_location_name',

            'captured_at',
            v_record.clock_in,

            'success',
            TRUE
        )
    )
    RETURNING id
    INTO v_event_id;


    -- ------------------------------------------------------------------------
    -- Audit log
    -- ------------------------------------------------------------------------

    INSERT INTO public.audit_logs (
        action,
        entity_type,
        entity_id,
        user_name,
        details,
        severity
    )
    VALUES (
        'ATTENDANCE_CLOCK_IN',
        'AttendanceRecord',
        v_record.id::TEXT,

        COALESCE(
            (
                SELECT full_name
                FROM public.profiles
                WHERE id = v_employee.user_id
            ),
            v_employee.full_name,
            'Attendance Terminal'
        ),

        jsonb_build_object(
            'module',
            'attendance',

            'event_id',
            v_event_id,

            'actual_location',
            v_location,

            'success',
            TRUE
        )::TEXT,

        'info'
    );


    -- ------------------------------------------------------------------------
    -- Return response
    -- ------------------------------------------------------------------------

    RETURN jsonb_build_object(

        'ok',
        TRUE,

        'success',
        TRUE,

        'attendance_id',
        v_record.id,

        'clock_in_at',
        v_record.clock_in,

        'server_time',
        v_record.clock_in,

        'late_minutes',
        v_late,

        'status',
        v_record.status,

        'assigned_branch_name',
        v_location ->> 'assigned_branch_name',

        'actual_location_name',
        v_location ->> 'actual_location_name',

        'actual_geofence_id',
        v_location ->> 'actual_geofence_id',

        'location_difference',
        CASE
            WHEN v_location ? 'location_difference'
             AND LOWER(
                    v_location ->> 'location_difference'
                 ) IN ('true', 'false')
            THEN
                (v_location ->> 'location_difference')::BOOLEAN
            ELSE NULL
        END,

        'distance',
        v_distance,

        'geofence_status',
        v_location ->> 'geofence_status',

        'location_status',
        v_location ->> 'location_status',

        'event_id',
        v_event_id
    );

END;
$$;


-- ============================================================================
-- 4. CANONICAL CLOCK-OUT FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.attendance_clock_out_for_employee(
    p_employee_id UUID,
    p_attendance_id UUID,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION,
    p_accuracy DOUBLE PRECISION,
    p_source TEXT DEFAULT 'web',
    p_device_id UUID DEFAULT NULL,
    p_verification_method TEXT DEFAULT 'GPS',
    p_source_detail TEXT DEFAULT 'WEB',
    p_geofence_override UUID DEFAULT NULL,
    p_allow_outside BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee RECORD;
    v_settings RECORD;
    v_record RECORD;
    v_location JSONB;

    v_clock_out TIMESTAMPTZ;

    v_work_end TIME;

    v_total INTEGER;
    v_early INTEGER;

    v_event_id UUID;

    v_actual_geofence_id UUID;
    v_distance DOUBLE PRECISION;
BEGIN

    -- ------------------------------------------------------------------------
    -- Employee validation
    -- ------------------------------------------------------------------------

    SELECT *
    INTO v_employee
    FROM public.employees
    WHERE id = p_employee_id
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Employee record not found.';
    END IF;


    -- ------------------------------------------------------------------------
    -- Attendance record
    -- ------------------------------------------------------------------------

    SELECT *
    INTO v_record
    FROM public.attendance_records
    WHERE id = p_attendance_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Attendance record not found.';
    END IF;


    IF v_record.employee_id <> p_employee_id THEN
        RAISE EXCEPTION
            'You can only clock out of your own attendance session.';
    END IF;


    -- ------------------------------------------------------------------------
    -- Already clocked out
    -- ------------------------------------------------------------------------

    IF v_record.clock_out IS NOT NULL THEN

        RETURN jsonb_build_object(

            'ok',
            TRUE,

            'success',
            TRUE,

            'attendance_id',
            v_record.id,

            'already_clocked_out',
            TRUE,

            'clock_out_at',
            v_record.clock_out,

            'work_hours',
            v_record.work_hours,

            'total_minutes',
            v_record.total_minutes
        );

    END IF;


    -- ------------------------------------------------------------------------
    -- HR settings
    -- ------------------------------------------------------------------------

    SELECT *
    INTO v_settings
    FROM public.hr_platform_settings
    WHERE id = 1
    LIMIT 1;


    -- ------------------------------------------------------------------------
    -- Validate clock-out location
    -- ------------------------------------------------------------------------

    v_location :=
        public.attendance_validate_location(
            p_employee_id,
            p_lat,
            p_lng,
            'clock_out',
            v_record.branch_id,
            p_geofence_override,
            p_allow_outside
        );


    v_distance :=
        NULLIF(
            v_location ->> 'distance',
            ''
        )::DOUBLE PRECISION;


    v_actual_geofence_id :=
        NULLIF(
            v_location ->> 'actual_geofence_id',
            ''
        )::UUID;


    -- ------------------------------------------------------------------------
    -- Update clock-out information
    -- ------------------------------------------------------------------------

    PERFORM set_config(
        'app.correcting_attendance',
        'on',
        TRUE
    );


    UPDATE public.attendance_records
    SET
        clock_out = clock_timestamp(),

        clock_out_lat = p_lat,
        clock_out_lng = p_lng,
        clock_out_accuracy = p_accuracy,

        clock_out_distance = v_distance,

        geofence_id = v_actual_geofence_id,
        geofence_distance = v_distance,

        geofence_status =
            v_location ->> 'geofence_status',

        location_status =
            v_location ->> 'location_status',

        verification_method =
            COALESCE(
                NULLIF(
                    p_verification_method,
                    ''
                ),
                'GPS'
            ),

        device_id =
            COALESCE(
                p_device_id,
                device_id
            )

    WHERE id = p_attendance_id;


    PERFORM set_config(
        'app.correcting_attendance',
        'off',
        TRUE
    );


    -- ------------------------------------------------------------------------
    -- Reload updated attendance
    -- ------------------------------------------------------------------------

    SELECT *
    INTO v_record
    FROM public.attendance_records
    WHERE id = p_attendance_id;


    v_clock_out :=
        v_record.clock_out;


    -- ------------------------------------------------------------------------
    -- Total worked time
    -- ------------------------------------------------------------------------

    v_total :=
        GREATEST(
            0,
            ROUND(
                EXTRACT(
                    EPOCH FROM (
                        v_clock_out - v_record.clock_in
                    )
                ) / 60.0
            )
        )::INTEGER;


    -- ------------------------------------------------------------------------
    -- Early departure
    -- ------------------------------------------------------------------------

    v_work_end :=
        (v_location ->> 'work_end_time')::TIME;


    v_early :=
        GREATEST(
            0,
            ROUND(
                EXTRACT(
                    EPOCH FROM (
                        v_work_end
                        -
                        (
                            v_clock_out
                            AT TIME ZONE public.att_app_timezone()
                        )::TIME
                    )
                ) / 60.0
            )
        )::INTEGER;


    -- ------------------------------------------------------------------------
    -- Final attendance update
    -- ------------------------------------------------------------------------

    UPDATE public.attendance_records
    SET

        total_minutes =
            v_total,

        work_hours =
            ROUND(
                v_total::NUMERIC / 60.0,
                2
            ),

        early_departure_minutes =
            v_early,

        status =
            CASE

                WHEN COALESCE(
                    v_record.late_minutes,
                    0
                ) > 0
                THEN 'late'

                WHEN v_early >
                     COALESCE(
                         v_settings.early_departure_threshold_minutes,
                         0
                     )
                THEN 'early_exit'

                ELSE 'present'

            END

    WHERE id = p_attendance_id;


    -- ------------------------------------------------------------------------
    -- Clock-out event
    -- ------------------------------------------------------------------------

    INSERT INTO public.attendance_events (
        employee_id,
        user_id,
        attendance_record_id,
        event_type,
        event_time,

        source,
        device_id,
        geofence_id,
        geofence_distance,
        location_status,

        verification_method,
        verification_status,

        latitude,
        longitude,

        late_minutes,
        early_departure_minutes,

        metadata
    )
    VALUES (
        p_employee_id,
        v_employee.user_id,
        p_attendance_id,

        'CLOCK_OUT',
        v_clock_out,

        UPPER(
            COALESCE(
                p_source_detail,
                'WEB'
            )
        ),

        p_device_id,

        v_actual_geofence_id,

        v_distance,

        v_location ->> 'location_status',

        COALESCE(
            NULLIF(
                p_verification_method,
                ''
            ),
            'GPS'
        ),

        CASE
            WHEN LOWER(
                v_location ->> 'geofence_status'
            ) = 'inside'
            THEN 'verified'
            ELSE 'unverified'
        END,

        p_lat,
        p_lng,

        v_record.late_minutes,

        v_early,

        jsonb_build_object(

            'assigned_branch_id',
            v_location ->> 'assigned_branch_id',

            'assigned_branch_name',
            v_location ->> 'assigned_branch_name',

            'actual_branch_id',
            v_location ->> 'actual_branch_id',

            'actual_geofence_id',
            v_location ->> 'actual_geofence_id',

            'actual_location_name',
            v_location ->> 'actual_location_name',

            'actual_location_type',
            v_location ->> 'actual_location_type',

            'location_difference',
            CASE
                WHEN v_location ? 'location_difference'
                 AND LOWER(
                        v_location ->> 'location_difference'
                     ) IN ('true', 'false')
                THEN
                    (v_location ->> 'location_difference')::BOOLEAN
                ELSE NULL
            END,

            'nearest_location_name',
            v_location ->> 'nearest_location_name',

            'captured_at',
            v_clock_out,

            'success',
            TRUE
        )
    )
    RETURNING id
    INTO v_event_id;


    -- ------------------------------------------------------------------------
    -- Audit log
    -- ------------------------------------------------------------------------

    INSERT INTO public.audit_logs (
        action,
        entity_type,
        entity_id,
        user_name,
        details,
        severity
    )
    VALUES (
        'ATTENDANCE_CLOCK_OUT',
        'AttendanceRecord',
        p_attendance_id::TEXT,

        COALESCE(
            (
                SELECT full_name
                FROM public.profiles
                WHERE id = v_employee.user_id
            ),
            v_employee.full_name,
            'Attendance Terminal'
        ),

        jsonb_build_object(

            'module',
            'attendance',

            'event_id',
            v_event_id,

            'work_minutes',
            v_total,

            'work_hours',
            ROUND(
                v_total::NUMERIC / 60.0,
                2
            ),

            'actual_location',
            v_location,

            'success',
            TRUE

        )::TEXT,

        'info'
    );


    -- ------------------------------------------------------------------------
    -- Return response
    -- ------------------------------------------------------------------------

    RETURN jsonb_build_object(

        'ok',
        TRUE,

        'success',
        TRUE,

        'attendance_id',
        p_attendance_id,

        'clock_out_at',
        v_clock_out,

        'server_time',
        v_clock_out,

        'total_minutes',
        v_total,

        'work_hours',
        ROUND(
            v_total::NUMERIC / 60.0,
            2
        ),

        'early_departure_minutes',
        v_early,

        'assigned_branch_name',
        v_location ->> 'assigned_branch_name',

        'actual_location_name',
        v_location ->> 'actual_location_name',

        'actual_geofence_id',
        v_location ->> 'actual_geofence_id',

        'location_difference',
        CASE
            WHEN v_location ? 'location_difference'
             AND LOWER(
                    v_location ->> 'location_difference'
                 ) IN ('true', 'false')
            THEN
                (v_location ->> 'location_difference')::BOOLEAN
            ELSE NULL
        END,

        'distance',
        v_distance,

        'geofence_status',
        v_location ->> 'geofence_status',

        'location_status',
        v_location ->> 'location_status',

        'event_id',
        v_event_id
    );


EXCEPTION
    WHEN OTHERS THEN

        PERFORM set_config(
            'app.correcting_attendance',
            'off',
            TRUE
        );

        RAISE;

END;
$$;


-- ============================================================================
-- 5. LOCK DOWN INTERNAL FUNCTIONS
-- ============================================================================
--
-- These are internal SECURITY DEFINER helpers.
-- Application clients should use the secure wrapper RPCs instead.
-- ============================================================================

REVOKE ALL
ON FUNCTION public.attendance_clock_in_for_employee(
    UUID,
    DOUBLE PRECISION,
    DOUBLE PRECISION,
    DOUBLE PRECISION,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    UUID,
    BOOLEAN
)
FROM PUBLIC, ANON, AUTHENTICATED;


REVOKE ALL
ON FUNCTION public.attendance_clock_out_for_employee(
    UUID,
    UUID,
    DOUBLE PRECISION,
    DOUBLE PRECISION,
    DOUBLE PRECISION,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    UUID,
    BOOLEAN
)
FROM PUBLIC, ANON, AUTHENTICATED;


-- ============================================================================
-- 6. VERIFICATION
-- ============================================================================
--
-- Confirm that exactly ONE function exists for each operation.
-- ============================================================================

SELECT
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_function_result(p.oid) AS return_type
FROM pg_proc p
JOIN pg_namespace n
  ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'attendance_clock_in_for_employee',
      'attendance_clock_out_for_employee'
  )
ORDER BY p.proname;