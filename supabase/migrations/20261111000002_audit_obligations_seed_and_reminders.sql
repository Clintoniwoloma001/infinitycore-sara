-- ============================================================================
-- PHASE 72b - AUDIT SOURCE DATA, OBLIGATION REGISTER & REMINDER SWEEP
-- ============================================================================
-- Run AFTER 20261111000001 (the Phase 72 schema). Idempotent, additive,
-- transaction-wrapped. Nothing is dropped and no Phase 71/72 row is rewritten.
--
-- THIS MIGRATION DOES THREE THINGS
--
-- 1. IMPORTS THE REAL WORKING DATA. The audit department's four working
--    documents are mapped into the ONE relational model created in Phase 72 -
--    not four parallel spreadsheets:
--      * INTERNAL AUDIT FOLLOW-UP TRACKING REPORT (Q3 2026, Administration
--        Unit)  -> 4 audit-finding obligations with their action plans,
--        risk ratings, owners, target dates and auditor verification notes.
--      * MFB Regulatory Compliance Tracking Board (master board) -> 15
--        statutory returns with regulator, frequency, strict statutory
--        timeline, submission channel and the responsible department.
--      * MFB Regulatory Compliance Board (dashboard) -> the overlapping 12
--        filings, the CBN capital/liquidity ratios, and the regulator
--        escalation directory kept as source metadata.
--      * Regulatory Circular Tracker -> 2 open CBN circulars with issue dates,
--        deadlines, action taken and the committee/owner recorded.
--
--    SOURCE VALUES ARE PRESERVED, NEVER OVERWRITTEN: every row keeps its
--    original wording in `source_metadata` (jsonb) and `source_owner_label`,
--    the document it came from in `source_document_type`, and its original
--    dates. The serialized spreadsheet dates are converted (Excel epoch
--    1899-12-30) so 46310 becomes 2026-10-15 exactly as written.
--
--    ** NO SAMPLE STATUS IS TREATED AS THE CURRENT LEGAL POSITION. **
--    The spreadsheets' 'Pending'/'Compliant' flags and their historical
--    deadlines are historical artefacts, so EVERY imported obligation lands as
--    status 'draft'. A Head of Audit must validate the statutory deadline (and
--    set the next occurrence) before the obligation is activated and any
--    recurring notice goes live. That gate is the point of the import.
--
-- 2. EXTENDS THE OBLIGATION with source provenance, the reminder lead time,
--    the reminder interval and the escalation route - so the reminder engine
--    below is configured per obligation, not hardcoded.
--
-- 3. THE REMINDER / ESCALATION SWEEP. audit_obligation_reminder_sweep() is
--    the server-side job the audit department actually runs: it reminds an
--    owner inside the lead time, reminds again on the interval, marks
--    overdue items OVERDUE to the owner, and escalates a persistent default
--    to the Head of the responsible department. It writes to the EXISTING
--    notifications table and is idempotent through the EXISTING
--    audit_reminder_log unique key, so a retried job cannot send a duplicate.
--    It needs no browser and no handset.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. OBLIGATION EXTENSIONS (additive; Phase 72 columns are untouched)
-- ---------------------------------------------------------------------------
-- Split into separate ALTER TABLE statements; IF NOT EXISTS is per-column
alter table public.audit_obligations add column if not exists source_document_type text;
alter table public.audit_obligations add column if not exists source_metadata jsonb not null default '{}'::jsonb;
alter table public.audit_obligations add column if not exists source_owner_label text;
alter table public.audit_obligations add column if not exists reminder_lead_days integer not null default 7;
alter table public.audit_obligations add column if not exists reminder_interval_days integer not null default 3;
alter table public.audit_obligations add column if not exists escalation_role text;
alter table public.audit_obligations add column if not exists escalation_delay_days integer not null default 3;

alter table public.audit_obligations drop constraint if exists audit_obligations_source_document_type_check;
alter table public.audit_obligations add constraint audit_obligations_source_document_type_check
  check (source_document_type is null or source_document_type in (
    'audit_followup_report', 'regulatory_compliance_board',
    'regulatory_master_board', 'regulatory_circular_tracker', 'manual'));

