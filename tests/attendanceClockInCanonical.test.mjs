import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260922000011_attendance_clock_in_canonical.sql')
const service = read('src/services/attendanceService.js')

// --- 1. Drops all overloaded variants before creating the canonical one ---
assert.match(migration, /drop function if exists public\.attendance_clock_in_for_employee cascade;/)
assert.match(migration, /drop function if exists public\.attendance_clock_out_for_employee cascade;/)

// --- 2. Canonical clock-in has exactly 10 strongly typed parameters with defaults ---
assert.match(migration, /create or replace function public\.attendance_clock_in_for_employee\(\s*p_employee_id uuid,\s*p_lat float,\s*p_lng float,\s*p_accuracy float,\s*p_source text default 'web',\s*p_device_id uuid default null,\s*p_verification_method text default 'GPS',\s*p_source_detail text default 'WEB',\s*p_geofence_override uuid default null,\s*p_allow_outside boolean default false\s*\)/s)

// --- 3. Canonical clock-out has exactly 10 strongly typed parameters with defaults ---
assert.match(migration, /create or replace function public\.attendance_clock_out_for_employee\(\s*p_employee_id uuid,\s*p_attendance_id uuid,\s*p_lat float,\s*p_lng float,\s*p_accuracy float,\s*p_source text default 'web',\s*p_device_id uuid default null,\s*p_verification_method text default 'GPS',\s*p_source_detail text default 'WEB',\s*p_geofence_override uuid default null,\s*p_allow_outside boolean default false\s*\)/s)

// --- 4. Internal helpers are not exposed directly to authenticated clients ---
assert.match(migration, /revoke all on function public\.attendance_clock_in_for_employee\(uuid, float, float, float, text, uuid, text, text, uuid, boolean\)/)
assert.match(migration, /revoke all on function public\.attendance_clock_out_for_employee\(uuid, uuid, float, float, float, text, uuid, text, text, uuid, boolean\)/)

// --- 5. Frontend sends strongly typed numbers and string fingerprint ---
assert.match(service, /p_lat: parseFloat\(coords\?\.lat \?\? 0\) \|\| 0/)
assert.match(service, /p_lng: parseFloat\(coords\?\.lng \?\? 0\) \|\| 0/)
assert.match(service, /p_accuracy: coords\?\.accuracy != null \? parseFloat\(coords\.accuracy\) : null/)
assert.match(service, /p_device_fingerprint: String\(deviceFingerprint \|\| ''\)/)

console.log('attendance canonical clock-in/out assertions passed.')