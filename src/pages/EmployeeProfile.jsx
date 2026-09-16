import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Briefcase, CalendarDays, Camera, CheckCircle2, Clock, CreditCard, Download, FileText, GraduationCap, Loader2, Pencil, Plus, Printer, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { employeeService } from '../services/employeeService'
import { attendanceService } from '../services/attendanceService'
import { documentService } from '../services/documentService'
import { guarantorVerificationService } from '../services/guarantorVerificationService'
import { payrollService } from '../services/payrollService'
import { supabase } from '../supabaseClient'
import EmployeeHRActions from '../components/EmployeeHRActions'
import StaffIdCard from '../components/StaffIdCard'
import ProfilePhotoModal from '../components/ProfilePhotoModal'
import EmployeeRecordPrint, { RECORD_SECTIONS, ALL_RECORD_SECTIONS } from '../components/EmployeeRecordPrint'
import PrintPortal from '../components/PrintPortal'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

function Section({ title, children, actions }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-slate-900">{title}</h3>
        {actions}
      </div>
      {children}
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <div className="text-sm text-slate-800 min-h-10 flex items-center border border-transparent rounded-lg px-0.5">{value || '—'}</div>
    </div>
  )
}

function InputField({ label, value, onChange, type, disabled }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={`${inputCls} ${disabled ? 'bg-slate-50 text-slate-500' : ''}`} value={value || ''} onChange={(e) => onChange(e.target.value)} type={type || 'text'} disabled={disabled} readOnly={disabled} />
    </div>
  )
}

function SelectField({ label, value, onChange, options, disabled }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <select className={`${inputCls} ${disabled ? 'bg-slate-50 text-slate-500' : ''}`} value={value || ''} onChange={onChange} disabled={disabled}>
        {options.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
      </select>
    </div>
  )
}

function AddRow({ columns, onAdd }) {
  const [draft, setDraft] = useState({})
  const ready = columns.every((c) => c.required === false || (draft[c.key] || '').trim() !== '')
  return (
    <div className="border-t border-slate-100 pt-3 mt-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {columns.map((c) => (
          <div key={c.key}>
            <label className={labelCls}>{c.label}</label>
            <input className={inputCls} value={draft[c.key] || ''} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })} placeholder={c.placeholder} type={c.type} />
          </div>
        ))}
      </div>
      <button onClick={() => { onAdd(draft); setDraft({}) }} disabled={!ready} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#009944] disabled:opacity-40">
        <Plus className="w-4 h-4" /> Add
      </button>
    </div>
  )
}

function ComingSoon({ title, description }) {
  return (
    <div className="text-center py-12">
      <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
        <Clock className="w-7 h-7 text-slate-400" />
      </div>
      <h4 className="font-semibold text-slate-700 mb-1">{title}</h4>
      <p className="text-sm text-slate-400">{description || 'This section will be available in a future update.'}</p>
    </div>
  )
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'personal', label: 'Personal' },
  { id: 'employment', label: 'Employment' },
  { id: 'documents', label: 'Documents' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'guarantors', label: 'Guarantor' },
  { id: 'leave', label: 'Leave' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'performance', label: 'Performance' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'queries', label: 'Queries / Disciplinary' },
  { id: 'training', label: 'Training' },
  { id: 'audit', label: 'Audit' },
]

const HR_CONTROLLED_FIELDS = [
  'employee_code', 'department', 'position', 'employment_status', 'employment_type',
  'hire_date', 'salary', 'basic_salary', 'allowances', 'branch', 'branch_manager_name',
  'area_manager_name', 'bank_name', 'account_number', 'account_name', 'bank_sort_code',
  'bvn', 'nin', 'pension_id', 'tax_id', 'nhf_id', 'hmo', 'manager_id', 'reporting_manager_id',
]

