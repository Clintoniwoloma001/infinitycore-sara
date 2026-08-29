import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import { date, money, status } from './hrShared'
import { employeeService } from '../services/employeeService'
import { attendanceService } from '../services/attendanceService'
import { documentService } from '../services/documentService'

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

function InputField({ label, value, onChange, type }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} value={value || ''} onChange={(e) => onChange(e.target.value)} type={type || 'text'} />
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

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'personal', label: 'Personal' },
  { id: 'employment', label: 'Employment' },
  { id: 'kin', label: 'Next of Kin & Beneficiary' },
  { id: 'education', label: 'Education' },
  { id: 'work', label: 'Work History' },
  { id: 'guarantors', label: 'Guarantors' },
  { id: 'bonds', label: 'Fidelity Bond' },
  { id: 'documents', label: 'Documents' },
  { id: 'attendance', label: 'Attendance' },
]

export default function EmployeeProfile() {
  const { id } = useParams()
  const { hasPermission } = useAuth()
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
      const att = await attendanceService.getHistory(id, 60).catch(() => [])
      setAttendance(att)
    } catch (e) {
      setError(e?.message || 'Unable to load employee profile')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveProfile = async () => {
    setSaving(true)
    setMessage('')
    try {
      const updated = await employeeService.update(id, draft)
      setEmployee(updated)
      setDraft(updated)
      setMessage('Saved.')
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

  if (loading) return <LoadingState label="Loading employee profile..." />
  if (error) return <ErrorState message={error} />

  const d = draft
  const setD = (key) => (e) => setDraft({ ...draft, [key]: e.target.value })

  return (
    <div>
      <Link to="/employees" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944] mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to employees
      </Link>

      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-full bg-[#009944] text-white flex items-center justify-center text-xl font-semibold">
              {employee?.full_name?.charAt(0)?.toUpperCase() || 'E'}
            </div>
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">{employee?.full_name}</h2>
              <p className="text-sm text-slate-500 mt-1">{employee?.position || 'No position'} {employee?.department ? `· ${employee.department}` : ''}</p>
              <div className="flex flex-wrap gap-2 mt-2">
                <span className="text-xs">{status(employee?.employment_status)}</span>
                <span className="text-xs">{employee?.employee_code ? `Code: ${employee.employee_code}` : ''}</span>
              </div>
            </div>
          </div>
          {message && !message.includes('fail') && <span className="text-sm text-emerald-600">{message}</span>}
          {message.includes('fail') && <span className="text-sm text-rose-600">{message}</span>}
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

      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

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
              <Field label="Bank" value={d.bank_name ? `${d.bank_name} ${d.account_number || ''}`.trim() : '—'} />
              <Field label="Pension ID" value={d.pension_id} />
              <Field label="Tax ID" value={d.tax_id} />
            </div>
          </Section>
        </div>
      )}

      {tab === 'personal' && (
        <Section
          title="Personal Information"
          actions={canEdit && (
            <button onClick={saveProfile} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
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
          </div>
        </Section>
      )}

      {tab === 'employment' && (
        <Section
          title="Employment"
          actions={canEdit && (
            <button onClick={saveProfile} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          )}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <InputField label="Employee Code" value={d.employee_code} onChange={(v) => setDraft({ ...draft, employee_code: v })} />
            <InputField label="Department" value={d.department} onChange={(v) => setDraft({ ...draft, department: v })} />
            <InputField label="Position" value={d.position} onChange={(v) => setDraft({ ...draft, position: v })} />
            <div>
              <label className={labelCls}>Employment Status</label>
              <select className={inputCls} value={d.employment_status || 'onboarding'} onChange={setD('employment_status')}>
                {['onboarding', 'active', 'probation', 'on_leave', 'terminated', 'suspended', 'inactive'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <InputField label="Employment Type" value={d.employment_type} onChange={(v) => setDraft({ ...draft, employment_type: v })} />
            <InputField label="Hire Date" value={d.hire_date} onChange={(v) => setDraft({ ...draft, hire_date: v })} type="date" />
            <InputField label="Salary" value={d.salary} onChange={(v) => setDraft({ ...draft, salary: v })} type="number" />
            <InputField label="Branch" value={d.branch} onChange={(v) => setDraft({ ...draft, branch: v })} />
            <InputField label="Bank Name" value={d.bank_name} onChange={(v) => setDraft({ ...draft, bank_name: v })} />
            <InputField label="Account Number" value={d.account_number} onChange={(v) => setDraft({ ...draft, account_number: v })} />
            <InputField label="BVN" value={d.bvn} onChange={(v) => setDraft({ ...draft, bvn: v })} />
            <InputField label="NIN" value={d.nin} onChange={(v) => setDraft({ ...draft, nin: v })} />
            <InputField label="Pension ID" value={d.pension_id} onChange={(v) => setDraft({ ...draft, pension_id: v })} />
            <InputField label="Tax ID" value={d.tax_id} onChange={(v) => setDraft({ ...draft, tax_id: v })} />
          </div>
        </Section>
      )}

      {tab === 'kin' && (
        <Section
          title="Next of Kin & Beneficiary"
          actions={canEdit && (
            <button onClick={saveProfile} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          )}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <InputField label="Next of Kin Name" value={d.next_of_kin_name} onChange={(v) => setDraft({ ...draft, next_of_kin_name: v })} />
            <InputField label="Next of Kin Relationship" value={d.next_of_kin_relationship} onChange={(v) => setDraft({ ...draft, next_of_kin_relationship: v })} />
            <InputField label="Next of Kin Phone" value={d.next_of_kin_phone} onChange={(v) => setDraft({ ...draft, next_of_kin_phone: v })} />
            <InputField label="Next of Kin Address" value={d.next_of_kin_address} onChange={(v) => setDraft({ ...draft, next_of_kin_address: v })} />
            <InputField label="Beneficiary Name" value={d.beneficiary_name} onChange={(v) => setDraft({ ...draft, beneficiary_name: v })} />
            <InputField label="Beneficiary Relationship" value={d.beneficiary_relationship} onChange={(v) => setDraft({ ...draft, beneficiary_relationship: v })} />
            <InputField label="Beneficiary Phone" value={d.beneficiary_phone} onChange={(v) => setDraft({ ...draft, beneficiary_phone: v })} />
            <InputField label="Beneficiary Address" value={d.beneficiary_address} onChange={(v) => setDraft({ ...draft, beneficiary_address: v })} />
            <InputField label="Emergency Contact" value={d.emergency_contact_name} onChange={(v) => setDraft({ ...draft, emergency_contact_name: v })} />
            <InputField label="Emergency Phone" value={d.emergency_contact_phone} onChange={(v) => setDraft({ ...draft, emergency_contact_phone: v })} />
          </div>
        </Section>
      )}

      {tab === 'education' && (
        <Section title="Education">
          {childrenData.employee_education?.length === 0 && <EmptyState title="No education records" />}
          <ChildList rows={childrenData.employee_education || []} onRemove={(rid) => removeChild('employee_education', rid)} columns={[['institution', 'Institution'], ['education_level', 'Level'], ['field_of_study', 'Field'], ['from_year', 'From'], ['to_year', 'To']]} />
          {canEdit && (
            <AddRow
              onAdd={(p) => addChild('employee_education', p)}
              columns={[
                { key: 'institution', label: 'Institution *' },
                { key: 'education_level', label: 'Level' },
                { key: 'from_year', label: 'From Year', type: 'number' },
                { key: 'to_year', label: 'To Year', type: 'number' },
                { key: 'field_of_study', label: 'Field of Study' },
                { key: 'class_degree', label: 'Class / Degree' },
              ]}
            />
          )}
        </Section>
      )}

      {tab === 'work' && (
        <Section title="Work History">
          {childrenData.employee_work_history?.length === 0 && <EmptyState title="No work history records" />}
          <ChildList rows={childrenData.employee_work_history || []} onRemove={(rid) => removeChild('employee_work_history', rid)} columns={[['company_name', 'Company'], ['position', 'Position'], ['start_date', 'Start'], ['end_date', 'End'], ['salary', 'Salary']]} />
          {canEdit && (
            <AddRow
              onAdd={(p) => addChild('employee_work_history', p)}
              columns={[
                { key: 'company_name', label: 'Company *' },
                { key: 'position', label: 'Position' },
                { key: 'company_address', label: 'Company Address' },
                { key: 'company_email', label: 'Company Email' },
                { key: 'duties', label: 'Duties' },
                { key: 'salary', label: 'Salary', type: 'number' },
                { key: 'supervisor_name', label: 'Supervisor' },
                { key: 'start_date', label: 'Start Date', type: 'date' },
                { key: 'end_date', label: 'End Date', type: 'date' },
                { key: 'reason_for_leaving', label: 'Reason for Leaving' },
              ]}
            />
          )}
        </Section>
      )}

      {tab === 'guarantors' && (
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
      )}

      {tab === 'bonds' && (
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
      )}

      {tab === 'documents' && (
        <Section title="Documents">
          {docs.length === 0 && <EmptyState title="No documents" description="Uploaded onboarding documents will appear here." />}
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
      )}

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