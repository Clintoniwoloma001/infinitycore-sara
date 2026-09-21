import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000004_profiles_email_unique.sql')
const useAuth = read('src/hooks/useAuth.jsx')
const app = read('src/App.jsx')
const supabaseService = read('src/services/supabaseService.js')
const appraisals = read('src/pages/Appraisals.jsx')

// ------------------------------------------------------------------
// 1. Migration: unique enforcement on profiles.email
// ------------------------------------------------------------------
// The base schema already makes `id` a PRIMARY KEY (FK -> auth.users),
// so id can never duplicate. `email` is the missing natural key — the
// column a bad manual INSERT could duplicate.
assert.match(migration, /uq_profiles_email_lower/)
assert.match(migration, /create unique index if not exists uq_profiles_email_lower/)
assert.match(migration, /on public\.profiles \(lower\(btrim\(email\)\)\)/, 'unique key normalizes case/whitespace')

// Pre-flight: never attempt the index while duplicates remain — abort
// loudly with a self-diagnosing message instead of a raw 23505 buried
// in a transaction log.
assert.match(migration, /having count\(\*\) > 1/, 'detects duplicate emails')
assert.match(migration, /profiles_email_unique_aborted: resolve the % duplicate email\(s\) above first/)
assert.match(migration, /btrim\(p\.email\) <> ''/, 'blank/whitespace-only emails are treated as absent')
assert.match(migration, /NULL.*exempt/, 'null emails remain legal (all-NULL keys exempt from unique indexes)')

// ------------------------------------------------------------------
// 2. Duplicate-detection logic matches what the app already assumes
//    (invites use ILIKE; reconciliation compares lower(btrim())).
//    Pure-JS mirror of the migration's SQL group-by so the behavior is
//    provable without a live database.
// ------------------------------------------------------------------
const emailKey = (e) => (e == null ? null : String(e).trim().toLowerCase())
function findDupes(rows) {
  const counts = new Map()
  for (const r of rows) {
    const key = emailKey(r.email)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1)
}

// Case + whitespace variants of the same address are THE duplicate.
assert.deepEqual(
  findDupes([{ email: ' keeper@bank.com ' }, { email: 'KEEPER@bank.com' }, { email: 'other@bank.com' }]),
  [['keeper@bank.com', 2]],
  'case/whitespace variants are caught as one duplicate email'
)
// Clean data (or varied genuine addresses) passes.
assert.deepEqual(findDupes([{ email: 'a@b.com' }, { email: 'c@b.com' }]), [], 'clean data has no duplicates')
// NULL / blank emails are not treated as duplicates (unique index exempts them).
assert.deepEqual(findDupes([{ email: null }, { email: ' ' }, { email: null }]), [], 'null/blank emails are exempt')

// ------------------------------------------------------------------
// 3. Frontend: graceful degradation when the profile fetch returns
//    nothing (PGRST116) — never a blank error boundary / page crash.
// ------------------------------------------------------------------
// useAuth catches the fetch error and normalizes PGRST116 into a clear
// "profile not found" message instead of leaking the raw PostgREST copy.
assert.match(useAuth, /\.from\('profiles'\)\.select\('\*'\)\.eq\('id', sessionUser\.id\)\.single\(\)/)
assert.match(useAuth, /e\?\.code === 'PGRST116'/)
assert.match(useAuth, /Your profile record could not be found\. Please contact an administrator\./)
assert.match(useAuth, /setProfileError\(/)
// App renders a dedicated "Profile unavailable" screen when profile is null.
assert.match(app, /if \(!profile\) return \(/)
assert.match(app, /Profile unavailable/)
assert.match(app, /no profile record is available yet/)
// Secondary profile .single() fetches all degrade instead of throwing:
assert.match(supabaseService, /\.eq\('email', e\)/, 'promoteSuperadmin looks up by email — the key this constraint protects')
assert.match(supabaseService, /if \(error\) return \{ promoted: false, error: error\.message \}/)
assert.match(supabaseService, /return \{ sent: false, error: e\?\.message \|\| String\(e\) \}/, 'sendDecisionEmail catches profile fetch failures')
assert.match(appraisals, /catch \{ \/\* manager not found — leave reviewer blank for manual entry \*\/ \}/)

console.log('profilesEmailUnique.test.mjs passed')