-- Enable RLS on the permission lookup tables and keep the access explicit to
-- the super admin role. The tables are used for role-based access lookup so
-- they must not remain readable by all authenticated users.

alter table if exists public.permissions enable row level security;
alter table if exists public.role_permissions enable row level security;

drop policy if exists "permissions_super_admin_read" on public.permissions;
create policy "permissions_super_admin_read"
  on public.permissions
  for select
  to authenticated
  using (public.current_role() = 'super_admin');

drop policy if exists "role_permissions_super_admin_read" on public.role_permissions;
create policy "role_permissions_super_admin_read"
  on public.role_permissions
  for select
  to authenticated
  using (public.current_role() = 'super_admin');
