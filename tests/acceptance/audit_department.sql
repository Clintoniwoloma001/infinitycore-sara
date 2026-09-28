-- Behavioural proof: Audit department + Automation Command Centre.
\pset pager off
set client_min_messages to notice;

do $$
declare
  v_emp uuid; v_uid uuid; v_item uuid; v_finding uuid;
  v_out jsonb; v_sent int; v_fails int := 0;
begin
  select e.id, e.user_id into v_emp, v_uid
    from public.employees e join public.profiles p on p.id = e.user_id
   where e.branch_id is not null limit 1;
  if v_emp is null then raise notice 'SKIP: no employee linked to a profile'; return; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role','authenticated')::text, true);
  alter table public.profiles disable trigger trg_enforce_role_change;

  delete from public.audit_findings;
  delete from public.regulatory_items;
  delete from public.audit_reminder_log;
  delete from public.notifications where user_id = v_uid;
  update public.automation_items set status = 'not_started', live_at = null;

  -- 1. GATING
  update public.profiles set role = 'staff' where id = v_uid;
  begin
    perform public.list_regulatory_items();
    raise notice '1. FAIL: a non-audit role could read the register';
    v_fails := v_fails + 1;
  exception when others then
    if sqlerrm like 'AUDIT_FORBIDDEN%' then raise notice '1. ok: non-audit role refused';
    else raise notice '1. unexpected: %', sqlerrm; v_fails := v_fails + 1; end if;
  end;
  update public.profiles set role = 'head_of_audit' where id = v_uid;

  -- 2. Create a regulatory item due in 5 days, lead time 14.
  v_out := public.upsert_regulatory_item(null, 'Quarterly regulatory return',
    current_date + 5, v_emp, 14, 'pending', 'test item', null, null);
  v_item := (v_out->>'id')::uuid;
  v_out := public.list_regulatory_items();
  raise notice '2. item created, total=% due_next_30=% owner=%',
    v_out#>>'{summary,total}', v_out#>>'{summary,due_next_30}',
    (v_out->'items')->0->>'process_owner_name';
  if (v_out#>>'{summary,total}')::int <> 1 then
    raise notice '   FAIL: item not counted'; v_fails := v_fails + 1;
  end if;

  -- 3. Reminder fires inside the lead time.
  v_sent := public.audit_regulatory_deadline_alerts();
  raise notice '3. deadline alerts sent: % (expected 1)', v_sent;
  if v_sent <> 1 then
    raise notice '   FAIL: owner not prompted inside the lead time'; v_fails := v_fails + 1;
  end if;
  if not exists (select 1 from public.notifications
                  where user_id = v_uid and link = '/audit?tab=regulatory') then
    raise notice '   FAIL: no notification reached the owner'; v_fails := v_fails + 1;
  else
    raise notice '   ok: the process owner got a real in-app notification';
  end if;

  -- 4. Re-running must not spam.
  v_sent := public.audit_regulatory_deadline_alerts();
  raise notice '4. second run sent: % (expected 0 - no spam)', v_sent;
  if v_sent <> 0 then
    raise notice '   FAIL: reminder duplicated within a day'; v_fails := v_fails + 1;
  end if;

  -- 5. Only the item INSIDE its lead time is chased; the far-future one is not.
  perform public.upsert_regulatory_item(null, 'Far future filing', current_date + 200,
    v_emp, 14, 'pending', null, null, null);
  delete from public.audit_reminder_log;
  delete from public.notifications where user_id = v_uid;
  v_sent := public.audit_regulatory_deadline_alerts();
  raise notice '5. two items, one inside its lead time: alerts sent = % (expected 1)', v_sent;
  if v_sent <> 1 then
    raise notice '   FAIL: expected exactly the in-window item'; v_fails := v_fails + 1;
  end if;
  if exists (select 1 from public.notifications
              where user_id = v_uid and title like '%Far future%') then
    raise notice '   FAIL: an item far beyond its lead time was prompted';
    v_fails := v_fails + 1;
  else
    raise notice '   ok: lead time respected - the 200-day item was not chased';
  end if;

  -- 6. Findings: reference generated, stage skipping refused.
  v_out := public.create_audit_finding('Ledger reconciliation gap', v_emp,
    'Operations', 'high', 'test finding', current_date + 3, null);
  v_finding := (v_out->>'id')::uuid;
  raise notice '6. finding raised as %', v_out->>'reference';
  if v_out->>'reference' is null then
    raise notice '   FAIL: no reference generated'; v_fails := v_fails + 1;
  end if;
  begin
    perform public.advance_audit_finding(v_finding, 'closed', 'skipping ahead');
    raise notice '   FAIL: a finding was closed in one jump'; v_fails := v_fails + 1;
  exception when others then
    if sqlerrm like 'INVALID_TRANSITION%' then
      raise notice '   ok: stage skipping refused with INVALID_TRANSITION';
    else raise notice '   unexpected: %', sqlerrm; v_fails := v_fails + 1; end if;
  end;

  -- 7. Closeout requires real notes.
  perform public.advance_audit_finding(v_finding, 'in_progress', null);
  perform public.advance_audit_finding(v_finding, 'pending_closeout', null);
  begin
    perform public.advance_audit_finding(v_finding, 'closed', 'x');
    raise notice '7. FAIL: closed with no real closeout note'; v_fails := v_fails + 1;
  exception when others then
    if sqlerrm like 'CLOSEOUT_NOTES_REQUIRED%' then
      raise notice '7. ok: closeout without notes refused';
    else raise notice '   unexpected: %', sqlerrm; v_fails := v_fails + 1; end if;
  end;

  -- 8. Open-action count and age are derived.
  v_out := public.list_audit_findings();
  raise notice '8. open_total=% age_days=% status=%',
    v_out#>>'{summary,open_total}', (v_out->'findings')->0->>'age_days',
    (v_out->'findings')->0->>'status';
  if (v_out#>>'{summary,open_total}')::int <> 1 then
    raise notice '   FAIL: open count wrong'; v_fails := v_fails + 1;
  end if;

  perform public.advance_audit_finding(v_finding, 'closed', 'Reconciled and evidenced.');
  v_out := public.list_audit_findings();
  raise notice '   after close: open_total=% closed=%',
    v_out#>>'{summary,open_total}', (v_out->'summary'->'by_status')->>'closed';
  if (v_out#>>'{summary,open_total}')::int <> 0 then
    raise notice '   FAIL: closing did not reduce the open count'; v_fails := v_fails + 1;
  else
    raise notice '   ok: closing reduced the open-action count';
  end if;

  -- 9. ACC percentages are DERIVED from item rows.
  -- The automation tracker is owned by Super Admin/Admin/Head of HR/Head of
  -- E-Business, so act as one of them (Head of Audit is a VIEWER of the ACC).
  update public.profiles set role = 'head_of_human_resources' where id = v_uid;
  perform public.set_automation_item_status('regulatory_dashboard', 'live', 'built');
  perform public.set_automation_item_status('regulatory_deadline_alerts', 'live', 'built');
  perform public.set_automation_item_status('audit_reporting_tracking', 'in_progress', 'wip');
  v_out := public.get_automation_portfolio();
  -- departments are ordered by label, so find Audit rather than assuming index 0.
  v_out := (select d from jsonb_array_elements(v_out->'departments') d
             where d->>'department' = 'audit');
  raise notice '9. audit dept: total=% live=% in_progress=% pct=%',
    v_out->>'total', v_out->>'live', v_out->>'in_progress', v_out->>'completion_pct';
  -- 2 live + 1 in-progress (half) = 2.5 of 4 = 62.5%
  if (v_out->>'completion_pct')::numeric <> 62.5 then
    raise notice '   FAIL: percentage is not derived from real item statuses';
    v_fails := v_fails + 1;
  else
    raise notice '   ok: 62.5%% recalculated from 2 live + 1 half of 4 items';
  end if;
  raise notice '   departments shown: %', jsonb_array_length(v_out->'departments');
  raise notice '   active workflows: %', jsonb_array_length(v_out->'active_workflows');

  -- 10. A non-owner role cannot change a status.
  update public.profiles set role = 'staff' where id = v_uid;
  begin
    perform public.set_automation_item_status('regulatory_dashboard', 'not_started', null);
    raise notice '10. FAIL: a non-owner changed an automation status';
    v_fails := v_fails + 1;
  exception when others then
    if sqlerrm like 'AUTOMATION_FORBIDDEN%' then
      raise notice '10. ok: status change refused for a non-owner';
    else raise notice '   unexpected: %', sqlerrm; v_fails := v_fails + 1; end if;
  end;

  -- cleanup
  delete from public.audit_findings;
  delete from public.regulatory_items;
  delete from public.audit_reminder_log;
  delete from public.notifications where user_id = v_uid;
  update public.automation_items set status = 'not_started', live_at = null;
  update public.profiles set role = 'staff' where id = v_uid;
  alter table public.profiles enable trigger trg_enforce_role_change;

  raise notice '';
  if v_fails = 0 then
    raise notice 'RESULT: all audit-workflow checks passed';
  else
    raise notice 'RESULT: % CHECK(S) FAILED', v_fails;
  end if;
end $$;

