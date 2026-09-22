-- ------------------------------------------------------------------
-- Phase — Messages identity fixes: profile-less members + directory parity
-- ------------------------------------------------------------------
-- Rewrites the two messaging identity RPCs so a real person is NEVER dropped
-- from the member panel just because their `profiles` row is missing (Phase 69
-- incident class: "a manually-run script wiped profiles rows"). Members join by
-- `auth.users.id` (FK), so an auth user can exist with no profile row; the old
-- INNER JOIN on `profiles` returned ZERO rows for them and the UI showed
-- "Unknown User".
--
-- New behaviour (backwards-compatible, additive fields only):
--   * resolve_user_identity drives from the requested ids (unnest) and LEFT
--     JOINs `profiles` + `employees`, so every requested id gets exactly one
--     row with the real employee name when available.
--   * Adds `has_account` (bool: an app `profiles` row exists). `profile_status`
--     is retained so the UI can label members "No account yet" / "Pending
--     approval" and disable their "Message" action instead of faking a name.
--   * get_messaging_directory additionally includes employee-linked accounts
--     that have NO profile row (auto-synced channel members) so their real
--     employee name + profile picture still resolve. Profile-row semantics are
--     otherwise unchanged (role null/customer excluded, search, limit 1000).
--     Bare auth rows (no profile, no employee) stay excluded; customers/anon/
--     service roles are never returned.
-- Idempotent: create-or-replace + grant.

create or replace function public.resolve_user_identity(p_user_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if p_user_ids is null or array_length(p_user_ids, 1) = 0 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', u.user_id,
    'employee_id', e.id,
    'full_name', coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(p.full_name), ''), p.email),
    'email', coalesce(nullif(btrim(e.email), ''), p.email),
    'role', p.role,
    'department', coalesce(nullif(btrim(e.department), ''), p.department),
    'position', e."position",
    'designation', e.confirmation_status,
    'staff_id', coalesce(e.staff_id, e.employee_number, e.employee_code),
    'employment_status', e.employment_status,
    'branch_id', e.branch_id,
    'branch', e.branch,
    'is_former_employee', (e.employment_status not in ('active', 'on_leave')),
    'profile_picture_path', coalesce(
      (select d.file_path from public.documents d
        where d.entity_type = 'employee' and d.entity_id = e.id
          and lower(coalesce(d.document_type, '')) = 'profile_picture'
        order by d.created_at desc limit 1)
      , null),
    'profile_status', p.status,
    'has_account', (p.id is not null)
  )), '[]'::jsonb) into v_result
  from unnest(p_user_ids) as u(user_id)
  left join public.profiles p on p.id = u.user_id
  left join lateral (
    select * from public.employees e2
    where e2.user_id = u.user_id
    order by e2.created_at desc
    limit 1
  ) e on true;

  return coalesce(v_result, '[]'::jsonb);
end; $$;
grant execute on function public.resolve_user_identity(uuid[]) to authenticated;

create or replace function public.get_messaging_directory(p_search text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_result jsonb;
begin
  if v_me is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', r.user_id,
    'employee_id', r.employee_id,
    'full_name', r.full_name,
    'email', r.email,
    'role', r.role,
    'department', r.department,
    'position', r.position,
    'designation', r.designation,
    'staff_id', r.staff_id,
    'employment_status', r.employment_status,
    'branch_id', r.branch_id,
    'branch', r.branch,
    'is_former_employee', r.is_former_employee,
    'profile_picture_path', r.profile_picture_path,
    'profile_status', r.profile_status,
    'has_account', r.has_account
  ) order by r.full_name), '[]'::jsonb) into v_result
  from (
    select
      u.id as user_id,
      e.id as employee_id,
      coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(p.full_name), ''), p.email) as full_name,
      coalesce(nullif(btrim(e.email), ''), p.email) as email,
      p.role as role,
      coalesce(nullif(btrim(e.department), ''), p.department) as department,
      e."position" as position,
      e.confirmation_status as designation,
      coalesce(e.staff_id, e.employee_number, e.employee_code) as staff_id,
      e.employment_status as employment_status,
      e.branch_id as branch_id,
      e.branch as branch,
      (e.employment_status not in ('active', 'on_leave')) as is_former_employee,
      (select d.file_path from public.documents d
        where d.entity_type = 'employee' and d.entity_id = e.id
          and lower(coalesce(d.document_type, '')) = 'profile_picture'
        order by d.created_at desc limit 1) as profile_picture_path,
      p.status as profile_status,
      (p.id is not null) as has_account
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join lateral (
      select * from public.employees e2
      where e2.user_id = u.id
      order by e2.created_at desc
      limit 1
    ) e on true
    where (
             (p.id is null and e.id is not null)
             or coalesce(p.role, 'customer') <> 'customer'
           )
      and (v_q is null
         or coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(p.full_name), ''), p.email) ilike '%' || v_q || '%'
         or coalesce(nullif(btrim(e.email), ''), p.email) ilike '%' || v_q || '%'
         or coalesce(nullif(btrim(e.department), ''), p.department) ilike '%' || v_q || '%')
    limit 1000
  ) r;

  return coalesce(v_result, '[]'::jsonb);
end; $$;
grant execute on function public.get_messaging_directory(text) to authenticated;