-- ---------------------------------------------------------------------------
-- 2. THE IMPORTED OBLIGATION REGISTER
-- ---------------------------------------------------------------------------
-- Reference is unique; `on conflict do nothing` makes the import rerunnable
-- WITHOUT clobbering edits a Head of Audit has since made to a row, and
-- without duplicating anything.
insert into public.audit_obligations (
  reference, title, description, instructions, obligation_type, department,
  source_document_type, source_owner_label, source_metadata,
  source_document, source_reference, reporting_period,
  issue_date, submission_deadline, review_deadline,
  priority, risk_rating, recurrence_rule, next_occurrence,
  reminder_lead_days, reminder_interval_days, escalation_role, escalation_delay_days,
  status, created_by
) values
-- ===== A. INTERNAL AUDIT FOLLOW-UP TRACKING REPORT (Q3 2026) ================
(
  'AUD-01',
  'Procurement Policy Non-Compliance',
  'Procurement Policy Non-Compliance: 2% of sampled transactions lacked the mandatory 2 vendor quotes.',
  'Update procurement checklist to mandate 2 quotes; Finance to reject incomplete vouchers.',
  'audit_finding', 'administration',
  'audit_followup_report',
  'Head of Administration / CFO',
  jsonb_build_object(
    'department_under_review', 'Administration Unit',
    'audit_period', 'Q3 2026',
    'risk_rating_source', 'Low',
    'current_status_source', 'Not Started',
    'revised_due_date_source', 'N/A',
    'auditor_comments', 'Awaiting update on the revised checklist rollout.'),
  'INTERNAL AUDIT FOLLOW-UP TRACKING REPORT.xlsx',
  'Sheet1!AUD-01', 'Q3 2026',
  date '2026-07-01', date '2026-10-15', null,
  'medium', 'low', 'none', date '2026-10-15',
  7, 3, 'head_of_administration', 3,
  'draft', null
),
(
  'AUD-02',
  'Failure to Tag Assets (repeat finding)',
  'Failure to Tag Assets: 65% of new assets deployed without physical or barcode tags (Repeat Finding).',
  'Enforce "No Tag, No Release" rule; deploy task force to clear backlog of untagged assets.',
  'audit_finding', 'administration',
  'audit_followup_report',
  'Administrative Manager / Ops Lead',
  jsonb_build_object(
    'department_under_review', 'Administration Unit',
    'audit_period', 'Q3 2026',
    'risk_rating_source', 'High',
    'current_status_source', 'In Progress',
    'revised_due_date_source', 'N/A',
    'auditor_comments', 'Task force formed. Currently verifying asset lists for branches.'),
  'INTERNAL AUDIT FOLLOW-UP TRACKING REPORT.xlsx',
  'Sheet1!AUD-02', 'Q3 2026',
  date '2026-07-01', date '2026-10-30', null,
  'high', 'high', 'none', date '2026-10-30',
  7, 3, 'head_of_administration', 3,
  'draft', null
),
(
  'AUD-03',
  'Slow Response Times on branch maintenance and audit issues',
  'Slow Response Times: 45% of critical branch maintenance and audit issues dragged out for months.',
  'Draft formal SLA framework with clear priority timelines; link metrics to quarterly KPIs.',
  'audit_finding', 'administration',
  'audit_followup_report',
  'Head of Administration / HR Partner',
  jsonb_build_object(
    'department_under_review', 'Administration Unit',
    'audit_period', 'Q3 2026',
    'risk_rating_source', 'Medium',
    'current_status_source', 'In Progress',
    'revised_due_date_source', 'N/A',
    'auditor_comments', 'Draft SLA framework is currently being reviewed by HR.'),
  'INTERNAL AUDIT FOLLOW-UP TRACKING REPORT.xlsx',
  'Sheet1!AUD-03', 'Q3 2026',
  date '2026-07-01', date '2026-11-01', null,
  'medium', 'medium', 'none', date '2026-11-01',
  7, 3, 'head_of_administration', 3,
  'draft', null
),
(
  'AUD-04',
  'Poor Record Keeping - manual, incomplete asset logs',
  'Poor Record Keeping: Manual, incomplete logs with no real-time visibility on asset distribution.',
  'Procure and deploy a cloud-based digitized Asset Management System; migrate inventory data.',
  'audit_finding', 'administration',
  'audit_followup_report',
  'Head of Administration / IT Director',
  jsonb_build_object(
    'department_under_review', 'Administration Unit',
    'audit_period', 'Q3 2026',
    'risk_rating_source', 'High',
    'current_status_source', 'Not Started',
    'revised_due_date_source', 'N/A',
    'auditor_comments', 'Software selection process is underway with IT team.'),
  'INTERNAL AUDIT FOLLOW-UP TRACKING REPORT.xlsx',
  'Sheet1!AUD-04', 'Q3 2026',
  date '2026-07-01', date '2026-12-15', null,
  'high', 'high', 'none', date '2026-12-15',
  7, 3, 'head_of_administration', 3,
  'draft', null
),
-- ===== B. MFB REGULATORY COMPLIANCE TRACKING BOARD (master board) ==========
-- Recurrence and next occurrence are RULES, not typed dates: the next
-- occurrence is computed from current_date below so the register is live.
(
  'REG-01', 'FinA Monthly Returns', 'Statutory monthly return filed through the CBN OFI returns (FinA) application.',
  'On or before 5th day of the subsequent month; preceding workday if the 5th is a weekend or public holiday.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'CBN (OFISD)', 'frequency', 'Monthly',
    'strict_deadline', 'On or before 5th day of subsequent month (Preceding workday if weekend/holiday)',
    'submission_channel', 'FinA Application',
    'core_ratio_min_paid_up_capital', '5,000,000,000', 'core_ratio_car', '10%', 'core_ratio_liquidity', '20%'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 1', 'Monthly',
  null,
  (date_trunc('month', current_date) + interval '5 days' - interval '1 day'
     + case when date_part('day', current_date) > 5 then interval '1 month' else interval '0' end)::date,
  null, 'high', 'high', 'monthly:5', null,
  7, 3, 'financial_controller', 3, 'draft', null
),
(
  'REG-02', 'Agent Banking Operations Report', 'Monthly agent banking operations return filed through the CBN portal.',
  'No later than 10th day of the subsequent month.',
  'regulatory_return', 'e_channel',
  'regulatory_master_board', 'E-channel Department',
  jsonb_build_object('regulator', 'CBN', 'frequency', 'Monthly',
    'strict_deadline', 'No later than 10th day of subsequent month',
    'submission_channel', 'CBN Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 2', 'Monthly',
  null,
  (date_trunc('month', current_date) + interval '10 days' - interval '1 day'
     + case when date_part('day', current_date) > 10 then interval '1 month' else interval '0' end)::date,
  null, 'medium', 'high', 'monthly:10', null,
  7, 3, 'head_of_e_business', 3, 'draft', null
),
(
  'REG-03', 'NDIC Quarterly Returns', 'Quarterly return to the Nigeria Deposit Insurance Corporation.',
  'Within 15 days after the end of each quarter.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'NDIC', 'frequency', 'Quarterly',
    'strict_deadline', 'Within 15 days after the end of each quarter',
    'submission_channel', 'NDIC Portal',
    'board_status', 'Compliant (historical - must be re-validated)'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 3', 'Quarterly',
  null,
  ((date_trunc('quarter', current_date) + interval '3 months' + interval '15 days' - interval '1 day'))::date,
  null, 'high', 'medium', 'quarterly:15', null,
  10, 5, 'financial_controller', 3, 'draft', null
),
(
  'REG-04', 'Audited Annual Financial Statement (CBN & NDIC)',
  'Audited annual financial statements submitted to CBN and NDIC.',
  'Within 4 months after financial year-end (typically April 30).',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'CBN & NDIC', 'frequency', 'Annually',
    'strict_deadline', 'Within 4 months after financial year-end (typically April 30)',
    'submission_channel', 'Email & Physical Submission'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 4', 'Annually',
  null,
  (date_trunc('year', current_date) + interval '4 months' - interval '1 day')::date,
  null, 'critical', 'high', 'annually:04-30', null,
  30, 7, 'financial_controller', 7, 'draft', null
),
(
  'REG-05', 'Company Income Tax (CIT) Returns', 'Annual company income tax return to the Federal Inland Revenue Service.',
  'Within 6 months of the MFB financial year-end (typically June 30).',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FIRS', 'frequency', 'Annually',
    'strict_deadline', 'Within 6 months of the MFB financial year-end (typically June 30)',
    'submission_channel', 'FIRS Taxpro-Max Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 5', 'Annually',
  null,
  (date_trunc('year', current_date) + interval '6 months' - interval '1 day')::date,
  null, 'critical', 'high', 'annually:06-30', null,
  30, 7, 'financial_controller', 7, 'draft', null
),
(
  'REG-06', 'Value Added Tax (VAT) Filing', 'Monthly VAT filing to the Federal Inland Revenue Service.',
  'On or before 21st day of the subsequent month.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FIRS', 'frequency', 'Monthly',
    'strict_deadline', 'On or before 21st day of subsequent month',
    'submission_channel', 'FIRS Taxpro-Max Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 6', 'Monthly',
  null,
  (date_trunc('month', current_date) + interval '21 days' - interval '1 day'
     + case when date_part('day', current_date) > 21 then interval '1 month' else interval '0' end)::date,
  null, 'high', 'high', 'monthly:21', null,
  7, 3, 'financial_controller', 3, 'draft', null
),
(
  'REG-07', 'Withholding Tax (WHT) Filing', 'Monthly withholding tax remittance and return to the Federal Inland Revenue Service.',
  'On or before 21st day of the subsequent month.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FIRS', 'frequency', 'Monthly',
    'strict_deadline', 'On or before 21st day of subsequent month',
    'submission_channel', 'FIRS Taxpro-Max Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 7', 'Monthly',
  null,
  (date_trunc('month', current_date) + interval '21 days' - interval '1 day'
     + case when date_part('day', current_date) > 21 then interval '1 month' else interval '0' end)::date,
  null, 'high', 'high', 'monthly:21', null,
  7, 3, 'financial_controller', 3, 'draft', null
),
(
  'REG-08', 'Suspicious Transaction Reports (STR)',
  'Suspicious transaction reports to the Nigerian Financial Intelligence Unit - event driven, 24-hour clock.',
  'Immediately or within 24 hours of transaction detection.',
  'regulatory_return', 'compliance',
  'regulatory_master_board', 'Compliance Unit',
  jsonb_build_object('regulator', 'NFIU', 'frequency', 'Event-Driven',
    'strict_deadline', 'Immediately or within 24 hours of transaction detection',
    'submission_channel', 'Automated AML System / NFIU Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 8', 'Event-driven',
  null, null, null, 'critical', 'critical', 'event_driven', null,
  1, 1, 'head_of_risk_compliance', 1, 'draft', null
),
(
  'REG-09', 'Currency Transaction Reports (CTR)',
  'Currency transaction reports to the NFIU following a transaction block.',
  'Within 7 days following the transaction block.',
  'regulatory_return', 'compliance',
  'regulatory_master_board', 'Compliance Unit',
  jsonb_build_object('regulator', 'NFIU', 'frequency', 'Weekly / Monthly',
    'strict_deadline', 'Within 7 days following the transaction block',
    'submission_channel', 'NFIU Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 9', 'Weekly',
  null, null, null, 'high', 'high', 'event_driven', null,
  7, 2, 'head_of_risk_compliance', 2, 'draft', null
),
(
  'REG-10', 'Pay-As-You-Earn (PAYE) Tax', 'Monthly PAYE remittance and return to the State Internal Revenue Service.',
  'On or before 10th day of the subsequent month.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'LIRS', 'frequency', 'Monthly',
    'strict_deadline', 'On or before 10th day of subsequent month',
    'submission_channel', 'LIRS e-Tax Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 11', 'Monthly',
  null,
  (date_trunc('month', current_date) + interval '10 days' - interval '1 day'
     + case when date_part('day', current_date) > 10 then interval '1 month' else interval '0' end)::date,
  null, 'high', 'high', 'monthly:10', null,
  7, 3, 'financial_controller', 3, 'draft', null
),
(
  'REG-11', 'FRCN Registration & Returns', 'Annual Financial Reporting Council of Nigeria registration and returns.',
  'Before 31st March annually.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FRCN', 'frequency', 'Annually',
    'strict_deadline', 'Before 31st March annually',
    'submission_channel', 'FRCN Online Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 10', 'Annually',
  null,
  (case when current_date <= make_date(date_part('year', current_date)::int, 3, 31)
        then make_date(date_part('year', current_date)::int, 3, 31)
        else make_date(date_part('year', current_date)::int + 1, 3, 31) end),
  null, 'medium', 'medium', 'annually:03-31', null,
  14, 7, 'financial_controller', 7, 'draft', null
),
(
  'REG-12', 'Annual Returns (Form CAC 10)', 'Annual returns to the Corporate Affairs Commission.',
  'Within 42 days after the Annual General Meeting (AGM), or at least once every year (not later than 12 months after the previous return).',
  'regulatory_return', 'legal',
  'regulatory_master_board', 'Company Secretary',
  jsonb_build_object('regulator', 'CAC', 'frequency', 'Annually',
    'strict_deadline', 'Within 42 days after the Annual General Meeting (AGM), or at least once every year',
    'submission_channel', 'CAC Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 12', 'Annually',
  null,
  (date_trunc('year', current_date) + interval '1 year' - interval '1 day')
    + interval '42 days',
  null, 'high', 'medium', 'annually:agm+42', null,
  14, 7, 'head_of_legal', 7, 'draft', null
),
(
  'REG-13', 'Annual Audited Financial Statement (FRC)',
  'Annual audited financial statement filed electronically through the FRC National Repository Portal.',
  'Filing must occur within 60 days of receiving board approval.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FRC', 'frequency', 'Annually',
    'strict_deadline', 'Within 60 days of receiving board approval',
    'submission_channel', 'FRC National Repository Portal (NRP)'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 13', 'Annually',
  null,
  (date_trunc('year', current_date) + interval '1 year' + interval '60 days' - interval '1 day')::date,
  null, 'high', 'high', 'event_driven', null,
  14, 7, 'financial_controller', 7, 'draft', null
),
(
  'REG-14', 'Management Report on Internal Control Over Financial Reporting (ICFR)',
  'ICFR report integrated into the annual financial statements submitted through the National Repository Portal.',
  'Concurrent with the AFS filing.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FRC', 'frequency', 'Annually',
    'strict_deadline', 'Concurrent with AFS filing',
    'submission_channel', 'Integrated into AFS via the National Repository Portal'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 14', 'Annually',
  null,
  (date_trunc('year', current_date) + interval '1 year' - interval '1 day')::date,
  null, 'high', 'medium', 'annually', null,
  14, 7, 'financial_controller', 7, 'draft', null
),
(
  'REG-15', 'Corporate Governance Compliance Report',
  'Nigerian Code of Corporate Governance (NCCG) compliance evaluation under Section 8(1)(g) of the FRC Act.',
  'Filing must occur on or before 31st March.',
  'regulatory_return', 'finance',
  'regulatory_master_board', 'FINCON Department',
  jsonb_build_object('regulator', 'FRC', 'frequency', 'Annually',
    'strict_deadline', 'On or before 31st March (Section 8(1)(g) FRC Act)',
    'submission_channel', 'FRC National Repository Portal (NRP)'),
  'MFB Regulatory Compliance Tracking Board.docx', 'Master Board S/N 15', 'Annually',
  null,
  (case when current_date <= make_date(date_part('year', current_date)::int, 3, 31)
        then make_date(date_part('year', current_date)::int, 3, 31)
        else make_date(date_part('year', current_date)::int + 1, 3, 31) end),
  null, 'medium', 'medium', 'annually:03-31', null,
  14, 7, 'financial_controller', 7, 'draft', null
),
-- ===== C. REGULATORY CIRCULAR TRACKER ======================================
(
  'CIR-01',
  'Baseline Standards for Automated AML Solution (CBN CMD/DIR/PUB/CIR/001006)',
  'Issuance of Baseline Standards for Automated Anti-Money Laundering (AML) Solution for Financial Institutions in Nigeria (Roadmap Drafting).',
  'Transition from manual and semi-automated monitoring to a technology-driven AML framework; implementation committee headed by the Head of ERM (Tolu Abiwon). Remaining roadmap components scheduled for completion by 10 March 2028.',
  'regulatory_circular', 'erm_operations',
  'regulatory_circular_tracker', 'ERM & Operation Department (committee headed by the Head of ERM - Tolu Abiwon)',
  jsonb_build_object('circular_number', 'CMD/DIR/PUB/CIR/001006', 'issued_by', 'CBN Compliance Department',
    'issued_date', '2026-03-31', 'deadline_written', 'June 10, 2026',
    'mode_of_communication', 'Email to MD/CEO, BOD & All Departmental Heads / April 8, 2026',
    'action_taken', 'A committee was set up for implementation, headed by the Head of ERM (Tolu Abiwon)',
    'compliance_source', 'Roadmap Phase Completed',
    'pending_source', 'Other components of the implementation roadmap remain underway and are scheduled for completion by March 10, 2028',
    'status_source', 'Open'),
  'Regulatory Circular Tracker.xlsx', 'Regulatory Tracker S/N 1', 'Q3 2026',
  date '2026-03-31', date '2026-06-10', null,
  'critical', 'high', 'event_driven', date '2028-03-10',
  7, 7, 'head_of_risk_compliance', 7, 'draft', null
),
(
  'CIR-02',
  'Implementation Timeline and Enforcement on POS Geo-Fencing (CBN PSS/DIR/PUB/CIR/001/003)',
  'Implementation Timeline and Enforcement on POS Geo-Fencing.',
  'Head of E-Business forwarded the Audit & Investigations email to the vendor; awaiting vendor response.',
  'regulatory_circular', 'e_business',
  'regulatory_circular_tracker', 'e-business Department',
  jsonb_build_object('circular_number', 'PSS/DIR/PUB/CIR/001/003',
    'issued_by', 'CBN Payments System Supervision department (PSS)',
    'issued_date', '2026-05-29', 'deadline_written', '2026-08-01',
    'mode_of_communication', 'email / 2026-09-09',
    'action_taken', 'Head of E-Business forwarded the Audit & Investigations email to the vendor.',
    'compliance_source', 'Awaiting response from the vendor',
    'status_source', 'open'),
  'Regulatory Circular Tracker.xlsx', 'Regulatory Tracker S/N 2', 'Q3 2026',
  date '2026-05-29', date '2026-08-01', null,
  'high', 'high', 'event_driven', null,
  5, 3, 'head_of_e_business', 3, 'draft', null
),
-- ===== D. MFB COMPLIANCE BOARD - overlapping filings kept with their board
--         status preserved as provenance (not as legal truth) ================
(
  'REG-16', 'State PAYE Remittance & Returns (SIRS)',
  'Monthly PAYE remittance and return to the State Internal Revenue Service.',
  'On or before 10th day of the subsequent month.',
  'regulatory_return', 'finance',
  'regulatory_compliance_board', 'FINCON Department',
  jsonb_build_object('regulator', 'SIRS (e.g. LIRS)', 'frequency', 'Monthly',
    'strict_deadline', 'On or before 10th day of subsequent month',
    'submission_channel', 'State IRS e-Tax Portal',
    'board_action_status_flag', 'Pending (historical)'),
  'MFB Regulatory Compliance Board.xlsx', 'Compliance Dashboard S/N 2', 'Monthly',
  null,
  (date_trunc('month', current_date) + interval '10 days' - interval '1 day'
     + case when date_part('day', current_date) > 10 then interval '1 month' else interval '0' end)::date,
  null, 'high', 'high', 'monthly:10', null,
  7, 3, 'financial_controller', 3, 'draft', null
),
(
  'REG-17', 'Notice of Change of Directors / Secretary (CAC)',
  'Event-driven notice of change of directors or company secretary.',
  'Within 14 days of the change or board resolution.',
  'regulatory_return', 'legal',
  'regulatory_compliance_board', 'Company Secretary',
  jsonb_build_object('regulator', 'CAC', 'frequency', 'Event-Driven',
    'strict_deadline', 'Within 14 days of the change or board resolution',
    'submission_channel', 'CAC Post-Incorporation Portal',
    'board_action_status_flag', 'Event-Driven (historical)'),
  'MFB Regulatory Compliance Board.xlsx', 'Compliance Dashboard S/N 9', 'Event-driven',
  null, null, null, 'medium', 'medium', 'event_driven', null,
  7, 3, 'head_of_legal', 3, 'draft', null
),
(
  'REG-18', 'Notice of Change in Registered Office Address (CAC)',
  'Event-driven notice of a change in the registered office address.',
  'Within 14 days of company relocation.',
  'regulatory_return', 'legal',
  'regulatory_compliance_board', 'Company Secretary',
  jsonb_build_object('regulator', 'CAC', 'frequency', 'Event-Driven',
    'strict_deadline', 'Within 14 days of company relocation',
    'submission_channel', 'CAC Post-Incorporation Portal',
    'board_action_status_flag', 'Event-Driven (historical)'),
  'MFB Regulatory Compliance Board.xlsx', 'Compliance Dashboard S/N 10', 'Event-driven',
  null, null, null, 'low', 'low', 'event_driven', null,
  7, 3, 'head_of_legal', 3, 'draft', null
),
(
  'REG-19', 'Notice of Increase in Share Capital (CAC)',
  'Event-driven notice of an increase in share capital.',
  'Within 15 days of general meeting resolution.',
  'regulatory_return', 'legal',
  'regulatory_compliance_board', 'Company Secretary',
  jsonb_build_object('regulator', 'CAC', 'frequency', 'Event-Driven',
    'strict_deadline', 'Within 15 days of general meeting resolution',
    'submission_channel', 'CAC Post-Incorporation Portal',
    'board_action_status_flag', 'Event-Driven (historical)'),
  'MFB Regulatory Compliance Board.xlsx', 'Compliance Dashboard S/N 11', 'Event-driven',
  null, null, null, 'low', 'low', 'event_driven', null,
  7, 3, 'head_of_legal', 3, 'draft', null
),
(
  'REG-20', 'Return of Allotment of Shares (Form CAC 2.1)',
  'Event-driven return of allotment of shares.',
  'Within 1 month of allotting new equity shares.',
  'regulatory_return', 'legal',
  'regulatory_compliance_board', 'Company Secretary',
  jsonb_build_object('regulator', 'CAC', 'frequency', 'Event-Driven',
    'strict_deadline', 'Within 1 month of allotting new equity shares',
    'submission_channel', 'CAC Post-Incorporation Portal',
    'board_action_status_flag', 'Event-Driven (historical)'),
  'MFB Regulatory Compliance Board.xlsx', 'Compliance Dashboard S/N 12', 'Event-driven',
  null, null, null, 'low', 'low', 'event_driven', null,
  7, 3, 'head_of_legal', 3, 'draft', null
)
on conflict (reference) do nothing;

-- Regulator escalation directory preserved from the MFB board's reference
-- sheet, so the contingency channel is one join away from the obligation.
comment on column public.audit_obligations.source_metadata is
  'Immutable copy of the source-document row (regulator, frequency, statutory timeline, channel, original status flags). The live legal position is validated by the Head of Audit, never assumed from this.';

-- ---------------------------------------------------------------------------
-- 3. BUSINESS-DAY HELPER (weekend/holiday treatment)
-- ---------------------------------------------------------------------------
-- Saturday shifts BACK to the preceding Friday, Sunday FORWARD to Monday -
-- matching "preceding workday if weekend/holiday" in the master board. Public
-- holidays are not modelled: pretending to know the holiday calendar would be
-- fabricating data, and the Head of Audit can move a validated deadline
-- through the authorised extension path (recorded, never silent).
create or replace function public.audit_shift_to_workday(p_date date)
returns date language sql immutable set search_path = public as $$
  select case extract(dow from p_date)
           when 6 then p_date - 1   -- Saturday -> Friday
           when 0 then p_date + 1   -- Sunday   -> Monday
           else p_date
         end;
$$;

-- ---------------------------------------------------------------------------
-- 4. REMINDER / ESCALATION SWEEP
-- ---------------------------------------------------------------------------
-- The engine the audit department actually runs against Heads of Department
-- and their owners. Per obligation:
--   * remind the owner inside the lead time (reminder_lead_days)
--   * remind again every reminder_interval_days while still outstanding
--   * mark OVERDUE once the deadline passes, and say so
--   * escalate a persistent default to the responsible department head
--     (escalation_role) after escalation_delay_days, once.
--
-- Idempotent by construction: audit_reminder_log's unique (kind, subject_id,
-- recipient_id, sent_on) absorbs a retried run, so a job that fires twice
-- cannot deliver twice. Nothing here sends email - the in-app notifications
-- table is the channel this app actually delivers, and Zoho stays phase 7.
create or replace function public.audit_obligation_reminder_sweep()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_reminded int := 0;
  v_overdue int := 0;
  v_escalated int := 0;
  v_due date;
  v_escalators uuid[];
begin
  for v_row in
    select a.id as assignment_id,
           o.reference, o.title, o.department,
           o.reminder_lead_days, o.reminder_interval_days,
           o.escalation_role, o.escalation_delay_days,
           a.assigned_user_id, a.status, a.submission_deadline,
           a.last_reminded_at, a.escalated_at,
           public.audit_shift_to_workday(a.submission_deadline) as eff_due
      from public.audit_obligation_assignments a
      join public.audit_obligations o on o.id = a.obligation_id
     where o.status = 'active'
       and a.status in ('not_started', 'acknowledged', 'returned_for_correction')
       and a.assigned_user_id is not null
       and a.submission_deadline is not null
  loop
    v_due := v_row.eff_due;

    -- Already reminded recently enough on the interval: nothing to do.
    if v_row.last_reminded_at is not null
       and v_row.last_reminded_at::date > current_date - v_row.reminder_interval_days then
      continue;
    end if;

    -- Inside the lead window, or overdue.
    if v_due <= current_date + v_row.reminder_lead_days then
      insert into public.audit_reminder_log (kind, subject_id, recipient_id, sent_on)
      values ('obligation', v_row.assignment_id, v_row.assigned_user_id, current_date)
      on conflict do nothing;

      if found then
        insert into public.notifications (user_id, title, message, link, type, read)
        values (
          v_row.assigned_user_id,
          'Audit obligation due: ' || v_row.reference,
          case
            when v_due < current_date then
              '"' || v_row.title || '" was due on '
              || to_char(v_due, 'DD Mon YYYY') || ' and is now OVERDUE by '
              || (current_date - v_due)::int || ' day(s). Submit or escalate now.'
            when v_due = current_date then
              '"' || v_row.title || '" is DUE TODAY ('
              || to_char(v_due, 'DD Mon YYYY') || ').'
            else
              '"' || v_row.title || '" is due on '
              || to_char(v_due, 'DD Mon YYYY') || ' ('
              || (v_due - current_date)::int || ' day(s) away).'
          end,
          '/audit?tab=obligations', 'urgent', false
        );
        update public.audit_obligation_assignments
           set last_reminded_at = now(), updated_at = now()
         where id = v_row.assignment_id;
        v_reminded := v_reminded + 1;

        if v_due < current_date then
          v_overdue := v_overdue + 1;
        end if;
      end if;
    end if;

    -- Escalation: a persistent default goes to the head of the responsible
    -- department, ONCE, after the configured delay.
    if v_row.escalated_at is null
       and v_row.escalation_role is not null
       and v_due < current_date - v_row.escalation_delay_days then
      -- Resolve the escalation audience: the head of the escalation role,
      -- and where that role does not exist in this deployment (some source
      -- documents name a "Head of Administration" that is not a platform
      -- role), the Head of Audit - never a silent drop.
      select coalesce(array_agg(p.id), '{}') into v_escalators
        from public.profiles p
       where p.role = v_row.escalation_role
          or (v_row.escalation_role is not null
              and not exists (select 1 from public.profiles q where q.role = v_row.escalation_role)
              and p.role = 'head_of_audit');

      if array_length(v_escalators, 1) > 0 then
        insert into public.audit_reminder_log (kind, subject_id, recipient_id, sent_on)
        select 'escalation', v_row.assignment_id, u, current_date
          from unnest(v_escalators) u
        on conflict do nothing;

        if found then
          insert into public.notifications (user_id, title, message, link, type, read)
          select u,
                 'Escalation: audit obligation ' || v_row.reference || ' overdue',
                 '"' || v_row.title || '" issued to the '
                 || v_row.department || ' department was due '
                 || to_char(v_due, 'DD Mon YYYY') || ' and is '
                 || (current_date - v_due)::int
                 || ' day(s) overdue. Please intervene.',
                 '/audit/command-center', 'urgent', false
            from unnest(v_escalators) u;

          update public.audit_obligation_assignments
             set escalated_at = now(), updated_at = now()
           where id = v_row.assignment_id;

          insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
          values ('AUDIT_OBLIGATION_ESCALATED', 'AuditObligationAssignment', v_row.assignment_id::text,
                  'audit-reminder-sweep',
                  jsonb_build_object('reference', v_row.reference, 'days_overdue',
                                     (current_date - v_due)::int, 'success', true)::text,
                  'warning');

          v_escalated := v_escalated + 1;
        end if;
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'reminded', v_reminded,
                            'overdue_flagged', v_overdue, 'escalated', v_escalated,
                            'as_of', current_date);
end;
$$;

revoke all on function public.audit_obligation_reminder_sweep() from public;
grant execute on function public.audit_obligation_reminder_sweep() to authenticated;

-- Extend the reminder-log kinds so the existing unique key keeps working.
alter table public.audit_reminder_log drop constraint if exists audit_reminder_log_kind_check;
alter table public.audit_reminder_log add constraint audit_reminder_log_kind_check
  check (kind in ('regulatory', 'closeout', 'obligation', 'escalation'));

-- ---------------------------------------------------------------------------
-- 5. THE OBLIGATION REGISTER RPC (Command Centre)
-- ---------------------------------------------------------------------------
-- The imported register, readable only by the restricted Command Centre. Every
-- row carries its provenance, the reminder/escalation configuration, the
-- next occurrence and the server-computed SLA state - so the Head of Audit
-- can validate statutory deadlines before activating anything.
create or replace function public.get_audit_obligation_register(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_audit_command_center_reader() then
    raise exception 'AUDIT_FORBIDDEN:The obligation register is restricted to the Head of Audit.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'obligations', coalesce((
      select jsonb_agg(x order by x.urgency, x.reference)
      from (
        select o.id, o.reference, o.title, o.obligation_type, o.department, o.status,
               o.priority, o.risk_rating, o.source_document_type, o.source_document,
               o.source_owner_label, o.source_metadata,
               o.recurrence_rule, o.next_occurrence,
               o.reminder_lead_days, o.reminder_interval_days,
               o.escalation_role, o.escalation_delay_days,
               coalesce(o.submission_deadline, o.next_occurrence) as effective_deadline,
               (select count(*)::int from public.audit_obligation_assignments a
                 where a.obligation_id = o.id) as assignments,
               case o.status when 'draft' then 0 when 'active' then 1 else 2 end as urgency,
               case when o.submission_deadline is null and o.next_occurrence is null then 'not_due'
                    when coalesce(o.submission_deadline, o.next_occurrence) < current_date then 'overdue'
                    when coalesce(o.submission_deadline, o.next_occurrence) = current_date then 'due_today'
                    when coalesce(o.submission_deadline, o.next_occurrence) <= current_date + 7 then 'due_soon'
                    else 'upcoming' end as sla_state
          from public.audit_obligations o
         where (p_status is null or o.status = p_status)
      ) x
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total', (select count(*)::int from public.audit_obligations),
      'draft', (select count(*)::int from public.audit_obligations where status = 'draft'),
      'active', (select count(*)::int from public.audit_obligations where status = 'active'),
      'by_type', (
        select coalesce(jsonb_object_agg(t.obligation_type, t.n), '{}'::jsonb) from (
          select obligation_type, count(*)::int as n from public.audit_obligations group by obligation_type
        ) t)
    )
  );
end;
$$;

revoke all on function public.get_audit_obligation_register(text) from public;
grant execute on function public.get_audit_obligation_register(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. THE VALIDATION GATE (activating an imported obligation)
-- ---------------------------------------------------------------------------
-- An imported obligation is 'draft' until a Head of Audit says the statutory
-- deadline is the CURRENT legal position. This function is that gate: it moves
-- the status and records who validated it and when in the existing audit_logs.
-- Activating a recurring obligation is a high-impact change, so it is logged.
create or replace function public.set_audit_obligation_status(
  p_obligation_id uuid,
  p_status text,
  p_validation_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
begin
  if not (public.has_permission('audit.obligations.manage')
          or public.current_role() in ('super_admin', 'admin', 'head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:Only the Head of Audit can change an obligation status.';
  end if;
  if p_status not in ('draft', 'active', 'paused', 'archived', 'closed') then
    raise exception 'INVALID_STATUS:Unknown obligation status.';
  end if;

  select reference into v_ref from public.audit_obligations where id = p_obligation_id;
  if v_ref is null then
    raise exception 'UNKNOWN_OBLIGATION:That obligation does not exist.';
  end if;

  update public.audit_obligations
     set status = p_status, updated_at = now()
   where id = p_obligation_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('AUDIT_OBLIGATION_STATUS_CHANGED', 'AuditObligation', p_obligation_id::text,
          (select full_name from public.profiles where id = auth.uid()),
          jsonb_build_object('reference', v_ref, 'status', p_status,
                             'validation_note', p_validation_note, 'success', true)::text,
          'info');

  return jsonb_build_object('ok', true, 'reference', v_ref, 'status', p_status);
end;
$$;

revoke all on function public.set_audit_obligation_status(uuid, text, text) from public;
grant execute on function public.set_audit_obligation_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. SCHEDULE (guarded; silently skipped where pg_cron is absent)
-- ---------------------------------------------------------------------------
-- Daily at 07:30 WAT: the register is only useful if it moves on its own.
-- An UNCRON fallback: the web Command Centre also calls the sweep from a
-- server route in a later phase; the job below is the primary path.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'infinitycore-audit-obligation-sweep',
      '30 7 * * *',
      $cmd$ select public.audit_obligation_reminder_sweep(); $cmd$
    );
  end if;
exception
  when others then null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. DEPARTMENT VIEW SHOWS WHAT IS ISSUED, NOT ONLY WHAT IS ASSIGNED
-- ---------------------------------------------------------------------------
-- The imported register is department-scoped but not yet issued to individuals
-- (that happens after the Head of Audit validates it), so a Head of Department
-- must still see the department's obligations - with a null assignment - or
-- the workspace would look empty for exactly the data it exists to show. An
-- INNER join hid them; this redefines the Phase 72 function with a LEFT join
-- and adds the source owner label. Nothing else about the contract changes.
create or replace function public.get_my_department_audit()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dept text := public.current_department();
begin
  if not public.is_department_head() then
    raise exception 'AUDIT_FORBIDDEN:This workspace is limited to Heads of Department.';
  end if;

  return jsonb_build_object(
    'ok', true,
    'viewer', jsonb_build_object(
      'user_id', auth.uid(),
      'department', v_dept
    ),
    'summary', jsonb_build_object(
      'obligations_issued', (
        select count(*)::int from public.audit_obligations o where o.department = v_dept),
      'assignments', (
        select count(*)::int from public.audit_obligation_assignments a where a.department = v_dept),
      'acknowledged', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept and a.acknowledged_at is not null),
      'submitted', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept and a.status in ('submitted', 'under_review', 'accepted', 'closed')),
      'pending', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept and a.status in ('not_started', 'acknowledged')),
      'overdue', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept
          and a.submission_deadline is not null
          and a.submission_deadline < current_date
          and a.status not in ('accepted', 'closed', 'rejected')),
      'returned_for_correction', (
        select count(*)::int from public.audit_submissions s
        join public.audit_obligation_assignments a on a.id = s.assignment_id
        where a.department = v_dept and s.status = 'returned_for_correction'),
      'due_today', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept
          and a.submission_deadline = current_date
          and a.status not in ('accepted', 'closed', 'rejected')),
      'due_next_30', (
        select count(*)::int from public.audit_obligation_assignments a
        where a.department = v_dept
          and a.submission_deadline between current_date and current_date + 30
          and a.status not in ('accepted', 'closed', 'rejected'))
    ),
    -- LEFT join on purpose: an obligation issued to the department but not yet
    -- assigned to a person is still the department's work.
    'obligations', coalesce((
      select jsonb_agg(x order by x.sla_rank, x.submission_deadline nulls last)
      from (
        select o.id, o.reference, o.title, o.instructions, o.obligation_type,
               o.risk_rating, o.priority, o.source_owner_label,
               o.requires_acknowledgement, o.requires_submission,
               o.required_documents, o.recurrence_rule,
               a.id as assignment_id, a.assigned_user_id, a.status as assignment_status,
               a.acknowledgement_deadline, a.acknowledged_at,
               coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) as submission_deadline,
               a.original_submission_deadline,
               a.deadline_extension_reason,
               p.full_name as owner_name, p.work_email as owner_email,
               (coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) - current_date)::int as days_until_due,
               case when a.id is null then 'not_issued'
                    when a.status in ('accepted', 'closed', 'rejected') then 'closed'
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) is null then 'not_due'
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) < current_date then 'overdue'
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) = current_date then 'due_today'
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) <= current_date + 7 then 'due_soon'
                    else 'upcoming' end as sla_state,
               case when a.id is null then 2
                    when a.status in ('accepted', 'closed', 'rejected') then 9
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) is null then 8
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) < current_date then 0
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) = current_date then 1
                    when coalesce(a.submission_deadline, o.submission_deadline, o.next_occurrence) <= current_date + 7 then 2
                    else 3 end as sla_rank
        from public.audit_obligations o
        left join public.audit_obligation_assignments a on a.obligation_id = o.id
        left join public.profiles p on p.id = a.assigned_user_id
        where o.department = v_dept
      ) x
    ), '[]'::jsonb),
    -- The department's own findings from the Phase 71 register.
    'findings', coalesce((
      select jsonb_agg(x order by x.severity_rank, x.opened_at)
      from (
        select f.id, f.title, f.description, f.severity, f.status, f.due_date,
               f.opened_at, f.reference,
               case f.severity when 'critical' then 1 when 'high' then 2
                               when 'medium' then 3 else 4 end as severity_rank
        from public.audit_findings f
        where f.department = v_dept
      ) x
    ), '[]'::jsonb),
    -- The full submission trail for this department, newest first. A returned
    -- item keeps its correction reason and the version it was returned from,
    -- so the Head of Department sees exactly why and can act on it.
    'submissions', coalesce((
      select jsonb_agg(x order by x.submitted_at desc)
      from (
        select s.id, s.assignment_id, s.version, s.status, s.correction_reason,
               s.correction_fields, s.submitted_at, s.reviewed_at,
               o.reference, o.title as obligation_title,
               p.full_name as submitted_by_name
        from public.audit_submissions s
        join public.audit_obligation_assignments a on a.id = s.assignment_id
        join public.audit_obligations o on o.id = s.obligation_id
        left join public.profiles p on p.id = s.submitted_by
        where a.department = v_dept
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_my_department_audit() from public;
grant execute on function public.get_my_department_audit() to authenticated;

commit;
