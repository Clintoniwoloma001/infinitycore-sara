-- ============================================================
-- PHASE 10: USER APPROVAL WORKFLOW + WORKFORCE OPERATIONS
--
-- ALL ADDITIVE.
-- Run after all prior schema files (schema.sql through
-- schema_phase9_integrated_operations.sql).
--
-- Safe to re-run.
-- Existing data is NOT intentionally deleted.
--
-- NOTE:
-- RPC functions are explicitly dropped/recreated because
-- PostgreSQL does not allow CREATE OR REPLACE FUNCTION to
-- remove or change existing parameter defaults.
-- ============================================================


-- ============================================================
-- 1. PROFILES — add status + department columns
-- ============================================================

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS status text
DEFAULT 'pending'
CHECK (status IN ('pending', 'active', 'suspended', 'rejected'));

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS department text;

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS approved_by uuid
REFERENCES auth.users(id)
ON DELETE SET NULL;

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS rejected_reason text;


-- Update signup trigger to also set status='pending'

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (
        id,
        email,
        full_name,
        role,
        status
    )
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
        'customer',
        'pending'
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- 2. USER ACCESS PROFILES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_access_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL
        REFERENCES auth.users(id)
        ON DELETE CASCADE,
    modules jsonb NOT NULL DEFAULT '[]'::jsonb,
    granted_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,
    granted_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),

    UNIQUE (user_id)
);

ALTER TABLE public.user_access_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_access_self_read"
ON public.user_access_profiles;

CREATE POLICY "user_access_self_read"
ON public.user_access_profiles
FOR SELECT
USING (
    user_id = auth.uid()
    OR public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
);

DROP POLICY IF EXISTS "user_access_manage"
ON public.user_access_profiles;

CREATE POLICY "user_access_manage"
ON public.user_access_profiles
FOR ALL
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
)
WITH CHECK (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
);


-- ============================================================
-- 3. USER APPROVAL AUDIT TRAIL
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_approval_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id uuid NOT NULL
        REFERENCES auth.users(id)
        ON DELETE CASCADE,

    action text NOT NULL CHECK (
        action IN (
            'USER_APPROVED',
            'USER_REJECTED',
            'USER_SUSPENDED',
            'USER_ACTIVATED',
            'USER_DEACTIVATED',
            'USER_ROLE_CHANGED',
            'USER_DEPARTMENT_CHANGED',
            'USER_ACCESS_CHANGED'
        )
    ),

    previous_status text,
    new_status text,
    previous_role text,
    new_role text,
    department text,

    approver_id uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    approver_name text,
    reason text,

    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_approval_audit_user
ON public.user_approval_audit(user_id);

CREATE INDEX IF NOT EXISTS idx_user_approval_audit_action
ON public.user_approval_audit(action);

ALTER TABLE public.user_approval_audit
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_approval_audit_read"
ON public.user_approval_audit;

CREATE POLICY "user_approval_audit_read"
ON public.user_approval_audit
FOR SELECT
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
);

DROP POLICY IF EXISTS "user_approval_audit_insert"
ON public.user_approval_audit;

CREATE POLICY "user_approval_audit_insert"
ON public.user_approval_audit
FOR INSERT
WITH CHECK (
    auth.role() = 'authenticated'
);


-- ============================================================
-- 4. TASKS — workforce management columns
-- ============================================================

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS assignment_type text
DEFAULT 'individual'
CHECK (
    assignment_type IN (
        'individual',
        'team',
        'department',
        'branch',
        'area'
    )
);

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS department text;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS branch text;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS area text;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS start_date date;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS supervisor_id uuid
REFERENCES auth.users(id)
ON DELETE SET NULL;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS completion_pct int
DEFAULT 0
CHECK (
    completion_pct >= 0
    AND completion_pct <= 100
);

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS kpi_id uuid;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS target_id uuid;

ALTER TABLE public.tasks
ADD COLUMN IF NOT EXISTS instructions text;


-- Widen task_type

ALTER TABLE public.tasks
DROP CONSTRAINT IF EXISTS tasks_task_type_check;

