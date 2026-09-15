-- ============================================================
-- PHASE 21 — ATTENDANCE ENUM ALIGNMENT (idempotent, additive)
-- ============================================================
-- The Attendance self-service UI lets employees pick fine-grained
-- late-arrival reasons and issue types. The Phase 10 CHECK
-- constraints were narrower, so any legitimate pick would be
-- rejected at insert time with a 23514 check violation.
--
-- This migration widens both CHECK constraints to accept every
-- value offered by the UI (Attendance.jsx LATE_REASONS /
-- ISSUE_TYPES) WITHOUT weakening any RLS policy.
--
-- The anonymous Phase-10 constraints get auto-generated names
-- (attendance_exceptions_reason_check etc.); we drop whichever
-- exists across re-runs and (re)create an EXPLICITLY-NAMED,
-- widened constraint. Fully idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. attendance_exceptions.reason
-- ------------------------------------------------------------
do $$
declare
  v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.attendance_exceptions'::regclass
     and contype = 'c'
     and conname in ('attendance_exceptions_reason_check', 'attendance_exceptions_reason_check1')
   limit 1;
  if v_con is not null then
    execute format('alter table public.attendance_exceptions drop constraint %I', v_con);
  end if;
end $$;

alter table public.attendance_exceptions
  add constraint attendance_exceptions_reason_check check (
    reason in (
      'traffic',
      'transport_delay',
      'health_emergency',
      'medical',
      'official_assignment',
      'family_emergency',
      'personal_emergency',
      'approved_exception',
      'weather',
      'other'
    )
  );

-- ------------------------------------------------------------
-- 2. attendance_issues.issue_type
-- ------------------------------------------------------------
do $$
declare
  v_con text;
begin
  select conname into v_con
    from pg_constraint
   where conrelid = 'public.attendance_issues'::regclass
     and contype = 'c'
     and conname in ('attendance_issues_issue_type_check', 'attendance_issues_issue_type_check1')
   limit 1;
  if v_con is not null then
    execute format('alter table public.attendance_issues drop constraint %I', v_con);
  end if;
end $$;

alter table public.attendance_issues
  add constraint attendance_issues_issue_type_check check (
    issue_type in (
      'forgot_clock_in',
      'forgot_clock_out',
      'incorrect_time',
      'wrong_time',
      'gps_problem',
      'wrong_location',
      'device_problem',
      'fingerprint_not_recognized',
      'device_unavailable',
      'network_failure',
      'other'
    )
  );

-- ============================================================
-- DONE. RLS policies untouched; constraints widened only.
-- ============================================================