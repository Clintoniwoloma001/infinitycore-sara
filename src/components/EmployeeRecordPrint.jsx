import React from 'react'
import Logo from './Logo'

// ------------------------------------------------------------------
// Employee Personnel Record — A4 printable HR document.
//
// Rendered into a body-level print portal so it flows across multiple
// pages. Every field lives in a wrapping container (label + value) with
// `min-width:0` + `overflow-wrap:anywhere` so long values (emails,
// phone numbers, addresses, job titles) wrap instead of colliding.
//
// `enabledSections` controls which sections are emitted so HR can print
// the Full Employee File or selected sections only.
// ------------------------------------------------------------------

export const RECORD_SECTIONS = [
  { key: 'personal', label: 'Personal' },
  { key: 'employment', label: 'Employment' },
  { key: 'nextOfKin', label: 'Next of Kin' },
  { key: 'education', label: 'Education' },
  { key: 'documents', label: 'Documents' },
  { key: 'guarantor', label: 'Guarantor' },
  { key: 'fidelity', label: 'Fidelity Bond' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'onboarding', label: 'Onboarding' },
  { key: 'leave', label: 'Leave' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'performance', label: 'Performance' },
  { key: 'queries', label: 'Queries / Disciplinary' },
  { key: 'audit', label: 'Audit' },
]

export const ALL_RECORD_SECTIONS = RECORD_SECTIONS.map((s) => s.key)

const fmtDate = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-GB')
}
const fmtDateTime = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString('en-GB')
}
const fmtMoney = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? `₦${Number(v).toLocaleString()}` : '—')

function Field({ label, value, className = '' }) {
  return (
    <div className={`record-field ${className}`}>
      <p className="record-field-label">{label}</p>
      <p className="record-field-value">{value == null || value === '' || value === 'null' ? '—' : value}</p>
    </div>
  )
}

function SectionTitle({ title, number }) {
  return (
    <div className="record-section-title">
      <span className="record-section-badge">{number}</span>
      <h3 className="record-section-heading">{title}</h3>
    </div>
  )
}

function SignatureBlock({ label, src }) {
  return (
    <div className="record-signature">
      {src ? (
        <img src={src} alt={label} className="record-signature-img" />
      ) : (
        <span className="text-[11px] italic text-slate-400">Not signed</span>
      )}
      <div className="w-full h-px bg-slate-300 mt-1" />
      <p className="record-field-label mt-1">{label}</p>
    </div>
  )
}

function NoData({ label }) {
  return <p className="text-xs text-slate-400 italic">{label || 'No records available.'}</p>
}

