-- ============================================================
-- PHASE 28 — PLATFORM CURRENCY (Infinity MFB · InfinityCore)
--
-- Adds an additive, idempotent currency configuration to the
-- single-row platform settings table and exposes a whitelist RPC
-- so Platform Settings → Currency can persist Naira (NGN / ₦).
--
--   * Additive only — never drops/renames existing settings.
--   * Safe to re-run; safe on empty DB.
--   * Mirrors the phase9 update_hr_settings whitelist style
--     (security definer, whitelisted keys, single-row id = 1).
--   * The default is NGN (₦, 2 decimal places, prefix) so the
--     platform renders Naira out of the box.
--
-- Run in Supabase SQL Editor OR apply as a migration.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ADDITIVE COLUMNS (idempotent)
-- ------------------------------------------------------------
alter table public.hr_platform_settings
  add column if not exists currency_code           text default 'NGN',
  add column if not exists currency_symbol         text default '₦',
  add column if not exists currency_position       text default 'prefix',
  add column if not exists currency_decimal_places integer default 2;

comment on column public.hr_platform_settings.currency_code is
  'ISO 4217 currency code. Default NGN (Naira).';
comment on column public.hr_platform_settings.currency_symbol is
  'Display symbol (e.g. ₦).';
comment on column public.hr_platform_settings.currency_position is
  'prefix or suffix — where the symbol sits relative to the amount.';
comment on column public.hr_platform_settings.currency_decimal_places is
  'Number of fraction digits shown (0, 1 or 2).';

-- ------------------------------------------------------------
-- 2. WHITELIST RPC — update ONLY the currency keys (security definer)
-- ------------------------------------------------------------
create or replace function public.update_platform_currency(p_currency jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_current record;
  v_key text;
  v_old_val text;
  v_new_val text;
begin
  if public.current_role() not in ('super_admin', 'admin', 'hr_manager') then
    raise exception 'Not authorized to update platform currency.';
  end if;

  select * into v_current from public.hr_platform_settings where id = 1;

  for v_key in select jsonb_object_keys(p_currency) loop
    -- Only the 4 currency keys are whitelisted — everything else is ignored.
    if v_key not in ('currency_code', 'currency_symbol', 'currency_position', 'currency_decimal_places') then
      continue;
    end if;
    v_old_val := case v_key
      when 'currency_code'           then v_current.currency_code::text
      when 'currency_symbol'         then v_current.currency_symbol::text
      when 'currency_position'       then v_current.currency_position::text
      when 'currency_decimal_places' then v_current.currency_decimal_places::text
      else null
    end;
    v_new_val := p_currency->>v_key;
    if v_new_val is not null and v_new_val <> v_old_val then
      insert into public.hr_settings_audit (setting_key, previous_value, new_value, changed_by)
      values (v_key, v_old_val, v_new_val, auth.uid());
    end if;
  end loop;

  update public.hr_platform_settings set
    currency_code           = coalesce((p_currency->>'currency_code')::text,        currency_code),
    currency_symbol         = coalesce((p_currency->>'currency_symbol')::text,      currency_symbol),
    currency_position       = lower(coalesce((p_currency->>'currency_position')::text, 'prefix')),
    currency_decimal_places = coalesce((p_currency->>'currency_decimal_places')::int, currency_decimal_places),
    updated_at = now(),
    updated_by = auth.uid()
  where id = 1;

  return jsonb_build_object('ok', true);
end; $$;

grant execute on function public.update_platform_currency(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 3. VERIFY (idempotent)
-- ------------------------------------------------------------
select
  (select currency_code from public.hr_platform_settings where id = 1)           as currency_code,
  (select currency_symbol from public.hr_platform_settings where id = 1)         as currency_symbol,
  (select currency_position from public.hr_platform_settings where id = 1)       as currency_position,
  (select currency_decimal_places from public.hr_platform_settings where id = 1) as currency_decimal_places;
