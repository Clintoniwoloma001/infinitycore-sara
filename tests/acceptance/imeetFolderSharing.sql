-- ===========================================================================
-- I-Meet folder sharing + Clean APIs provider
-- Run with: npm run test:imeet-sharing
-- One transaction, ROLLED BACK at the end. No data survives.
-- ===========================================================================
\set ON_ERROR_STOP on
begin;

alter table public.profiles disable trigger trg_enforce_role_change;

-- owner, member, and a third user who must never gain access
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('9e000001-0000-0000-0000-000000000001','owner@imeet.test','authenticated','authenticated',
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()),
  ('9e000001-0000-0000-0000-000000000002','member@imeet.test','authenticated','authenticated',
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()),
  ('9e000001-0000-0000-0000-000000000003','outsider@imeet.test','authenticated','authenticated',
   '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now())
on conflict (id) do nothing;

insert into public.profiles (id, full_name, role, status, email) values
  ('9e000001-0000-0000-0000-000000000001','Folder Owner','super_admin','active','owner@imeet.test'),
  ('9e000001-0000-0000-0000-000000000002','Shared Member','admin','active','member@imeet.test'),
  ('9e000001-0000-0000-0000-000000000003','Outsider','admin','active','outsider@imeet.test')
on conflict (id) do update set role = excluded.role, status = 'active';

alter table public.profiles enable trigger trg_enforce_role_change;

create temp table t (k text primary key, v uuid);
insert into t values
  ('owner',   '9e000001-0000-0000-0000-000000000001'),
  ('member',  '9e000001-0000-0000-0000-000000000002'),
  ('outsider','9e000001-0000-0000-0000-000000000003');

select set_config('request.jwt.claim.sub', (select v::text from t where k='owner'), true);
select set_config('request.jwt.claims',
  json_build_object('sub',(select v::text from t where k='owner'),'role','authenticated')::text, true);

create or replace function pg_temp.as_user(p_key text)
returns void language plpgsql as $$
declare v uuid;
begin
  select t.v into v from t where t.k = p_key;
  perform set_config('request.jwt.claim.sub', v::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v::text, 'role','authenticated')::text, true);
end $$;

create or replace function pg_temp.ok(p boolean, p_label text)
returns void language plpgsql as $$
begin
  if p is not true then raise exception 'ASSERTION FAILED: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;

-- The owner's folder + one meeting, both created as the owner.
insert into public.imeet_folders (id, owner_id, name)
values ('9e000002-0000-0000-0000-000000000001',
        (select v from t where k='owner'), 'Board Meetings')
on conflict (id) do nothing;

insert into public.imeet_meetings (id, folder_id, owner_id, title)
values ('9e000003-0000-0000-0000-000000000001',
        '9e000002-0000-0000-0000-000000000001',
        (select v from t where k='owner'), 'Q3 Review')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- T1: A stranger sees nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  v_folder constant uuid := '9e000002-0000-0000-0000-000000000001';
begin
  perform pg_temp.as_user('outsider');
  perform pg_temp.ok(public.imeet_is_folder_owner(v_folder) = false,
    'T1 an outsider does not own the folder');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder) = false,
    'T1 an outsider cannot view the folder');
  perform pg_temp.ok(public.imeet_can_download_folder(v_folder) = false,
    'T1 an outsider cannot download from the folder');
  perform pg_temp.ok(jsonb_array_length(
      public.imeet_list_my_folders() -> 'folders') = 0,
    'T1 the outsider folder list is empty');
end $$;

-- ---------------------------------------------------------------------------
-- T2: The OWNER shares, and the member gains view + download.
-- ---------------------------------------------------------------------------
do $$
declare
  v_folder constant uuid := '9e000002-0000-0000-0000-000000000001';
  v_member uuid;
begin
  select t.v into v_member from t where t.k = 'member';
  perform pg_temp.as_user('owner');
  perform public.imeet_share_folder(v_folder, v_member, true, true);

  perform pg_temp.ok(exists (select 1 from public.imeet_folder_members
      where folder_id = v_folder and user_id = v_member and revoked_at is null),
    'T2 the membership row exists after sharing');

  perform pg_temp.as_user('member');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder),
    'T2 the member can now view the folder');
  perform pg_temp.ok(public.imeet_can_download_folder(v_folder),
    'T2 the member can download from the folder');
  perform pg_temp.ok(jsonb_array_length(
      public.imeet_list_my_folders() -> 'folders') = 1,
    'T2 the shared folder appears in the member list');
  perform pg_temp.ok((public.imeet_list_my_folders() -> 'folders' -> 0 ->> 'is_owner') = 'false',
    'T2 the member is flagged as NOT the owner');
end $$;

-- ---------------------------------------------------------------------------
-- T3: A member cannot escalate - no re-sharing, no member enumeration.
-- ---------------------------------------------------------------------------
do $$
declare
  v_folder constant uuid := '9e000002-0000-0000-0000-000000000001';
  v_outsider uuid;
  v_raised boolean;
begin
  select t.v into v_outsider from t where t.k = 'outsider';
  perform pg_temp.as_user('member');

  v_raised := false;
  begin
    perform public.imeet_share_folder(v_folder, v_outsider, true, true);
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised, 'T3 a member CANNOT share the folder onward');

  v_raised := false;
  begin
    perform public.imeet_list_folder_members(v_folder);
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised, 'T3 a member CANNOT list who else has access');

  perform pg_temp.as_user('outsider');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder) = false,
    'T3 the outsider gained NOTHING from the member attempt');
end $$;

