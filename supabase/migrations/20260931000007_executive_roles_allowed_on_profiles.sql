-- ============================================================================
-- EXECUTIVE ROLES: director / chairman / md_ceo can exist on a profile
-- ============================================================================
-- THE BUG (this is why every executive page errored)
--   `profiles_role_check` listed:
--     super_admin, admin, head_of_business, area_manager, branch_manager,
--     head_of_operations, head_of_e_business, financial_controller,
--     head_of_risk_compliance, head_of_legal, head_of_audit, loan_officer,
--     relationship_manager, customer_service, head_of_human_resources,
--     hr_officer, staff, customer
--
--   It did NOT list `md_ceo`, `chairman` or `director`.
--
--   Meanwhile the whole application treats those three as first-class
--   executive roles:
--     * src/constants/roles.js defines MD_CEO / CHAIRMAN / DIRECTOR, and
--       get_director_executive_snapshot() *requires* current_role() to be one
--       of 'md_ceo','chairman','director','super_admin';
--     * the Flutter role guard and the executive dashboards key off them.
--
--   So a Director, Chairman or MD/CEO could not hold their own role. A profile
--   row could not be created or updated with it, and the executive snapshot
--   refused everyone who was not 'super_admin'. That surfaced as a wall of
--   unrelated-looking errors on pages such as Branch Performance, where the
--   underlying cause was a permission check several layers up.
--
--   This is NOT the same as "the executives have no employee_id". They are not
--   meant to have one — a director/chairman/MD is an office holder, not a
--   branch roster line. The executive screens read the PROFILE role and the
--   permission document, so the correct fix is to let the role exist at all.
--
-- SAFE / ADDITIVE
--   * Widening a CHECK constraint cannot invalidate an existing row, so this
--     touches no data.
--   * No role is removed, so every existing grant keeps working.
--   * The original constraint is restored by name, so this is safe to re-run.
begin;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (
    role = ANY (ARRAY[
      -- executive tier (the three this migration adds)
      'super_admin'::text, 'md_ceo'::text, 'chairman'::text, 'director'::text,
      -- management / operations (unchanged)
      'admin'::text, 'head_of_business'::text, 'area_manager'::text,
      'branch_manager'::text, 'head_of_operations'::text,
      'head_of_e_business'::text, 'financial_controller'::text,
      'head_of_risk_compliance'::text, 'head_of_legal'::text,
      'head_of_audit'::text, 'head_of_human_resources'::text,
      -- front line / shared (unchanged)
      'loan_officer'::text, 'relationship_manager'::text,
      'customer_service'::text, 'hr_officer'::text,
      'staff'::text, 'customer'::text
    ])
  );

commit;
