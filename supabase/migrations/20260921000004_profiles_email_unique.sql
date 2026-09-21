-- ============================================================
-- PROFILES — EMAIL UNIQUENESS HARDENING
-- ------------------------------------------------------------
-- Guards against a repeat of the incident where a manually-run SQL
-- script produced duplicate (or missing) rows in `profiles`, which
-- then broke every `.single()` profile fetch in the app with
-- PGRST116 ("Cannot coerce the result to a single JSON object").
--
--   * `id` is already a PRIMARY KEY (FK -> auth.users(id)) and
--     `auth_user_id` does not exist (id IS the auth user id), so a
--     profile can never be duplicated BY ID — Postgres rejects it.
--   * `email` had NO uniqueness guarantee: the one natural key a bad
--     script could duplicate, producing two rows that differ only by
--     id while sharing an email. A lookup by email (promoteSuperadmin)
--     then hits PGRST116, and the app-wide id lookup silently misses.
--
-- This migration adds unique enforcement on profiles.email,
-- case/whitespace-insensitive (lower(btrim(...))) to match how the
-- rest of the codebase resolves users — invite detection uses ILIKE
-- and account reconciliation compares lower(btrim(email)). A future
-- bad INSERT now fails loudly with a unique_violation (23505) at
-- insert time instead of only surfacing as a confusing frontend
-- crash later.
--
-- PRE-FLIGHT: the unique index can only exist when no duplicate
-- non-null emails remain. If the data was NOT already corrected, the
-- migration aborts with a clear message listing every duplicated
-- email so the operator can resolve it first. Failure is loud and
-- self-diagnosing — never a silent partial apply. Multiple NULL
-- emails remain legal (all-NULL keys are exempt from unique indexes),
-- so a stray blank profile never blocks application.
--
-- Idempotent + additive — safe to re-run. Applied on top of the
-- base schema.sql `profiles` table (which adds the email column);
-- do not modify any existing profile rows.
-- ============================================================

do $$
declare
  v_dup_count bigint;
begin
  select count(*) into v_dup_count
    from (
      select lower(btrim(p.email)) as email_key
        from public.profiles p
       where p.email is not null and btrim(p.email) <> ''
       group by lower(btrim(p.email))
      having count(*) > 1
    ) d;

  if v_dup_count > 0 then
    raise notice 'Duplicate profile emails still present (%):', v_dup_count;
    raise info '%',
      (
        select string_agg(
          format('  %L × %s rows', lower(btrim(p.email)), n),
          E'\n' order by lower(btrim(p.email))
        )
        from (
          select lower(btrim(email)) as email, count(*) as n
            from public.profiles
           where email is not null and btrim(email) <> ''
           group by lower(btrim(email))
          having count(*) > 1
        ) p
      );
    raise exception 'profiles_email_unique_aborted: resolve the % duplicate email(s) above first, then re-run this migration.', v_dup_count;
  end if;
end $$;

-- Equivalent to ADD CONSTRAINT ... UNIQUE, but normalizes case/whitespace
-- so "Foo@x.com" and "foo@x.com " can never both exist. NULLs exempt.
create unique index if not exists uq_profiles_email_lower
  on public.profiles (lower(btrim(email)));