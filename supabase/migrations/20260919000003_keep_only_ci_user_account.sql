-- DESTRUCTIVE ACCOUNT CLEANUP
-- Keeps only c.iwoloma@infinitymfb.com as an auth user/profile. Employee rows
-- are never deleted: non-kept employees are only unlinked by setting user_id
-- to NULL. The preflight checks make the entire transaction fail safely if the
-- keeper account or its single employee record cannot be identified.

begin;

do $$
declare
  v_keeper_email constant text := 'c.iwoloma@infinitymfb.com';
  v_keeper_user_id uuid;
  v_keeper_employee_id uuid;
  v_employee_matches integer;
begin
  select id
    into v_keeper_user_id
    from auth.users
   where lower(btrim(email)) = v_keeper_email;

  if v_keeper_user_id is null then
    raise exception 'Account cleanup stopped: auth user % was not found.', v_keeper_email;
  end if;

  if not exists (select 1 from public.profiles where id = v_keeper_user_id) then
    raise exception 'Account cleanup stopped: profile for % was not found.', v_keeper_email;
  end if;

  select count(*)
    into v_employee_matches
    from public.employees
   where lower(btrim(email)) = v_keeper_email;

  if v_employee_matches <> 1 then
    raise exception
      'Account cleanup stopped: expected exactly one employee with email %, found %.',
      v_keeper_email, v_employee_matches;
  end if;

  select id
    into v_keeper_employee_id
    from public.employees
   where lower(btrim(email)) = v_keeper_email;

  -- Preserve all employee records. Clear every existing account link first,
  -- then link the one verified employee to the retained account.
  update public.employees
     set user_id = null
   where user_id is not null;

  update public.employees
     set user_id = v_keeper_user_id
   where id = v_keeper_employee_id;

  -- Make the retained profile's email agree with the retained auth account.
  update public.profiles
     set email = v_keeper_email
   where id = v_keeper_user_id;

  -- Deleting auth.users removes the matching public.profiles rows via their
  -- existing ON DELETE CASCADE relationship. No public.employees row is
  -- deleted; their user_id values were safely cleared above.
  delete from auth.users
   where id <> v_keeper_user_id;

  if exists (
    select 1
      from public.employees
     where user_id is not null
       and (id <> v_keeper_employee_id or user_id <> v_keeper_user_id)
  ) then
    raise exception 'Account cleanup stopped: an unexpected employee account link remains.';
  end if;
end;
$$;

commit;
