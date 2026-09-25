-- Hotfix for the already-applied Director migration. The hosted legacy
-- repayments table was created without the canonical payment_date column that
-- the existing Repayments UI already writes. This repair is additive and does
-- not backfill fabricated historical dates.
begin;

alter table public.repayments
  add column if not exists payment_date date;

comment on column public.repayments.payment_date is
  'Date the repayment was marked paid; null for unpaid or undated historical rows';

commit;