export default function EmployeeProfile() {
  const { id } = useParams()
  const { hasPermission, user, isAdmin, isHR } = useAuth()
  const canEdit = hasPermission('hr.employee.update')

  const [employee, setEmployee] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('overview')
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [childrenData, setChildrenData] = useState({})
  const [docs, setDocs] = useState([])
  const [attendance, setAttendance] = useState([])
  const [message, setMessage] = useState('')
  const [verifications, setVerifications] = useState([])
  const [guarantorDocs, setGuarantorDocs] = useState([])
  const [payrollItems, setPayrollItems] = useState([])
  const [payrollPeriods, setPayrollPeriods] = useState([])
  const [events, setEvents] = useState([])
  const [showAddPayroll, setShowAddPayroll] = useState(false)
  const [selectedPeriod, setSelectedPeriod] = useState('')
  const [payrollBusy, setPayrollBusy] = useState(false)
  const [payrollError, setPayrollError] = useState('')
  const [payrollSuccess, setPayrollSuccess] = useState('')
  const [onboardingSub, setOnboardingSub] = useState(null)
  const [appraisals, setAppraisals] = useState([])
  const [queries, setQueries] = useState([])
  const [leaveRequests, setLeaveRequests] = useState([])
  const [trainingLoading, setTrainingLoading] = useState(false)

  const [showCard, setShowCard] = useState(false)
  const [showRecord, setShowRecord] = useState(false)
  const [showPhotos, setShowPhotos] = useState(false)
  const [photoUrl, setPhotoUrl] = useState(null)
  const [passportUrl, setPassportUrl] = useState(null)
  const [recordBusy, setRecordBusy] = useState(false)
  const [recordError, setRecordError] = useState('')

  // Record section selection (default = full employee file)
  const [recordSections, setRecordSections] = useState(ALL_RECORD_SECTIONS)

  // Staff ID card configuration
  const [cardExpiryMode, setCardExpiryMode] = useState('date')
  const [cardExpiryDate, setCardExpiryDate] = useState('')
  const [cardIssueDate, setCardIssueDate] = useState(new Date().toISOString().slice(0, 10))
  const [cardIssuedBy, setCardIssuedBy] = useState('Human Resources')
  const [cardStatus, setCardStatus] = useState('active')
  const [cardSaving, setCardSaving] = useState(false)

  const canReadPayroll = hasPermission('hr.payroll.read')
  const canManagePayroll = hasPermission('payroll.manage')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const emp = await employeeService.getById(id)
      setEmployee(emp)
      setDraft(emp)
      const childs = await employeeService.listChildrenForEmployee(id)
      setChildrenData(childs)
      const docList = await documentService.list('employee', id).catch(() => [])
      setDocs(docList)
      const passportDoc = docList.find((d) => /passport/i.test(d.document_type))
      if (passportDoc?.file_path) {
        const url = await documentService.getSignedUrl(passportDoc.file_path).catch(() => null)
        if (url) setPassportUrl(url)
      }
      const profPicDoc = docList.find((d) => d.document_type === 'profile_picture')
      if (profPicDoc?.file_path) {
        const url = await documentService.getSignedUrl(profPicDoc.file_path).catch(() => null)
        if (url) setPhotoUrl(url)
      } else if (passportDoc?.file_path) {
        const url = await documentService.getSignedUrl(passportDoc.file_path).catch(() => null)
        if (url) setPhotoUrl(url)
      } else {
        setPhotoUrl(null)
      }
      const att = await attendanceService.getHistory(id, { limit: 90 }).catch(() => [])
      setAttendance(att)

      // Load guarantor verifications
      const verifs = await guarantorVerificationService.listVerificationsForEmployee(id).catch(() => [])
      setVerifications(verifs)

      // Load guarantor documents
      if (verifs.length > 0) {
        const allDocs = await Promise.all(
          verifs.map((v) => guarantorVerificationService.listGuarantorDocuments(v.id).catch(() => []))
        )
        setGuarantorDocs(allDocs.flat())
      } else {
        setGuarantorDocs([])
      }

      // Load onboarding events
      if (verifs.length > 0) {
        const verifIds = verifs.map((v) => v.id)
        const { data: evtData } = await supabase
          .from('onboarding_events')
          .select('*')
          .in('guarantor_verification_id', verifIds)
          .order('created_at', { ascending: false })
          .catch(() => ({ data: [] }))
        setEvents(evtData || [])
      } else {
        setEvents([])
      }

      // Load payroll
      if (canReadPayroll) {
        const items = await payrollService.itemsForEmployee(id).catch(() => [])
        setPayrollItems(items)
        const periods = await payrollService.listPeriods().catch(() => [])
        setPayrollPeriods(periods)
      }

      // Load onboarding submission, appraisals, queries, leave requests
      const [subRes, apprRes, queryRes, leaveRes] = await Promise.all([
        supabase.from('employee_onboarding_submissions').select('*').eq('employee_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('employee_appraisals').select('*').eq('employee_id', id).order('created_at', { ascending: false }),
        supabase.from('hr_queries').select('*').eq('employee_id', id).order('created_at', { ascending: false }),
        emp?.user_id
          ? supabase.from('leave_requests').select('*').eq('created_by', emp.user_id).order('created_at', { ascending: false })
          : Promise.resolve({ data: [] }),
      ])
      setOnboardingSub(subRes?.data || null)
      setAppraisals(apprRes?.data || [])
      setQueries(queryRes?.data || [])
      setLeaveRequests(leaveRes?.data || [])
    } catch (e) {
      setError(e?.message || 'Unable to load employee profile')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // HR saves employment fields via RPC
  const saveHrFields = async (fieldsToSave) => {
    setSaving(true)
    setMessage('')
    try {
      await employeeService.updateHrFields(id, fieldsToSave)
      setMessage('Saved.')
      await load()
    } catch (e) {
      setMessage(e?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Personal info save (RPC)
  const savePersonalInfo = async () => {
    setSaving(true)
    setMessage('')
    try {
      const personalFields = {
        full_name: draft.full_name,
        email: draft.email,
        phone: draft.phone,
        date_of_birth: draft.date_of_birth,
        sex: draft.sex,
        state_of_origin: draft.state_of_origin,
        lga: draft.lga,
        town: draft.town,
        residential_address: draft.residential_address,
        religion: draft.religion,
        denomination: draft.denomination,
        nationality: draft.nationality,
        marital_status: draft.marital_status,
        spouse_name: draft.spouse_name,
        spouse_occupation: draft.spouse_occupation,
        spouse_phone: draft.spouse_phone,
        spouse_email: draft.spouse_email,
        emergency_contact_name: draft.emergency_contact_name,
        emergency_contact_phone: draft.emergency_contact_phone,
      }
      await employeeService.updatePersonalInfo(personalFields)
      setMessage('Saved.')
      await load()
    } catch (e) {
      setMessage(e?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // HR saves full employment record
  const saveEmployment = async () => {
    setSaving(true)
    setMessage('')
    try {
      const empFields = {
        employee_code: draft.employee_code,
        department: draft.department,
        position: draft.position,
        employment_status: draft.employment_status,
        employment_type: draft.employment_type,
        hire_date: draft.hire_date,
        salary: draft.salary,
        basic_salary: draft.basic_salary,
        allowances: draft.allowances,
        branch: draft.branch,
        branch_manager_name: draft.branch_manager_name,
        area_manager_name: draft.area_manager_name,
        bank_name: draft.bank_name,
        account_number: draft.account_number,
        account_name: draft.account_name,
        bank_sort_code: draft.bank_sort_code,
        bvn: draft.bvn,
        nin: draft.nin,
        pension_id: draft.pension_id,
        tax_id: draft.tax_id,
        nhf_id: draft.nhf_id,
        hmo: draft.hmo,
      }
      await employeeService.updateHrFields(id, empFields)
      setMessage('Saved.')
      await load()
    } catch (e) {
      setMessage(e?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const addChild = async (table, payload) => {
    await employeeService.addChild(table, id, payload)
    const childs = await employeeService.listChildrenForEmployee(id)
    setChildrenData(childs)
  }

  const removeChild = async (table, rowId) => {
    await employeeService.removeChild(table, rowId)
    const childs = await employeeService.listChildrenForEmployee(id)
    setChildrenData(childs)
  }

  const addToPayroll = async () => {
    if (!selectedPeriod) { setPayrollError('Select a payroll period.'); return }
    setPayrollBusy(true); setPayrollError(''); setPayrollSuccess('')
    try {
      await payrollService.addToPayroll(id, selectedPeriod, draft.salary || null)
      setPayrollSuccess('Employee added to payroll.')
      setShowAddPayroll(false); setSelectedPeriod('')
      const items = await payrollService.itemsForEmployee(id).catch(() => [])
      setPayrollItems(items)
    } catch (e) {
      setPayrollError(e?.message || 'Failed to add to payroll')
    } finally {
      setPayrollBusy(false)
    }
  }

  if (loading) return <LoadingState label="Loading employee profile..." />
  if (error) return <ErrorState message={error} />

  const d = draft
  const setD = (key) => (e) => setDraft({ ...draft, [key]: e.target.value })

  const openCard = async () => {
    setRecordError('')
    setRecordBusy(true)
    try {
      if (employee?.id && !employee.employee_number && !employee.staff_id) {
        const res = await employeeService.ensureEmployeeNumber(id)
        if (res?.employee_number) {
          setEmployee((prev) => ({ ...prev, ...res }))
          setDraft((prev) => ({ ...prev, ...res }))
        }
      }
      setCardExpiryMode(employee?.staff_id_expiry ? 'date' : 'date')
      setCardExpiryDate(employee?.staff_id_expiry ? employee.staff_id_expiry.slice(0, 10) : new Date(Date.now() + 3 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10))
      setCardIssueDate((employee?.staff_id_issued_at || new Date().toISOString()).slice(0, 10))
      setCardIssuedBy(user?.full_name || user?.email || 'Human Resources')
      setCardStatus(employee?.staff_id_status || 'active')
      setShowCard(true)
    } catch (e) {
      setRecordError(e?.message || 'Unable to generate staff ID')
    } finally {
      setRecordBusy(false)
    }
  }

  const openRecord = async () => {
    setRecordError('')
    try {
      await load()
      setShowRecord(true)
    } catch (e) {
      setRecordError(e?.message || 'Unable to prepare employee record')
    }
  }

  const toggleSection = (key) => {
    setRecordSections((prev) => (
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    ))
  }

  const selectAllSections = () => setRecordSections(ALL_RECORD_SECTIONS)

  // Persist staff ID card configuration (expiry, issue, status, official ID)
  const saveCardConfig = async () => {
    setCardSaving(true)
    setRecordError('')
    try {
      const payload = {
        staff_id_expiry: cardExpiryMode === 'date' && cardExpiryDate ? cardExpiryDate : null,
        staff_id_status: cardStatus,
      }
      const res = await employeeService.updateHrFields(id, payload)
      if (res?.ok) {
        setEmployee((prev) => ({ ...prev, staff_id_expiry: payload.staff_id_expiry, staff_id_status: cardStatus }))
        setMessage('ID card settings saved.')
      }
    } catch (e) {
      setRecordError(e?.message || 'Unable to save ID card settings — please check that the Phase 12/14 migration is applied.')
    } finally {
      setCardSaving(false)
    }
  }

  return (
    <div>
      <Link to="/employees" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944] mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to employees
      </Link>

      {/* Header */}
      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-full bg-[#009944] text-white flex items-center justify-center text-xl font-semibold overflow-hidden">
              {photoUrl ? (
                <img src={photoUrl} alt="Passport" className="w-full h-full object-cover" />
              ) : employee?.full_name?.charAt(0)?.toUpperCase() || 'E'}
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">{employee?.full_name}</h2>
              <p className="text-sm text-slate-500 mt-1">{employee?.position || 'No position'} {employee?.department ? `· ${employee.department}` : ''}</p>
              <div className="flex flex-wrap gap-2 mt-2">
                <span className="text-xs">{status(employee?.employment_status)}</span>
                <span className="text-xs">{employee?.employee_code ? `Code: ${employee.employee_code}` : ''}</span>
                {employee?.staff_id && <span className="text-xs font-semibold text-[#009944]">Staff ID: {employee.staff_id}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            {message && !message.includes('fail') && <span className="text-sm text-emerald-600">{message}</span>}
            {message.includes('fail') && <span className="text-sm text-rose-600">{message}</span>}
            <button onClick={openCard} disabled={recordBusy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border-2 border-[#009944] text-[#009944] text-sm font-medium hover:bg-emerald-50 disabled:opacity-60 whitespace-nowrap">
              {recordBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />} Staff ID Card
            </button>
            <button onClick={() => setShowPhotos(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 whitespace-nowrap">
              <Camera className="w-4 h-4" /> Photos
            </button>
            <button onClick={openRecord}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700 whitespace-nowrap">
              <Printer className="w-4 h-4" /> Print / Download Record
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          {[
            { label: 'Salary', value: money(employee?.salary) },
            { label: 'Email', value: employee?.email || '—' },
            { label: 'Phone', value: employee?.phone || '—' },
            { label: 'Branch', value: employee?.branch || '—' },
          ].map((s) => (
            <div key={s.label} className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs text-slate-400">{s.label}</div>
              <div className="text-sm font-medium text-slate-800 mt-0.5 truncate">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- OVERVIEW ---- */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Personal">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Date of Birth" value={date(d.date_of_birth)} />
              <Field label="Sex" value={d.sex} />
              <Field label="State of Origin" value={d.state_of_origin} />
              <Field label="LGA" value={d.lga} />
              <Field label="Town" value={d.town} />
              <Field label="Nationality" value={d.nationality} />
              <Field label="Marital Status" value={d.marital_status} />
              <Field label="Religion" value={d.religion} />
            </div>
          </Section>
          <Section title="Employment">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Department" value={d.department} />
              <Field label="Position" value={d.position} />
              <Field label="Employment Type" value={d.employment_type} />
              <Field label="Hire Date" value={date(d.hire_date)} />
              <Field label="Salary" value={money(d.salary)} />
              <Field label="Allowances" value={money(d.allowances)} />
              <Field label="HMO" value={d.hmo} />
              <Field label="Branch" value={d.branch} />
              <Field label="Branch Manager" value={d.branch_manager_name} />
              <Field label="Area Manager" value={d.area_manager_name} />
              <Field label="Bank" value={d.bank_name ? `${d.bank_name} ${d.account_number || ''}`.trim() : '—'} />
              <Field label="Pension ID" value={d.pension_id} />
              <Field label="Tax ID" value={d.tax_id} />
            </div>
          </Section>
        </div>
      )}

      {/* ---- PERSONAL (self-editable fields) ---- */}
      {tab === 'personal' && (
        <Section
          title="Personal Information"
          actions={(
            <button onClick={savePersonalInfo} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          )}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <InputField label="Full Name" value={d.full_name} onChange={(v) => setDraft({ ...draft, full_name: v })} />
            <InputField label="Email" value={d.email} onChange={(v) => setDraft({ ...draft, email: v })} />
            <InputField label="Phone" value={d.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
            <InputField label="Date of Birth" value={d.date_of_birth} onChange={(v) => setDraft({ ...draft, date_of_birth: v })} type="date" />
            <InputField label="Sex" value={d.sex} onChange={(v) => setDraft({ ...draft, sex: v })} />
            <InputField label="State of Origin" value={d.state_of_origin} onChange={(v) => setDraft({ ...draft, state_of_origin: v })} />
            <InputField label="LGA" value={d.lga} onChange={(v) => setDraft({ ...draft, lga: v })} />
            <InputField label="Town / City" value={d.town} onChange={(v) => setDraft({ ...draft, town: v })} />
            <InputField label="Residential Address" value={d.residential_address} onChange={(v) => setDraft({ ...draft, residential_address: v })} />
            <InputField label="Religion" value={d.religion} onChange={(v) => setDraft({ ...draft, religion: v })} />
            <InputField label="Denomination" value={d.denomination} onChange={(v) => setDraft({ ...draft, denomination: v })} />
            <InputField label="Nationality" value={d.nationality} onChange={(v) => setDraft({ ...draft, nationality: v })} />
            <InputField label="Marital Status" value={d.marital_status} onChange={(v) => setDraft({ ...draft, marital_status: v })} />
            <InputField label="Spouse Name" value={d.spouse_name} onChange={(v) => setDraft({ ...draft, spouse_name: v })} />
            <InputField label="Spouse Occupation" value={d.spouse_occupation} onChange={(v) => setDraft({ ...draft, spouse_occupation: v })} />
            <InputField label="Spouse Phone" value={d.spouse_phone} onChange={(v) => setDraft({ ...draft, spouse_phone: v })} />
            <InputField label="Spouse Email" value={d.spouse_email} onChange={(v) => setDraft({ ...draft, spouse_email: v })} />
            <InputField label="Number of Children" value={d.number_of_children} onChange={(v) => setDraft({ ...draft, number_of_children: v })} type="number" />
            <InputField label="Children Age Range" value={d.children_age_range} onChange={(v) => setDraft({ ...draft, children_age_range: v })} />
            <InputField label="Emergency Contact Name" value={d.emergency_contact_name} onChange={(v) => setDraft({ ...draft, emergency_contact_name: v })} />
            <InputField label="Emergency Contact Phone" value={d.emergency_contact_phone} onChange={(v) => setDraft({ ...draft, emergency_contact_phone: v })} />
          </div>
        </Section>
      )}

      {/* ---- EMPLOYMENT (HR-controlled) ---- */}
      {tab === 'employment' && (
        <Section
          title="Employment Information"
          actions={canEdit && (
            <button onClick={saveEmployment} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          )}
        >
          {!canEdit && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 mb-4">
              <ShieldCheck className="w-4 h-4 inline mr-1" />
              Employment fields are HR-controlled. Only authorized HR/Admin users can edit these fields.
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <InputField label="Employee Code" value={d.employee_code} onChange={(v) => setDraft({ ...draft, employee_code: v })} disabled={!canEdit} />
            <InputField label="Department" value={d.department} onChange={(v) => setDraft({ ...draft, department: v })} disabled={!canEdit} />
            <InputField label="Position" value={d.position} onChange={(v) => setDraft({ ...draft, position: v })} disabled={!canEdit} />
            <div>
              <label className={labelCls}>Employment Status</label>
              <select className={`${inputCls} ${!canEdit ? 'bg-slate-50 text-slate-500' : ''}`} value={d.employment_status || 'onboarding'} onChange={setD('employment_status')} disabled={!canEdit}>
                {['onboarding', 'active', 'probation', 'on_leave', 'terminated', 'suspended', 'inactive'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <InputField label="Employment Type" value={d.employment_type} onChange={(v) => setDraft({ ...draft, employment_type: v })} disabled={!canEdit} />
            <InputField label="Hire Date" value={d.hire_date} onChange={(v) => setDraft({ ...draft, hire_date: v })} type="date" disabled={!canEdit} />
            <InputField label="Salary" value={d.salary} onChange={(v) => setDraft({ ...draft, salary: v })} type="number" disabled={!canEdit} />
            <InputField label="Basic Salary" value={d.basic_salary} onChange={(v) => setDraft({ ...draft, basic_salary: v })} type="number" disabled={!canEdit} />
            <InputField label="Allowances" value={d.allowances} onChange={(v) => setDraft({ ...draft, allowances: v })} type="number" disabled={!canEdit} />
            <InputField label="HMO" value={d.hmo} onChange={(v) => setDraft({ ...draft, hmo: v })} disabled={!canEdit} />
            <InputField label="Branch" value={d.branch} onChange={(v) => setDraft({ ...draft, branch: v })} disabled={!canEdit} />
            <InputField label="Branch Manager" value={d.branch_manager_name} onChange={(v) => setDraft({ ...draft, branch_manager_name: v })} disabled={!canEdit} />
            <InputField label="Area Manager" value={d.area_manager_name} onChange={(v) => setDraft({ ...draft, area_manager_name: v })} disabled={!canEdit} />
            <InputField label="Bank Name" value={d.bank_name} onChange={(v) => setDraft({ ...draft, bank_name: v })} disabled={!canEdit} />
            <InputField label="Account Number" value={d.account_number} onChange={(v) => setDraft({ ...draft, account_number: v })} disabled={!canEdit} />
            <InputField label="Account Name" value={d.account_name} onChange={(v) => setDraft({ ...draft, account_name: v })} disabled={!canEdit} />
            <InputField label="Bank Sort Code" value={d.bank_sort_code} onChange={(v) => setDraft({ ...draft, bank_sort_code: v })} disabled={!canEdit} />
            <InputField label="BVN" value={d.bvn} onChange={(v) => setDraft({ ...draft, bvn: v })} disabled={!canEdit} />
            <InputField label="NIN" value={d.nin} onChange={(v) => setDraft({ ...draft, nin: v })} disabled={!canEdit} />
            <InputField label="Pension ID" value={d.pension_id} onChange={(v) => setDraft({ ...draft, pension_id: v })} disabled={!canEdit} />
            <InputField label="Tax ID" value={d.tax_id} onChange={(v) => setDraft({ ...draft, tax_id: v })} disabled={!canEdit} />
            <InputField label="NHF ID" value={d.nhf_id} onChange={(v) => setDraft({ ...draft, nhf_id: v })} disabled={!canEdit} />
          </div>
        </Section>
      )}

      {/* ---- DOCUMENTS ---- */}
      {tab === 'documents' && (
        <>
          <Section title="Employee Documents">
            {docs.length === 0 && <EmptyState title="No employee documents" description="Uploaded onboarding documents will appear here." />}
            {docs.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {docs.map((doc) => (
                  <li key={doc.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{doc.file_name}</div>
                      <div className="text-xs text-slate-400">{doc.document_type} · {date(doc.uploaded_at)}</div>
                    </div>
                    {status(doc.verification_status, ['verified'])}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {guarantorDocs.length > 0 && (
            <Section title="Guarantor Documents">
              <ul className="divide-y divide-slate-100">
                {guarantorDocs.map((doc) => (
                  <li key={doc.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{doc.file_name}</div>
                      <div className="text-xs text-slate-400">{doc.document_type.replace(/_/g, ' ')} · {date(doc.created_at)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {status(doc.status, ['verified'])}
                      <button
                        onClick={async () => {
                          try {
                            const url = await guarantorVerificationService.getSignedUrl(doc.file_path)
                            window.open(url, '_blank')
                          } catch { /* ignore */ }
                        }}
                        className="text-xs text-[#009944] hover:underline"
                      >View</button>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Certificates & Qualifications">
            {docs.filter(d => d.document_type?.toLowerCase().includes('certificate') || d.document_type?.toLowerCase().includes('qualification')).length === 0 && (
              <EmptyState title="No certificates uploaded" description="Certificate documents will appear here." />
            )}
            <ul className="divide-y divide-slate-100">
              {docs.filter(d => d.document_type?.toLowerCase().includes('certificate') || d.document_type?.toLowerCase().includes('qualification')).map((doc) => (
                <li key={doc.id} className="py-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-slate-800">{doc.file_name}</div>
                    <div className="text-xs text-slate-400">{doc.document_type} · {date(doc.uploaded_at)}</div>
                  </div>
                  {status(doc.verification_status, ['verified'])}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      {/* ---- ONBOARDING ---- */}
      {tab === 'onboarding' && (
        <Section title="Onboarding Information">
          {!onboardingSub ? (
            <EmptyState title="No onboarding record" description="This employee was not created through the onboarding flow." />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Status</div>
                  <div className="text-sm font-medium mt-0.5">{status(onboardingSub.status, ['approved'])}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Onboarding Status</div>
                  <div className="text-sm font-medium mt-0.5">{onboardingSub.onboarding_status || '—'}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Submitted</div>
                  <div className="text-sm font-medium mt-0.5">{date(onboardingSub.created_at)}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Reviewed</div>
                  <div className="text-sm font-medium mt-0.5">{date(onboardingSub.reviewed_at)}</div>
                </div>
              </div>
              {onboardingSub.review_comments && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <span className="font-medium">Review Comments:</span> {onboardingSub.review_comments}
                </div>
              )}
              {onboardingSub.payload && (
                <div>
                  <h4 className="font-medium text-slate-800 mb-2 text-sm">Submitted Data</h4>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 max-h-64 overflow-y-auto">
                    <pre className="text-xs text-slate-600 whitespace-pre-wrap">
                      {JSON.stringify(onboardingSub.payload, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {/* ---- GUARANTOR ---- */}
      {tab === 'guarantors' && (
        <>
          {verifications.length > 0 && (
            <Section title="Guarantor Verifications">
              <div className="space-y-3">
                {verifications.map((v) => (
                  <div key={v.id} className="rounded-lg border border-slate-200 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <span className="text-sm font-medium text-slate-800">{v.guarantor_name}</span>
                        <span className="text-xs text-slate-400 ml-2">{v.guarantor_email}</span>
                      </div>
                      {status(v.status, ['approved'])}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                      <div><span className="text-xs text-slate-400">Relationship: </span><span className="text-slate-700">{v.guarantor_relationship || '—'}</span></div>
                      <div><span className="text-xs text-slate-400">Submitted: </span><span className="text-slate-700">{date(v.submitted_at)}</span></div>
                      <div><span className="text-xs text-slate-400">Reviewed: </span><span className="text-slate-700">{date(v.reviewed_at)}</span></div>
                      <div><span className="text-xs text-slate-400">HR Comments: </span><span className="text-slate-700">{v.hr_comments || '—'}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section title="Guarantors">
            {childrenData.employee_guarantors?.length === 0 && <EmptyState title="No guarantors recorded" />}
            <ChildList rows={childrenData.employee_guarantors || []} onRemove={(rid) => removeChild('employee_guarantors', rid)} columns={[['full_name', 'Name'], ['phone', 'Phone'], ['relationship', 'Relationship'], ['verification_status', 'Verification']]} />
            {canEdit && (
              <AddRow
                onAdd={(p) => addChild('employee_guarantors', p)}
                columns={[
                  { key: 'full_name', label: 'Full Name *' },
                  { key: 'phone', label: 'Phone' },
                  { key: 'email', label: 'Email' },
                  { key: 'relationship', label: 'Relationship' },
                  { key: 'profession', label: 'Profession' },
                  { key: 'designation', label: 'Designation' },
                  { key: 'business_address', label: 'Business Address' },
                  { key: 'residential_address', label: 'Residential Address' },
                  { key: 'bvn', label: 'BVN' },
                  { key: 'nin', label: 'NIN' },
                ]}
              />
            )}
          </Section>
          <Section title="Fidelity Bond">
            {childrenData.employee_fidelity_bonds?.length === 0 && <EmptyState title="No fidelity bonds recorded" />}
            <ChildList rows={childrenData.employee_fidelity_bonds || []} onRemove={(rid) => removeChild('employee_fidelity_bonds', rid)} columns={[['surety_name', 'Surety'], ['occupation', 'Occupation'], ['relationship', 'Relationship'], ['verification_status', 'Verification']]} />
            {canEdit && (
              <AddRow
                onAdd={(p) => addChild('employee_fidelity_bonds', p)}
                columns={[
                  { key: 'surety_name', label: 'Surety Name *' },
                  { key: 'occupation', label: 'Occupation' },
                  { key: 'email', label: 'Email' },
                  { key: 'phone', label: 'Phone' },
                  { key: 'relationship', label: 'Relationship' },
                  { key: 'address', label: 'Address' },
                  { key: 'bvn', label: 'BVN' },
                  { key: 'nin', label: 'NIN' },
                ]}
              />
            )}
          </Section>
        </>
      )}

      {/* ---- LEAVE ---- */}
      {tab === 'leave' && (
        <Section title={`Leave Requests (${leaveRequests.length})`}>
          {leaveRequests.length === 0 ? (
            <EmptyState title="No leave requests" description="Leave requests submitted by this employee will appear here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">Type</th>
                    <th className="px-4 py-2 font-medium">Start</th>
                    <th className="px-4 py-2 font-medium">End</th>
                    <th className="px-4 py-2 font-medium">Days</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Submitted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {leaveRequests.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2 font-medium">{(r.leave_type || 'annual').replace(/_/g, ' ')}</td>
                      <td className="px-4 py-2">{date(r.start_date)}</td>
                      <td className="px-4 py-2">{date(r.end_date)}</td>
                      <td className="px-4 py-2">{r.days || '—'}</td>
                      <td className="px-4 py-2">{status(r.status, ['approved'])}</td>
                      <td className="px-4 py-2">{date(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* ---- ATTENDANCE ---- */}
      {tab === 'attendance' && (
        <Section title={`Attendance (${attendance.length} records)`}>
          {attendance.length === 0 && <EmptyState title="No attendance records" />}
          {attendance.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Clock In</th>
                    <th className="px-4 py-2 font-medium">Clock Out</th>
                    <th className="px-4 py-2 font-medium">Hours</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {attendance.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2">{date(r.attendance_date)}</td>
                      <td className="px-4 py-2">{r.clock_in ? new Date(r.clock_in).toLocaleTimeString() : '—'}</td>
                      <td className="px-4 py-2">{r.clock_out ? new Date(r.clock_out).toLocaleTimeString() : '—'}</td>
                      <td className="px-4 py-2">{r.work_hours || '—'}</td>
                      <td className="px-4 py-2">{status(r.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* ---- PERFORMANCE ---- */}
      {tab === 'performance' && (
        <>
          <Section title="Appraisals">
            {appraisals.length === 0 ? (
              <EmptyState title="No appraisals recorded" />
            ) : (
              <div className="space-y-3">
                {appraisals.map((a) => (
                  <div key={a.id} className="rounded-lg border border-slate-200 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-sm text-slate-800">{a.appraisal_type} · {a.quarter} {a.appraisal_year}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 capitalize">{(a.overall_rating || '').replace('_', ' ')}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                      {a.reviewer && <div><span className="text-xs text-slate-400">Reviewer: </span><span className="text-slate-700">{a.reviewer}</span></div>}
                      {a.strengths && <div><span className="text-xs text-slate-400">Strengths: </span><span className="text-slate-700">{a.strengths}</span></div>}
                      {a.areas_for_improvement && <div><span className="text-xs text-slate-400">Improvement: </span><span className="text-slate-700">{a.areas_for_improvement}</span></div>}
                      {a.comments && <div><span className="text-xs text-slate-400">Comments: </span><span className="text-slate-700">{a.comments}</span></div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section title="HR Actions">
            <EmployeeHRActions employee={employee} canEdit={canEdit} />
          </Section>
        </>
      )}

      {/* ---- PAYROLL ---- */}
      {tab === 'payroll' && (
        <Section
          title="Payroll"
          actions={canManagePayroll && employee?.employment_status === 'active' && (
            <button onClick={() => setShowAddPayroll(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> Add to Payroll
            </button>
          )}
        >
          {!canReadPayroll ? (
            <EmptyState title="No access" description="You do not have permission to view payroll records." />
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Payroll Eligibility</div>
                  <div className="text-sm font-medium mt-0.5">
                    {['active', 'probation', 'on_leave'].includes(employee?.employment_status)
                      ? <span className="text-emerald-600">Eligible</span>
                      : <span className="text-rose-600">Not eligible</span>}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Employment Status</div>
                  <div className="text-sm font-medium mt-0.5">{status(employee?.employment_status)}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs text-slate-400">Payroll Sessions</div>
                  <div className="text-sm font-medium mt-0.5">{payrollItems.length}</div>
                </div>
              </div>
              {payrollError && <ErrorState message={payrollError} />}
              {payrollSuccess && (
                <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">{payrollSuccess}</div>
              )}
              {payrollItems.length === 0 ? (
                <EmptyState title="No payroll records" description="This employee has not been added to any payroll period." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-left">
                      <tr>
                        <th className="px-4 py-2 font-medium">Period</th>
                        <th className="px-4 py-2 font-medium">Salary</th>
                        <th className="px-4 py-2 font-medium">Allowances</th>
                        <th className="px-4 py-2 font-medium">Deductions</th>
                        <th className="px-4 py-2 font-medium">Net Pay</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {payrollItems.map((r) => (
                        <tr key={r.id}>
                          <td className="px-4 py-2 font-medium">{r.payroll_period}</td>
                          <td className="px-4 py-2">{money(r.salary)}</td>
                          <td className="px-4 py-2">{money(r.allowances)}</td>
                          <td className="px-4 py-2">{money(r.deductions)}</td>
                          <td className="px-4 py-2 font-medium">{money(r.net_pay)}</td>
                          <td className="px-4 py-2">{status(r.status, ['paid'])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Section>
      )}

      {/* ---- QUERIES / DISCIPLINARY ---- */}
      {tab === 'queries' && (
        <Section title="HR Queries & Disciplinary Records">
          {queries.length === 0 ? (
            <EmptyState title="No queries or disciplinary records" description="HR queries and disciplinary records for this employee will appear here." />
          ) : (
            <div className="space-y-3">
              {queries.map((q) => (
                <div key={q.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm text-slate-800">{q.query_title}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">{q.status}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    <div><span className="text-xs text-slate-400">Type: </span><span className="text-slate-700">{q.query_type}</span></div>
                    <div><span className="text-xs text-slate-400">Period: </span><span className="text-slate-700">{q.work_period || '—'}</span></div>
                    {q.description && <div className="col-span-2"><span className="text-xs text-slate-400">Description: </span><span className="text-slate-700">{q.description}</span></div>}
                    {q.response && <div className="col-span-2"><span className="text-xs text-slate-400">Response: </span><span className="text-slate-700">{q.response}</span></div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ---- TRAINING ---- */}
      {tab === 'training' && (
        <Section title="Training & Development">
          <ComingSoon title="Training & Development" description="Training records, certifications, and development plans will be available here once the training module is implemented." />
        </Section>
      )}

      {/* ---- AUDIT ---- */}
      {tab === 'audit' && (
        <Section title="Audit Trail">
          {events.length === 0 ? (
            <EmptyState title="No events recorded" description="Onboarding, verification, and approval events will appear here." />
          ) : (
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="flex items-start gap-3 py-2 border-b border-slate-100">
                  <div className="w-2 h-2 rounded-full bg-[#009944] mt-1.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-slate-700">{e.event_type.replace(/_/g, ' ')}</p>
                    <p className="text-xs text-slate-400">{e.details} — {date(e.created_at)}{e.actor ? ` · ${e.actor}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ---- Payroll Modal ---- */}
      {showAddPayroll && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold text-slate-900">Add to Payroll</h3>
              <button onClick={() => { setShowAddPayroll(false); setPayrollError('') }} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            {payrollError && <div className="mb-4"><ErrorState message={payrollError} /></div>}
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Payroll Period</label>
                <select className={inputCls} value={selectedPeriod} onChange={(e) => setSelectedPeriod(e.target.value)}>
                  <option value="">Select a period…</option>
                  {payrollPeriods.map((p) => <option key={p.id} value={p.period_label}>{p.period_label} ({p.status})</option>)}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setShowAddPayroll(false); setSelectedPeriod(''); setPayrollError('') }} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                <button onClick={addToPayroll} disabled={payrollBusy || !selectedPeriod} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                  {payrollBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Briefcase className="w-4 h-4" />} Add to Payroll
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Photos Modal ---- */}
      {showPhotos && (
        <ProfilePhotoModal
          employee={employee}
          photoUrl={passportUrl}
          onClose={() => setShowPhotos(false)}
          onSaved={async () => {
            const docList = await documentService.list('employee', id).catch(() => [])
            setDocs(docList)
            const passportDoc = docList.find((d) => /passport/i.test(d.document_type))
            if (passportDoc?.file_path) {
              const url = await documentService.getSignedUrl(passportDoc.file_path).catch(() => null)
              if (url) setPassportUrl(url)
            }
            const profPicDoc = docList.find((d) => d.document_type === 'profile_picture')
            if (profPicDoc?.file_path) {
              const url = await documentService.getSignedUrl(profPicDoc.file_path).catch(() => null)
              if (url) setPhotoUrl(url)
            } else {
              setPhotoUrl(passportDoc?.file_path ? passportUrl : null)
            }
            load()
          }}
        />
      )}

      {/* ---- Staff ID Card Modal ---- */}
      {showCard && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-slate-100 rounded-xl w-full max-w-[520px] max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4 no-print">
              <h3 className="text-lg font-semibold text-slate-900">Staff ID Card</h3>
              <div className="flex items-center gap-3">
                <button onClick={() => window.print()} className="inline-flex items-center gap-1 text-sm text-[#009944] hover:underline font-medium">
                  <Printer className="w-4 h-4" /> Print Card
                </button>
                <button onClick={() => window.print()} className="inline-flex items-center gap-1 text-sm text-slate-600 hover:underline font-medium">
                  <Download className="w-4 h-4" /> Download
                </button>
                <button onClick={() => setShowCard(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
              </div>
            </div>
            {recordError && <div className="mb-3"><ErrorState message={recordError} /></div>}

            {canEdit && (
              <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-medium text-slate-800 mb-3">Card Configuration</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Expiry</label>
                    <select className={inputCls} value={cardExpiryMode} onChange={(e) => setCardExpiryMode(e.target.value)}>
                      <option value="date">Set Expiry Date</option>
                      <option value="none">No Expiry</option>
                    </select>
                  </div>
                  {cardExpiryMode === 'date' && (
                    <div>
                      <label className={labelCls}>Expiry Date</label>
                      <input type="date" className={inputCls} value={cardExpiryDate} onChange={(e) => setCardExpiryDate(e.target.value)} />
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>Issue Date</label>
                    <input type="date" className={inputCls} value={cardIssueDate} onChange={(e) => setCardIssueDate(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls}>Issued By</label>
                    <input className={inputCls} value={cardIssuedBy} onChange={(e) => setCardIssuedBy(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls}>Status</label>
                    <select className={inputCls} value={cardStatus} onChange={(e) => setCardStatus(e.target.value)}>
                      <option value="active">Active</option>
                      <option value="replaced">Replaced</option>
                      <option value="expired">Expired</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <button onClick={saveCardConfig} disabled={cardSaving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-60">
                      {cardSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Settings
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl p-5 flex justify-center">
              <StaffIdCard
                employee={employee}
                photoUrl={passportUrl}
                expiryMode={cardExpiryMode}
                expiryDate={cardExpiryDate}
                issueDate={cardIssueDate}
                issuedBy={cardIssuedBy}
                status={cardStatus}
              />
            </div>

            <PrintPortal className="print-idcard">
              <StaffIdCard
                employee={employee}
                photoUrl={passportUrl}
                expiryMode={cardExpiryMode}
                expiryDate={cardExpiryDate}
                issueDate={cardIssueDate}
                issuedBy={cardIssuedBy}
                status={cardStatus}
              />
            </PrintPortal>
          </div>
        </div>
      )}

      {/* ---- Employee Record Print / Download Modal ---- */}
      {showRecord && (
        <div className="fixed inset-0 z-50 bg-black/50 overflow-y-auto p-4">
          <div className="max-w-[900px] mx-auto bg-white rounded-xl shadow-xl no-print sticky top-4 z-10">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-wrap gap-3">
              <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                <FileText className="w-5 h-5 text-[#009944]" /> Employee Personnel Record
              </h3>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={selectAllSections} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50">
                  <CheckCircle2 className="w-4 h-4 text-[#009944]" /> Full Employee File
                </button>
                <button onClick={() => { selectAllSections(); window.print() }} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
                  <Printer className="w-4 h-4" /> Print {recordSections.length === ALL_RECORD_SECTIONS.length ? 'Full Record' : 'Selected'}
                </button>
                <button onClick={() => { selectAllSections(); window.print() }} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50">
                  <Download className="w-4 h-4" /> Download {recordSections.length === ALL_RECORD_SECTIONS.length ? 'Full Record' : 'Selected'} PDF
                </button>
                <button onClick={() => setShowRecord(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
              <p className="text-xs font-medium text-slate-500 mb-2">Select sections to include:</p>
              <div className="flex flex-wrap gap-2">
                {RECORD_SECTIONS.map((s) => {
                  const on = recordSections.includes(s.key)
                  return (
                    <button key={s.key} onClick={() => toggleSection(s.key)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${on ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'}`}>
                      <span className={`w-3 h-3 rounded border flex items-center justify-center ${on ? 'bg-white border-white' : 'border-slate-300'}`}>
                        {on && <CheckCircle2 className="w-3 h-3 text-[#009944]" />}
                      </span>
                      {s.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="max-w-[900px] mx-auto mt-4 bg-white border border-slate-200 rounded-xl overflow-x-auto">
            <EmployeeRecordPrint
              employee={employee}
              education={childrenData.employee_education || []}
              workHistory={childrenData.employee_work_history || []}
              guarantors={childrenData.employee_guarantors || []}
              fidelityBonds={childrenData.employee_fidelity_bonds || []}
              documents={docs}
              verifications={verifications}
              photoUrl={photoUrl}
              payrollItems={payrollItems}
              onboardingSub={onboardingSub}
              leaveRequests={leaveRequests}
              attendance={attendance}
              appraisals={appraisals}
              queries={queries}
              events={events}
              enabledSections={recordSections}
            />
          </div>
          <PrintPortal className="record-print">
            <EmployeeRecordPrint
              employee={employee}
              education={childrenData.employee_education || []}
              workHistory={childrenData.employee_work_history || []}
              guarantors={childrenData.employee_guarantors || []}
              fidelityBonds={childrenData.employee_fidelity_bonds || []}
              documents={docs}
              verifications={verifications}
              photoUrl={photoUrl}
              payrollItems={payrollItems}
              onboardingSub={onboardingSub}
              leaveRequests={leaveRequests}
              attendance={attendance}
              appraisals={appraisals}
              queries={queries}
              events={events}
              enabledSections={recordSections}
            />
          </PrintPortal>
        </div>
      )}
    </div>
  )
}

function ChildList({ rows, onRemove, columns }) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((row) => (
        <li key={row.id} className="py-3 flex items-start justify-between gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1 flex-1">
            {columns.map(([key, label]) => (
              <div key={key} className="text-sm">
                <span className="text-xs text-slate-400">{label}: </span>
                <span className="text-slate-700">{key === 'salary' ? money(row[key]) : row[key] || '—'}</span>
              </div>
            ))}
          </div>
          <button onClick={() => onRemove(row.id)} className="text-rose-500 hover:text-rose-700"><Trash2 className="w-4 h-4" /></button>
        </li>
      ))}
    </ul>
  )
}
