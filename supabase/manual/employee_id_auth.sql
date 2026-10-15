CREATE OR REPLACE FUNCTION public.normalize_employee_id(p_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
    SELECT regexp_replace(
        upper(btrim(p_id)),
        '[-_[:space:]\\]+',
        '/',
        'g'
    );
$$;

CREATE TABLE IF NOT EXISTS public.auth_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id uuid NOT NULL,
    normalized_id text NOT NULL,
    outcome text NOT NULL
        CHECK (outcome IN ('success', 'failure', 'rate_limited')),
    password_hash text,
    ip_prefix text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_normalized
    ON public.auth_attempts (normalized_id, outcome);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_created_at
    ON public.auth_attempts (created_at);

REVOKE ALL ON TABLE public.auth_attempts
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.employee_signup_by_id(
    p_normalized_id text,
    p_password text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_norm text;
    v_employee_id uuid;
BEGIN
    IF p_normalized_id IS NULL
       OR length(btrim(p_normalized_id)) = 0 THEN
        RETURN jsonb_build_object(
            'error', 'Invalid employee ID format'
        );
    END IF;

    IF p_password IS NULL OR length(p_password) < 6 THEN
        RETURN jsonb_build_object(
            'error', 'Password must be at least 6 characters'
        );
    END IF;

    v_norm := public.normalize_employee_id(p_normalized_id);

    SELECT e.id
      INTO v_employee_id
      FROM public.employees AS e
     WHERE e.employment_status = 'active'
       AND e.is_archived IS DISTINCT FROM TRUE
       AND (
           public.normalize_employee_id(e.employee_number) = v_norm
           OR public.normalize_employee_id(e.employee_code) = v_norm
           OR public.normalize_employee_id(e.staff_id) = v_norm
       )
     LIMIT 1;

    RETURN jsonb_build_object(
        'status', 'processing',
        'message',
        'If this Employee ID is eligible, the request can be verified using the email address on record.'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_employee_id(text)
    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.normalize_employee_id(text)
    TO authenticated;

REVOKE ALL ON FUNCTION public.employee_signup_by_id(text, text)
    FROM PUBLIC, anon, authenticated;