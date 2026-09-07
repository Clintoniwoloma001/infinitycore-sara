import React, { useEffect, useState } from 'react'
import { X, CheckCircle2, AlertCircle, Loader2, User } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { employeeService } from '../services/employeeService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const FIELD_CONFIG = [
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'department', label: 'Department', type: 'text' },
  { key: 'position', label: 'Position', type: 'text' },
  { key: 'branch', label: 'Branch', type: 'text' },
  { key: 'employment_type', label: 'Employment Type', type: 'text' },
  { key: 'hire_date', label: 'Date Employed', type: 'date' },
  { key: 'emergency_contact_name', label: 'Emergency Contact Name', type: 'text' },
  { key: 'emergency_contact_phone', label: 'Emergency Contact Phone', type: 'text' },
  { key: 'next_of_kin_name', label: 'Next of Kin Name', type: 'text' },
  { key: 'next_of_kin_phone', label: 'Next of Kin Phone', type: 'text' },
  { key: 'bank_name', label: 'Bank Name', type: 'text' },
  { key: 'account_number', label: 'Account Number', type: 'text' },
  { key: 'bvn', label: 'BVN', type: 'text' },
]

export default function EmployeeCompletionModal({ employeeId, onClose, onSaved }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [employee, setEmployee] = useState(null)
  const [completion, setCompletion] = useState(null)
  const [draft, setDraft] = useState({})
  const [msg, setMsg] = useState('')

  useEffect(() => {
    loadCompletion()
  }, [employeeId])

  const loadCompletion = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.rpc('get_employee_completion', { p_employee_id: employeeId })
      if (error) throw error
      setCompletion(data)

      if (data?.ok) {
        const emp = await employeeService.getById(employeeId)
        setEmployee(emp)
        setDraft(emp || {})
      }
    } catch (e) {
      setMsg(e?.message || 'Failed to load employee data')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setMsg('')
    try {
      await employeeService.update(employeeId, draft)
      setMsg('Profile updated successfully.')
      onSaved?.()
      // Reload completion
      const { data } = await supabase.rpc('get_employee_completion', { p_employee_id: employeeId })
      if (data?.ok) setCompletion(data)
      if (data?.is_complete) {
        setTimeout(() => onClose?.(), 1200)
      }
    } catch (e) {
      setMsg(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const pct = completion?.completion_pct ?? 0
  const missing = completion?.missing_fields || []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-[#0a0b0d] to-[#1a1b1f] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#FF8C00]/20 flex items-center justify-center">
              <User className="w-5 h-5 text-[#FF8C00]" />
            </div>
            <div>
              <h2 className="font-semibold text-lg">Welcome to InfinityCore</h2>
              <p className="text-sm text-white/60">Before you continue, please complete your basic employee information.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {/* Completion bar */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-slate-700">Profile Completion</span>
                <span className={`text-sm font-semibold ${pct === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>{pct}%</span>
              </div>
              <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${pct === 100 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {missing.length > 0 && (
                <div className="mt-3 flex items-start gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2 border border-amber-200">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">Missing required information:</span>{' '}
                    {missing.join(', ')}
                  </div>
                </div>
              )}
              {pct === 100 && (
                <div className="mt-3 flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-200">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Your profile is complete!
                </div>
              )}
            </div>

            {/* Form fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {FIELD_CONFIG.map((f) => (
                <div key={f.key}>
                  <label className={labelCls}>
                    {f.label}
                    {missing.includes(f.label) && <span className="text-rose-500 ml-1">*</span>}
                  </label>
                  <input
                    className={inputCls}
                    type={f.type}
                    value={draft[f.key] || ''}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </div>
              ))}
            </div>

            {msg && (
              <div className={`mt-4 text-sm rounded-lg px-3 py-2 ${msg.includes('success') ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
                {msg}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        {!loading && (
          <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between shrink-0">
            <button
              onClick={onClose}
              className="text-sm font-medium text-slate-500 hover:text-slate-700"
            >
              Save & Continue Later
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Continue Profile
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