-- ---------------------------------------------------------------------------
-- T4: THE OWNER CAN KICK ANYTIME, and the revoke is IMMEDIATE.
--     This is the requirement that matters most, so it is asserted on the
--     permission function rather than on a flag in the response.
-- ---------------------------------------------------------------------------
do $$
declare
  v_folder constant uuid := '9e000002-0000-0000-0000-000000000001';
  v_member uuid;
  v_res jsonb;
begin
  select t.v into v_member from t where t.k = 'member';

  -- The member still has access right up to the revoke.
  perform pg_temp.as_user('member');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder), 'T4 member has access before the kick');

  -- The owner removes them.
  perform pg_temp.as_user('owner');
  v_res := public.imeet_unshare_folder(v_folder, v_member);
  perform pg_temp.ok((v_res ->> 'ok') = 'true', 'T4 the owner can revoke access');

  -- IMMEDIATE: the very next permission check already denies.
  perform pg_temp.as_user('member');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder) = false,
    'T4 access is revoked IMMEDIATELY after the kick');
  perform pg_temp.ok(public.imeet_can_download_folder(v_folder) = false,
    'T4 download is revoked immediately too');
  perform pg_temp.ok(jsonb_array_length(
      public.imeet_list_my_folders() -> 'folders') = 0,
    'T4 the folder disappears from the member list immediately');
end $$;

-- ---------------------------------------------------------------------------
-- T5: Revoking is idempotent, and a member cannot revoke.
-- ---------------------------------------------------------------------------
do $$
declare
  v_folder constant uuid := '9e000002-0000-0000-0000-000000000001';
  v_member uuid;
  v_res jsonb;
  v_raised boolean;
begin
  select t.v into v_member from t where t.k = 'member';

  perform pg_temp.as_user('owner');
  v_res := public.imeet_unshare_folder(v_folder, v_member);
  perform pg_temp.ok((v_res ->> 'ok') = 'true' and (v_res ->> 'changed') = 'false',
    'T5 a repeated revoke is a safe no-op, not an error');

  -- Only ONE membership row ever exists, so the folder cannot accumulate
  -- duplicate grants for the same person.
  perform pg_temp.ok((select count(*) from public.imeet_folder_members
      where folder_id = v_folder and user_id = v_member) = 1,
    'T5 exactly one membership row per user per folder');

  -- Re-granting revives the same row.
  perform public.imeet_share_folder(v_folder, v_member, true, true);
  perform pg_temp.as_user('member');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder), 'T5 access can be re-granted');
  perform pg_temp.ok((select count(*) from public.imeet_folder_members
      where folder_id = v_folder and user_id = v_member) = 1,
    'T5 re-granting reuses the row rather than duplicating it');

  -- A member still cannot revoke anyone.
  perform pg_temp.as_user('member');
  v_raised := false;
  begin
    perform public.imeet_unshare_folder(v_folder, (select v from t where k='owner'));
  exception when others then v_raised := true; end;
  perform pg_temp.ok(v_raised, 'T5 a member CANNOT revoke the owner');

  -- And the owner still has their folder.
  perform pg_temp.as_user('owner');
  perform pg_temp.ok(public.imeet_is_folder_owner(v_folder), 'T5 the owner retains ownership');
end $$;

-- ---------------------------------------------------------------------------
-- T6: View-only sharing can read but not download.
-- ---------------------------------------------------------------------------
do $$
declare
  v_folder constant uuid := '9e000002-0000-0000-0000-000000000001';
  v_member uuid;
  v_raised boolean;
begin
  select t.v into v_member from t where t.k = 'member';
  perform pg_temp.as_user('owner');
  perform public.imeet_share_folder(v_folder, v_member, true, false);

  perform pg_temp.as_user('member');
  perform pg_temp.ok(public.imeet_can_view_folder(v_folder), 'T6 view-only member can read');
  perform pg_temp.ok(public.imeet_can_download_folder(v_folder) = false,
    'T6 view-only member CANNOT download');
end $$;

-- ---------------------------------------------------------------------------
-- T7: Clean APIs is registered with the exact dashboard model ids.
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.ok(exists (select 1 from public.ai_providers
      where id = 'cleanapis' and default_model = 'gpt-5.6-luna'),
    'T7 the Clean APIs primary model is gpt-5.6-luna');
  perform pg_temp.ok(exists (select 1 from public.ai_providers p
      where p.id = 'cleanapis'
        and p.models @> '[{"id":"gpt-5.6-luna","label":"GPT-5.6 Luna","capabilities":["chat","json","tools","vision"]}]'::jsonb),
    'T7 gpt-5.6-luna is offered with the right capabilities');
  perform pg_temp.ok(exists (select 1 from public.ai_providers p
      where p.id = 'cleanapis'
        and p.models @> '[{"id":"deepseek-v4-flash-0731","label":"DeepSeek V4 Flash 0731","capabilities":["chat","json","tools"]}]'::jsonb),
    'T7 deepseek-v4-flash-0731 is registered as the fallback');
  perform pg_temp.ok(exists (select 1 from public.provider_health where provider_id = 'cleanapis'),
    'T7 Clean APIs has a health row so the router tracks it');
end $$;

-- ---------------------------------------------------------------------------
-- T8: No secret is ever stored in the database.
-- ---------------------------------------------------------------------------
do $$
declare v_leak integer;
begin
  select count(*) into v_leak
    from public.ai_providers p
   where p::text ilike '%cc_%' or p.doc_url ilike '%key%';
  perform pg_temp.ok(v_leak = 0, 'T8 no Clean APIs key is stored in the database');
end $$;

rollback;