ALTER TABLE public.tasks
ADD CONSTRAINT tasks_task_type_check
CHECK (
    task_type IN (
        'approval',
        'verification',
        'assessment',
        'review',
        'follow_up',
        'support',
        'onboarding',
        'work_task',
        'project',
        'assignment',
        'report'
    )
);


-- Widen task status

ALTER TABLE public.tasks
DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE public.tasks
ADD CONSTRAINT tasks_status_check
CHECK (
    status IN (
        'pending',
        'in_progress',
        'completed',
        'cancelled',
        'submitted'
    )
);


-- Tasks INSERT policy

DROP POLICY IF EXISTS "tasks_insert_admin"
ON public.tasks;

CREATE POLICY "tasks_insert_admin"
ON public.tasks
FOR INSERT
WITH CHECK (
    public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'operations_manager',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);


-- Tasks UPDATE policy

DROP POLICY IF EXISTS "tasks_update_assigned_or_admin"
ON public.tasks;

CREATE POLICY "tasks_update_assigned_or_admin"
ON public.tasks
FOR UPDATE
USING (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'operations_manager',
        'hr_manager',
        'area_manager'
    )
)
WITH CHECK (
    assigned_to = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'operations_manager',
        'hr_manager',
        'area_manager'
    )
);


-- Tasks READ policy

DROP POLICY IF EXISTS "tasks_read_assigned"
ON public.tasks;

CREATE POLICY "tasks_read_assigned"
ON public.tasks
FOR SELECT
USING (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'branch_manager',
        'operations_manager',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);


-- ============================================================
-- 5. TASK PROGRESS REPORTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.task_progress_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id uuid NOT NULL
        REFERENCES public.tasks(id)
        ON DELETE CASCADE,

    submitted_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    progress_pct int DEFAULT 0
        CHECK (
            progress_pct >= 0
            AND progress_pct <= 100
        ),

    completed_quantity numeric DEFAULT 0,

    narrative text,

    attachment_path text,
    attachment_name text,

    status text DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'accepted',
                'correction_requested',
                'rejected'
            )
        ),

    reviewed_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    reviewed_at timestamptz,
    review_comment text,

    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_reports_task
ON public.task_progress_reports(task_id);

CREATE INDEX IF NOT EXISTS idx_task_reports_status
ON public.task_progress_reports(status);

ALTER TABLE public.task_progress_reports
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "task_reports_read"
ON public.task_progress_reports;

CREATE POLICY "task_reports_read"
ON public.task_progress_reports
FOR SELECT
USING (
    submitted_by = auth.uid()

    OR EXISTS (
        SELECT 1
        FROM public.tasks t
        WHERE t.id = task_id
        AND (
            t.assigned_to = auth.uid()
            OR t.created_by = auth.uid()
        )
    )

    OR public.current_role() IN (
        'super_admin',
        'admin',
        'branch_manager',
        'operations_manager',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);

DROP POLICY IF EXISTS "task_reports_insert"
ON public.task_progress_reports;

CREATE POLICY "task_reports_insert"
ON public.task_progress_reports
FOR INSERT
WITH CHECK (
    auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "task_reports_update"
ON public.task_progress_reports;

CREATE POLICY "task_reports_update"
ON public.task_progress_reports
FOR UPDATE
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'branch_manager',
        'operations_manager',
        'hr_manager',
        'hr_officer',
        'area_manager'
    )
);


-- ============================================================
-- 6. KPI DEFINITIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kpi_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    name text NOT NULL,
    description text,

    measurement_type text DEFAULT 'quantity'
        CHECK (
            measurement_type IN (
                'quantity',
                'monetary',
                'percentage',
                'rating'
            )
        ),

    target_value numeric NOT NULL DEFAULT 100,
    unit text,

    period text
        CHECK (
            period IN (
                'monthly',
                'quarterly',
                'annual',
                'custom'
            )
        ),

    period_label text,

    start_date date,
    end_date date,

    is_shared boolean DEFAULT false,
    is_active boolean DEFAULT true,

    created_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.kpi_definitions
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kpi_defs_read"
ON public.kpi_definitions;

