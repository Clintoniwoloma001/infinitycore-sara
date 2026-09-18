-- ============================================================
-- PHASE 56 - DOCUMENT SIGNATURES
-- Additive, idempotent signature configuration and employee
-- signature update RPCs. Signatures remain in the private
-- `documents` storage bucket; tables store only storage paths.
-- ============================================================

alter table public.hr_platform_settings
  add column if not exists management_signature_path text,
  add column if not exists hr_manager_signature_path text;

alter table public.employees
  add column if not exists signature_url text;

create or replace function public.update_hr_signature(
  p_signature_type text,
  p_signature_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_old_path text;
  v_key text;
begin
  if v_role not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to update document signatures.';
  end if;
  if p_signature_type not in ('management', 'hr_manager') then
    raise exception 'Invalid document signature type.';
  end if;
  if p_signature_path is not null and (
    length(trim(p_signature_path)) = 0
    or p_signature_path !~ '^signatures/(management|hr-manager)/[A-Za-z0-9._/-]+\.png$'
  ) then
    raise exception 'Invalid signature storage path.';
  end if;

  if p_signature_type = 'management' then
    select management_signature_path into v_old_path
    from public.hr_platform_settings where id = 1;
    v_key := 'management_signature_path';
    update public.hr_platform_settings
    set management_signature_path = nullif(trim(p_signature_path), ''),
        updated_at = now(), updated_by = auth.uid()
    where id = 1;
  else
    select hr_manager_signature_path into v_old_path
    from public.hr_platform_settings where id = 1;
    v_key := 'hr_manager_signature_path';
    update public.hr_platform_settings
    set hr_manager_signature_path = nullif(trim(p_signature_path), ''),
        updated_at = now(), updated_by = auth.uid()
    where id = 1;
  end if;

  if v_old_path is distinct from nullif(trim(p_signature_path), '') then
    insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
    values (v_key, v_old_path, nullif(trim(p_signature_path), ''), auth.uid());
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'DOCUMENT_SIGNATURE_UPDATED',
      'PlatformSettings',
      '1',
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      format('Updated %s document signature configuration.', p_signature_type),
      'info'
    );
  end if;

  return jsonb_build_object('ok', true, 'signature_type', p_signature_type,
    'signature_path', nullif(trim(p_signature_path), ''));
end;
$$;

grant execute on function public.update_hr_signature(text, text) to authenticated;

create or replace function public.update_employee_signature(
  p_employee_id uuid,
  p_signature_path text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text := public.current_role();
  v_employee public.employees;
  v_allowed boolean := false;
begin
  select * into v_employee from public.employees where id = p_employee_id;
  if v_employee.id is null then raise exception 'Employee not found.'; end if;
  if p_signature_path is not null and (
    length(trim(p_signature_path)) = 0
    or p_signature_path !~ '^signatures/employees/[A-Za-z0-9-]+/[A-Za-z0-9._/-]+\.png$'
  ) then
    raise exception 'Invalid employee signature storage path.';
  end if;

  v_allowed := v_role in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
    or v_employee.user_id = auth.uid();
  if not v_allowed then raise exception 'Not authorized to update this employee signature.'; end if;

  update public.employees
  set signature_url = nullif(trim(p_signature_path), ''), updated_at = now()
  where id = p_employee_id;

  insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
  values (
    'EMPLOYEE_SIGNATURE_UPDATED',
    'Employee',
    p_employee_id::text,
    coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
    'Employee card-holder signature updated.',
    'info'
  );

  return jsonb_build_object('ok', true, 'employee_id', p_employee_id,
    'signature_path', nullif(trim(p_signature_path), ''));
end;
$$;

grant execute on function public.update_employee_signature(uuid, text) to authenticated;

-- Private-bucket storage policies. Management/HR signatures are readable by
-- authenticated staff because every official card/document may need them;
-- employee signatures are readable only by the employee or HR.
drop policy if exists "signature_upload" on storage.objects;
create policy "signature_upload" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'documents'
  and (
    (
      (name like 'signatures/management/%' or name like 'signatures/hr-manager/%')
      and public.current_role() in ('super_admin', 'admin', 'hr_manager')
    )
    or (
      name like 'signatures/employees/%'
      and (
        public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
        or exists (
          select 1 from public.employees e
          where e.id::text = split_part(name, '/', 3)
            and e.user_id = auth.uid()
        )
      )
    )
  )
);

drop policy if exists "signature_read" on storage.objects;
create policy "signature_read" on storage.objects
for select to authenticated
using (
  bucket_id = 'documents'
  and (
    name like 'signatures/management/%'
    or name like 'signatures/hr-manager/%'
    or (
      name like 'signatures/employees/%'
      and (
        public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
        or exists (
          select 1 from public.employees e
          where e.id::text = split_part(name, '/', 3)
            and e.user_id = auth.uid()
        )
      )
    )
  )
);

drop policy if exists "signature_delete" on storage.objects;
create policy "signature_delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'documents'
  and public.current_role() in ('super_admin', 'admin', 'hr_manager', 'hr_officer')
  and (
    name like 'signatures/management/%'
    or name like 'signatures/hr-manager/%'
    or name like 'signatures/employees/%'
  )
);
