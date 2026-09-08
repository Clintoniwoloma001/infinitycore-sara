import React, { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { Loader2, X, User, UserPlus, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { ROLES, ROLE_METADATA, assignableRoles } from '../constants/roles'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const SECTIONS = [
  { id: 'personal', label: 'Personal Information' },
  { id: 'contact', label: 'Contact & Address' },
  { id: 'employment', label: 'Employment Information' },
  { id: 'bank', label: 'Bank / Payroll' },
  { id: 'statutory', label: 'Statutory / Identity' },
  { id: 'kin', label: 'Emergency / Next of Kin' },
  { id: 'account', label: 'Account / Access (Optional)' },
]

export default function AddEmployeeModal({ onClose, onCreated }) {
  const { user, profile, role: actorRole } = useAuth()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState({ employment_status: 'active', source: 'manual' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(null)
  const [duplicate, setDuplicate] = useState(null)
  const [createAccount, setCreateAccount] = useState(false)
  const [empCode, setEmpCode] = useState('')

  const set = (k) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [k]: val }))
  }

  // Auto-generate employee code
  useEffect(() => {
    supabase.rpc('generate_employee_code').then(({ data }) => {
      if (data) { setEmpCode(data); setForm((f) => ({ ...f, employee_code: data })) }
    }).catch(() => {})
  }, [])

  // Duplicate check on email/phone change
  const checkDuplicate = async (field, value) => {
    if (!value) return
    try {
      const { data } = await supabase.from('employees').select('id, full_name, email, phone, employee_code').eq(field, value).maybeSingle()
      if (data) setDuplicate(data)
      else setDuplicate(null)
    } catch { /* ignore */ }
  }

  const next = () => setStep((s) => Math.min(s + 1, SECTIONS.length - 1))
  const prev = () => setStep((s) => Math.max(s - 1, 0))

  const validate = () => {
    if (!form.full_name) return 'Full name is required.'
    if (step === 6 && createAccount && !form.account_email) return 'Account email is required when creating a user account.'
    return null
  }

  const save = async () => {
    const vErr = validate()
    if (vErr) { setError(vErr); return }
    setError('')
    setSaving(true)
    try {
      // Create employee via RPC (includes duplicate check)
      const { data, error: rpcError } = await supabase.rpc('create_employee_manual', {
        p_full_name: form.full_name,
        p_email: form.email || null,
        p_phone: form.phone || null,
        p_department: form.department || null,
        p_position: form.position || null,
        p_branch: form.branch || null,
        p_area: form.area || null,
        p_employment_type: form.employment_type || null,
        p_employment_status: form.employment_status || 'active',
        p_hire_date: form.hire_date || null,
        p_employee_code: form.employee_code || null,
        p_basic_salary: form.basic_salary ? parseFloat(form.basic_salary) : null,
        p_bank_name: form.bank_name || null,
        p_account_name: form.account_name || null,
        p_account_number: form.account_number || null,
        p_bank_sort_code: form.bank_sort_code || null,
        p_bvn: form.bvn || null,
        p_nin: form.nin || null,
        p_tax_id: form.tax_id || null,
        p_pension_id: form.pension_id || null,
        p_gender: form.gender || null,
        p_date_of_birth: form.date_of_birth || null,
        p_nationality: form.nationality || null,
        p_marital_status: form.marital_status || null,
        p_state_of_origin: form.state_of_origin || null,
        p_lga: form.lga || null,
        p_residential_address: form.residential_address || null,
        p_emergency_contact_name: form.emergency_contact_name || null,
        p_emergency_contact_phone: form.emergency_contact_phone || null,
        p_next_of_kin_name: form.next_of_kin_name || null,
        p_next_of_kin_phone: form.next_of_kin_phone || null,
        p_next_of_kin_relationship: form.next_of_kin_relationship || null,
        p_work_location: form.work_location || null,
        p_probation_end_date: form.probation_end_date || null,
        p_preferred_name: form.preferred_name || null,
      })

      if (rpcError) throw rpcError
      if (data?.ok === false) {
        if (data.error === 'duplicate') {
          setError(data.message || 'Duplicate employee found')
          setDuplicate({ id: data.existing_id })
          return
        }
        throw new Error(data.message || 'Failed to create employee')
      }

      const employeeId = data?.employee_id

      // Optionally create user account
      if (createAccount && form.account_email) {
        try {
          await supabase.functions.invoke('create-user', {
            body: {
              email: form.account_email,
              fullName: form.full_name,
              phone: form.phone || null,
              role: form.account_role || 'staff',
              department: form.department || null,
              branch: form.branch || null,
              userType: 'staff',
            },
          })
        } catch (e) {
          // Employee created, but account creation failed — not critical
          setSuccess({ employeeId, warning: 'Employee created, but user account creation failed. Edge function may not be deployed.' })
          onCreated(employeeId)
          return
        }
      }

      setSuccess({ employeeId })
      setTimeout(() => { onCreated(employeeId) }, 1500)
    } catch (e) {
      setError(e?.message || 'Failed to create employee')
    } finally {
      setSaving(false)
    }
  }

  if (success) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl w-full max-w-md p-6 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-7 h-7 text-emerald-600" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-2">Employee Created Successfully</h3>
          {success.warning && <p className="text-sm text-amber-600 mb-2">{success.warning}</p>}
          <p className="text-sm text-slate-500 mb-4">The employee has been added to the directory.</p>
          <button onClick={() => onCreated(success.employeeId)} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">View Employee</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-[#009944]" />
            <h3 className="text-lg font-semibold text-slate-900">Add Employee</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        {error && <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 p-3 text-sm text-rose-700 flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /> {error}</div>}

        {duplicate && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
            <p className="font-medium mb-1">Possible existing employee found</p>
            <button onClick={() => onCreated(duplicate.id)} className="text-[#009944] hover:underline text-xs font-medium">View Existing Employee →</button>
          </div>
        )}

        {/* Progress */}
        <div className="flex gap-1 mb-5">
          {SECTIONS.map((s, i) => (
            <button key={s.id} onClick={() => setStep(i)}
              className={`flex-1 h-1.5 rounded-full ${i <= step ? 'bg-[#009944]' : 'bg-slate-200'}`}
              title={s.label} />
          ))}
        </div>
        <p className="text-xs text-slate-400 mb-4 text-center">{SECTIONS[step].label} (Step {step + 1} of {SECTIONS.length})</p>

        {/* Step content */}
        <div className="space-y-4">
          {step === 0 && (
            <>
              <div><label className={labelCls}>Full Name *</label><input className={inputCls} value={form.full_name || ''} onChange={(e) => { set('full_name')(e); }} placeholder="John Doe" /></div>
              <div><label className={labelCls}>Preferred Name</label><input className={inputCls} value={form.preferred_name || ''} onChange={set('preferred_name')} placeholder="Johnny" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Date of Birth</label><input type="date" className={inputCls} value={form.date_of_birth || ''} onChange={set('date_of_birth')} /></div>
                <div><label className={labelCls}>Gender</label><select className={inputCls} value={form.gender || ''} onChange={set('gender')}><option value="">Select…</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Marital Status</label><select className={inputCls} value={form.marital_status || ''} onChange={set('marital_status')}><option value="">Select…</option><option value="single">Single</option><option value="married">Married</option><option value="divorced">Divorced</option><option value="widowed">Widowed</option></select></div>
                <div><label className={labelCls}>Nationality</label><input className={inputCls} value={form.nationality || ''} onChange={set('nationality')} placeholder="Nigerian" /></div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Email</label><input className={inputCls} value={form.email || ''} onChange={(e) => { set('email')(e); checkDuplicate('email', e.target.value) }} placeholder="john@company.com" /></div>
                <div><label className={labelCls}>Phone</label><input className={inputCls} value={form.phone || ''} onChange={(e) => { set('phone')(e); checkDuplicate('phone', e.target.value) }} placeholder="+1234567890" /></div>
              </div>
              <div><label className={labelCls}>Residential Address</label><input className={inputCls} value={form.residential_address || ''} onChange={set('residential_address')} placeholder="Street address" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>State</label><input className={inputCls} value={form.state_of_origin || ''} onChange={set('state_of_origin')} placeholder="Lagos" /></div>
                <div><label className={labelCls}>LGA</label><input className={inputCls} value={form.lga || ''} onChange={set('lga')} placeholder="Ikeja" /></div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Employee ID / Work ID</label>
                  <div className="flex gap-2">
                    <input className={inputCls} value={form.employee_code || empCode || ''} onChange={set('employee_code')} placeholder="EMP-0001" />
                    <button type="button" onClick={() => supabase.rpc('generate_employee_code').then(({ data }) => { if (data) { setEmpCode(data); setForm((f) => ({ ...f, employee_code: data })) } })} className="px-3 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="Auto-generate"><RefreshCw className="w-4 h-4" /></button>
                  </div>
                </div>
                <div><label className={labelCls}>Job Title / Position</label><input className={inputCls} value={form.position || ''} onChange={set('position')} placeholder="Software Engineer" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Department</label><input className={inputCls} value={form.department || ''} onChange={set('department')} placeholder="IT" /></div>
                <div><label className={labelCls}>Branch</label><input className={inputCls} value={form.branch || ''} onChange={set('branch')} placeholder="HQ" /></div>
              </div>
              <div><label className={labelCls}>Area</label><input className={inputCls} value={form.area || ''} onChange={set('area')} placeholder="Lagos Mainland" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Employment Type</label><select className={inputCls} value={form.employment_type || ''} onChange={set('employment_type')}><option value="">Select…</option><option value="full_time">Full Time</option><option value="part_time">Part Time</option><option value="contract">Contract</option><option value="intern">Intern</option></select></div>
                <div><label className={labelCls}>Employment Status</label><select className={inputCls} value={form.employment_status || 'active'} onChange={set('employment_status')}><option value="active">Active</option><option value="probation">Probation</option><option value="onboarding">Onboarding</option><option value="inactive">Inactive</option></select></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Date of Employment</label><input type="date" className={inputCls} value={form.hire_date || ''} onChange={set('hire_date')} /></div>
                <div><label className={labelCls}>Probation End Date</label><input type="date" className={inputCls} value={form.probation_end_date || ''} onChange={set('probation_end_date')} /></div>
              </div>
              <div><label className={labelCls}>Work Location</label><input className={inputCls} value={form.work_location || ''} onChange={set('work_location')} placeholder="Office / Remote" /></div>
              <div><label className={labelCls}>Basic Salary</label><input type="number" className={inputCls} value={form.basic_salary || ''} onChange={set('basic_salary')} placeholder="0.00" /></div>
            </>
          )}

          {step === 3 && (
            <>
              <div><label className={labelCls}>Bank Name</label><input className={inputCls} value={form.bank_name || ''} onChange={set('bank_name')} placeholder="First Bank" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Account Name</label><input className={inputCls} value={form.account_name || ''} onChange={set('account_name')} placeholder="John Doe" /></div>
                <div><label className={labelCls}>Account Number</label><input className={inputCls} value={form.account_number || ''} onChange={set('account_number')} placeholder="0123456789" /></div>
              </div>
              <div><label className={labelCls}>Bank Sort Code</label><input className={inputCls} value={form.bank_sort_code || ''} onChange={set('bank_sort_code')} placeholder="011" /></div>
              <p className="text-xs text-slate-400">Bank details are protected by RLS and only visible to authorized HR/admin users.</p>
            </>
          )}

          {step === 4 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>BVN</label><input className={inputCls} value={form.bvn || ''} onChange={set('bvn')} placeholder="11-digit BVN" /></div>
                <div><label className={labelCls}>NIN</label><input className={inputCls} value={form.nin || ''} onChange={set('nin')} placeholder="11-digit NIN" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Tax ID</label><input className={inputCls} value={form.tax_id || ''} onChange={set('tax_id')} placeholder="TIN" /></div>
                <div><label className={labelCls}>Pension ID</label><input className={inputCls} value={form.pension_id || ''} onChange={set('pension_id')} placeholder="Pension PIN" /></div>
              </div>
              <p className="text-xs text-slate-400">Statutory information is protected by RLS and only visible to authorized HR/admin users.</p>
            </>
          )}

          {step === 5 && (
            <>
              <div><label className={labelCls}>Emergency Contact Name</label><input className={inputCls} value={form.emergency_contact_name || ''} onChange={set('emergency_contact_name')} placeholder="Jane Doe" /></div>
              <div><label className={labelCls}>Emergency Contact Phone</label><input className={inputCls} value={form.emergency_contact_phone || ''} onChange={set('emergency_contact_phone')} placeholder="+1234567890" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Next of Kin Name</label><input className={inputCls} value={form.next_of_kin_name || ''} onChange={set('next_of_kin_name')} placeholder="Jane Doe" /></div>
                <div><label className={labelCls}>Next of Kin Phone</label><input className={inputCls} value={form.next_of_kin_phone || ''} onChange={set('next_of_kin_phone')} placeholder="+1234567890" /></div>
              </div>
              <div><label className={labelCls}>Next of Kin Relationship</label><input className={inputCls} value={form.next_of_kin_relationship || ''} onChange={set('next_of_kin_relationship')} placeholder="Spouse, Parent, Sibling..." /></div>
            </>
          )}

          {step === 6 && (
            <>
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 mb-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={createAccount} onChange={(e) => setCreateAccount(e.target.checked)} className="w-4 h-4 rounded border-slate-300 text-[#009944] focus:ring-[#009944]" />
                  <div>
                    <p className="text-sm font-medium text-slate-700">Create User Account</p>
                    <p className="text-xs text-slate-400">Create login credentials for this employee (requires Edge Function deployment)</p>
                  </div>
                </label>
              </div>
              {createAccount && (
                <>
                  <div><label className={labelCls}>Account Email *</label><input className={inputCls} value={form.account_email || ''} onChange={set('account_email')} placeholder="john@company.com" /></div>
                  <div>
                    <label className={labelCls}>Account Role</label>
                    <select className={inputCls} value={form.account_role || 'staff'} onChange={set('account_role')}>
                      {assignableRoles(actorRole).map((r) => <option key={r} value={r}>{ROLE_METADATA[r]?.label || r}</option>)}
                    </select>
                  </div>
                </>
              )}
              <div className="rounded-lg bg-blue-50 border border-blue-100 p-3 text-xs text-blue-600">
                <p><strong>Create Employee Only</strong> — saves the employee record without login credentials.</p>
                <p className="mt-1"><strong>Create Employee + User Account</strong> — also creates login access (requires Edge Function).</p>
              </div>
            </>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between pt-5 mt-5 border-t border-slate-100">
          <button onClick={prev} disabled={step === 0} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Previous</button>
          {step < SECTIONS.length - 1 ? (
            <button onClick={next} className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700">Next</button>
          ) : (
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Create Employee
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
