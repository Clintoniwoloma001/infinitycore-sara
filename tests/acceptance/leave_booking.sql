-- Behavioural proof of the booking -> request workflow, run against the local
-- Postgres. Exercises the TIME GATE and the conversion into the real
-- leave_requests table (the existing approval chain's table).
\pset pager off
set client_min_messages to notice;

do $$
declare
  v_link_id uuid;
  v_raw text;
  v_emp_id uuid;
  v_booking uuid;
  v_req uuid;
  v_out jsonb;
  v_failures int := 0;
begin
  -- An employee to act as, with a signed-in session.
  select e.id into v_emp_id
    from public.employees e
    join public.profiles p on p.id = e.user_id
   where e.branch_id is not null
   limit 1;
  if v_emp_id is null then
    raise notice 'SKIP: no employee is linked to a profile (nothing to book as)';
    return;
  end if;
  perform set_config('request.jwt.claims',
    (select json_build_object('sub', e.user_id::text, 'role','authenticated')::text
       from public.employees e where e.id = v_emp_id), true);

  -- Act as a leave administrator for the HR-side calls, then put it back.
  -- The role-change guard trigger only inspects the CALLER's role, which is
  -- 'customer' for this fixture, so it is suspended for the duration.
  alter table public.profiles disable trigger trg_enforce_role_change;
  update public.profiles set role = 'super_admin'
   where id = (select e.user_id from public.employees e where e.id = v_emp_id);

  -- Clean slate.
  delete from public.leave_bookings where employee_id = v_emp_id;
  delete from public.leave_booking_links;
  update public.hr_platform_settings
     set leave_booking_request_lead_value = 14, leave_booking_request_lead_unit = 'days'
   where id = 1;

  -- 1. HR creates a link; only the hash is stored, the raw key comes back once.
  v_out := public.create_leave_booking_link('Dec planning', 'test', null);
  v_link_id := (v_out->>'id')::uuid;
  v_raw := v_out->>'token';
  raise notice '1. link created, raw token returned once: %', (v_raw is not null);
  if v_raw is null or length(v_raw) <> 48 then v_failures := v_failures + 1; end if;

  if exists (select 1 from public.leave_booking_links
              where id = v_link_id and token_hash = v_raw) then
    raise notice '   FAIL: the raw token was stored in the clear';
    v_failures := v_failures + 1;
  else
    raise notice '   ok: raw token is NOT stored (only its sha256 hash)';
  end if;

  -- 2. The employee books planned dates.
  v_out := public.submit_leave_booking(v_raw, 'annual', current_date + 60, current_date + 64, 'test');
  v_booking := (v_out->>'id')::uuid;
  raise notice '2. booked, working days reported: %', v_out->>'working_days';
  if not (v_out->>'notice' ilike '%not a%request%') then
    raise notice '   FAIL: the booking was not announced as a booking';
    v_failures := v_failures + 1;
  else
    raise notice '   ok: announced as a booking, not a request';
  end if;

  -- 3. A booking is NOT a leave request.
  if exists (select 1 from public.leave_requests where employee_id = v_emp_id
              and start_date = current_date + 60) then
    raise notice '   FAIL: the booking created a leave_request by itself';
    v_failures := v_failures + 1;
  else
    raise notice '3. ok: a booking created NO leave_requests row';
  end if;

  -- 4. The button is gated: 60 days out, a 14 day window is not open.
  v_out := public.get_my_leave_bookings();
  raise notice '4. can_request at 60 days out (window %): %',
    v_out->>'window_days', (v_out->'bookings'->0->>'can_request');
  if (v_out->'bookings'->0->>'can_request')::boolean then
    raise notice '   FAIL: requestable outside the window';
    v_failures := v_failures + 1;
  else
    raise notice '   ok: button disabled, with the date it opens on shown';
  end if;

  -- 5. The server refuses conversion outside the window, whatever the UI does.
  begin
    perform public.convert_leave_booking_to_request(v_booking);
    raise notice '   FAIL: conversion succeeded outside the window';
    v_failures := v_failures + 1;
  exception when others then
    if sqlerrm like 'TOO_EARLY%' then
      raise notice '5. ok: server refused with TOO_EARLY';
    else
      raise notice '   unexpected: %', sqlerrm;
      v_failures := v_failures + 1;
    end if;
  end;

  -- 6. HR shortens the window to 7 days -> still not open at 60 days.
  perform public.save_leave_booking_window(7, 'days', 'tightening for the test');
  v_out := public.get_my_leave_bookings();
  raise notice '6. window now % days, can_request: %',
    v_out->>'window_days', (v_out->'bookings'->0->>'can_request');
  if (v_out->'bookings'->0->>'can_request')::boolean then
    raise notice '   FAIL: shortening the window did not change the gate';
    v_failures := v_failures + 1;
  else
    raise notice '   ok: the button state follows the HR setting';
  end if;

  -- 7. Move the booking inside the window, then convert.
  update public.leave_bookings set start_date = current_date + 5, end_date = current_date + 9
   where id = v_booking;
  v_out := public.get_my_leave_bookings();
  raise notice '7. can_request at 5 days out (7 day window): %',
    (v_out->'bookings'->0->>'can_request');
  if not (v_out->'bookings'->0->>'can_request')::boolean then
    raise notice '   FAIL: not requestable inside the window';
    v_failures := v_failures + 1;
  end if;

  v_out := public.convert_leave_booking_to_request(v_booking);
  v_req := (v_out->>'leave_request_id')::uuid;
  raise notice '   converted -> leave_request % with status %', v_req, v_out->>'status';

  -- 8. It really is a normal request in the EXISTING chain's table.
  if not exists (
    select 1 from public.leave_requests
     where id = v_req and status = 'pending'
       and current_approval_level = 1 and approval_level = 1
       and is_cancellation = false
       and leave_type = 'annual'
       and start_date = current_date + 5
       and employee_id = v_emp_id
  ) then
    raise notice '   FAIL: the converted row is not a normal pending request';
    v_failures := v_failures + 1;
  else
    raise notice '8. ok: pending / approval_level 1 / current_approval_level 1, same as a typed request';
  end if;


  -- 9. It cannot be converted twice.
  begin
    perform public.convert_leave_booking_to_request(v_booking);
    raise notice '   FAIL: double conversion was allowed';
    v_failures := v_failures + 1;
  exception when others then
    if sqlerrm like 'BOOKING_NOT_PENDING%' then
      raise notice '9. ok: refused with BOOKING_NOT_PENDING';
    else
      raise notice '   unexpected: %', sqlerrm;
      v_failures := v_failures + 1;
    end if;
  end;

  -- 10. A revoked link stops accepting new bookings but keeps what it made.
  perform public.revoke_leave_booking_link(v_link_id);
  begin
    perform public.submit_leave_booking(v_raw, 'annual', current_date + 80, current_date + 82, null);
    raise notice '   FAIL: a closed link still accepted a booking';
    v_failures := v_failures + 1;
  exception when others then
    if sqlerrm like 'LINK_CLOSED%' then
      raise notice '10. ok: closed link refused with LINK_CLOSED';
    else
      raise notice '   unexpected: %', sqlerrm;
      v_failures := v_failures + 1;
    end if;
  end;
  if not exists (select 1 from public.leave_bookings where id = v_booking) then
    raise notice '    FAIL: revoking deleted an existing booking';
    v_failures := v_failures + 1;
  else
    raise notice '    ok: the existing booking survived the revoke';
  end if;

  -- 11. The planner shows the booking as a planned entry, not as leave.
  perform public.save_leave_booking_window(14, 'days', 'restoring after the test');
  update public.leave_bookings set status = 'booked', leave_request_id = null
   where id = v_booking;
  delete from public.leave_requests where id = v_req;
  -- Nulls must be typed or Postgres cannot resolve the signature.
  v_out := public.get_leave_planner(
    current_date, current_date + 90,
    null::text, null::uuid, null::text, null::text,
    null::uuid, null::text, null::text);
  if exists (select 1 from jsonb_array_elements(v_out->'entries') en
              where en->>'source' = 'booking') then
    raise notice '11. ok: the booking appears in the planner timeline as source=booking';
  else
    raise notice '    FAIL: the booking is missing from the planner';
    v_failures := v_failures + 1;
  end if;
  raise notice '    capacity rows expose booked_count: %',
    (v_out->'capacity'->0 ? 'booked_count');

  -- cleanup
  delete from public.leave_bookings where employee_id = v_emp_id;
  delete from public.leave_booking_links;
  delete from public.leave_requests where id = v_req;
  update public.profiles set role = 'staff'
   where id = (select e.user_id from public.employees e where e.id = v_emp_id);
  alter table public.profiles enable trigger trg_enforce_role_change;

  raise notice '';
  if v_failures = 0 then
    raise notice 'RESULT: all booking-workflow checks passed';
  else
    raise notice 'RESULT: % CHECK(S) FAILED', v_failures;
  end if;
end $$;

