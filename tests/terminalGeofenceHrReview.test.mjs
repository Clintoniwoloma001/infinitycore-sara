import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260922000001_terminal_geofence_hr_review.sql')
const service = read('src/services/attendanceService.js')
const engineService = read('src/services/attendanceEngineService.js')
const page = read('src/pages/AttendanceManagement.jsx')
const terminal = read('src/pages/AttendanceTerminal.jsx')
const settings = read('src/components/AttendanceSettings.jsx')
const profile = read('src/pages/EmployeeProfile.jsx')

// --- 1. Schema: terminal geofence columns on attendance_devices ---
assert.match(migration, /add column if not exists geofence_id uuid references public\.attendance_geofences\(id\) on delete set null/)
assert.match(migration, /add column if not exists custom_lat numeric/)
assert.match(migration, /add column if not exists custom_lng numeric/)
assert.match(migration, /add column if not exists radius_meters/)

// --- 2. Schema: HR review columns + status check + branch capture on attendance_records ---
assert.match(migration, /add column if not exists hr_review_status text not null default 'NONE'/)
assert.match(migration, /add constraint attendance_records_hr_review_status_check/)
assert.match(migration, /check \(hr_review_status in \('NONE', 'PENDING_REVIEW', 'APPROVED', 'FLAGGED_QUERY_ISSUED'\)\)/)
assert.match(migration, /add column if not exists clocked_in_branch_id uuid references public\.branches\(id\)/)
assert.match(migration, /add column if not exists terminal_geofence_distance float/)
assert.match(migration, /create index if not exists ix_attendance_records_hr_review_status/)