CREATE POLICY "kpi_defs_read"
ON public.kpi_definitions
FOR SELECT
USING (
    auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "kpi_defs_manage"
ON public.kpi_definitions;

CREATE POLICY "kpi_defs_manage"
ON public.kpi_definitions
FOR ALL
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
)
WITH CHECK (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);


-- ============================================================
-- 7. KPI ASSIGNMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kpi_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    kpi_id uuid NOT NULL
        REFERENCES public.kpi_definitions(id)
        ON DELETE CASCADE,

    assignment_type text DEFAULT 'individual'
        CHECK (
            assignment_type IN (
                'individual',
                'team',
                'department',
                'branch',
                'area'
            )
        ),

    user_id uuid
        REFERENCES auth.users(id)
        ON DELETE CASCADE,

    department text,
    branch text,
    area text,

    target_value numeric,

    created_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kpi_assign_kpi
ON public.kpi_assignments(kpi_id);

CREATE INDEX IF NOT EXISTS idx_kpi_assign_user
ON public.kpi_assignments(user_id);

ALTER TABLE public.kpi_assignments
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kpi_assign_read"
ON public.kpi_assignments;

CREATE POLICY "kpi_assign_read"
ON public.kpi_assignments
FOR SELECT
USING (
    user_id = auth.uid()
    OR public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);

DROP POLICY IF EXISTS "kpi_assign_manage"
ON public.kpi_assignments;

CREATE POLICY "kpi_assign_manage"
ON public.kpi_assignments
FOR ALL
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
)
WITH CHECK (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);


-- ============================================================
-- 8. KPI SUBMISSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kpi_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    kpi_id uuid NOT NULL
        REFERENCES public.kpi_definitions(id)
        ON DELETE CASCADE,

    assignment_id uuid
        REFERENCES public.kpi_assignments(id)
        ON DELETE SET NULL,

    user_id uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    actual_value numeric DEFAULT 0,
    progress_pct numeric DEFAULT 0,

    narrative text,

    attachment_path text,
    attachment_name text,

    period_label text,

    status text DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'accepted',
                'correction_requested',
                'rejected'
            )
        ),

    reviewed_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    reviewed_at timestamptz,
    review_comment text,

    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kpi_subs_kpi
ON public.kpi_submissions(kpi_id);

CREATE INDEX IF NOT EXISTS idx_kpi_subs_user
ON public.kpi_submissions(user_id);

CREATE INDEX IF NOT EXISTS idx_kpi_subs_status
ON public.kpi_submissions(status);

ALTER TABLE public.kpi_submissions
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kpi_subs_read"
ON public.kpi_submissions;

CREATE POLICY "kpi_subs_read"
ON public.kpi_submissions
FOR SELECT
USING (
    user_id = auth.uid()
    OR public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);

DROP POLICY IF EXISTS "kpi_subs_insert"
ON public.kpi_submissions;

CREATE POLICY "kpi_subs_insert"
ON public.kpi_submissions
FOR INSERT
WITH CHECK (
    auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "kpi_subs_update"
ON public.kpi_submissions;

CREATE POLICY "kpi_subs_update"
ON public.kpi_submissions
FOR UPDATE
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);


-- ============================================================
-- 9. WORK PLANS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.work_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    title text NOT NULL,
    description text,

    assignment_type text DEFAULT 'individual'
        CHECK (
            assignment_type IN (
                'individual',
                'team',
                'department',
                'branch',
                'area'
            )
        ),

    user_id uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    department text,
    branch text,
    area text,

    start_date date,
    end_date date,

    status text DEFAULT 'draft'
        CHECK (
            status IN (
                'draft',
                'active',
                'completed',
                'cancelled'
            )
        ),

    progress_pct int DEFAULT 0
        CHECK (
            progress_pct >= 0
            AND progress_pct <= 100
        ),

    created_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.work_plans
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "work_plans_read"
ON public.work_plans;

CREATE POLICY "work_plans_read"
ON public.work_plans
FOR SELECT
USING (
    user_id = auth.uid()
    OR public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);

