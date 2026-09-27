// Capacity rules (sections 2, 3, 4). Plain forms, dropdowns, toggles and
// numeric inputs - HR never sees raw JSON.
//
// The precedence ladder is data (priority_number), and the list is ordered by
// it, so HR can see which rule wins without reading any code. Saving is
// refused server-side without the configuration permission; this form is a
// convenience, not the control.
import React, { useCallback, useEffect, useState } from 'react'
import { Trash2, Pencil, Plus } from 'lucide-react'
import { leavePlannerService } from '../../services/leavePlannerService'
import { LoadingState, ErrorState } from '../PageStates'
import { supabase } from '../../supabaseClient'
import RuleForm from './RuleForm'
import RuleTable from './RuleTable'

const BLANK = {
  id: null, name: '', scope_type: 'branch', branchId: '',
  department: '', area: '', role: '', team: '', scopeValue: '',
  maxPeopleOnLeave: '', minPeopleOnDuty: '',
  maxPercentOnLeave: '', minStaffingPercent: '',
  criticalRoleRestriction: false, priorityNumber: '', notes: '',
}

/** Turn a server row into the form shape. */
export function ruleToForm(r) {
  return {
    id: r.id,
    name: r.name,
    scope_type: r.scope_type,
    branchId: r.branch_id || '',
    department: r.department || '',
    area: r.area || '',
    role: r.role || '',
    team: r.team || '',
    scopeValue: r.scope_value || '',
    maxPeopleOnLeave: r.max_people_on_leave ?? '',
    minPeopleOnDuty: r.min_people_on_duty ?? '',
    maxPercentOnLeave: r.max_percent_on_leave ?? '',
    minStaffingPercent: r.min_staffing_percent ?? '',
    criticalRoleRestriction: !!r.critical_role_restriction,
    priorityNumber: r.priority_number ?? '',
    notes: r.notes || '',
  }
}

export default function CapacityRuleEditor({ onChanged }) {
  const [rules, setRules] = useState([])
  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setRules(await leavePlannerService.listRules()) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    supabase.from('branches').select('id, branch_name').order('branch_name')
      .then(({ data }) => setBranches(data || []))
  }, [])

  const save = async (e) => {
    e.preventDefault()
    setNotice(null)
    try {
      await leavePlannerService.saveRule({
        ...form,
        maxPeopleOnLeave: form.maxPeopleOnLeave === '' ? null : Number(form.maxPeopleOnLeave),
        minPeopleOnDuty: form.minPeopleOnDuty === '' ? null : Number(form.minPeopleOnDuty),
        maxPercentOnLeave: form.maxPercentOnLeave === '' ? null : Number(form.maxPercentOnLeave),
        minStaffingPercent: form.minStaffingPercent === '' ? null : Number(form.minStaffingPercent),
        priorityNumber: form.priorityNumber === '' ? null : Number(form.priorityNumber),
        branchId: form.branchId || null,
      })
      setForm(BLANK)
      setNotice({ tone: 'ok', text: 'Rule saved. It applies to future checks.' })
      load(); onChanged?.()
    } catch (err) {
      setNotice({ tone: 'error', text: err.message })
    }
  }

  const remove = async (r) => {
    if (!window.confirm(`Delete the rule "${r.name}"?`)) return
    try {
      await leavePlannerService.deleteRule(r.id)
      load(); onChanged?.()
    } catch (err) {
      setNotice({ tone: 'error', text: err.message })
    }
  }

  if (loading) return <LoadingState label="Loading capacity rules..." />
  if (error) return <ErrorState title="Unable to load rules" message={error} />

  return (
    <div className="space-y-5">
      <RuleForm
        form={form} branches={branches} notice={notice}
        onChange={setForm} onSubmit={save} onCancel={() => setForm(BLANK)}
      />
      <RuleTable rules={rules} onEdit={(r) => setForm(ruleToForm(r))} onDelete={remove} />
    </div>
  )
}