// --- 3. _terminal_geofence helper: custom coords win, falls back to linked geofence ---
assert.match(migration, /create or replace function public\._terminal_geofence\(p_device_id uuid\)/)
assert.match(migration, /returns table \(\s*geofence_id uuid,\s*lat double precision,\s*lng double precision,\s*radius integer,\s*label text,\s*branch_id text/s)
assert.match(migration, /coalesce\(d\.custom_lat, g\.latitude\)/)
assert.match(migration, /coalesce\(d\.custom_lng, g\.longitude\)/)
assert.match(migration, /coalesce\(d\.radius_meters, g\.radius_meters, 150\)/)
assert.match(migration, /revoke all on function public\._terminal_geofence\(uuid\) from public;/)

// --- 4. attendance_validate_location gains geofence-override + allow-outside params ---
assert.match(migration, /p_geofence_override uuid default null/)
assert.match(migration, /p_allow_outside boolean default false/)
assert.match(migration, /and \(p_geofence_override is null or g\.id = p_geofence_override\)/)
assert.match(migration, /if not v_has_location and not p_allow_outside then/)
assert.match(migration, /if v_best_distance is null and not p_allow_outside then/)
// restricted: authenticated only, never public
assert.match(migration, /revoke all on function public\.attendance_validate_location\(uuid, float, float, text, uuid, uuid, boolean\) from public;/)
assert.match(migration, /grant execute on function public\.attendance_validate_location\(uuid, float, float, text, uuid, uuid, boolean\) to authenticated;/)

// --- 5. Clock in/out RPCs thread the new params through to the location engine ---
assert.match(migration, /v_location := public\.attendance_validate_location\(p_employee_id, p_lat, p_lng, 'clock_in', null, p_geofence_override, p_allow_outside\)/)
assert.match(migration, /v_location := public\.attendance_validate_location\(p_employee_id, p_lat, p_lng, 'clock_out', v_record\.branch_id, p_geofence_override, p_allow_outside\)/)
// never callable from the browser
assert.match(migration, /revoke all on function public\.attendance_clock_in_for_employee\(uuid, float, float, float, text, uuid, text, text, uuid, boolean\) from public, anon, authenticated;/)
assert.match(migration, /revoke all on function public\.attendance_clock_out_for_employee\(uuid, uuid, float, float, float, text, uuid, text, text, uuid, boolean\) from public, anon, authenticated;/)

// --- 6. Public terminal gates: terminal-range check + original 5-arg signatures ---
assert.match(migration, /create or replace function public\.validate_attendance_terminal_location/)
assert.match(migration, /'error', 'OUT_OF_BOUNDS:Out of bounds error: You must be within range of the terminal to clock in\.'/)
assert.match(migration, /grant execute on function public\.validate_attendance_terminal_location\(text, text, float, float, text\) to anon, authenticated;/)
assert.match(migration, /grant execute on function public\.clock_attendance_terminal\(text, text, text, float, float, float, text\) to anon, authenticated;/)
assert.match(migration, /create or replace function public\.clock_attendance_terminal\(\s*p_token text,\s*p_employee_identifier text,\s*p_event_type text,\s*p_lat float,\s*p_lng float,\s*p_accuracy float,\s*p_device_fingerprint text\s*\)/s)

// --- 7. clock_attendance_terminal records distance + flags cross-branch for HR review ---
assert.match(migration, /set terminal_geofence_distance = v_terminal_distance/)
assert.match(migration, /select count\(\*\) > 0 into v_is_area_manager from public\.get_area_manager_area_branches\(v_employee_id\) b;/)
assert.match(migration, /if not v_is_area_manager then/)
assert.match(migration, /set hr_review_status = 'PENDING_REVIEW'/)
assert.match(migration, /'terminal_review_message', v_review_note/)
assert.match(migration, /'hr_review_status', 'PENDING_REVIEW'/)

// --- 8. list_attendance_hr_reviews: shaped rows + role gate + valid filters ---
assert.match(migration, /create or replace function public\.list_attendance_hr_reviews\(p_status text default 'PENDING_REVIEW'\)/)
assert.match(migration, /record_id uuid,/)
assert.match(migration, /original_branch_name text,/)
assert.match(migration, /clocked_in_branch_name text,/)
assert.match(migration, /hr_reviewed_at timestamptz,/)
assert.match(migration, /hr_review_comment text,/)
assert.match(migration, /terminal_geofence_distance float/)
assert.match(migration, /if public\.current_role\(\) not in \('super_admin', 'admin', 'head_of_human_resources', 'hr_officer', 'branch_manager'\) then/)
assert.match(migration, /'PENDING_REVIEW', 'APPROVED', 'FLAGGED_QUERY_ISSUED', 'ALL'/)
assert.match(migration, /where ar\.hr_review_status <> 'NONE'/)
assert.match(migration, /grant execute on function public\.list_attendance_hr_reviews\(text\) to authenticated;/)

// --- 9. review_attendance_hr_record: approve / flag_query -> employee query ---
assert.match(migration, /create or replace function public\.review_attendance_hr_record\(/)
assert.match(migration, /if v_record\.hr_review_status not in \('PENDING_REVIEW', 'FLAGGED_QUERY_ISSUED'\) then/)
assert.match(migration, /'ATTENDANCE_HR_REVIEW_APPROVED'/)
assert.match(migration, /'ATTENDANCE_HR_REVIEW_QUERY'/)
assert.match(migration, /insert into public\.employee_queries \(employee_id, user_id, subject, category, description, status, priority, assigned_to\)/)
assert.match(migration, /'attendance', trim\(p_comment\), 'open', 'normal', v_emp\.user_id/)
assert.match(migration, /'#\/my-queries', 'attendance_review', false/)
assert.match(migration, /grant execute on function public\.review_attendance_hr_record\(uuid, text, text\) to authenticated;/)

// --- 10. Service: HR review wrappers call the right RPCs (5-char note guard) ---
assert.match(service, /async listHrReviewRecords\(status = 'PENDING_REVIEW'\)/)
assert.match(service, /await supabase\.rpc\('list_attendance_hr_reviews'/)
assert.match(service, /async approveHrReview\(recordId, comment = null\)/)
assert.match(service, /async flagHrReview\(recordId, note\)/)
assert.match(service, /String\(note\)\.trim\(\)\.length < 5/)
assert.match(service, /p_record_id: recordId,\s*p_action: 'flag_query',/s)
assert.match(service, /p_record_id: recordId,\s*p_action: 'approved',/s)

// --- 11. Service: OUT_OF_BOUNDS prefix is stripped before it reaches the UI ---
assert.match(service, /if \(msg\.startsWith\('OUT_OF_BOUNDS:'\)\) return msg\.replace\('OUT_OF_BOUNDS:', ''\)/)
assert.match(service, /\.select\('id, device_name, device_type, status, active, branch_id, geofence_id, location_id, custom_lat, custom_lng, radius_meters, last_seen_at/)

// --- 12. Engine service: raw device columns, no ambiguous geofence embed ---
assert.match(engineService, /location_id, geofence_id, custom_lat, custom_lng, radius_meters/)

// --- 13. Management page: HR Review panel with approve / flag-query actions ---
assert.match(page, /HR Review — cross-branch clock-ins/)
assert.match(page, /attendanceService\.listHrReviewRecords\(/)
assert.match(page, /attendanceService\.approveHrReview\(record\.record_id\)/)
assert.match(page, /attendanceService\.flagHrReview\(reviewModal\.record_id, reviewModal\.note\.trim\(\)\)/)
assert.match(page, /Flag query/)
assert.match(page, /reviewModal\.note\.trim\(\)\.length < 5/)
assert.match(page, /supabase\.from\('branches'\)\.select\('id, branch_name'\)/)
assert.match(page, /const branchLabel = \(id\)/)

// --- 14. Management page: terminal devices show assigned branch + geofence mode ---
assert.match(page, /<th className="py-2 pr-3 font-medium">Branch<\/th>/)
assert.match(page, /Geofence-linked/)
assert.match(page, /Custom location · \{device\.radius_meters \|\| 150\}m/)
assert.match(page, /import \{ supabase \} from '\.\.\/supabaseClient'/)

// --- 15. Terminal UI: out-of-bounds is surfaced, not mislabelled as denied ---
assert.match(terminal, /geoStatus === 'rejected'/)
assert.match(terminal, /setGeoMessage\(normalizeAttendanceError\(m\)\)/)
assert.match(terminal, /Location rejected — outside permitted area\./)

// --- 16. Terminal UI: cross-branch success carries the HR review notice ---
assert.match(terminal, /reviewNotice: data\.terminal_review_message \|\| null/)
assert.match(terminal, /result\.reviewNotice/)
assert.match(terminal, /Sent for HR review/)
assert.match(terminal, /speakText\(data\.terminal_review_message/)

// --- 17. Devices UI: edit mode, geofence modes, assigned branch dropdown ---
assert.match(settings, /const EMPTY_DEVICE_FORM = \{/)
assert.match(settings, /geofenceMode: 'none'/)
assert.match(settings, /geofenceMode: linked \? 'link' : \(d\.custom_lat \? 'custom' : 'none'\)/)
assert.match(settings, /attendanceEngineService\.updateDevice\(editId, payload\)/)
assert.match(settings, /attendanceEngineService\.createDevice\(\{ \.\.\.payload, status: 'active', active: true \}\)/)
assert.match(settings, /label className=\{labelCls\}>Assigned Branch/)
assert.match(settings, /'No geofence'.*'Link existing geofence'.*'Custom location'/)

// --- 18. Employee profile personal-info save now targets the employee record ---
assert.match(profile, /const savePersonalInfo = async \(\) => \{/)
assert.match(profile, /number_of_children: draft\.number_of_children,/)
assert.match(profile, /children_age_range: draft\.children_age_range,/)
assert.match(profile, /await employeeService\.updateHrFields\(id, personalFields\)/)

console.log('terminal geofence + HR review assertions passed.')