DROP POLICY IF EXISTS "work_plans_manage"
ON public.work_plans;

CREATE POLICY "work_plans_manage"
ON public.work_plans
FOR ALL
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
)
WITH CHECK (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager',
        'area_manager'
    )
);


-- ============================================================
-- 10. ATTENDANCE EXCEPTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attendance_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    attendance_id uuid
        REFERENCES public.attendance_records(id)
        ON DELETE CASCADE,

    employee_id uuid
        REFERENCES public.employees(id)
        ON DELETE CASCADE,

    exception_type text DEFAULT 'late_arrival'
        CHECK (
            exception_type IN (
                'late_arrival',
                'early_exit',
                'missed_break',
                'other'
            )
        ),

    reason text
        CHECK (
            reason IN (
                'traffic',
                'transport_delay',
                'health_emergency',
                'official_assignment',
                'family_emergency',
                'weather',
                'other'
            )
        ),

    custom_explanation text,

    expected_time text,
    actual_time text,

    status text DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'accepted',
                'rejected'
            )
        ),

    reviewed_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    reviewed_at timestamptz,
    review_comment text,

    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_exc_attendance
ON public.attendance_exceptions(attendance_id);

CREATE INDEX IF NOT EXISTS idx_attendance_exc_status
ON public.attendance_exceptions(status);

ALTER TABLE public.attendance_exceptions
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attendance_exc_read"
ON public.attendance_exceptions;

CREATE POLICY "attendance_exc_read"
ON public.attendance_exceptions
FOR SELECT
USING (
    employee_id IN (
        SELECT id
        FROM public.employees
        WHERE user_id = auth.uid()
    )

    OR public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager'
    )
);

DROP POLICY IF EXISTS "attendance_exc_insert"
ON public.attendance_exceptions;

CREATE POLICY "attendance_exc_insert"
ON public.attendance_exceptions
FOR INSERT
WITH CHECK (
    employee_id IN (
        SELECT id
        FROM public.employees
        WHERE user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "attendance_exc_review"
ON public.attendance_exceptions;

CREATE POLICY "attendance_exc_review"
ON public.attendance_exceptions
FOR UPDATE
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager'
    )
);


-- ============================================================
-- 11. ATTENDANCE ISSUES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attendance_issues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id uuid
        REFERENCES public.employees(id)
        ON DELETE CASCADE,

    issue_date date NOT NULL,

    issue_type text NOT NULL
        CHECK (
            issue_type IN (
                'forgot_clock_in',
                'forgot_clock_out',
                'incorrect_time',
                'wrong_location',
                'device_problem',
                'other'
            )
        ),

    explanation text,

    attachment_path text,
    attachment_name text,

    status text DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'approved',
                'rejected'
            )
        ),

    reviewed_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    reviewed_at timestamptz,
    review_comment text,

    created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_issues_emp
ON public.attendance_issues(employee_id);

CREATE INDEX IF NOT EXISTS idx_attendance_issues_status
ON public.attendance_issues(status);

ALTER TABLE public.attendance_issues
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attendance_issues_read"
ON public.attendance_issues;

CREATE POLICY "attendance_issues_read"
ON public.attendance_issues
FOR SELECT
USING (
    employee_id IN (
        SELECT id
        FROM public.employees
        WHERE user_id = auth.uid()
    )

    OR public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager'
    )
);

DROP POLICY IF EXISTS "attendance_issues_insert"
ON public.attendance_issues;

CREATE POLICY "attendance_issues_insert"
ON public.attendance_issues
FOR INSERT
WITH CHECK (
    employee_id IN (
        SELECT id
        FROM public.employees
        WHERE user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "attendance_issues_review"
ON public.attendance_issues;

CREATE POLICY "attendance_issues_review"
ON public.attendance_issues
FOR UPDATE
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager',
        'hr_officer',
        'branch_manager'
    )
);


-- ============================================================
-- 12. ATTENDANCE CONFIGURATION
-- ============================================================