export default function EmployeeRecordPrint({
  employee = {},
  education = [],
  workHistory = [],
  guarantors = [],
  fidelityBonds = [],
  documents = [],
  verifications = [],
  photoUrl = null,
  payrollItems = [],
  onboardingSub = null,
  leaveRequests = [],
  attendance = [],
  appraisals = [],
  queries = [],
  events = [],
  enabledSections = ALL_RECORD_SECTIONS,
}) {
  const emp = employee
  const enabled = (key) => enabledSections.includes(key)
  const photo = photoUrl || emp.photo_url || null
  const initials = (emp.full_name || 'E').split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join('')
  const generatedAt = new Date().toLocaleString('en-GB')
  const recordId = emp.employee_number || emp.employee_code || emp.id?.slice(0, 8) || 'N/A'
  const officialId = emp.employee_number || emp.staff_id || emp.employee_code || '—'
  const onboardingStatus = onboardingSub?.onboarding_status || onboardingSub?.status || null
  const checklist = onboardingSub?.payload || {}

  const sectionCount = RECORD_SECTIONS.filter((s) => enabled(s.key)).length
  let sectionNumber = 0

  return (
    <div className="record-doc">
      {/* ============ HEADER ============ */}
      <div className="record-header">
        <div className="flex items-center gap-3 min-w-0">
          <Logo size={46} variant="full" />
          <div className="min-w-0">
            <h1 className="record-title">Employee Personnel Record</h1>
            <p className="record-subtitle">Infinity Bank · InfinityCore HR</p>
          </div>
        </div>
        <div className="record-head-meta">
          <div className="record-photo-frame">
            {photo ? (
              <img src={photo} alt="Passport" className="record-photo" />
            ) : (
              <div className="w-full h-full bg-slate-50 flex items-center justify-center">
                <span className="text-xl font-bold text-[#009944]">{initials || '—'}</span>
              </div>
            )}
          </div>
          <div className="space-y-0.5 text-left">
            <div className="record-meta"><span>Record ID:</span> <strong>{recordId}</strong></div>
            <div className="record-meta"><span>Generated:</span> <strong>{generatedAt}</strong></div>
            <div className="record-meta"><span>Generated By:</span> <strong>InfinityCore HR</strong></div>
            <div className="record-meta"><span>Sections:</span> <strong>{sectionCount}</strong></div>
          </div>
        </div>
      </div>

      {/* ============ COVER / EMPLOYEE SUMMARY ============ */}
      {enabled('personal') && (
        <section className="record-section">
          <SectionTitle title="Employee Summary" number={++sectionNumber} />
          <div className="record-summary">
            <div className="record-summary-identity min-w-0">
              <p className="record-summary-name">{emp.full_name || '—'}</p>
              <p className="text-xs text-slate-500">{emp.position || emp.job_title || ''}</p>
              <div className="mt-2 space-y-0.5">
                <div className="record-meta"><span>Official Staff ID:</span> <strong className="text-[#009944]">{officialId}</strong></div>
                {emp.employee_code && <div className="record-meta"><span>Employee Code:</span> <strong>{emp.employee_code}</strong></div>}
                {emp.department && <div className="record-meta"><span>Department:</span> <strong>{emp.department}</strong></div>}
                {emp.branch && <div className="record-meta"><span>Branch:</span> <strong>{emp.branch}</strong></div>}
                {emp.employment_status && <div className="record-meta"><span>Status:</span> <strong>{emp.employment_status}</strong></div>}
                {emp.hire_date && <div className="record-meta"><span>Date Joined:</span> <strong>{fmtDate(emp.hire_date)}</strong></div>}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ============ 1. PERSONAL ============ */}
      {enabled('personal') && (
        <section className="record-section">
          <SectionTitle title="Personal Information" number={++sectionNumber} />
          <div className="record-grid">
            <Field label="Full Name" value={emp.full_name} />
            <Field label="Preferred Name" value={emp.preferred_name} />
            <Field label="Email" value={emp.email} />
            <Field label="Phone" value={emp.phone} />
            <Field label="Date of Birth" value={emp.date_of_birth ? fmtDate(emp.date_of_birth) : emp.date_of_birth} />
            <Field label="Sex" value={emp.sex || emp.gender} />
            <Field label="Nationality" value={emp.nationality} />
            <Field label="State of Origin" value={emp.state_of_origin} />
            <Field label="LGA" value={emp.lga} />
            <Field label="Town / City" value={emp.town || emp.town_city} />
            <Field label="Residential Address" value={emp.residential_address} className="col-span-2" />
            <Field label="Religion" value={emp.religion} />
            <Field label="Denomination" value={emp.denomination} />
            <Field label="Marital Status" value={emp.marital_status} />
            <Field label="Spouse Name" value={emp.spouse_name} />
            <Field label="Spouse Occupation" value={emp.spouse_occupation} />
            <Field label="Number of Children" value={emp.number_of_children} />
            <Field label="Children Age Range" value={emp.children_age_range} />
            <Field label="Residing With Spouse" value={emp.living_with_spouse} />
          </div>
        </section>
      )}

      {/* ============ 2. EMPLOYMENT / HR ============ */}
      {enabled('employment') && (
        <section className="record-section">
          <SectionTitle title="Employment / HR Record" number={++sectionNumber} />
          <div className="record-grid">
            <Field label="Employee Number" value={emp.employee_number} />
            <Field label="Staff ID" value={emp.staff_id} />
            <Field label="Employee Code" value={emp.employee_code} />
            <Field label="Department" value={emp.department} />
            <Field label="Position" value={emp.position || emp.job_title} />
            <Field label="Employment Status" value={emp.employment_status} />
            <Field label="Employment Type" value={emp.employment_type} />
            <Field label="Hire Date" value={fmtDate(emp.hire_date)} />
            <Field label="Confirmation Date" value={fmtDate(emp.confirmation_date)} />
            <Field label="Probation End Date" value={fmtDate(emp.probation_end_date)} />
            <Field label="Work Location" value={emp.work_location} />
            <Field label="Area" value={emp.area} />
            <Field label="Salary" value={fmtMoney(emp.salary)} />
            <Field label="Basic Salary" value={fmtMoney(emp.basic_salary)} />
            <Field label="Allowances" value={fmtMoney(emp.allowances)} />
            <Field label="HMO" value={emp.hmo} />
            <Field label="Branch" value={emp.branch} />
            <Field label="Branch Manager" value={emp.branch_manager_name} />
            <Field label="Area Manager" value={emp.area_manager_name} />
            <Field label="Bank Name" value={emp.bank_name} />
            <Field label="Account Number" value={emp.account_number} />
            <Field label="Account Name" value={emp.account_name} />
            <Field label="Bank Sort Code" value={emp.bank_sort_code} />
            <Field label="BVN" value={emp.bvn} />
            <Field label="NIN" value={emp.nin} />
            <Field label="Pension ID" value={emp.pension_id} />
            <Field label="Tax ID" value={emp.tax_id} />
            <Field label="NHF ID" value={emp.nhf_id} />
          </div>
        </section>
      )}

      {/* ============ 3. NEXT OF KIN / EMERGENCY ============ */}
      {enabled('nextOfKin') && (
        <section className="record-section">
          <SectionTitle title="Next of Kin & Emergency Contacts" number={++sectionNumber} />
          <div className="record-grid">
            <Field label="Next of Kin Name" value={emp.next_of_kin_name} />
            <Field label="Relationship" value={emp.next_of_kin_relationship} />
            <Field label="Next of Kin Phone" value={emp.next_of_kin_phone} />
            <Field label="Next of Kin Address" value={emp.next_of_kin_address} className="col-span-2" />
            <Field label="Beneficiary Name" value={emp.beneficiary_name} />
            <Field label="Beneficiary Relationship" value={emp.beneficiary_relationship} />
            <Field label="Beneficiary Phone" value={emp.beneficiary_phone} />
            <Field label="Beneficiary Address" value={emp.beneficiary_address} className="col-span-2" />
            <Field label="Emergency Contact Name" value={emp.emergency_contact_name} />
            <Field label="Emergency Contact Phone" value={emp.emergency_contact_phone} />
          </div>
        </section>
      )}

      {/* ============ 4. EDUCATION ============ */}
      {enabled('education') && (
        <section className="record-section">
          <SectionTitle title="Education & Qualifications" number={++sectionNumber} />
          {education.length === 0 ? (
            <NoData label="No education records provided." />
          ) : (
            <table className="record-table">
              <thead>
                <tr>
                  <th>Institution</th>
                  <th>Level</th>
                  <th>Field of Study</th>
                  <th>Period</th>
                  <th>Class / Degree</th>
                </tr>
              </thead>
              <tbody>
                {education.map((e) => (
                  <tr key={e.id}>
                    <td>{e.institution || '—'}</td>
                    <td>{e.education_level || '—'}</td>
                    <td>{e.field_of_study || e.course || '—'}</td>
                    <td>{e.from_year || '—'} — {e.to_year || '—'}</td>
                    <td>{e.class_degree || e.grade || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {workHistory.length > 0 && (
            <>
              <h4 className="record-subtitle-list">Work History</h4>
              <table className="record-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Position</th>
                    <th>Period</th>
                    <th>Reason for Leaving</th>
                  </tr>
                </thead>
                <tbody>
                  {workHistory.map((w) => (
                    <tr key={w.id}>
                      <td>{w.company_name || '—'}</td>
                      <td>{w.position || '—'}</td>
                      <td>{fmtDate(w.start_date)} — {fmtDate(w.end_date)}</td>
                      <td>{w.reason_for_leaving || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {/* ============ 5. DOCUMENTS ============ */}
      {enabled('documents') && (
        <section className="record-section">
          <SectionTitle title="Documents & Supporting Records" number={++sectionNumber} />
          {documents.length === 0 ? (
            <NoData label="No documents on file." />
          ) : (
            <table className="record-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Document</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d, i) => (
                  <tr key={d.id}>
                    <td>{i + 1}</td>
                    <td>{d.file_name || '—'}</td>
                    <td>{d.document_type || '—'}</td>
                    <td>{d.verification_status || 'pending'}</td>
                    <td>{fmtDate(d.uploaded_at || d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ============ 6. GUARANTOR ============ */}
      {enabled('guarantor') && (
        <section className="record-section">
          <SectionTitle title="Guarantor Details" number={++sectionNumber} />
          {verifications.length === 0 && guarantors.length === 0 ? (
            <NoData label="No guarantor information on file." />
          ) : (
            <>
              {verifications.map((v) => (
                <div key={v.id} className="avoid-break record-box">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold text-sm text-slate-800">{v.guarantor_name || '—'}</p>
                    <span className={`record-pill ${v.status === 'approved' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : v.status === 'rejected' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                      {v.status?.replace(/_/g, ' ') || 'pending'}
                    </span>
                  </div>
                  <div className="record-grid">
                    <Field label="Relationship" value={v.guarantor_relationship || v.relationship} />
                    <Field label="Email" value={v.guarantor_email || v.email} />
                    <Field label="Phone" value={v.guarantor_phone || v.phone} />
                    <Field label="Occupation" value={v.occupation || v.guarantor_occupation} />
                    <Field label="Employer" value={v.employer || v.guarantor_employer} />
                    <Field label="Residential Address" value={v.address || v.guarantor_address} className="col-span-2" />
                    <Field label="Verification Date" value={fmtDateTime(v.verified_at || v.submitted_at)} />
                    <Field label="Submitted Documents" value={(v.document_count || 0) > 0 ? `${v.document_count} document(s)` : 'None'} />
                  </div>
                  {v.signature_url && <SignatureBlock label={`${v.guarantor_name || 'Guarantor'}'s Signature`} src={v.signature_url} />}
                </div>
              ))}
              {guarantors.map((g) => (
                <div key={g.id} className="avoid-break record-box">
                  <p className="font-semibold text-sm text-slate-800">{g.full_name || '—'}</p>
                  <div className="record-grid">
                    <Field label="Relationship" value={g.relationship} />
                    <Field label="Phone" value={g.phone} />
                    <Field label="Email" value={g.email} />
                    <Field label="Occupation" value={g.occupation} />
                    <Field label="Employer" value={g.employer} />
                    <Field label="Address" value={g.address} className="col-span-2" />
                    <Field label="Verification Status" value={g.verification_status} />
                    <Field label="Expected Guarantor" value={emp.expected_guarantor_name || emp.expected_guarantor || '—'} />
                    {g.verification_status && <Field label="Verification" value={g.verification_status} />}
                  </div>
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {/* ============ 7. FIDELITY BOND ============ */}
      {enabled('fidelity') && (
        <section className="record-section">
          <SectionTitle title="Fidelity Bond" number={++sectionNumber} />
          {fidelityBonds.length === 0 ? (
            <NoData label="No fidelity bond on file." />
          ) : (
            fidelityBonds.map((f) => (
              <div key={f.id} className="avoid-break record-box">
                <p className="font-semibold text-sm text-slate-800">{f.surety_name || f.bond_type || 'Fidelity Bond'}</p>
                <div className="record-grid">
                  <Field label="Bond Type" value={f.bond_type} />
                  <Field label="Bond Amount" value={fmtMoney(f.bond_amount)} />
                  <Field label="Surety Name" value={f.surety_name} />
                  <Field label="Relationship" value={f.relationship} />
                  <Field label="Status" value={f.status} />
                  <Field label="Verification Status" value={f.verification_status} />
                  <Field label="Date Issued" value={fmtDate(f.issued_at || f.created_at)} />
                  <Field label="Effective Date" value={fmtDate(f.effective_date)} />
                  <Field label="Expiry Date" value={fmtDate(f.expiry_date)} />
                </div>
                {f.signature_url && <SignatureBlock label={`${f.surety_name || 'Surety'}'s Signature`} src={f.signature_url} />}
              </div>
            ))
          )}
        </section>
      )}

      {/* ============ 8. PAYROLL ============ */}
      {enabled('payroll') && (
        <section className="record-section">
          <SectionTitle title="Payroll" number={++sectionNumber} />
          <div className="record-grid">
            <Field label="Salary" value={fmtMoney(emp.salary)} />
            <Field label="Basic Salary" value={fmtMoney(emp.basic_salary)} />
            <Field label="Allowances" value={fmtMoney(emp.allowances)} />
            <Field label="Bank Name" value={emp.bank_name} />
            <Field label="Account Number" value={emp.account_number} />
            <Field label="Pension ID" value={emp.pension_id} />
            <Field label="Tax ID" value={emp.tax_id} />
            <Field label="NHF ID" value={emp.nhf_id} />
          </div>
          {payrollItems.length > 0 && (
            <table className="record-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Salary</th>
                  <th>Allowances</th>
                  <th>Deductions</th>
                  <th>Net Pay</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payrollItems.map((r) => (
                  <tr key={r.id}>
                    <td>{r.payroll_period || '—'}</td>
                    <td>{fmtMoney(r.salary)}</td>
                    <td>{fmtMoney(r.allowances)}</td>
                    <td>{fmtMoney(r.deductions)}</td>
                    <td>{fmtMoney(r.net_pay)}</td>
                    <td>{r.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ============ 9. ONBOARDING ============ */}
      {enabled('onboarding') && (
        <section className="record-section">
          <SectionTitle title="Onboarding" number={++sectionNumber} />
          {!onboardingSub ? (
            <NoData label="No onboarding submission on file." />
          ) : (
            <div className="record-grid">
              <Field label="Onboarding Status" value={onboardingStatus} />
              <Field label="Review Status" value={onboardingSub.status} />
              <Field label="Submitted At" value={fmtDateTime(onboardingSub.created_at)} />
              <Field label="Reviewed At" value={fmtDateTime(onboardingSub.reviewed_at)} />
              <Field label="Review Comments" value={onboardingSub.review_comments} className="col-span-2" />
              <Field label="Guarantor Status" value={verifications.length ? verifications.map((v) => v.status).join(', ') : 'pending'} />
              <Field label="Fidelity Bond Status" value={fidelityBonds.length ? fidelityBonds.map((f) => f.status || f.verification_status).join(', ') : 'pending'} />
            </div>
          )}
          {checklist && typeof checklist === 'object' && Object.keys(checklist).length > 0 && (
            <div className="mt-3">
              <p className="record-field-label">Onboarding Checklist Status</p>
              <p className="text-xs text-slate-600 break-words">{JSON.stringify(checklist, null, 2)}</p>
            </div>
          )}
        </section>
      )}

      {/* ============ 10. LEAVE ============ */}
      {enabled('leave') && (
        <section className="record-section">
          <SectionTitle title="Leave" number={++sectionNumber} />
          {leaveRequests.length === 0 ? (
            <NoData label="No leave requests recorded." />
          ) : (
            <table className="record-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Days</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {leaveRequests.map((l) => (
                  <tr key={l.id}>
                    <td>{l.leave_type || '—'}</td>
                    <td>{fmtDate(l.start_date)}</td>
                    <td>{fmtDate(l.end_date)}</td>
                    <td>{l.days || l.number_of_days || '—'}</td>
                    <td>{l.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ============ 11. ATTENDANCE ============ */}
      {enabled('attendance') && (
        <section className="record-section">
          <SectionTitle title="Attendance Summary" number={++sectionNumber} />
          {attendance.length === 0 ? (
            <NoData label="No attendance records within the recent window." />
          ) : (
            <table className="record-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Clock In</th>
                  <th>Clock Out</th>
                  <th>Hours</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {attendance.slice(0, 50).map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.work_date || r.date || r.clock_in)}</td>
                    <td>{r.clock_in ? new Date(r.clock_in).toLocaleTimeString('en-GB') : '—'}</td>
                    <td>{r.clock_out ? new Date(r.clock_out).toLocaleTimeString('en-GB') : '—'}</td>
                    <td>{r.work_hours ?? r.hours ?? '—'}</td>
                    <td>{r.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ============ 12. PERFORMANCE ============ */}
      {enabled('performance') && (
        <section className="record-section">
          <SectionTitle title="Performance / Appraisals" number={++sectionNumber} />
          {appraisals.length === 0 ? (
            <NoData label="No appraisal records." />
          ) : (
            appraisals.map((a) => (
              <div key={a.id} className="avoid-break record-box">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-sm text-slate-800">{a.period || 'Appraisal'}</p>
                  <span className="record-pill bg-blue-50 text-blue-700 border-blue-200">{a.status || 'pending'}</span>
                </div>
                <div className="record-grid">
                  <Field label="Score" value={a.score ?? a.rating} />
                  <Field label="Reviewed By" value={a.reviewer_name || a.reviewed_by} />
                  <Field label="Summary" value={a.summary || a.comments} className="col-span-2" />
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {/* ============ 13. QUERIES / DISCIPLINARY ============ */}
      {enabled('queries') && (
        <section className="record-section">
          <SectionTitle title="Queries / Disciplinary" number={++sectionNumber} />
          {queries.length === 0 ? (
            <NoData label="No queries or disciplinary records." />
          ) : (
            queries.map((q) => (
              <div key={q.id} className="avoid-break record-box">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold text-sm text-slate-800">{q.query_title || 'Query'}</p>
                  <span className="record-pill bg-slate-100 text-slate-600 border-slate-200">{q.status || '—'}</span>
                </div>
                <div className="record-grid">
                  <Field label="Type" value={q.query_type} />
                  <Field label="Period" value={q.work_period} />
                  <Field label="Description" value={q.description} className="col-span-2" />
                  <Field label="Response" value={q.response} className="col-span-2" />
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {/* ============ 14. AUDIT ============ */}
      {enabled('audit') && (
        <section className="record-section">
          <SectionTitle title="Audit / HR Actions" number={++sectionNumber} />
          {events.length === 0 ? (
            <NoData label="No HR/audit events recorded." />
          ) : (
            <table className="record-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Details</th>
                  <th>Actor</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.event_type?.replace(/_/g, ' ') || '—'}</td>
                    <td>{e.details || '—'}</td>
                    <td>{e.actor || '—'}</td>
                    <td>{fmtDateTime(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ============ SIGNATURES ============ */}
      <footer className="record-footer">
        <div className="flex items-end justify-between gap-8">
          <div className="w-40">
            {emp.signature_url ? (
              <img src={emp.signature_url} alt="Employee signature" className="record-signature-img" />
            ) : (
              <span className="text-[11px] italic text-slate-400">Not signed</span>
            )}
            <div className="w-full h-px bg-slate-300 mt-1" />
            <p className="record-field-label mt-1">Employee Signature</p>
          </div>
          <div className="w-40">
            <span className="text-[11px] italic text-slate-400">Not signed</span>
            <div className="w-full h-px bg-slate-300 mt-1" />
            <p className="record-field-label mt-1">HR Authorized Signature</p>
          </div>
        </div>
        <p className="text-[10px] text-slate-400 mt-5">
          Printed on {generatedAt} from InfinityCore HR · Record ID: {recordId} · For internal HR use only.
          This document contains confidential employee information.
        </p>
      </footer>
    </div>
  )
}