import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Camera, CheckCircle2, CreditCard, Download, FileText, GraduationCap, Loader2, Printer, Save, ShieldCheck , Fingerprint } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import { employeeService } from '../services/employeeService'
import { documentService } from '../services/documentService'
import { supabase } from '../supabaseClient'
import StaffIdCard from '../components/StaffIdCard'
import ProfilePhotoModal from '../components/ProfilePhotoModal'
import PrintPortal from '../components/PrintPortal'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

const READ_ONLY_FIELDS = [
  { label: 'Employee Code', value: 'employee_code' },
  { label: 'Department', value: 'department' },
  { label: 'Position', value: 'position' },
  { label: 'Branch', value: 'branch' },
  { label: 'Branch Manager', value: 'branch_manager_name' },
  { label: 'Area Manager', value: 'area_manager_name' },
  { label: 'Salary', value: 'salary', format: 'currency' },
  { label: 'Allowances', value: 'allowances', format: 'currency' },
  { label: 'Employment Status', value: 'employment_status' },
  { label: 'Hire Date', value: 'hire_date', format: 'date' },
  { label: 'HMO', value: 'hmo' },
  { label: 'Pension ID', value: 'pension_id' },
  { label: 'Tax ID', value: 'tax_id' },
  { label: 'BVN', value: 'bvn' },
  { label: 'NIN', value: 'nin' },
  { label: 'Employee Number', value: 'employee_number' },
  { label: 'Staff ID', value: 'staff_id' },
]

