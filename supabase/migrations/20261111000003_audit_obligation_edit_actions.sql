-- ============================================================================
-- PHASE 72c - AUDIT OBLIGATION EDIT + STATUS ACTIONS
-- ============================================================================
-- Run AFTER 20261111000002 (the obligation register + reminder sweep).
-- Idempotent, additive, transaction-wrapped. Nothing is dropped, no Phase
-- 71/72/72b row is rewritten and NO new status value is introduced.
--
-- WHY THIS MIGRATION
-- The Audit Command Centre could already CREATE an obligation and move its
-- STATUS (set_audit_obligation_status), but it could not EDIT one. Four
-- actions the Head of Audit needs on an obligation that is already in the
-- register had no server-side write path at all:
--
--   Edit         change the obligation's fields
--   Pause        status 'paused'
--   Send back    status 'draft'  (the register already labels 'draft' as
--                "Awaiting validation" - there is deliberately no separate
--                'awaiting_validation' value, see the note below)
--   Delete       status 'archived' (soft delete; there is no hard-delete RPC
--                and no 'deleted' value, see the note below)
--
-- NO NEW STATUS VALUES. The obligations table already carries exactly
-- ('draft','active','paused','archived','closed'). This migration adds no
-- column and no enum value, so the existing CHECK constraint stays valid:
--   * "Send back" maps to the EXISTING 'draft' value, which is precisely the
--     "awaiting validation" state the register already displays.
--   * "Delete" maps to the EXISTING 'archived' value, which is the soft-delete
--     state the register already filters on. A hard delete would destroy the
--     obligation's assignments and submissions through ON DELETE CASCADE, so
--     it is deliberately not offered.
--
-- PROVENANCE IS IMMUTABLE. update_audit_obligation never touches
-- source_metadata, source_document_type or source_owner_label: the imported
-- wording from the audit department's working documents stays exactly as it
-- was written, while the live legal position (deadlines, reminder windows,
-- escalation route) is edited around it.
--
-- The permission gate is IDENTICAL to create_audit_obligation - the Head of
-- Audit (and the two break-glass admins). It is not widened by adding an
-- editor.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. UPDATE AN OBLIGATION (and optionally move its status in the same call)
-- ---------------------------------------------------------------------------
-- Every parameter defaults to null and a null parameter means "leave this
-- field alone", so a caller can change one field without resending the whole
-- row. p_status is the one exception that is validated rather than ignored.
--
-- p_status exists so the Command Centre's "Activate" can save the Head of
-- Audit's edits AND flip the row to active in ONE round trip - the review
-- modal edits and activates as a single decision, not two.
create or replace function public.update_audit_obligation(
  p_obligation_id uuid,
  p_reference text default null,
  p_title text default null,
  p_description text default null,
  p_instructions text default null,
  p_obligation_type text default null,
  p_department text default null,
  p_accountable_owner_user_id uuid default null,
  p_reporting_period text default null,
  p_source_document text default null,
  p_source_reference text default null,
  p_issue_date date default null,
  p_acknowledgement_deadline date default null,
  p_submission_deadline date default null,
  p_review_deadline date default null,
  p_priority text default null,
  p_risk_rating text default null,
  p_requires_acknowledgement boolean default null,
  p_requires_submission boolean default null,
  p_required_documents jsonb default null,
  p_recurrence_rule text default null,
  p_next_occurrence date default null,
  p_reminder_lead_days integer default null,
  p_reminder_interval_days integer default null,
  p_escalation_role text default null,
  p_escalation_delay_days integer default null,
  p_status text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
  v_existing public.audit_obligations;
  v_changed text[] := '{}';
begin
  -- Same gate as create_audit_obligation. Adding an editor does not widen it.
  if not (public.has_permission('audit.obligations.manage')
          or public.current_role() in ('super_admin', 'admin', 'head_of_audit')) then
    raise exception 'AUDIT_FORBIDDEN:Only the Head of Audit can edit audit obligations.';
  end if;

  -- An unknown status is refused BEFORE anything is written. The accepted set
  -- is exactly the table's existing CHECK constraint - nothing new.
  if p_status is not null and p_status not in ('draft', 'active', 'paused', 'archived', 'closed') then
    raise exception 'INVALID_STATUS:Unknown obligation status.';
  end if;

  -- A blank reference or title is refused, exactly as create_audit_obligation
  -- does, so an edit cannot empty a key field.
  if (p_reference is not null and btrim(p_reference) = '')
     or (p_title is not null and btrim(p_title) = '') then
    raise exception 'OBLIGATION_DETAILS_REQUIRED:An obligation needs a reference and a title.';
  end if;

  select * into v_existing from public.audit_obligations where id = p_obligation_id;
  if v_existing.id is null then
    raise exception 'UNKNOWN_OBLIGATION:That obligation does not exist.';
  end if;

  -- A reference is UNIQUE; give a readable error instead of 23505.
  if p_reference is not null and btrim(p_reference) <> v_existing.reference
     and exists (select 1 from public.audit_obligations o
                  where o.reference = btrim(p_reference) and o.id <> p_obligation_id) then
    raise exception 'REFERENCE_TAKEN:That obligation reference is already in use.';
  end if;

  -- Field-level updates. coalesce(x, existing) keeps an omitted parameter
  -- from silently nulling a populated column.
  update public.audit_obligations
     set reference                = coalesce(btrim(p_reference), reference),
         title                    = coalesce(btrim(p_title), title),
         description              = coalesce(p_description, description),
         instructions             = coalesce(p_instructions, instructions),
         obligation_type          = coalesce(p_obligation_type, obligation_type),
         department               = coalesce(p_department, department),
         accountable_owner_user_id = case when p_accountable_owner_user_id is null
                                          then accountable_owner_user_id
                                          else p_accountable_owner_user_id end,
         reporting_period         = coalesce(p_reporting_period, reporting_period),
         source_document          = coalesce(p_source_document, source_document),
         source_reference         = coalesce(p_source_reference, source_reference),
         issue_date               = coalesce(p_issue_date, issue_date),
         acknowledgement_deadline = coalesce(p_acknowledgement_deadline, acknowledgement_deadline),
         submission_deadline      = coalesce(p_submission_deadline, submission_deadline),
         review_deadline          = coalesce(p_review_deadline, review_deadline),
         priority                 = coalesce(p_priority, priority),
         risk_rating              = coalesce(p_risk_rating, risk_rating),
         requires_acknowledgement  = coalesce(p_requires_acknowledgement, requires_acknowledgement),
         requires_submission      = coalesce(p_requires_submission, requires_submission),
         required_documents       = coalesce(p_required_documents, required_documents),
         recurrence_rule          = coalesce(p_recurrence_rule, recurrence_rule),
         next_occurrence          = coalesce(p_next_occurrence, next_occurrence),
         reminder_lead_days       = coalesce(p_reminder_lead_days, reminder_lead_days),
         reminder_interval_days   = coalesce(p_reminder_interval_days, reminder_interval_days),
         escalation_role          = coalesce(p_escalation_role, escalation_role),
         escalation_delay_days    = coalesce(p_escalation_delay_days, escalation_delay_days),
         status                   = coalesce(p_status, status),
         updated_at               = now()
   where id = p_obligation_id
   returning reference into v_ref;

  -- Record WHAT moved, so the audit trail says "draft -> active" rather than
  -- a silent row rewrite. Activating an obligation is high-impact and this is
  -- the same reason set_audit_obligation_status logs.
  if p_status is not null and p_status <> v_existing.status then
    v_changed := array_append(v_changed, format('status:%s->%s', v_existing.status, p_status));
  end if;
  if p_reference is not null and btrim(p_reference) <> v_existing.reference then
    v_changed := array_append(v_changed, 'reference');
  end if;
  if p_submission_deadline is not null
     and p_submission_deadline <> v_existing.submission_deadline then
    v_changed := array_append(v_changed, 'submission_deadline');
  end if;
  if p_next_occurrence is not null and p_next_occurrence <> v_existing.next_occurrence then
    v_changed := array_append(v_changed, 'next_occurrence');
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    case when p_status is not null and p_status <> v_existing.status
         then 'AUDIT_OBLIGATION_UPDATED_AND_STATUS_CHANGED'
         else 'AUDIT_OBLIGATION_UPDATED' end,
    'AuditObligation', p_obligation_id::text,
    (select full_name from public.profiles where id = auth.uid()),
    jsonb_build_object(
      'reference', v_ref,
      'previous_status', v_existing.status,
      'new_status', coalesce(p_status, v_existing.status),
      'changed_fields', to_jsonb(v_changed),
      'success', true)::text,
    'info'
  );

  return jsonb_build_object('ok', true, 'reference', v_ref,
                            'status', coalesce(p_status, v_existing.status),
                            'changed_fields', to_jsonb(v_changed));
end;
$$;

revoke all on function public.update_audit_obligation(
  uuid, text, text, text, text, text, text, uuid, text, text, text, date, date, date, date,
  text, text, boolean, boolean, jsonb, text, date, integer, integer, text, integer, text
) from public;
grant execute on function public.update_audit_obligation(
  uuid, text, text, text, text, text, text, uuid, text, text, text, date, date, date, date,
  text, text, boolean, boolean, jsonb, text, date, integer, integer, text, integer, text
) to authenticated;

commit;
