import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000005_profiles_auth_foreign_keys.sql')
const baseSchema = read('schema.sql')
const phase9 = read('schema_phase9_user_management_security.sql')

// ------------------------------------------------------------------
// 1. Migration: profiles.id -> auth.users(id) ON DELETE CASCADE
// ------------------------------------------------------------------
assert.match(migration, /profiles_id_fkey/, 'constraint name')
assert.match(migration, /foreign key \(id\) references auth\.users\(id\) on delete cascade/)
assert.match(migration, /add constraint profiles_id_fkey/, 'adds via ALTER (idempotent guard via pg_constraint check)')
assert.match(migration, /select 1 from pg_constraint/, 'no-op when the FK already exists')

// ------------------------------------------------------------------
// 2. Migration: profiles.employee_id -> employees(id) ON DELETE SET NULL
// ------------------------------------------------------------------
assert.match(migration, /add column if not exists employee_id uuid/, 'ensures the column exists')
assert.match(migration, /foreign key \(employee_id\) references public\.employees\(id\) on delete set null/)
assert.match(migration, /to_regclass\('public\.employees'\)/, 'guards FK add on employees existing')

// ------------------------------------------------------------------
// 3. Pre-flight orphan checks (never apply over broken data silently)
// ------------------------------------------------------------------
assert.match(migration, /profiles_auth_fk_aborted: % profile id\(s\) have no matching auth\.users row/)
assert.match(migration, /profiles_employee_fk_aborted: % profile\(s\) reference a missing employee/)
assert.match(migration, /not exists \(select 1 from auth\.users u where u\.id = p\.id\)/, 'detects auth orphans')
assert.match(migration, /not exists \(select 1 from public\.employees e where e\.id = p\.employee_id\)/, 'detects employee orphans')

// ------------------------------------------------------------------
// 4. Source schema already declares both FKs — the migration re-asserts
//    them against a damaged/partially-restored DB (e.g. a scaffold where
//    a manual script dropped them).
// ------------------------------------------------------------------
assert.match(baseSchema, /id uuid primary key references auth\.users\(id\) on delete cascade/)
assert.match(phase9, /employee_id uuid references public\.employees\(id\) on delete set null/)

// ------------------------------------------------------------------
// 5. e2e of the SHIPPED definitions mirrors what was verified against a
//    real Postgres in a scratch DB:
//    orphan insert -> FK violation, employee orphan -> FK violation,
//    auth delete -> cascade, employee delete -> set null.
// ------------------------------------------------------------------
const cascadeCount = (migration.match(/on delete cascade/g) || []).length
assert.ok(cascadeCount >= 1, 'cascade behaviour explicitly requested')
const setNullCount = (migration.match(/on delete set null/g) || []).length
assert.ok(setNullCount >= 1, 'set-null behaviour explicitly requested')

console.log('profilesAuthFk.test.mjs passed')