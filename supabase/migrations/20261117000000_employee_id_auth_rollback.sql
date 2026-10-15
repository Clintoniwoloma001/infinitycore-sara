-- Rollback for 20261117000000_employee_id_auth.sql
-- Removes only the objects this migration added. Idempotent.

begin;

drop function if exists public.auth_rate_limit_hit(text, int, interval);
drop function if exists public.resolve_employee_for_auth(text);
drop table if exists public.auth_rate_limits;

commit;
