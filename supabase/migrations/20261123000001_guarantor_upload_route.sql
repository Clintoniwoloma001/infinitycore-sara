begin;
alter table if exists public.guarantor_verifications
  add column if not exists submission_method text default 'online',
  add column if not exists uploaded_form_path text,
  add column if not exists uploaded_signature_path text;
commit;