CREATE TABLE IF NOT EXISTS public.attendance_config (
    id int PRIMARY KEY DEFAULT 1
        CHECK (id = 1),

    expected_start_time text DEFAULT '08:00',
    expected_end_time text DEFAULT '17:00',

    grace_period_minutes int DEFAULT 15,

    late_threshold_time text DEFAULT '08:16',

    working_days text[]
        DEFAULT ARRAY[
            'monday',
            'tuesday',
            'wednesday',
            'thursday',
            'friday'
        ],

    updated_by uuid
        REFERENCES auth.users(id)
        ON DELETE SET NULL,

    updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.attendance_config
ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attendance_config_read"
ON public.attendance_config;

CREATE POLICY "attendance_config_read"
ON public.attendance_config
FOR SELECT
USING (
    auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "attendance_config_manage"
ON public.attendance_config;

CREATE POLICY "attendance_config_manage"
ON public.attendance_config
FOR UPDATE
USING (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
)
WITH CHECK (
    public.current_role() IN (
        'super_admin',
        'admin',
        'hr_manager'
    )
);


-- Seed default configuration

INSERT INTO public.attendance_config (
    id,
    expected_start_time,
    expected_end_time,
    grace_period_minutes,
    late_threshold_time
)
VALUES (
    1,
    '08:00',
    '17:00',
    15,
    '08:16'
)
ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- 13. USER APPROVAL RPCs
--
-- IMPORTANT:
-- Explicit DROP FUNCTION statements are required because
-- PostgreSQL cannot remove/change parameter defaults using
-- CREATE OR REPLACE FUNCTION.
-- ============================================================


-- ------------------------------------------------------------
-- APPROVE USER
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.approve_user(uuid, text, text, jsonb);

CREATE FUNCTION public.approve_user(
    p_user_id uuid,
    p_role text DEFAULT 'customer',
    p_department text DEFAULT NULL,
    p_modules jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    actor_role text := public.current_role();
    actor_name text;

    v_prev_status text;
    v_prev_role text;

    promoter_roles text[] :=
        ARRAY[
            'super_admin',
            'admin',
            'hr_manager',
            'area_manager',
            'branch_manager'
        ];
BEGIN

    IF NOT (actor_role = ANY(promoter_roles)) THEN
        RAISE EXCEPTION 'Not authorized to approve users';
    END IF;


    -- Role hierarchy

    IF p_role = 'super_admin'
       AND actor_role <> 'super_admin' THEN

        RAISE EXCEPTION
            'Only super_admin can assign the super_admin role';

    END IF;


    IF p_role = 'admin'
       AND actor_role NOT IN ('super_admin', 'admin') THEN

        RAISE EXCEPTION
            'Only super_admin or admin can assign the admin role';

    END IF;


    IF p_role IN ('area_manager', 'head_of_business')
       AND actor_role NOT IN ('super_admin', 'admin') THEN

        RAISE EXCEPTION
            'Only super_admin or admin can assign this role';

    END IF;


    IF actor_role = 'branch_manager'
       AND p_role NOT IN (
            'staff',
            'loan_officer',
            'relationship_manager',
            'customer_service'
       ) THEN

        RAISE EXCEPTION
            'Branch Manager is not authorized to assign this role';

    END IF;


    -- Lock and retrieve target user

    SELECT
        status,
        role
    INTO
        v_prev_status,
        v_prev_role
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;


    IF v_prev_status IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;


    -- Get approver name

    SELECT
        COALESCE(full_name, email)
    INTO
        actor_name
    FROM public.profiles
    WHERE id = auth.uid();


    -- Activate and assign role

    UPDATE public.profiles
    SET
        status = 'active',
        role = p_role,
        department = p_department,
        approved_by = auth.uid(),
        approved_at = now(),
        rejected_reason = NULL
    WHERE id = p_user_id;


    -- Access profile

    IF p_modules IS NOT NULL THEN

        INSERT INTO public.user_access_profiles (
            user_id,
            modules,
            granted_by,
            granted_at,
            updated_at
        )
        VALUES (
            p_user_id,
            p_modules,
            auth.uid(),
            now(),
            now()
        )

        ON CONFLICT (user_id)
        DO UPDATE SET
            modules = EXCLUDED.modules,
            granted_by = auth.uid(),
            granted_at = now(),
            updated_at = now();

    END IF;


    -- Approval audit

    INSERT INTO public.user_approval_audit (
        user_id,
        action,
        previous_status,
        new_status,
        previous_role,
        new_role,
        department,
        approver_id,
        approver_name
    )
    VALUES (
        p_user_id,
        'USER_APPROVED',
        v_prev_status,
        'active',
        v_prev_role,
        p_role,
        p_department,
        auth.uid(),
        actor_name
    );


    -- Role change audit

    IF v_prev_role IS DISTINCT FROM p_role THEN

        INSERT INTO public.user_approval_audit (
            user_id,
            action,
            previous_role,
            new_role,
            approver_id,
            approver_name
        )
        VALUES (
            p_user_id,
            'USER_ROLE_CHANGED',
            v_prev_role,
            p_role,
            auth.uid(),
            actor_name
        );

    END IF;


    -- Department audit

    IF p_department IS NOT NULL THEN

        INSERT INTO public.user_approval_audit (
            user_id,
            action,
            department,
            approver_id,
            approver_name
        )
        VALUES (
            p_user_id,
            'USER_DEPARTMENT_CHANGED',
            p_department,
            auth.uid(),
            actor_name
        );

    END IF;


    -- Access audit

    IF p_modules IS NOT NULL THEN

        INSERT INTO public.user_approval_audit (
            user_id,
            action,
            approver_id,
            approver_name
        )
        VALUES (
            p_user_id,
            'USER_ACCESS_CHANGED',
            auth.uid(),
            actor_name
        );

    END IF;


    -- Existing audit trail

    INSERT INTO public.audit_logs (
        action,
        entity_type,
        entity_id,
        user_name,
        details,
        severity
    )
    VALUES (
        'USER_APPROVED',
        'User',
        p_user_id::text,
        actor_name,
        format(
            'User approved: role=%s, department=%s',
            p_role,
            COALESCE(p_department, 'none')
        ),
        'critical'
    );


    RETURN jsonb_build_object(
        'ok',
        true
    );

END;
$$;


GRANT EXECUTE
ON FUNCTION public.approve_user(uuid, text, text, jsonb)
TO authenticated;


-- ------------------------------------------------------------
-- REJECT USER
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.reject_user(uuid, text);

CREATE FUNCTION public.reject_user(
    p_user_id uuid,
    p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    actor_role text := public.current_role();
    actor_name text;
    v_prev_status text;

    promoter_roles text[] :=
        ARRAY[
            'super_admin',
            'admin',
            'hr_manager'
        ];
BEGIN

    IF NOT (actor_role = ANY(promoter_roles)) THEN
        RAISE EXCEPTION
            'Not authorized to reject users';
    END IF;


    SELECT status
    INTO v_prev_status
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;


    IF v_prev_status IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;


    SELECT
        COALESCE(full_name, email)
    INTO actor_name
    FROM public.profiles
    WHERE id = auth.uid();


    UPDATE public.profiles
    SET
        status = 'rejected',
        rejected_reason = p_reason
    WHERE id = p_user_id;


    INSERT INTO public.user_approval_audit (
        user_id,
        action,
        previous_status,
        new_status,
        approver_id,
        approver_name,
        reason
    )
    VALUES (
        p_user_id,
        'USER_REJECTED',
        v_prev_status,
        'rejected',
        auth.uid(),
        actor_name,
        p_reason
    );


    INSERT INTO public.audit_logs (
        action,
        entity_type,
        entity_id,
        user_name,
        details,
        severity
    )
    VALUES (
        'USER_REJECTED',
        'User',
        p_user_id::text,
        actor_name,
        format(
            'User rejected: %s',
            COALESCE(p_reason, 'no reason given')
        ),
        'critical'
    );


    RETURN jsonb_build_object(
        'ok',
        true
    );

END;
$$;


GRANT EXECUTE
ON FUNCTION public.reject_user(uuid, text)
TO authenticated;


-- ------------------------------------------------------------
-- SUSPEND USER
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.suspend_user(uuid, text);

CREATE FUNCTION public.suspend_user(
    p_user_id uuid,
    p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    actor_role text := public.current_role();
    actor_name text;
    v_prev_status text;

    promoter_roles text[] :=
        ARRAY[
            'super_admin',
            'admin',
            'hr_manager'
        ];
BEGIN

    IF NOT (actor_role = ANY(promoter_roles)) THEN
        RAISE EXCEPTION
            'Not authorized to suspend users';
    END IF;


    SELECT status
    INTO v_prev_status
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;


    IF v_prev_status IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;


    SELECT
        COALESCE(full_name, email)
    INTO actor_name
    FROM public.profiles
    WHERE id = auth.uid();


    UPDATE public.profiles
    SET
        status = 'suspended',
        rejected_reason = p_reason
    WHERE id = p_user_id;


    INSERT INTO public.user_approval_audit (
        user_id,
        action,
        previous_status,
        new_status,
        approver_id,
        approver_name,
        reason
    )
    VALUES (
        p_user_id,
        'USER_SUSPENDED',
        v_prev_status,
        'suspended',
        auth.uid(),
        actor_name,
        p_reason
    );


    INSERT INTO public.audit_logs (
        action,
        entity_type,
        entity_id,
        user_name,
        details,
        severity
    )
    VALUES (
        'USER_SUSPENDED',
        'User',
        p_user_id::text,
        actor_name,
        COALESCE(p_reason, 'no reason'),
        'critical'
    );


    RETURN jsonb_build_object(
        'ok',
        true
    );

END;
$$;


GRANT EXECUTE
ON FUNCTION public.suspend_user(uuid, text)
TO authenticated;


-- ------------------------------------------------------------
-- ACTIVATE USER
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.activate_user(uuid);

CREATE FUNCTION public.activate_user(
    p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    actor_role text := public.current_role();
    actor_name text;
    v_prev_status text;

    promoter_roles text[] :=
        ARRAY[
            'super_admin',
            'admin',
            'hr_manager'
        ];
BEGIN

    IF NOT (actor_role = ANY(promoter_roles)) THEN
        RAISE EXCEPTION
            'Not authorized to activate users';
    END IF;


    SELECT status
    INTO v_prev_status
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;


    IF v_prev_status IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;


    SELECT
        COALESCE(full_name, email)
    INTO actor_name
    FROM public.profiles
    WHERE id = auth.uid();


    UPDATE public.profiles
    SET
        status = 'active',
        rejected_reason = NULL
    WHERE id = p_user_id;


    INSERT INTO public.user_approval_audit (
        user_id,
        action,
        previous_status,
        new_status,
        approver_id,
        approver_name
    )
    VALUES (
        p_user_id,
        'USER_ACTIVATED',
        v_prev_status,
        'active',
        auth.uid(),
        actor_name
    );


    INSERT INTO public.audit_logs (
        action,
        entity_type,
        entity_id,
        user_name,
        details,
        severity
    )
    VALUES (
        'USER_ACTIVATED',
        'User',
        p_user_id::text,
        actor_name,
        'User activated',
        'info'
    );


    RETURN jsonb_build_object(
        'ok',
        true
    );

END;
$$;


GRANT EXECUTE
ON FUNCTION public.activate_user(uuid)
TO authenticated;


-- ------------------------------------------------------------
-- UPDATE USER ACCESS
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_user_access(uuid, jsonb);

CREATE FUNCTION public.update_user_access(
    p_user_id uuid,
    p_modules jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    actor_role text := public.current_role();
    actor_name text;

    promoter_roles text[] :=
        ARRAY[
            'super_admin',
            'admin',
            'hr_manager'
        ];
BEGIN

    IF NOT (actor_role = ANY(promoter_roles)) THEN
        RAISE EXCEPTION
            'Not authorized to change user access';
    END IF;


    SELECT
        COALESCE(full_name, email)
    INTO actor_name
    FROM public.profiles
    WHERE id = auth.uid();


    INSERT INTO public.user_access_profiles (
        user_id,
        modules,
        granted_by,
        granted_at,
        updated_at
    )
    VALUES (
        p_user_id,
        p_modules,
        auth.uid(),
        now(),
        now()
    )

    ON CONFLICT (user_id)
    DO UPDATE SET
        modules = EXCLUDED.modules,
        granted_by = auth.uid(),
        granted_at = now(),
        updated_at = now();


    INSERT INTO public.user_approval_audit (
        user_id,
        action,
        approver_id,
        approver_name
    )
    VALUES (
        p_user_id,
        'USER_ACCESS_CHANGED',
        auth.uid(),
        actor_name
    );


    RETURN jsonb_build_object(
        'ok',
        true
    );

END;
$$;


GRANT EXECUTE
ON FUNCTION public.update_user_access(uuid, jsonb)
TO authenticated;


-- ============================================================
-- 14. PROFILES RLS
-- ============================================================

DROP POLICY IF EXISTS "profiles read own or admin"
ON public.profiles;

CREATE POLICY "profiles read own or admin"
ON public.profiles
FOR SELECT
USING (
    auth.uid() = id
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'hr_manager'
    )
);


DROP POLICY IF EXISTS "profiles update own or admin"
ON public.profiles;

CREATE POLICY "profiles update own or admin"
ON public.profiles
FOR UPDATE
USING (
    auth.uid() = id
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'hr_manager'
    )
)
WITH CHECK (
    auth.uid() = id
    OR public.current_role() IN (
        'admin',
        'super_admin',
        'hr_manager'
    )
);


-- ============================================================
-- 15. NEW PERMISSIONS — WORK MANAGEMENT
-- ============================================================

INSERT INTO public.permissions (
    permission_key,
    description,
    category
)
VALUES

(
    'work.tasks.manage',
    'Create and assign tasks to staff',
    'hr'
),

(
    'work.kpis.manage',
    'Create and assign KPIs',
    'hr'
),

(
    'work.targets.manage',
    'Create and assign targets',
    'hr'
),

(
    'work.plans.manage',
    'Create and manage work plans',
    'hr'
),

(
    'work.reports.review',
    'Review and approve work reports',
    'hr'
),

(
    'work.team.performance',
    'View team performance',
    'hr'
),

(
    'attendance.config.manage',
    'Configure attendance settings',
    'admin'
)

ON CONFLICT (permission_key)
DO NOTHING;


-- ============================================================
-- Assign permissions to SUPER ADMIN + ADMIN
-- ============================================================

DO $$
DECLARE
    r text;
BEGIN

    FOREACH r IN ARRAY ARRAY[
        'super_admin',
        'admin'
    ]
    LOOP

        PERFORM public.assign_permission_to_role(
            r,
            'work.tasks.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.kpis.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.targets.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.plans.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.reports.review'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.team.performance'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'attendance.config.manage'
        );

    END LOOP;


-- ============================================================
-- Assign permissions to HR / AREA / BRANCH management
-- ============================================================

    FOREACH r IN ARRAY ARRAY[
        'hr_manager',
        'area_manager',
        'branch_manager'
    ]
    LOOP

        PERFORM public.assign_permission_to_role(
            r,
            'work.tasks.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.kpis.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.targets.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.plans.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.reports.review'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.team.performance'
        );

    END LOOP;


-- ============================================================
-- Assign permissions to HR OFFICER
-- ============================================================

    FOREACH r IN ARRAY ARRAY[
        'hr_officer'
    ]
    LOOP

        PERFORM public.assign_permission_to_role(
            r,
            'work.tasks.manage'
        );

        PERFORM public.assign_permission_to_role(
            r,
            'work.reports.review'
        );

    END LOOP;

END;
$$;


-- ============================================================
-- PHASE 10 COMPLETE
--
-- User approval workflow
-- Workforce tasks
-- Task progress reports
-- KPI definitions
-- KPI assignments
-- KPI submissions
-- Work plans
-- Attendance exceptions
-- Attendance issues
-- Attendance configuration
-- User access profiles
-- Approval audit trail
-- Management permissions
-- ============================================================
