// Supabase Edge Function: escalate-leave-requests
//
// Runs on a schedule (see DEPLOY.md — pg_cron, not page load). For any
// pending request that has sat at its current stage longer than
// ESCALATE_HOURS, this marks it `escalated = true` and notifies:
//   - everyone holding the role required at that stage
//   - all admin/super_admin/hr_manager, as oversight
//
// It never skips a stage or auto-approves anything — the hierarchy
// (Branch Manager → Area Manager → Head of Business → HR) is a real
// policy chain, not something automation should bypass. This only
// makes sure a stuck request can't go unnoticed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ESCALATE_HOURS = 48

const STAGE_ROLE_MAP = {
  branch_manager: ['branch_manager'],
  area_manager: ['area_manager'],
  head_of_business: ['head_of_business'],
  hr: ['hr_manager'],
}
const STAGE_LABELS = {
  branch_manager: 'Branch Manager',
  area_manager: 'Area Manager',
  head_of_business: 'Head of Business',
  hr: 'HR',
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { data: pending, error: fetchError } = await supabase
    .from('leave_requests')
    .select('id, employee_name, current_stage, created_at, escalated')
    .eq('status', 'pending')

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 })
  }

  let escalatedCount = 0

  for (const r of pending || []) {
    // Find the most recent decision for this request, to know when it
    // actually entered its CURRENT stage (not just when it was created).
    const { data: lastApproval } = await supabase
      .from('leave_approvals')
      .select('decided_at')
      .eq('leave_request_id', r.id)
      .order('decided_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const enteredAt = lastApproval?.decided_at || r.created_at
    const ageHours = (Date.now() - new Date(enteredAt).getTime()) / 3600000

    if (ageHours < ESCALATE_HOURS || r.escalated) continue

    await supabase.from('leave_requests').update({ escalated: true }).eq('id', r.id)

    await supabase.from('audit_logs').insert({
      action: 'leave_stage_overdue',
      entity_type: 'LeaveRequest',
      entity_id: r.id,
      details: `${r.employee_name} — stuck at ${STAGE_LABELS[r.current_stage] || r.current_stage} for ${Math.floor(ageHours)}h+`,
      user_name: 'System (scheduled)',
      severity: 'warning',
    })

    const rolesToNotify = [...(STAGE_ROLE_MAP[r.current_stage] || []), 'admin', 'super_admin', 'hr_manager']
    const { data: recipients } = await supabase.from('profiles').select('id').in('role', rolesToNotify)

    if (recipients?.length) {
      const notifications = recipients.map((p) => ({
        user_id: p.id,
        title: 'Leave request overdue',
        message: `${r.employee_name}'s leave request has been waiting on ${STAGE_LABELS[r.current_stage] || r.current_stage} for ${Math.floor(ageHours)}h+.`,
        type: 'leave_escalation',
        link: '/leave-requests',
      }))
      await supabase.from('notifications').insert(notifications)
    }

    escalatedCount++
  }

  return new Response(JSON.stringify({ escalated: escalatedCount }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
