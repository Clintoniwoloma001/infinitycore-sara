import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260922000010_leave_approval_workflow_feedback.sql')
const service = read('src/services/leaveApprovalsService.js')
const settings = read('src/pages/Settings.jsx')
const layout = read('src/components/Layout.jsx')
const leaveRequests = read('src/pages/LeaveRequests.jsx')
const reminder = read('src/components/leave/LeaveApprovalReminder.jsx')
const feedback = read('src/components/leave/LeaveFeedbackModal.jsx')

// --- 1. Migration adds the workflow key, reminder/feedback columns, and table ---
assert.match(migration, /leave_approval_workflow jsonb not null default '[^']+'::jsonb/)
assert.match(migration, /updated_at timestamptz default now\(\)/)
assert.match(migration, /current_approval_level integer/)
assert.match(migration, /stage_entered_at timestamptz/)
assert.match(migration, /last_reminded_at timestamptz/)
assert.match(migration, /feedback_submitted boolean not null default false/)
assert.match(migration, /create table if not exists public\.leave_feedback/)

// --- 2. RPCs exist: workflow CRUD, chain resolution, feedback, notifier ---
assert.match(migration, /create or replace function public\.get_leave_workflow_chain_for_employee\(p_employee_id uuid\)/)
assert.match(migration, /create or replace function public\.get_leave_approval_workflow\(\)/)
assert.match(migration, /create or replace function public\.save_leave_approval_workflow\(p_workflow jsonb, p_reason text\)/)
assert.match(migration, /create or replace function public\.submit_leave_feedback\(/)
assert.match(migration, /create or replace function public\._leave_stage_approver_ids\(/)
assert.match(migration, /create or replace function public\.notify_leave_approvers\(\)/)

// --- 3. process_leave_decision + chain reader are workflow-aware and sync SLA/feedback columns ---
assert.match(migration, /create or replace function public\.get_leave_approval_chain_for_request\(p_request_id uuid\)/)
assert.match(migration, /public\.get_leave_workflow_chain_for_employee\(v_employee_id\)/)
assert.match(migration, /create or replace function public\.process_leave_decision\(/)
assert.match(migration, /current_approval_level = v_stage_idx \+ 1/)
assert.match(migration, /stage_entered_at = now\(\)/)
assert.match(migration, /last_reminded_at = now\(\)/)

// --- 4. 30-minute cron reminder schedule (guarded) ---
assert.match(migration, /'infinitycore-leave-approver-reminders',/)
assert.match(migration, /'\*\/30 \* \* \* \*'/)
assert.match(migration, /extname = 'pg_cron'/)

// --- 5. Service exposes the workflow + feedback helpers ---
assert.match(service, /export const WORKFLOW_ROLES/)
assert.match(service, /export async function getApprovalWorkflow\(\)/)
assert.match(service, /export async function saveApprovalWorkflow\(/)
assert.match(service, /export async function submitLeaveFeedback\(/)

// --- 6. Settings page renders the workflow builder using the shared PeoplePicker ---
assert.match(settings, /LeaveWorkflowBuilder/)
assert.match(settings, /import PeoplePicker/)
assert.match(settings, /import \{ supabase \} from '\.\.\/supabaseClient'/)

// --- 7. Layout mounts reminder banner + feedback modal ---
assert.match(layout, /import LeaveApprovalReminder/)
assert.match(layout, /import LeaveFeedbackModal/)
assert.match(layout, /<LeaveApprovalReminder/)
assert.match(layout, /<LeaveFeedbackModal/)

// --- 8. LeaveRequests seeds SLA clock + current level on create and reroute ---
assert.match(leaveRequests, /current_approval_level: 1/)
assert.match(leaveRequests, /stage_entered_at: new Date\(\)\.toISOString\(\)/)

// --- 9. Reminder: 30-min interval, Sara audio (speech), notification + vibration ---
assert.match(reminder, /30 \* 60 \* 1000/)
assert.match(reminder, /speechSynthesis/)
assert.match(reminder, /navigator\.vibrate/)
assert.match(reminder, /Leave approval reminder/)

// --- 10. Feedback modal: ratings, textarea minimum, submits via RPC ---
assert.match(feedback, /submitLeaveFeedback/)
assert.match(feedback, /turnaroundRating/)
assert.match(feedback, /easeRating/)
assert.match(feedback, /text\.trim\(\)\.length < 10/)

console.log('leave approval workflow + feedback assertions passed.')