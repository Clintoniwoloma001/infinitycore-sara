-- ============================================================
-- PHASE 42 — Medical Screening workflow completions (idempotent)
--
-- Run after schema_phase40_medical_screening_workflow.sql.
-- Closes the tracking + expiry gaps in the hospital referral loop:
--
--   1. begin_medical_screening(p_token)  — PUBLIC, token-scoped.
--      Moves an issued/qr_opened referral to `screening_started`,
--      records a SCREENING_STARTED event, audits and notifies HR so
--      "In Progress" is tracked the moment the hospital starts.
--
--   2. notify_expiring_medical_referrals() — HR RPC (no scheduler
--      exists in this project). Called opportunistically from HR
--      dashboard / workbench loads. Fires ONE in-app notification per
--      expiring referral per 24h, so a listing never spams HR.
--
-- Both are additive and safe to re-run.
--
-- FIX (42601): v_hr_id was used as a `FOR v_hr_id IN SELECT id FROM ...`
-- loop target without being declared, which PL/pgSQL rejected with
-- "loop variable of loop over rows must be a record variable or list
-- of scalar variables". Declared explicitly as uuid (matches
-- profiles.id) in both functions so the loop resolves as the
-- single-scalar-variable form.
-- ============================================================

-- ============================================================
-- 1. RPC: begin_medical_screening (PUBLIC / token + single-use)
--     Mirrors submit_medical_screening's guards. `started_at` already
--     exists on medical_referrals (Phase 40).
-- ============================================================
create or replace function public.begin_medical_screening(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := md5(p_token);
  v_ref record;
  v_hr_id uuid;
begin
  select * into v_ref from public.medical_referrals where referral_token_hash = v_hash for update;
  if v_ref.id is null then
    raise exception 'Invalid or unrecognized medical screening referral.';
  end if;
  if v_ref.status = 'revoked' then
    raise exception 'This medical screening referral has been revoked. Contact Human Resources for a new referral.';
  end if;
  if v_ref.expires_at is not null and v_ref.expires_at < now() then
    raise exception 'This medical screening referral has expired. Contact Human Resources for a new referral.';
  end if;
  if v_ref.status in ('submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared') then
    raise exception 'This screening has already been submitted. A new referral is required for re-screening.';
  end if;

  if v_ref.status = 'screening_started' then
    -- Idempotent: already started (e.g. re-click or reload). Return without
    -- creating a duplicate event/notification.
    return jsonb_build_object('ok', true, 'status', 'screening_started', 'reference', v_ref.reference);
  end if;

  update public.medical_referrals
    set status = 'screening_started', started_at = coalesce(started_at, now()), updated_at = now()
  where id = v_ref.id;

  insert into public.medical_screening_events (referral_id, event_type, details, actor)
  values (v_ref.id, 'SCREENING_STARTED',
    format('Screening started for referral %s', v_ref.reference), 'Hospital / unauthenticated');

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values ('MEDICAL_SCREENING_STARTED', 'MedicalReferral', v_ref.id::text, 'Hospital / unauthenticated',
    format('Screening started for referral %s', v_ref.reference), 'info');

  for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  loop
    insert into public.notifications (user_id, title, message, type, link)
    values (v_hr_id, 'Medical screening started',
      format('The hospital has begun the medical screening for %s (%s).', v_ref.subject_name, v_ref.reference),
      'medical', '/medical-management');
  end loop;

  return jsonb_build_object('ok', true, 'status', 'screening_started', 'reference', v_ref.reference);
end; $$;

grant execute on function public.begin_medical_screening(text) to anon, authenticated;

-- ============================================================
-- 2. RPC: notify_expiring_medical_referrals (HR only)
--     Opportunistic scheduler: call after HR loads a medical surface.
--     Creates one in-app notification per active referral expiring
--     within 7 days, deduped per 24h (so a page refresh never repeats).
-- ============================================================
create or replace function public.notify_expiring_medical_referrals()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor_role text := public.current_role();
  v_ref record;
  v_hr_id uuid;
  v_created int := 0;
begin
  if v_actor_role not in ('super_admin', 'admin', 'hr_manager', 'hr_officer') then
    raise exception 'Not authorized';
  end if;

  for v_ref in
    select * from public.medical_referrals r
    where r.status in ('draft', 'issued', 'qr_opened', 'screening_started')
      and r.expires_at is not null
      and r.expires_at > now()
      and r.expires_at < now() + interval '7 days'
  loop
    if exists (
      select 1 from public.notifications n
      where n.type = 'medical'
        and n.title = 'Medical referral expiring soon'
        and strpos(coalesce(n.message, ''), v_ref.reference) > 0
        and n.created_at > now() - interval '24 hours'
    ) then
      continue;
    end if;

    for v_hr_id in select id from public.profiles where role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    loop
      insert into public.notifications (user_id, title, message, type, link)
      values (v_hr_id, 'Medical referral expiring soon',
        format('The medical screening referral %s for %s expires on %s.', v_ref.reference, v_ref.subject_name, to_char(v_ref.expires_at, 'DD Mon YYYY')),
        'medical', '/medical-management');
    end loop;
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('ok', true, 'notified', v_created);
end; $$;

grant execute on function public.notify_expiring_medical_referrals() to authenticated;