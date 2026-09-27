// The capacity-rule form. One scope-appropriate field is shown at a time, so an
// admin is never asked for a branch on a global rule.
import React from 'react'
import { Plus } from 'lucide-react'

export const SCOPES = [
  { id: 'global', label: 'Everyone (global)' },
  { id: 'area', label: 'Area' },
  { id: 'branch', label: 'Branch' },
  { id: 'department', label: 'Department' },
  { id: 'team', label: 'Team' },
  { id: 'role', label: 'Role' },
  { id: 'designation', label: 'Designation' },
]

const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm'

export function scopeLabel(r) {
  const base = SCOPES.find((s) => s.id === r.scope_type)?.label || r.scope_type
  const extra = r.branch_name || r.department || r.area || r.role || r.team
  return extra ? `${base} · ${extra}` : base
}

export function ruleLimits(r) {
  return [
    r.max_people_on_leave != null && `max ${r.max_people_on_leave} on leave`,
    r.min_people_on_duty != null && `min ${r.min_people_on_duty} on duty`,
    r.max_percent_on_leave != null && `max ${r.max_percent_on_leave}%`,
    r.min_staffing_percent != null && `min ${r.min_staffing_percent}% staffing`,
    r.critical_role_restriction && 'critical role',
  ].filter(Boolean).join(', ') || '—'
}

function ScopeField({ form, branches, set }) {
  if (form.scope_type === 'branch') {
    return (
      <label className="block text-sm">
        <span className="font-medium text-slate-700">Branch</span>
        <select className={field} value={form.branchId} onChange={set('branchId')}>
          <option value="">Choose a branch</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.branch_name}</option>)}
        </select>
      </label>
    )
  }
  const map = {
    department: ['Department', 'department'],
    area: ['Area', 'area'],
    role: ['Role', 'role'],
    team: ['Team', 'team'],
    designation: ['Designation', 'scopeValue'],
  }
  const cfg = map[form.scope_type]
  if (!cfg) return null
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{cfg[0]}</span>
      <input className={field} value={form[cfg[1]]} onChange={set(cfg[1])} />
    </label>
  )
}

function NumField({ label, value, onChange }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input type="number" min="0" className={field} value={value} onChange={onChange} />
    </label>
  )
}

export default function RuleForm({ form, branches, notice, onChange, onSubmit, onCancel }) {
  const set = (k) => (e) => onChange({ ...form, [k]: e.target.value })

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
      <h2 className="font-semibold text-slate-900">
        {form.id ? 'Edit capacity rule' : 'Add capacity rule'}
      </h2>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Rule name</span>
          <input className={field} value={form.name} onChange={set('name')}
            placeholder="Ketu Branch capacity" />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Applies to</span>
          <select className={field} value={form.scope_type} onChange={set('scope_type')}>
            {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <ScopeField form={form} branches={branches} set={set} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <NumField label="Max people on leave" value={form.maxPeopleOnLeave}
          onChange={set('maxPeopleOnLeave')} />
        <NumField label="Min people on duty" value={form.minPeopleOnDuty}
          onChange={set('minPeopleOnDuty')} />
        <NumField label="Max % on leave" value={form.maxPercentOnLeave}
          onChange={set('maxPercentOnLeave')} />
        <NumField label="Min staffing %" value={form.minStaffingPercent}
          onChange={set('minStaffingPercent')} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.criticalRoleRestriction}
            onChange={(e) => onChange({ ...form, criticalRoleRestriction: e.target.checked })} />
          No overlapping leave allowed for this critical role
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">
            Precedence (higher wins; blank uses the recommended value)
          </span>
          <input type="number" className={field} value={form.priorityNumber}
            onChange={set('priorityNumber')} />
        </label>
      </div>

      <label className="block text-sm">
        <span className="font-medium text-slate-700">Notes</span>
        <input className={field} value={form.notes} onChange={set('notes')} />
      </label>

      {notice && (
        <p className={`text-sm ${notice.tone === 'ok' ? 'text-emerald-700' : 'text-amber-700'}`}>
          {notice.text}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36]">
          <Plus className="w-4 h-4" />{form.id ? 'Save changes' : 'Add rule'}
        </button>
        {form.id && (
          <button type="button" onClick={onCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
