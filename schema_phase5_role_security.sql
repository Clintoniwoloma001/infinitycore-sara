-- ============================================================
-- Phase 5: Role security — least privilege by default
-- Run manually in Supabase SQL Editor, after phase4.
--
-- Fixes a real gap in the original schema.sql: profiles.role
-- defaulted to 'staff', and the "profiles update own or admin" RLS
-- policy let ANY authenticated user update their OWN role column
-- (e.g. a direct PostgREST call setting role='super_admin' on their
-- own row would have succeeded). This migration:
--   1. Makes new signups default to 'customer', not 'staff'.
--   2. Adds a trigger that enforces WHO is allowed to change WHOSE
--      role to WHAT, regardless of which client/table/RPC is used.
--   3. Audits every role change server-side, so it's captured even
--      if the app UI is bypassed.
-- ============================================================

-- 1. New signups get 'customer' by default, not 'staff'.
alter table public.profiles alter column role set default 'customer';

-- Re-affirm the accepted role set (idempotent, matches phase4).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in (
    'super_admin','admin','head_of_business','area_manager','branch_manager',
    'operations_manager','loan_officer','relationship_manager','customer_service',
    'hr_manager','hr_officer','staff','customer'
  ));

-- 2. Make the signup trigger explicit: role is ALWAYS 'customer' at
--    creation, no matter what a client sends in raw_user_meta_data.
--    (This also covers Google/OAuth signups — Supabase routes every
--    new identity through the same auth.users insert.)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''), 'customer')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Server-side promotion authorization. This runs on EVERY update
--    to public.profiles, independent of RLS and independent of the
--    frontend — a malicious direct API call cannot bypass it.
create or replace function public.enforce_role_change_policy()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor_role text := public.current_role();
  promoter_roles text[] := array['super_admin','admin','hr_manager','area_manager','branch_manager'];
begin
  if new.role is distinct from old.role then
    if not (actor_role = any(promoter_roles)) then
      raise exception 'Not authorized to change roles (actor role: %)', actor_role;
    end if;

    if new.role = 'super_admin' and actor_role <> 'super_admin' then
      raise exception 'Only super_admin can assign the super_admin role';
    end if;

    if new.role = 'admin' and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign the admin role';
    end if;

    if new.role in ('area_manager','head_of_business') and actor_role not in ('super_admin','admin') then
      raise exception 'Only super_admin or admin can assign this role';
    end if;

    -- Branch Manager may only promote a customer into front-line staff
    -- roles, never into management or above.
    if actor_role = 'branch_manager' and new.role not in ('staff','loan_officer','relationship_manager','customer_service') then
      raise exception 'Branch Manager is not authorized to assign this role';
    end if;

    -- Log every role change server-side, regardless of which client made it.
    insert into public.audit_logs (action, entity_type, entity_id, user_name, details, severity)
    values (
      'user_role_changed',
      'User',
      new.id::text,
      coalesce((select full_name from public.profiles where id = auth.uid()), auth.uid()::text),
      format('%s: %s -> %s', coalesce(new.email, new.id::text), old.role, new.role),
      'critical'
    );
  end if;
  return new;
end; $$;

drop trigger if exists trg_enforce_role_change on public.profiles;
create trigger trg_enforce_role_change
  before update on public.profiles
  for each row execute function public.enforce_role_change_policy();

-- ============================================================
-- DONE. Existing rows are unaffected (this only changes the DEFAULT
-- for new rows and adds an enforcement trigger for future updates).
--
-- IMPORTANT — check your data after running this:
-- select id, email, role from public.profiles where role in ('staff')
-- order by created_at desc limit 20;
-- Any of those that should actually be customers were created before
-- this fix and were not automatically corrected — promote/demote them
-- by hand once via User Management (now properly gated by the trigger
-- above for everyone after you).
-- ============================================================
