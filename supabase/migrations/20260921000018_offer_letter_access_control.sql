-- Phase 5 — Offer-letter access control.
-- Idempotent/additive.
-- Rules:
--   * HR users can still issue and download offer letters.
--   * Candidates can only PREVIEW the latest accepted offer via their portal token.
--   * Super Admin downloads are intentionally not audited by this change.

create or replace function public.public_get_accepted_offer_by_portal_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate public.hr_candidates;
  v_offer public.offer_letters;
  v_job public.hr_jobs;
begin
  select * into v_candidate
    from public.hr_candidates
   where application_token_hash = md5(p_token);

  if v_candidate.id is null then
    raise exception 'Portal link is invalid or has expired.';
  end if;

  select * into v_offer
    from public.offer_letters
   where candidate_id = v_candidate.id
     and status = 'accepted'
     and superseded_by is null
   order by accepted_at desc nulls last, issued_at desc nulls last, created_at desc
   limit 1;

  if v_offer.id is null then
    raise exception 'No accepted offer letter is available for preview yet.';
  end if;

  select * into v_job from public.hr_jobs where id = v_offer.job_id;

  return jsonb_build_object(
    'offer', to_jsonb(v_offer),
    'candidate', to_jsonb(v_candidate),
    'job', case when v_job.id is not null then to_jsonb(v_job) else null end
  );
end;
$$;

grant execute on function public.public_get_accepted_offer_by_portal_token(text) to anon, authenticated;