export default function Profile() {
  const { user, profile, name } = useAuth()
  const [employee, setEmployee] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [tab, setTab] = useState('personal')

  const [education, setEducation] = useState([])
  const [guarantors, setGuarantors] = useState([])
  const [fidelityBonds, setFidelityBonds] = useState([])
  const [docs, setDocs] = useState([])
  const [photoUrl, setPhotoUrl] = useState(null)
  const [passportUrl, setPassportUrl] = useState(null)

  const [showCard, setShowCard] = useState(false)
  const [showPhotos, setShowPhotos] = useState(false)
  const [loadingCard, setLoadingCard] = useState(false)
  const [cardError, setCardError] = useState('')

  useEffect(() => {
    const load = async () => {
      if (!user?.id) { setLoading(false); return }
      try {
        const { data: emp } = await supabase
          .from('employees')
          .select('*')
          .eq('user_id', user.id)
          .limit(1)
          .maybeSingle()
        if (emp) {
          setEmployee(emp)
          setDraft(emp)
          // Load child data
          const childData = await employeeService.listChildrenForEmployee(emp.id).catch(() => ({}))
          setEducation(childData.employee_education || [])
          setGuarantors(childData.employee_guarantors || [])
          setFidelityBonds(childData.employee_fidelity_bonds || [])
          // Load documents & passport photo
          const docList = await documentService.list('employee', emp.id).catch(() => [])
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
        }
      } catch {
        // Employee record may not exist yet
      } finally {
        setLoading(false)
      }
    }
    load()
    // Auto-open staff ID card if query param present
    if (window.location.hash.includes('card=1')) setShowCard(true)
  }, [user?.id])

  const openCard = async () => {
    setCardError('')
    // Ensure employee number is assigned before opening the card
    if (employee?.id && !employee.employee_number && !employee.staff_id) {
      setLoadingCard(true)
      try {
        const res = await employeeService.ensureEmployeeNumber(employee.id)
        if (res?.employee_number) setEmployee((prev) => ({ ...prev, ...res }))
      } catch (e) {
        setCardError(e?.message || 'Unable to generate staff ID. Please try again.')
        setLoadingCard(false)
        return
      }
      setLoadingCard(false)
    }
    setShowCard(true)
  }

  const savePersonal = async () => {
    setSaving(true)
    setMessage('')
    try {
      await employeeService.updatePersonalInfo({
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
      })
      setMessage('Personal information updated.')
    } catch (e) {
      setMessage(e?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingState label="Loading profile..." />

  const d = draft
  const hasEmployee = !!employee

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#009944] mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      {/* Header */}
      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-[#FF8C00] text-black flex items-center justify-center text-xl font-semibold">
            {photoUrl ? (
              <img src={photoUrl} alt="Passport" className="w-full h-full object-cover rounded-full" />
            ) : name?.charAt(0)?.toUpperCase() || 'U'}
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-semibold text-slate-900">{name}</h2>
            <p className="text-sm text-slate-500 mt-1">{profile?.role?.replace(/_/g, ' ') || 'Staff'}</p>
            <p className="text-xs text-slate-400 mt-1">{user?.email}</p>
            {employee?.employee_number && (
              <p className="text-xs text-slate-500 mt-1">Employee Number: <span className="font-semibold text-[#009944]">{employee.employee_number}</span></p>
            )}
          </div>
          {hasEmployee && (
            <div className="flex flex-col gap-2">
              <button onClick={openCard} disabled={loadingCard}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border-2 border-[#009944] text-[#009944] text-sm font-medium hover:bg-emerald-50 disabled:opacity-60">
                {loadingCard ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                My Staff ID Card
              </button>
<button
            onClick={() => window.location.hash = '#/biometrics/' + (employee?.id || '')}
            disabled={!employee}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border-2 border-[#009944] text-[#009944] text-sm font-medium hover:bg-emerald-50 disabled:opacity-60">
            <Fingerprint className="w-4 h-4" /> Link Biometrics
          </button>
              <button onClick={() => setShowPhotos(true)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50">
                <Camera className="w-4 h-4" /> Manage Photos
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-3 mb-6">
        {[
          { id: 'personal', label: 'Personal Information' },
          { id: 'employment', label: 'Employment (Read-only)' },
          { id: 'guarantor', label: 'Guarantor (Read-only)' },
          { id: 'education', label: 'Education & Documents' },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border ${tab === t.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-500 border-slate-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Messages */}
      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {cardError && <div className="mb-4"><ErrorState message={cardError} /></div>}
      {message && message.includes('fail') && (
        <div className="mb-4 rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-800">{message}</div>
      )}
      {message && !message.includes('fail') && (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {message}
        </div>
      )}

      {/* Personal Information */}
      {tab === 'personal' && (
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-900">Personal Information</h3>
            <button onClick={savePersonal} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          </div>
          <p className="text-sm text-slate-500 mb-4">You can update your personal contact information below. Employment-related fields (Employee ID, Department, Salary, etc.) are controlled by HR and cannot be changed here.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>Full Name</label>
              <input className={inputCls} value={d.full_name || ''} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input className={inputCls} value={d.email || ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })} type="email" />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input className={inputCls} value={d.phone || ''} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Date of Birth</label>
              <input className={inputCls} value={d.date_of_birth || ''} onChange={(e) => setDraft({ ...draft, date_of_birth: e.target.value })} type="date" />
            </div>
            <div>
              <label className={labelCls}>Sex</label>
              <input className={inputCls} value={d.sex || ''} onChange={(e) => setDraft({ ...draft, sex: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>State of Origin</label>
              <input className={inputCls} value={d.state_of_origin || ''} onChange={(e) => setDraft({ ...draft, state_of_origin: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>LGA</label>
              <input className={inputCls} value={d.lga || ''} onChange={(e) => setDraft({ ...draft, lga: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Town / City</label>
              <input className={inputCls} value={d.town || ''} onChange={(e) => setDraft({ ...draft, town: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Residential Address</label>
              <input className={inputCls} value={d.residential_address || ''} onChange={(e) => setDraft({ ...draft, residential_address: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Religion</label>
              <input className={inputCls} value={d.religion || ''} onChange={(e) => setDraft({ ...draft, religion: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Denomination</label>
              <input className={inputCls} value={d.denomination || ''} onChange={(e) => setDraft({ ...draft, denomination: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Nationality</label>
              <input className={inputCls} value={d.nationality || ''} onChange={(e) => setDraft({ ...draft, nationality: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Marital Status</label>
              <input className={inputCls} value={d.marital_status || ''} onChange={(e) => setDraft({ ...draft, marital_status: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Spouse Name</label>
              <input className={inputCls} value={d.spouse_name || ''} onChange={(e) => setDraft({ ...draft, spouse_name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Spouse Phone</label>
              <input className={inputCls} value={d.spouse_phone || ''} onChange={(e) => setDraft({ ...draft, spouse_phone: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Emergency Contact Name</label>
              <input className={inputCls} value={d.emergency_contact_name || ''} onChange={(e) => setDraft({ ...draft, emergency_contact_name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Emergency Contact Phone</label>
              <input className={inputCls} value={d.emergency_contact_phone || ''} onChange={(e) => setDraft({ ...draft, emergency_contact_phone: e.target.value })} />
            </div>
          </div>
        </div>
      )}

      {/* Employment (Read-only) */}
      {tab === 'employment' && (
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck className="w-5 h-5 text-slate-400" />
            <h3 className="font-semibold text-slate-900">Employment Information (Read-only)</h3>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 mb-4">
            Employment-related fields are controlled by HR. If any of these fields need correction, please contact your HR department.
          </div>
          {!hasEmployee ? (
            <div className="text-center py-8 text-sm text-slate-400">No employee record found for your account.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {READ_ONLY_FIELDS.map((f) => {
                let displayValue = d[f.value]
                if (f.format === 'currency') displayValue = `₦${Number(displayValue || 0).toLocaleString()}`
                else if (f.format === 'date') displayValue = displayValue ? new Date(displayValue).toLocaleDateString() : '—'
                else displayValue = displayValue || '—'
                return (
                  <div key={f.value}>
                    <label className={labelCls}>{f.label}</label>
                    <div className="text-sm text-slate-800 min-h-10 flex items-center border border-transparent rounded-lg px-0.5 bg-slate-50">{displayValue}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Guarantor (Read-only) */}
      {tab === 'guarantor' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="w-5 h-5 text-slate-400" />
              <h3 className="font-semibold text-slate-900">Guarantor Information (Read-only)</h3>
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 mb-4">
              Guarantor information is maintained by HR. Contact your HR department for any corrections.
            </div>
            {guarantors.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-400">No guarantor information on record.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {guarantors.map((g) => (
                  <div key={g.id} className="rounded-lg border border-slate-200 p-4 bg-slate-50">
                    <p className="font-medium text-slate-900">{g.full_name}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-slate-400">Relationship:</span> {g.relationship || '—'}</div>
                      <div><span className="text-slate-400">Phone:</span> {g.phone || '—'}</div>
                      <div><span className="text-slate-400">Email:</span> {g.email || '—'}</div>
                      <div><span className="text-slate-400">Verification:</span> {g.verification_status || 'pending'}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {fidelityBonds.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-900 mb-3">Fidelity Bonds</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {fidelityBonds.map((f) => (
                  <div key={f.id} className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                    <p className="font-medium text-sm text-slate-800">{f.surety_name}</p>
                    <p className="text-xs text-slate-500 mt-1">Relationship: {f.relationship || '—'}</p>
                    <p className="text-xs text-slate-500">Status: {f.verification_status || 'pending'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Education & Documents (Read-only) */}
      {tab === 'education' && (
        <div className="space-y-6">
          {/* Education */}
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <GraduationCap className="w-5 h-5 text-slate-400" />
              <h3 className="font-semibold text-slate-900">Education (Read-only)</h3>
            </div>
            {education.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-400">No education records on file.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-left">
                    <tr>
                      <th className="px-4 py-2 font-medium">Institution</th>
                      <th className="px-4 py-2 font-medium">Level</th>
                      <th className="px-4 py-2 font-medium">Field of Study</th>
                      <th className="px-4 py-2 font-medium">Period</th>
                      <th className="px-4 py-2 font-medium">Class / Degree</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {education.map((e) => (
                      <tr key={e.id}>
                        <td className="px-4 py-2">{e.institution}</td>
                        <td className="px-4 py-2">{e.education_level || '—'}</td>
                        <td className="px-4 py-2">{e.field_of_study || '—'}</td>
                        <td className="px-4 py-2">{e.from_year || '—'} — {e.to_year || '—'}</td>
                        <td className="px-4 py-2">{e.class_degree || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Documents */}
          <div className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5 text-slate-400" />
              <h3 className="font-semibold text-slate-900">Documents (Read-only)</h3>
            </div>
            {docs.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-400">No employee documents on file.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {docs.map((doc) => (
                  <li key={doc.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{doc.file_name}</div>
                      <div className="text-xs text-slate-400">{doc.document_type} · {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : '—'}</div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium
                      ${doc.verification_status === 'verified' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : doc.verification_status === 'rejected' ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                      {doc.verification_status || 'pending'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Photos Modal */}
      {showPhotos && employee && (
        <ProfilePhotoModal
          employee={employee}
          photoUrl={passportUrl}
          onClose={() => setShowPhotos(false)}
          onSaved={async () => {
            const docList = await documentService.list('employee', employee.id).catch(() => [])
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
              setPhotoUrl(passportUrl)
            }
          }}
        />
      )}

      {/* Staff ID Card Modal */}
      {showCard && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-slate-100 rounded-xl max-w-[420px] w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4 no-print">
              <h3 className="text-lg font-semibold text-slate-900">Staff ID Card</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => window.print()} className="inline-flex items-center gap-1 text-sm text-[#009944] hover:underline font-medium"><Printer className="w-4 h-4" /> Print Card</button>
                <button onClick={() => window.print()} className="inline-flex items-center gap-1 text-sm text-slate-600 hover:underline font-medium"><Download className="w-4 h-4" /> Download</button>
                <button onClick={() => setShowCard(false)} className="text-slate-400 hover:text-slate-600">✕</button>
              </div>
            </div>
            {cardError && <div className="mb-3"><ErrorState message={cardError} /></div>}
            <div className="bg-white rounded-xl p-5 flex justify-center">
              <StaffIdCard
                employee={employee}
                photoUrl={passportUrl}
                expiryMode={employee?.staff_id_expiry ? 'date' : 'none'}
                expiryDate={employee?.staff_id_expiry || undefined}
                issueDate={employee?.staff_id_issued_at}
                issuedBy={employee?.staff_id_issued_by || 'Human Resources'}
                status={employee?.staff_id_status || 'active'}
              />
            </div>
            <PrintPortal className="print-idcard">
              <StaffIdCard
                employee={employee}
                photoUrl={passportUrl}
                expiryMode={employee?.staff_id_expiry ? 'date' : 'none'}
                expiryDate={employee?.staff_id_expiry || undefined}
                issueDate={employee?.staff_id_issued_at}
                issuedBy={employee?.staff_id_issued_by || 'Human Resources'}
                status={employee?.staff_id_status || 'active'}
              />
            </PrintPortal>
          </div>
        </div>
      )}
    </div>
  )
}