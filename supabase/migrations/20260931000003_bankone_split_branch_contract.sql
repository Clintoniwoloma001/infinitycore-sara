-- ============================================================================
-- BankOne: correct split_bankone_branch + deterministic RPC contract
-- ============================================================================
-- Run in Supabase SQL Editor AFTER 20260931000002. Idempotent and additive.
--
-- WHY THIS MIGRATION EXISTS
--
-- (1) split_bankone_branch still normalized with the LEGACY expression
--         upper(replace(btrim(x), '-', ' '))
--     which does NOT strip '/' or '.' and does NOT collapse whitespace, while
--     every other reprocessing path in 20260931000002 uses bankone_norm_branch().
--     Proven consequence: for one and the same BankOne branch, the split path
--     wrote the mapping key
--         "TRADE FAIR/ BOUNDARY/ YABA"   (mapping_type = split)
--     while the accept path wrote
--         "TRADE FAIR BOUNDARY YABA"     (mapping_type = normalized)
--     i.e. TWO mapping rows for ONE real branch, because the unique key is
--     normalized_bankone_branch_name. The split's own loan re-pointing UPDATE
--     then compared its legacy key against legacy-normalized rows and could
--     match nothing, so a split could "succeed" while re-pointing zero loans.
--
-- (2) The reported symptom
--         Could not find the function public.split_bankone_branch(
--             p_new_branch_names, _reason, p_source_importId) in the schema cache
--     lists argument names ("_reason", "p_source_importId") that do not exist
--     in any revision of this repository. That is PostgREST echoing the keys the
--     CALLER sent. It means the caller is out of contract with the deployed
--     function - typically a stale build, or a database where this function was
--     never created/migrated. The fix is therefore threefold:
--       a) one canonical, snake_case contract (unchanged argument names and
--          types, so CREATE OR REPLACE succeeds and no overload is created),
--       b) a schema-cache reload so a freshly applied function is callable
--          immediately, without a manual "Reload schema" in the dashboard,
--       c) a signature-probe RPC so the client can detect drift and say what is
--          actually deployed instead of failing opaquely.
--
-- The function signature below is DELIBERATELY IDENTICAL to the one in
-- 20260929000002, so this is a replace and never a new overload.
begin;

-- ---------------------------------------------------------------------------
-- 1. ONE canonical normalizer, guaranteed present even if this migration is
--    applied to a database that somehow lacks 20260931000002.
-- ---------------------------------------------------------------------------
create or replace function public.bankone_norm_branch(p text)
returns text language sql immutable parallel safe as $$
  select upper(btrim(regexp_replace(regexp_replace(p, '[.\-_/\\]+', ' ', 'g'), '\s+', ' ', 'g')));
$$;

