begin;
create table if not exists public.signature_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  context text not null,
  context_id text,
  original_path text not null,
  normalised_path text,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  created_at timestamptz not null default now()
);
commit;
