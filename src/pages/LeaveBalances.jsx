import React, { useEffect, useMemo, useState } from 'react'
import { Pencil, Users, X, Check, Loader2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { logAction } from '../services/supabaseService'
import {
  LEAVE_TYPE_LABELS,
  currentYear,
  listAllBalances,
  adjustBalance,
  getEmployeeLeaveEntitlement,
  getEmployeeBalances,
} from '../services/leaveBalanceService'
import { supabase } from '../supabaseClient'

const ACTIVE_LEAVE_TYPES = Object.keys(LEAVE_TYPE_LABELS).filter((t) => t !== 'unpaid')

const inputCls = 'w-full h-11 rounded-xl border border-slate-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]/40 focus:border-[#009944] transition-all duration-200'
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1.5'

export default function LeaveBalances() {
  const [employees, setEmployees] = useState([])
  const [rows, setRows] = useState([])
  const [effectiveEnt, setEffectiveEnt] = useState({})

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null) // { mode: 'single'|'batch', ... }
  const [expandedEmployees, setExpandedEmployees] = useState({})
  const { name: userName } = useAuth()

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const year = currentYear()

      // All employees with a platform user account
      const { data: employeeRows, error: empError } = await supabase
        .from('employees')
        .select('id, full_name, user_id, position, designation_id')
        .not('user_id', 'is', null)
        .order('full_name', { ascending: true })
      if (empError) throw empError

      const employeeList = employeeRows || []
      const employeeByUserId = new Map()
      for (const emp of employeeList) {
        if (emp.user_id) employeeByUserId.set(emp.user_id, emp)
      }

      // Existing balance rows for the current year
      const balanceRows = await listAllBalances(year)

      // Effective entitlements keyed by user_id (leave_balances.employee_id stores the user id)
      const entMap = {}
      for (const emp of employeeList) {
        entMap[emp.user_id] = {}
        for (const t of ACTIVE_LEAVE_TYPES) {
          entMap[emp.user_id][t] = await getEmployeeLeaveEntitlement(emp.user_id, t)
        }
      }

      setEmployees(employeeByUserId)
      setEffectiveEnt(entMap)
      setRows(balanceRows)
    } catch (e) {
      setError(e?.message || 'Failed to load balances')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const byEmployee = useMemo(() => {
    const map = {}
    for (const [userId, emp] of employees.entries()) {
      map[userId] = { name: emp.full_name || userId, employeeId: emp.id, balances: {} }
    }
    for (const r of rows) {
      if (!map[r.employee_id]) {
        map[r.employee_id] = { name: r.employee_name || r.employee_id, balances: {} }
      }
      map[r.employee_id].balances[r.leave_type] = r
    }
    return map
  }, [employees, rows])

  const employeeList = useMemo(() => {
    const list = []
    for (const [userId, emp] of employees.entries()) {
      list.push({ id: userId, name: emp.full_name || userId, employeeId: emp.id })
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }, [employees])

  const toggleEmployee = (id) => {
    setExpandedEmployees((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const ensureRowExists = async (userId, employeeName, leaveType) => {
    const existing = rows.find((r) => r.employee_id === userId && r.leave_type === leaveType)
    if (existing) return existing
    const updated = await getEmployeeBalances(userId, employeeName, currentYear())
    const created = updated.find((r) => r.leave_type === leaveType)
    if (!created) throw new Error(`Could not create ${LEAVE_TYPE_LABELS[leaveType]} balance row.`)
    setRows((prev) => [...prev, created])
    return created
  }

  const openSingle = async (userId, leaveType) => {
    const emp = byEmployee[userId]
    const r = emp?.balances[leaveType]
    let row = r
    if (!row) {
      row = await ensureRowExists(userId, emp?.name, leaveType)
    }
    const defaultEnt = Number(row.default_entitlement ?? effectiveEnt[userId]?.[leaveType]?.default_entitlement ?? row.effective_entitlement ?? row.entitled_days ?? 0)
    setModal({
      mode: 'single',
      userId,
      employeeId: emp?.employeeId,
      employeeName: emp?.name,
      leaveType,
      rowId: row.id,
      default_entitlement: defaultEnt,
      manual_override: row.manual_override ?? '',
      effective_entitlement: Number(row.effective_entitlement ?? row.entitled_days ?? defaultEnt),
      used_days: row.used_days ?? 0,
      pending_days: row.pending_days ?? 0,
      reason: row.override_reason || '',
    })
  }

  const openBatch = () => {
    setModal({
      mode: 'batch',
      leaveType: ACTIVE_LEAVE_TYPES[0],
      manual_override: '',
      used_days: '',
      pending_days: '',
      selectedEmployeeIds: new Set(employeeList.map((e) => e.id)),
      reason: '',
      updateOverride: true,
      updateUsed: false,
      updatePending: false,
    })
  }

  const closeModal = () => setModal(null)

  const saveSingle = async () => {
    if (!modal) return
    setSaving(true)
    try {
      const patch = {
        manual_override: modal.manual_override === '' ? null : Number(modal.manual_override),
        used_days: Number(modal.used_days),
        pending_days: Number(modal.pending_days),
        override_reason: modal.reason || null,
      }
      await adjustBalance(modal.rowId, patch)
      await logAction({
        action: 'leave_entitlement_adjusted',
        entityType: 'LeaveBalance',
        entityId: modal.rowId,
        details: `${modal.employeeName} ${modal.leaveType} → override ${patch.manual_override ?? 'default'}, effective ${modal.effective_entitlement}, used ${patch.used_days}, pending ${patch.pending_days}${modal.reason ? ` (${modal.reason})` : ''}`,
        userName,
      })
      closeModal()
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to save adjustment.')
    } finally {
      setSaving(false)
    }
  }

  const resetSingleToDefault = async () => {
    if (!modal) return
    if (!window.confirm('Reset this entitlement to the system default?')) return
    setSaving(true)
    try {
      await adjustBalance(modal.rowId, {
        resetToDefault: true,
        override_reason: modal.reason || 'Reset to system default',
      })
      await logAction({
        action: 'leave_entitlement_reset',
        entityType: 'LeaveBalance',
        entityId: modal.rowId,
        details: `${modal.employeeName} ${modal.leaveType} reset to default ${modal.default_entitlement}`,
        userName,
      })
      closeModal()
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to reset entitlement.')
    } finally {
      setSaving(false)
    }
  }

  const saveBatch = async () => {
    if (!modal) return
    setSaving(true)
    try {
      const targetEmployees = employeeList.filter((e) => modal.selectedEmployeeIds.has(e.id))
      if (targetEmployees.length === 0) throw new Error('Select at least one employee.')

      const updates = []
      for (const emp of targetEmployees) {
        const row = await ensureRowExists(emp.id, emp.name, modal.leaveType)
        const patch = {}
        if (modal.updateOverride) patch.manual_override = Number(modal.manual_override)
        if (modal.updateUsed) patch.used_days = Number(modal.used_days)
        if (modal.updatePending) patch.pending_days = Number(modal.pending_days)
        if (Object.keys(patch).length === 0) continue
        patch.override_reason = modal.reason || null
        await adjustBalance(row.id, patch)
        updates.push({ rowId: row.id, employeeName: emp.name, patch })
        await logAction({
          action: 'leave_entitlement_batch_adjusted',
          entityType: 'LeaveBalance',
          entityId: row.id,
          details: `${emp.name} ${modal.leaveType} batch → ${Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(', ')}${modal.reason ? ` (${modal.reason})` : ''}`,
          userName,
        })
      }

      if (updates.length === 0) throw new Error('Choose at least one value to update.')
      closeModal()
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to apply batch adjustment.')
    } finally {
      setSaving(false)
    }
  }

  const isFormValid = () => {
    if (!modal) return false
    if (modal.mode === 'single') {
      const overrideOk = modal.manual_override === '' || Number(modal.manual_override) >= 0
      return overrideOk && Number(modal.used_days) >= 0 && Number(modal.pending_days) >= 0
    }
    if (modal.mode === 'batch') {
      const hasValue = (modal.updateOverride && modal.manual_override !== '') || (modal.updateUsed && modal.used_days !== '') || (modal.updatePending && modal.pending_days !== '')
      return hasValue && modal.selectedEmployeeIds.size > 0
    }
    return false
  }

  const computedEffective = useMemo(() => {
    if (!modal || modal.mode !== 'single') return null
    if (modal.manual_override === '' || modal.manual_override === null) return modal.default_entitlement
    return Number(modal.manual_override)
  }, [modal])

  return (
    <div>
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Leave Balances</h2>
          <p className="text-sm text-slate-500 mt-1">Annual leave defaults are driven by designation (MD/CEO = 20, MD / Heads = 15, others = 10). HR can set per-employee overrides.</p>
        </div>
        <button
          onClick={openBatch}
          disabled={loading || employeeList.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50 transition-all duration-200 shadow-sm hover:shadow"
        >
          <Users className="w-4 h-4" /> Batch Adjust
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" />
        </div>
      ) : employeeList.length === 0 ? (
        <div className="text-center py-16 text-slate-400">No employees with platform user accounts found.</div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-left">
                <tr>
                  <th className="px-6 py-3 font-medium">Employee</th>
                  {ACTIVE_LEAVE_TYPES.map((t) => (
                    <th key={t} className="px-4 py-3 font-medium text-center">{LEAVE_TYPE_LABELS[t]}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {employeeList.map(({ id, name }) => {
                  const emp = byEmployee[id]
                  const expanded = expandedEmployees[id]
                  return (
                    <React.Fragment key={id}>
                      <tr className="hover:bg-slate-50/70 transition-colors">
                        <td className="px-6 py-3">
                          <button
                            onClick={() => toggleEmployee(id)}
                            className="flex items-center gap-2 text-left group"
                          >
                            {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                            <span className="font-medium text-slate-800 group-hover:text-[#009944] transition-colors">{name}</span>
                          </button>
                        </td>
                        {ACTIVE_LEAVE_TYPES.map((t) => {
                          const r = emp.balances[t]
                          const ent = r ? Number(r.effective_entitlement ?? r.entitled_days) : (effectiveEnt[id]?.[t]?.effective_entitlement ?? 0)
                          const used = r ? Number(r.used_days) : 0
                          const pending = r ? Number(r.pending_days ?? 0) : 0
                          const remaining = ent - used - pending
                          const hasRow = !!r
                          const hasOverride = hasRow && r.manual_override != null
                          return (
                            <td key={t} className="px-4 py-3 text-center">
                              <button
                                onClick={() => openSingle(id, t)}
                                className="group inline-flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg hover:bg-[#009944]/5 hover:text-[#009944] text-slate-700 transition-all duration-200"
                                title={hasRow ? 'Click to edit balance' : 'Click to create and edit balance'}
                              >
                                <span className={`font-medium ${hasRow ? '' : 'text-slate-400 italic'}`}>
                                  {remaining}<span className="text-slate-400 font-normal">/{ent}</span>
                                </span>
                                {hasOverride && (
                                  <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">override</span>
                                )}
                                <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </button>
                            </td>
                          )
                        })}
                      </tr>

                      {expanded && (
                        <tr className="bg-slate-50/80">
                          <td colSpan={1 + ACTIVE_LEAVE_TYPES.length} className="px-6 py-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                              {ACTIVE_LEAVE_TYPES.map((t) => {
                                const r = emp.balances[t]
                                const defaultEnt = r ? Number(r.default_entitlement ?? r.effective_entitlement ?? r.entitled_days) : (effectiveEnt[id]?.[t]?.default_entitlement ?? 0)
                                const override = r ? r.manual_override : null
                                const effective = r ? Number(r.effective_entitlement ?? r.entitled_days) : (effectiveEnt[id]?.[t]?.effective_entitlement ?? 0)
                                const used = r ? Number(r.used_days) : 0
                                const pending = r ? Number(r.pending_days ?? 0) : 0
                                const remaining = effective - used - pending
                                return (
                                  <div key={t} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{LEAVE_TYPE_LABELS[t]}</span>
                                      <button
                                        onClick={() => openSingle(id, t)}
                                        className="text-[#009944] hover:text-[#007a36] text-xs font-medium"
                                      >
                                        Edit
                                      </button>
                                    </div>
                                    <div className="grid grid-cols-2 gap-y-2 text-sm">
                                      <div className="text-slate-500">Default</div>
                                      <div className="text-right font-medium text-slate-700">{defaultEnt}</div>
                                      <div className="text-slate-500">Override</div>
                                      <div className="text-right font-medium text-amber-700">{override ?? '—'}</div>
                                      <div className="text-slate-500">Effective</div>
                                      <div className="text-right font-semibold text-slate-900">{effective}</div>
                                      <div className="text-slate-500">Used</div>
                                      <div className="text-right font-medium text-slate-700">{used}</div>
                                      <div className="text-slate-500">Pending</div>
                                      <div className="text-right font-medium text-slate-700">{pending}</div>
                                      <div className="text-slate-500">Remaining</div>
                                      <div className="text-right font-semibold text-[#009944]">{remaining}</div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-400 flex items-center justify-between">
            <span>Format: Remaining / Effective entitlement · Click any cell to edit. Orange chip = manual override.</span>
            <span>{rows.length} balance row{rows.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ animation: 'lbBackdropIn 0.25s ease-out forwards' }}>
          <style>{`
            @keyframes lbBackdropIn { from { opacity: 0 } to { opacity: 1 } }
            @keyframes lbModalIn { from { opacity: 0; transform: scale(0.96) translateY(12px) } to { opacity: 1; transform: scale(1) translateY(0) } }
          `}</style>
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ease-out"
            onClick={closeModal}
          />
          <div className="relative bg-white rounded-2xl w-full max-w-lg shadow-2xl" style={{ animation: 'lbModalIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards' }}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">
                {modal.mode === 'single' ? 'Edit Leave Balance' : 'Batch Adjust Leave Balances'}
              </h3>
              <button
                onClick={closeModal}
                disabled={saving}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition-colors disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
              {modal.mode === 'single' ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Employee</label>
                      <p className="text-sm font-medium text-slate-800 truncate">{modal.employeeName}</p>
                    </div>
                    <div>
                      <label className={labelCls}>Leave Type</label>
                      <p className="text-sm font-medium text-slate-800">{LEAVE_TYPE_LABELS[modal.leaveType]}</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="grid grid-cols-3 gap-4 text-center text-sm">
                      <div>
                        <div className="text-xs text-slate-500 mb-1">System Default</div>
                        <div className="font-semibold text-slate-900">{modal.default_entitlement}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Manual Override</div>
                        <div className="font-semibold text-amber-700">{modal.manual_override === '' ? '—' : modal.manual_override}</div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-500 mb-1">Effective</div>
                        <div className="font-semibold text-[#009944]">{computedEffective}</div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Manual Override Days <span className="text-slate-400 font-normal">(leave blank for default)</span></label>
                      <input
                        type="number"
                        min={0}
                        className={inputCls}
                        value={modal.manual_override}
                        onChange={(e) => setModal({ ...modal, manual_override: e.target.value, effective_entitlement: e.target.value === '' ? modal.default_entitlement : Number(e.target.value) })}
                        placeholder={modal.default_entitlement}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Used Days</label>
                      <input
                        type="number"
                        min={0}
                        className={inputCls}
                        value={modal.used_days}
                        onChange={(e) => setModal({ ...modal, used_days: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Pending Days</label>
                      <input
                        type="number"
                        min={0}
                        className={inputCls}
                        value={modal.pending_days}
                        onChange={(e) => setModal({ ...modal, pending_days: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Remaining</label>
                      <div className="h-11 flex items-center px-4 rounded-xl border border-slate-200 bg-slate-50 text-sm font-semibold text-slate-900">
                        {computedEffective - Number(modal.used_days) - Number(modal.pending_days)}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className={labelCls}>Leave Type</label>
                    <select
                      className={inputCls}
                      value={modal.leaveType}
                      onChange={(e) => setModal({ ...modal, leaveType: e.target.value })}
                    >
                      {ACTIVE_LEAVE_TYPES.map((t) => (
                        <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <label className={labelCls}>Values to update</label>
                    <div className="space-y-3">
                      <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:border-[#009944]/40 hover:bg-[#009944]/5 transition-colors cursor-pointer">
                        <input
                          type="checkbox"
                          checked={modal.updateOverride}
                          onChange={(e) => setModal({ ...modal, updateOverride: e.target.checked })}
                          className="w-4 h-4 text-[#009944] rounded border-slate-300 focus:ring-[#009944]"
                        />
                        <span className="text-sm text-slate-700 flex-1">Manual Override Days</span>
                        {modal.updateOverride && (
                          <input
                            type="number"
                            min={0}
                            className={`${inputCls} w-24`}
                            value={modal.manual_override}
                            onChange={(e) => setModal({ ...modal, manual_override: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </label>
                      <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:border-[#009944]/40 hover:bg-[#009944]/5 transition-colors cursor-pointer">
                        <input
                          type="checkbox"
                          checked={modal.updateUsed}
                          onChange={(e) => setModal({ ...modal, updateUsed: e.target.checked })}
                          className="w-4 h-4 text-[#009944] rounded border-slate-300 focus:ring-[#009944]"
                        />
                        <span className="text-sm text-slate-700 flex-1">Used Days</span>
                        {modal.updateUsed && (
                          <input
                            type="number"
                            min={0}
                            className={`${inputCls} w-24`}
                            value={modal.used_days}
                            onChange={(e) => setModal({ ...modal, used_days: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </label>
                      <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:border-[#009944]/40 hover:bg-[#009944]/5 transition-colors cursor-pointer">
                        <input
                          type="checkbox"
                          checked={modal.updatePending}
                          onChange={(e) => setModal({ ...modal, updatePending: e.target.checked })}
                          className="w-4 h-4 text-[#009944] rounded border-slate-300 focus:ring-[#009944]"
                        />
                        <span className="text-sm text-slate-700 flex-1">Pending Days</span>
                        {modal.updatePending && (
                          <input
                            type="number"
                            min={0}
                            className={`${inputCls} w-24`}
                            value={modal.pending_days}
                            onChange={(e) => setModal({ ...modal, pending_days: e.target.value })}
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </label>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className={labelCls}>Employees ({modal.selectedEmployeeIds.size} selected)</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setModal({ ...modal, selectedEmployeeIds: new Set(employeeList.map((e) => e.id)) })}
                          className="text-xs text-[#009944] hover:underline"
                        >
                          Select All
                        </button>
                        <span className="text-slate-300">|</span>
                        <button
                          type="button"
                          onClick={() => setModal({ ...modal, selectedEmployeeIds: new Set() })}
                          className="text-xs text-slate-500 hover:underline"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
                      {employeeList.map((emp) => {
                        const selected = modal.selectedEmployeeIds.has(emp.id)
                        return (
                          <label
                            key={emp.id}
                            className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${selected ? 'bg-[#009944]/5' : 'hover:bg-slate-50'}`}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => {
                                const next = new Set(modal.selectedEmployeeIds)
                                if (next.has(emp.id)) next.delete(emp.id)
                                else next.add(emp.id)
                                setModal({ ...modal, selectedEmployeeIds: next })
                              }}
                              className="w-4 h-4 text-[#009944] rounded border-slate-300 focus:ring-[#009944]"
                            />
                            <span className="text-sm text-slate-700">{emp.name}</span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className={labelCls}>Reason / Note <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="text"
                  className={inputCls}
                  value={modal.reason}
                  onChange={(e) => setModal({ ...modal, reason: e.target.value })}
                  placeholder="e.g. Year-end adjustment, manual correction"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
              {modal.mode === 'single' ? (
                <button
                  onClick={resetSingleToDefault}
                  disabled={saving}
                  className="px-4 py-2 rounded-xl border border-amber-300 text-sm text-amber-700 hover:bg-amber-50 disabled:opacity-50 transition-all duration-200"
                >
                  Reset to Default
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={closeModal}
                  disabled={saving}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-sm text-slate-600 hover:bg-white disabled:opacity-50 transition-all duration-200"
                >
                  Cancel
                </button>
                <button
                  onClick={modal.mode === 'single' ? saveSingle : saveBatch}
                  disabled={saving || !isFormValid()}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50 transition-all duration-200 shadow-sm hover:shadow"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {saving ? 'Saving…' : modal.mode === 'single' ? 'Save Balance' : `Update ${modal.selectedEmployeeIds.size} Employee${modal.selectedEmployeeIds.size !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