-- ---------------------------------------------------------------------------
-- 2. Re-issue split_bankone_branch. Business logic is PRESERVED verbatim:
--    same validations, same reuse-of-existing-branch behaviour, same
--    deactivate-never-delete, same audit event, same return shape. Only the
--    normalization is corrected, and the reprocessing is made verifiable.
--
--    The signature is UNCHANGED on purpose, so this is a replace and never
--    introduces a second overload that PostgREST could not disambiguate.
-- ---------------------------------------------------------------------------
create or replace function public.split_bankone_branch(
  p_parent_branch_id     uuid,
  p_new_branch_names     text[],
  p_source_import_id     uuid default null,
  p_reason               text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent     public.branches%rowtype;
  v_new_id     uuid;
  v_name       text;
  v_norm       text;
  v_created    uuid[] := '{}';
  v_reused     uuid[] := '{}';
  v_parent_norm text;
  v_affected   integer;
begin
  -- Authorization is unchanged: still an authenticated, role-gated operation.
  -- This is NOT made public in order to silence the error.
  if not public.can_review_work_tasks() then
    raise exception 'You are not allowed to split branches.';
  end if;
  if p_parent_branch_id is null then
    raise exception 'Choose the InfinityCore branch to split.';
  end if;
  if p_new_branch_names is null or array_length(p_new_branch_names, 1) < 2 then
    raise exception 'A split needs at least two real branch names.';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to split a branch.';
  end if;

  select * into v_parent from public.branches where id = p_parent_branch_id for update;
  if v_parent.id is null then
    raise exception 'The branch being split does not exist.';
  end if;
  -- The combined form of the parent, e.g. "Mushin/Yaba" -> "MUSHIN YABA". Used
  -- below so the split can also claim rows whose BankOne label is combined.
  v_parent_norm := public.bankone_norm_branch(v_parent.branch_name);

  foreach v_name in array p_new_branch_names loop
    if v_name is null or btrim(v_name) = '' then continue; end if;

    -- THE FIX: the shared canonical normalizer, so a split and an accept can
    -- never produce two different keys for the same BankOne branch.
    v_norm := public.bankone_norm_branch(v_name);
    if v_norm is null or v_norm = '' then continue; end if;

    -- Re-use an existing canonical branch if one already carries this name,
    -- so a split can be run twice without creating duplicates.
    select id into v_new_id from public.branches
     where public.bankone_norm_branch(branch_name) = v_norm
     order by (branch_name = btrim(v_name)) desc nulls last
     limit 1;

    if v_new_id is null then
      insert into public.branches (branch_name, branch_code, status)
      values (btrim(v_name), upper(left(regexp_replace(btrim(v_name), '[^A-Za-z0-9]', '', 'g'), 6)),
              'active')
      returning id into v_new_id;
      v_created := v_created || v_new_id;
    else
      v_reused := v_reused || v_new_id;
    end if;

    -- Record the mapping, tagged as a split and linked to its parent.
    insert into public.bankone_branch_mappings
      (bankone_branch_name, normalized_bankone_branch_name, canonical_branch_id,
       mapping_type, status, source, split_from_branch_id, created_by)
    values (btrim(v_name), v_norm, v_new_id, 'split', 'active', 'admin', p_parent_branch_id, auth.uid())
    on conflict (normalized_bankone_branch_name) do update
      set canonical_branch_id  = excluded.canonical_branch_id,
          bankone_branch_name  = excluded.bankone_branch_name,
          mapping_type         = 'split',
          status               = 'active',
          split_from_branch_id = excluded.split_from_branch_id,
          created_by           = auth.uid(),
          updated_at           = now();
  end loop;

  if array_length(v_created, 1) is null and array_length(v_reused, 1) is null then
    raise exception 'None of the branch names were usable.';
  end if;

  -- Retire, never delete, the combined branch.
  update public.branches set status = 'inactive', updated_at = now() where id = p_parent_branch_id;

  -- Re-point only the BankOne import rows, and only those that actually carry
  -- one of the new names. Historical employees/attendance/loans are untouched.
  --
  -- THE FIX (two parts):
  --  (a) both sides use bankone_norm_branch(), so a slash/period/double-space
  --      BankOne branch name actually matches instead of silently matching
  --      nothing;
  --  (b) the row key is compared against the COMBINED parent form as well as
  --      each individual name. BankOne frequently reports a combined label
  --      ("MUSHIN/YABA") while InfinityCore holds the same combined branch, so
  --      a split into MUSHIN + YABA must also claim the combined rows. Without
  --      (b) the split "succeeded" while re-pointing ZERO loans, because the
  --      mapping keys (MUSHIN, YABA) could never equal the row key
  --      (MUSHIN YABA).
  update public.bankone_import_rows r
     set resolved_branch_id = m.canonical_branch_id,
         match_status = 'auto_resolved'
    from public.bankone_branch_mappings m
   where m.split_from_branch_id = p_parent_branch_id
     and r.branch_name_raw is not null
     and (
       public.bankone_norm_branch(r.branch_name_raw) = m.normalized_bankone_branch_name
       or public.bankone_norm_branch(r.branch_name_raw) = v_parent_norm
     );
  get diagnostics v_affected = row_count;

  -- The split decision is now recorded per batch like every other resolution,
  -- so the review screen reflects it after a refresh instead of re-deriving it.
  -- The combined parent form must match too, for the same reason as the row
  -- re-pointing above (a pending resolution is keyed "MUSHIN YABA").
  update public.bankone_branch_resolutions br
     set branch_id = m.canonical_branch_id,
         decision = 'mapped',
         mapping_method = 'split',
         decided_by = auth.uid(),
         decided_at = now(),
         updated_at = now()
    from public.bankone_branch_mappings m
   where br.batch_id = p_source_import_id
     and m.split_from_branch_id = p_parent_branch_id
     and (
       br.normalized_branch_name = m.normalized_bankone_branch_name
       or br.normalized_branch_name = v_parent_norm
     );

  perform public.bankone_audit('BRANCH_SPLIT', 'branch', p_parent_branch_id::text,
    jsonb_build_object('parent_branch', v_parent.branch_name,
                       'new_branches', to_jsonb(p_new_branch_names),
                       'created_branch_ids', to_jsonb(v_created),
                       'reused_branch_ids', to_jsonb(v_reused),
                       'rows_repointed', v_affected,
                       'source_import_id', p_source_import_id,
                       'reason', p_reason,
                       'note', 'Parent branch deactivated, not deleted; existing history keeps its original branch'));

  -- Return shape is EXTENDED, not changed: ok / parent_branch_id /
  -- created_branch_ids keep their original meaning so existing callers keep
  -- working. rows_repointed lets the UI state the real effect instead of
  -- guessing it.
  return jsonb_build_object(
    'ok', true,
    'parent_branch_id', p_parent_branch_id,
    'created_branch_ids', to_jsonb(v_created),
    'reused_branch_ids', to_jsonb(v_reused),
    'branch_ids', to_jsonb(coalesce(v_created,'{}') || coalesce(v_reused,'{}')),
    'rows_repointed', v_affected,
    'source_import_id', p_source_import_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. SIGNATURE PROBE. The "in the schema cache" error is opaque because
--    PostgREST echoes the keys the CALLER sent rather than what is deployed.
--    This returns the ACTUAL deployed argument names/types so the client can
--    detect drift and report it precisely. Read-only, no side effects.
-- ---------------------------------------------------------------------------
create or replace function public.bankone_split_branch_signature()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with funcs as (
    -- One row per OVERLOAD (distinct oid), not per argument. The previous
    -- version aggregated argument rows and therefore reported overload_count = 4
    -- for a single function.
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'split_bankone_branch'
  ),
  per_func as (
    -- proargnames is name[]; proargtypes is an oidvector and must be cast to
    -- oid[] before unnest. Note proallargtypes is EMPTY on PostgreSQL 17, so
    -- proargtypes is the only reliable source of argument types here.
    -- pg_get_function_identity_arguments() is included as the authoritative
    -- single-line rendering for error messages.
    select p.oid,
           p.pronargs as nargs,
           p.pronargdefaults as ndefaults,
           (select jsonb_agg(
                      jsonb_build_object(
                        'name', u.nm,
                        'type', format_type(u.typ, null),
                        -- proargdefaults covers only the LAST n arguments, so an
                        -- argument is optional when its ordinal is in that window.
                        'has_default', u.ord > p.pronargs - p.pronargdefaults)
                    order by u.ord)
              from unnest(p.proargnames, p.proargtypes::oid[])
                with ordinality as u(nm, typ, ord)) as args,
           pg_get_function_identity_arguments(p.oid) as identity
      from funcs f
      join pg_proc p on p.oid = f.oid
  )
  select jsonb_build_object(
    'ok', true,
    'exists', (select count(*) > 0 from funcs),
    'overload_count', (select count(*) from funcs),
    -- Scalar subquery, not min(jsonb) (no such aggregate). With one function
    -- this is that function's arg list; if overload_count > 1 the caller must
    -- treat the contract as ambiguous.
    'args', coalesce((select args from per_func limit 1), '[]'::jsonb),
    -- Authoritative single-line rendering, useful for an error message.
    'identity', (select identity from per_func limit 1)
  );
$$;

comment on function public.bankone_split_branch_signature is
  'Reports the DEPLOYED argument names/types of split_bankone_branch so a client can detect a contract mismatch precisely instead of failing with an opaque "in the schema cache" error. Overload count > 1 means PostgREST cannot disambiguate and the contract must be reconciled.';

-- ---------------------------------------------------------------------------
-- 4. SCHEMA CACHE. After applying this migration the function is callable
--    immediately, with no manual "Reload schema" step in the Supabase
--    dashboard. NOTIFY is a no-op if pgrst is not running (e.g. a bare
--    Postgres), so this is safe everywhere.
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_notify('pgrst', 'reload schema');
exception when others then
  raise notice 'pgrst notify skipped: %', sqlerrm;
end $$;

grant execute on function public.split_bankone_branch(uuid, text[], uuid, text) to authenticated;
grant execute on function public.bankone_split_branch_signature() to authenticated;
revoke all on function public.split_bankone_branch(uuid, text[], uuid, text) from anon;
revoke all on function public.bankone_split_branch_signature() from anon;

commit;

-- Final safety net: also notify after COMMIT, because PostgREST reloads on a
-- committed transaction. Harmless if repeated.
notify pgrst, 'reload schema';
