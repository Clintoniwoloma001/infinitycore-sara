-- Phase 7 — Surface the configurable leave approval chain in HR & Platform Settings.
-- Extends update_hr_settings (latest def: 20260921000010) so the settings UI can
-- persist the leave_approval_chain template stored on hr_platform_settings (added by
-- 20260921000019). Idempotent/additive — create-or-replace, no new objects.

-- Known stage keys (single source mirrored in the frontend APPROVAL_STAGES catalog).
create or replace function public.update_hr_settings(p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'head_of_human_resources') then
    raise exception 'Not authorized to update HR settings.';
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;

  -- Validate leave_approval_chain when supplied: non-empty array of known stage keys.
  if p_settings ? 'leave_approval_chain' then
    if jsonb_typeof(p_settings -> 'leave_approval_chain') <> 'array' then
      raise exception 'leave_approval_chain must be a JSON array of stage keys.';
    end if;
    if jsonb_array_length(p_settings -> 'leave_approval_chain') = 0 then
      raise exception 'leave_approval_chain must contain at least one stage.';
    end if;
    if exists (
      select 1
        from jsonb_array_elements_text(p_settings -> 'leave_approval_chain') as s(k)
       where s.k not in ('line_manager', 'branch_manager', 'area_manager', 'head_of_human_resources')
    ) then
      raise exception 'leave_approval_chain contains an unknown stage key.';
    end if;
  end if;

  for v_key in select jsonb_object_keys(p_settings) loop
    v_old_val := case v_key
      when 'require_gps_clock_in' then v_current.require_gps_clock_in::text
      when 'require_gps_clock_out' then v_current.require_gps_clock_out::text
      when 'geofence_enabled' then v_current.geofence_enabled::text
      when 'default_geofence_radius' then v_current.default_geofence_radius::text
      when 'allow_manual_correction' then v_current.allow_manual_correction::text
      when 'late_threshold_minutes' then v_current.late_threshold_minutes::text
      when 'early_departure_threshold_minutes' then v_current.early_departure_threshold_minutes::text
      when 'default_work_start_time' then v_current.default_work_start_time::text
      when 'default_work_end_time' then v_current.default_work_end_time::text
      when 'default_grace_period_minutes' then v_current.default_grace_period_minutes::text
      when 'default_break_duration_minutes' then v_current.default_break_duration_minutes::text
      when 'overtime_threshold_minutes' then v_current.overtime_threshold_minutes::text
      when 'app_timezone' then v_current.app_timezone
      when 'leave_annual_days' then v_current.leave_annual_days::text
      when 'leave_sick_days' then v_current.leave_sick_days::text
      when 'leave_casual_days' then v_current.leave_casual_days::text
      when 'leave_maternity_days' then v_current.leave_maternity_days::text
      when 'leave_paternity_days' then v_current.leave_paternity_days::text
      when 'leave_compassionate_days' then v_current.leave_compassionate_days::text
      when 'leave_study_days' then v_current.leave_study_days::text
      when 'leave_unpaid_days' then v_current.leave_unpaid_days::text
      when 'leave_approval_required' then v_current.leave_approval_required::text
      when 'leave_attachment_required' then v_current.leave_attachment_required::text
      when 'leave_carry_forward' then v_current.leave_carry_forward::text
      when 'leave_approval_chain' then (v_current.leave_approval_chain)::text
      else null
    end;
    v_new_val := case
      when v_key = 'leave_approval_chain' then (p_settings -> 'leave_approval_chain')::text
      else p_settings ->> v_key
    end;
    if v_old_val is distinct from v_new_val then
      insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
      values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings set
    require_gps_clock_in = coalesce((p_settings->>'require_gps_clock_in')::boolean, require_gps_clock_in),
    require_gps_clock_out = coalesce((p_settings->>'require_gps_clock_out')::boolean, require_gps_clock_out),
    geofence_enabled = coalesce((p_settings->>'geofence_enabled')::boolean, geofence_enabled),
    default_geofence_radius = coalesce((p_settings->>'default_geofence_radius')::int, default_geofence_radius),
    allow_manual_correction = coalesce((p_settings->>'allow_manual_correction')::boolean, allow_manual_correction),
    late_threshold_minutes = coalesce((p_settings->>'late_threshold_minutes')::int, late_threshold_minutes),
    early_departure_threshold_minutes = coalesce((p_settings->>'early_departure_threshold_minutes')::int, early_departure_threshold_minutes),
    default_work_start_time = coalesce((p_settings->>'default_work_start_time')::time, default_work_start_time),
    default_work_end_time = coalesce((p_settings->>'default_work_end_time')::time, default_work_end_time),
    default_grace_period_minutes = coalesce((p_settings->>'default_grace_period_minutes')::int, default_grace_period_minutes),
    default_break_duration_minutes = coalesce((p_settings->>'default_break_duration_minutes')::int, default_break_duration_minutes),
    overtime_threshold_minutes = coalesce((p_settings->>'overtime_threshold_minutes')::int, overtime_threshold_minutes),
    app_timezone = coalesce(nullif(p_settings->>'app_timezone', ''), app_timezone),
    leave_annual_days = coalesce((p_settings->>'leave_annual_days')::int, leave_annual_days),
    leave_sick_days = coalesce((p_settings->>'leave_sick_days')::int, leave_sick_days),
    leave_casual_days = coalesce((p_settings->>'leave_casual_days')::int, leave_casual_days),
    leave_maternity_days = coalesce((p_settings->>'leave_maternity_days')::int, leave_maternity_days),
    leave_paternity_days = coalesce((p_settings->>'leave_paternity_days')::int, leave_paternity_days),
    leave_compassionate_days = coalesce((p_settings->>'leave_compassionate_days')::int, leave_compassionate_days),
    leave_study_days = coalesce((p_settings->>'leave_study_days')::int, leave_study_days),
    leave_unpaid_days = coalesce((p_settings->>'leave_unpaid_days')::int, leave_unpaid_days),
    leave_approval_required = coalesce((p_settings->>'leave_approval_required')::boolean, leave_approval_required),
    leave_attachment_required = coalesce((p_settings->>'leave_attachment_required')::boolean, leave_attachment_required),
    leave_carry_forward = coalesce((p_settings->>'leave_carry_forward')::boolean, leave_carry_forward),
    leave_approval_chain = coalesce(p_settings -> 'leave_approval_chain', leave_approval_chain),
    updated_at = now(),
    updated_by = auth.uid()
  where id = 1;

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.update_hr_settings(jsonb) to authenticated;