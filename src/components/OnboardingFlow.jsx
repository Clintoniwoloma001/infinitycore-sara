import React, { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { Loader2, Check, User, Briefcase, Phone, MapPin, Heart, ArrowRight, ArrowLeft, Sparkles, Calendar, Building2, Banknote, FileText } from 'lucide-react'

const inputCls = 'w-full h-11 rounded-lg border border-slate-300 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] transition-all'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const STEPS = [
  { id: 'welcome', label: 'Welcome', icon: Sparkles },
  { id: 'personal', label: 'Personal Info', icon: User },
  { id: 'contact', label: 'Contact', icon: Phone },
  { id: 'address', label: 'Address', icon: MapPin },
  { id: 'employment', label: 'Employment', icon: Briefcase },
  { id: 'bank', label: 'Bank Details', icon: Banknote },
  { id: 'kin', label: 'Next of Kin', icon: Heart },
  { id: 'complete', label: 'Complete', icon: Check },
]

export default function OnboardingFlow({ onComplete }) {
  const { user, profile } = useAuth()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [employee, setEmployee] = useState(null)
  const [form, setForm] = useState({
    full_name: profile?.full_name || '',
    email: user?.email || '',
    phone: '',
    date_of_birth: '',
    sex: '',
    marital_status: '',
    nationality: 'Nigerian',
    state_of_origin: '',
    lga: '',
    town: '',
    residential_address: '',
    religion: '',
    department: '',
    position: '',
    employment_type: 'full_time',
    salary: '',
    hire_date: new Date().toISOString().slice(0, 10),
    bank_name: '',
    account_number: '',
    bank_sort_code: '',
    bvn: '',
    nin: '',
    pension_id: '',
    tax_id: '',
    next_of_kin_name: '',
    next_of_kin_phone: '',
    next_of_kin_relationship: '',
    next_of_kin_address: '',
    beneficiary_name: '',
    beneficiary_phone: '',
    beneficiary_relationship: '',
  })

  useEffect(() => {
    const loadEmployee = async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('*')
        .eq('user_id', user?.id)
        .limit(1)
      if (!error && data && data.length > 0) {
        setEmployee(data[0])
        setForm((prev) => ({ ...prev, ...data[0] }))
      }
    }
    if (user?.id) loadEmployee()
  }, [user?.id])

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const next = () => {
    setAnimating(true)
    setTimeout(() => {
      setStep((s) => Math.min(s + 1, STEPS.length - 1))
      setAnimating(false)
    }, 200)
  }

  const back = () => {
    setAnimating(true)
    setTimeout(() => {
      setStep((s) => Math.max(s - 1, 0))
      setAnimating(false)
    }, 200)
  }

  const saveAndComplete = async () => {
    setSaving(true)
    try {
      // Upsert employee record
      const payload = {
        user_id: user?.id,
        full_name: form.full_name || profile?.full_name || '',
        email: form.email,
        phone: form.phone,
        department: form.department,
        position: form.position,
        employment_type: form.employment_type,
        salary: form.salary ? Number(form.salary) : null,
        hire_date: form.hire_date,
        employment_status: 'active',
        date_of_birth: form.date_of_birth || null,
        sex: form.sex || null,
        marital_status: form.marital_status || null,
        nationality: form.nationality || null,
        state_of_origin: form.state_of_origin || null,
        lga: form.lga || null,
        town: form.town || null,
        residential_address: form.residential_address || null,
        religion: form.religion || null,
        bank_name: form.bank_name || null,
        account_number: form.account_number || null,
        bank_sort_code: form.bank_sort_code || null,
        bvn: form.bvn || null,
        nin: form.nin || null,
        pension_id: form.pension_id || null,
        tax_id: form.tax_id || null,
        next_of_kin_name: form.next_of_kin_name || null,
        next_of_kin_phone: form.next_of_kin_phone || null,
        next_of_kin_relationship: form.next_of_kin_relationship || null,
        next_of_kin_address: form.next_of_kin_address || null,
        beneficiary_name: form.beneficiary_name || null,
        beneficiary_phone: form.beneficiary_phone || null,
        beneficiary_relationship: form.beneficiary_relationship || null,
      }

      if (employee?.id) {
        await supabase.from('employees').update(payload).eq('id', employee.id)
      } else {
        const { data } = await supabase.from('employees').insert(payload).select().single()
        if (data) setEmployee(data)
      }

      // Create digital file record
      const setupSteps = STEPS.slice(1, -1).map((s) => ({ step: s.id, label: s.label, completed: true }))
      await supabase.from('employee_digital_files').upsert({
        employee_id: employee?.id,
        user_id: user?.id,
        onboarding_completed: true,
        onboarding_completed_at: new Date().toISOString(),
        profile_completion_pct: 100,
        setup_steps: setupSteps,
      })

      onComplete?.()
    } catch (e) {
      console.error('Onboarding save error:', e)
    } finally {
      setSaving(false)
    }
  }

  const progress = ((step + 1) / STEPS.length) * 100

  // WELCOME STEP
  if (step === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-emerald-50 flex items-center justify-center p-4">
        <div className="max-w-lg w-full text-center">
          <div className="mb-8 animate-[fadeIn_0.5s_ease]">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-[#009944] to-[#007a36] flex items-center justify-center mx-auto mb-6 shadow-lg">
              <Sparkles className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-slate-900 mb-3">Welcome to InfinityCore, {profile?.full_name?.split(' ')[0] || 'there'}! 👋</h1>
            <p className="text-slate-600 text-lg leading-relaxed">
              Let's set up your employee digital file. This will be your permanent record —
              appraisals, attendance, queries, and more will all be stored here.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6 text-left">
            <p className="text-sm font-medium text-slate-700 mb-4">Here's what we'll set up:</p>
            <div className="space-y-2">
              {STEPS.slice(1, -1).map((s, i) => {
                const Icon = s.icon
                return (
                  <div key={s.id} className="flex items-center gap-3 text-sm text-slate-600 animate-[fadeIn_0.3s_ease]" style={{ animationDelay: `${i * 100}ms` }}>
                    <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                      <Icon className="w-4 h-4 text-[#009944]" />
                    </div>
                    {s.label}
                  </div>
                )
              })}
            </div>
          </div>

          <button
            onClick={next}
            className="inline-flex items-center gap-2 px-8 py-3 rounded-xl bg-[#009944] text-white font-medium hover:bg-[#007a36] transition-all hover:scale-105 shadow-lg"
          >
            Let's Get Started <ArrowRight className="w-5 h-5" />
          </button>
          <p className="text-xs text-slate-400 mt-4">Takes about 3 minutes · You can edit later</p>
        </div>
      </div>
    )
  }

  // COMPLETE STEP
  if (step === STEPS.length - 1) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-emerald-50 flex items-center justify-center p-4">
        <div className="max-w-lg w-full text-center">
          <div className="w-24 h-24 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-6 animate-[fadeIn_0.5s_ease]">
            <Check className="w-12 h-12 text-[#009944]" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-3">All Set! 🎉</h1>
          <p className="text-slate-600 text-lg mb-6">
            Your employee digital file is now complete. Welcome to the team!
          </p>
          <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6 text-left">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Employee</span>
                <span className="font-medium text-slate-900">{form.full_name}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Department</span>
                <span className="font-medium text-slate-900">{form.department || '—'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Position</span>
                <span className="font-medium text-slate-900">{form.position || '—'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-500">Bank</span>
                <span className="font-medium text-slate-900">{form.bank_name || '—'}</span>
              </div>
            </div>
          </div>
          <button
            onClick={saveAndComplete}
            disabled={saving}
            className="inline-flex items-center gap-2 px-8 py-3 rounded-xl bg-[#009944] text-white font-medium hover:bg-[#007a36] transition-all hover:scale-105 shadow-lg disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
            {saving ? 'Saving...' : 'Enter InfinityCore'}
          </button>
        </div>
      </div>
    )
  }

  // FORM STEPS
  const currentStep = STEPS[step]
  const Icon = currentStep.icon

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-emerald-50 flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        {/* Progress bar */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[#009944] flex items-center justify-center">
                <Icon className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-medium text-slate-700">{currentStep.label}</span>
            </div>
            <span className="text-xs text-slate-400">{step} / {STEPS.length - 2} of {STEPS.length - 2}</span>
          </div>
          <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-[#009944] to-[#007a36] rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Step content */}
        <div className={`bg-white rounded-2xl border border-slate-200 p-6 shadow-sm transition-all duration-200 ${animating ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'}`}>
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Personal Information</h2>
              <p className="text-sm text-slate-500 mb-4">Tell us about yourself.</p>
              <div>
                <label className={labelCls}>Full Name</label>
                <input className={inputCls} value={form.full_name} onChange={(e) => update('full_name', e.target.value)} placeholder="Your full name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Date of Birth</label>
                  <input type="date" className={inputCls} value={form.date_of_birth} onChange={(e) => update('date_of_birth', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Sex</label>
                  <select className={inputCls} value={form.sex} onChange={(e) => update('sex', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Marital Status</label>
                  <select className={inputCls} value={form.marital_status} onChange={(e) => update('marital_status', e.target.value)}>
                    <option value="">Select...</option>
                    <option value="single">Single</option>
                    <option value="married">Married</option>
                    <option value="divorced">Divorced</option>
                    <option value="widowed">Widowed</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Nationality</label>
                  <input className={inputCls} value={form.nationality} onChange={(e) => update('nationality', e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Contact Details</h2>
              <p className="text-sm text-slate-500 mb-4">How can we reach you?</p>
              <div>
                <label className={labelCls}>Email Address</label>
                <input className={inputCls} value={form.email} onChange={(e) => update('email', e.target.value)} placeholder="you@example.com" />
              </div>
              <div>
                <label className={labelCls}>Phone Number</label>
                <input className={inputCls} value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+234..." />
              </div>
              <div>
                <label className={labelCls}>State of Origin</label>
                <input className={inputCls} value={form.state_of_origin} onChange={(e) => update('state_of_origin', e.target.value)} placeholder="e.g. Lagos" />
              </div>
              <div>
                <label className={labelCls}>LGA</label>
                <input className={inputCls} value={form.lga} onChange={(e) => update('lga', e.target.value)} placeholder="Local Government Area" />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Residential Address</h2>
              <p className="text-sm text-slate-500 mb-4">Where do you live?</p>
              <div>
                <label className={labelCls}>Town / City</label>
                <input className={inputCls} value={form.town} onChange={(e) => update('town', e.target.value)} placeholder="Your town" />
              </div>
              <div>
                <label className={labelCls}>Residential Address</label>
                <textarea className={inputCls + ' h-20 py-2'} value={form.residential_address} onChange={(e) => update('residential_address', e.target.value)} placeholder="Full residential address" />
              </div>
              <div>
                <label className={labelCls}>Religion (optional)</label>
                <input className={inputCls} value={form.religion} onChange={(e) => update('religion', e.target.value)} placeholder="Optional" />
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Employment Details</h2>
              <p className="text-sm text-slate-500 mb-4">Your role at InfinityCore.</p>
              <div>
                <label className={labelCls}>Department</label>
                <input className={inputCls} value={form.department} onChange={(e) => update('department', e.target.value)} placeholder="e.g. Operations" />
              </div>
              <div>
                <label className={labelCls}>Position / Title</label>
                <input className={inputCls} value={form.position} onChange={(e) => update('position', e.target.value)} placeholder="e.g. Loan Officer" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Employment Type</label>
                  <select className={inputCls} value={form.employment_type} onChange={(e) => update('employment_type', e.target.value)}>
                    <option value="full_time">Full Time</option>
                    <option value="part_time">Part Time</option>
                    <option value="contract">Contract</option>
                    <option value="intern">Intern</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Hire Date</label>
                  <input type="date" className={inputCls} value={form.hire_date} onChange={(e) => update('hire_date', e.target.value)} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Salary (₦)</label>
                <input type="number" className={inputCls} value={form.salary} onChange={(e) => update('salary', e.target.value)} placeholder="Annual salary" />
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Bank Account Details</h2>
              <p className="text-sm text-slate-500 mb-4">For salary payments.</p>
              <div>
                <label className={labelCls}>Bank Name</label>
                <input className={inputCls} value={form.bank_name} onChange={(e) => update('bank_name', e.target.value)} placeholder="e.g. Access Bank" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Account Number</label>
                  <input className={inputCls} value={form.account_number} onChange={(e) => update('account_number', e.target.value)} placeholder="10-digit number" />
                </div>
                <div>
                  <label className={labelCls}>Sort Code</label>
                  <input className={inputCls} value={form.bank_sort_code} onChange={(e) => update('bank_sort_code', e.target.value)} placeholder="Bank sort code" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>BVN</label>
                  <input className={inputCls} value={form.bvn} onChange={(e) => update('bvn', e.target.value)} placeholder="11-digit BVN" />
                </div>
                <div>
                  <label className={labelCls}>NIN</label>
                  <input className={inputCls} value={form.nin} onChange={(e) => update('nin', e.target.value)} placeholder="National ID" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Pension ID (optional)</label>
                  <input className={inputCls} value={form.pension_id} onChange={(e) => update('pension_id', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Tax ID (optional)</label>
                  <input className={inputCls} value={form.tax_id} onChange={(e) => update('tax_id', e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Next of Kin & Beneficiary</h2>
              <p className="text-sm text-slate-500 mb-4">Emergency contact information.</p>
              <div>
                <label className={labelCls}>Next of Kin Name</label>
                <input className={inputCls} value={form.next_of_kin_name} onChange={(e) => update('next_of_kin_name', e.target.value)} placeholder="Full name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Phone</label>
                  <input className={inputCls} value={form.next_of_kin_phone} onChange={(e) => update('next_of_kin_phone', e.target.value)} placeholder="+234..." />
                </div>
                <div>
                  <label className={labelCls}>Relationship</label>
                  <input className={inputCls} value={form.next_of_kin_relationship} onChange={(e) => update('next_of_kin_relationship', e.target.value)} placeholder="e.g. Spouse" />
                </div>
              </div>
              <div>
                <label className={labelCls}>Address</label>
                <input className={inputCls} value={form.next_of_kin_address} onChange={(e) => update('next_of_kin_address', e.target.value)} placeholder="Contact address" />
              </div>
              <div className="border-t border-slate-100 pt-4 mt-4">
                <label className={labelCls}>Beneficiary Name</label>
                <input className={inputCls} value={form.beneficiary_name} onChange={(e) => update('beneficiary_name', e.target.value)} placeholder="Beneficiary full name" />
              </div>
              <div>
                <label className={labelCls}>Beneficiary Phone</label>
                <input className={inputCls} value={form.beneficiary_phone} onChange={(e) => update('beneficiary_phone', e.target.value)} placeholder="+234..." />
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-6 pt-4 border-t border-slate-100">
            <button onClick={back} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 transition-all">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button onClick={next} className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] transition-all hover:scale-105">
              Continue <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
