import React, { useEffect, useMemo, useState } from 'react'
import { Plus, Check, X, Banknote, TrendingUp, AlertTriangle } from 'lucide-react'
import { loanApplications as appSvc, customers as custSvc, loans as loanSvc, logAction, sendDecisionEmail } from '../services/supabaseService'
import { scoreLoanApplication, RISK_META, LOAN_STATUS_META, calculateMonthlyPayment } from '../lib/loanScoring'
import { formatCurrency, formatDate, StatusBadge } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

const EMPTY = { customer_id: '', amount: '', purpose: '', term_months: '12', interest_rate: '12', employment_status: 'employed', monthly_income: '', monthly_expenses: '', existing_debt: '', repayment_history_score: '60' }

export default function Loans() {
  const [apps, setApps] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [rejecting, setRejecting] = useState(null)
  const [comment, setComment] = useState('')
  const { name: userName, user, canApprove, isAdmin } = useAuth()

  const load = async () => {
    setLoading(true)
    try { const [a, c] = await Promise.all([appSvc.list(), custSvc.list()]); setApps(a); setCustomers(c) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const live = useMemo(() => scoreLoanApplication({
    amount: Number(form.amount) || 0, termMonths: Number(form.term_months) || 12, monthlyIncome: Number(form.monthly_income) || 0,
    monthlyExpenses: Number(form.monthly_expenses) || 0, existingDebt: Number(form.existing_debt) || 0,
    employmentStatus: form.employment_status, repaymentHistoryScore: Number(form.repayment_history_score) || 50, interestRate: Number(form.interest_rate) || 12,
  }), [form])

  const submit = async () => {
    if (!form.customer_id || !form.amount || !form.term_months) return alert('Customer, amount and term are required')
    setSaving(true)
    try {
      const customer = customers.find((c) => c.id === form.customer_id)
      const result = scoreLoanApplication({
        amount: Number(form.amount), termMonths: Number(form.term_months), monthlyIncome: Number(form.monthly_income) || customer?.monthly_income || 0,
        monthlyExpenses: Number(form.monthly_expenses) || 0, existingDebt: Number(form.existing_debt) || 0,
        employmentStatus: form.employment_status, repaymentHistoryScore: Number(form.repayment_history_score) || customer?.credit_score || 50, interestRate: Number(form.interest_rate) || 12,
      })
      const auto = result.approvalRoute === 'auto'
      const created = await appSvc.create({
        customer_id: form.customer_id, customer_name: customer?.name || '', amount: Number(form.amount), purpose: form.purpose,
        term_months: Number(form.term_months), interest_rate: Number(form.interest_rate) || 12, employment_status: form.employment_status,
        monthly_income: Number(form.monthly_income) || customer?.monthly_income || 0, monthly_expenses: Number(form.monthly_expenses) || 0,
        existing_debt: Number(form.existing_debt) || 0, repayment_history_score: Number(form.repayment_history_score) || 0,
        risk_score: result.riskScore, risk_level: result.riskLevel, approval_route: result.approvalRoute,
        status: auto ? 'approved' : 'pending', reviewed_by_name: auto ? userName : '', approval_comments: auto ? 'Auto-approved (low risk)' : '',
      })
      await logAction({ action: auto ? 'loan_auto_approved' : 'loan_application_submitted', entityType: 'LoanApplication', entityId: created.id, details: `${customer?.name} — ${formatCurrency(Number(form.amount))} — ${RISK_META[result.riskLevel].label}`, userName })
      alert(auto ? 'Auto-approved (low risk)' : `Submitted — ${RISK_META[result.riskLevel].route}`)
      setOpen(false); setForm(EMPTY); load()
    } catch (e) { alert(e.message) } finally { setSaving(false) }
  }

  const decide = async (app, decision) => {
    if (decision === 'rejected' && !comment.trim()) return alert('Add a reason for rejection')
    try {
      await appSvc.update(app.id, { status: decision, reviewed_by_name: userName, approval_comments: comment, reviewed_date: new Date().toISOString() })
      await logAction({ action: `loan_${decision}`, entityType: 'LoanApplication', entityId: app.id, details: `${app.customer_name} — ${decision}`, userName, severity: decision === 'rejected' ? 'warning' : 'info' })
      try { await sendDecisionEmail({ recipientId: app.created_by, subject: `Loan ${decision}: ${app.customer_name}`, message: `Hello,\n\n${app.customer_name}'s loan application for ${formatCurrency(app.amount)} was ${decision} by ${userName}.${decision === 'rejected' && comment ? `\n\nComments: ${comment}` : ''}\n\n— Infinity Bank Operations` }) } catch { /* best-effort */ }
      setRejecting(null); setComment(''); load()
    } catch (e) { alert(e.message) }
  }

  const disburse = async (app) => {
    if (!confirm(`Disburse ${formatCurrency(app.amount)} to ${app.customer_name}?`)) return
    try {
      const monthly = calculateMonthlyPayment(app.amount, app.interest_rate, app.term_months)
      const today = new Date().toISOString().slice(0, 10)
      const maturity = new Date(); maturity.setMonth(maturity.getMonth() + app.term_months)
      await loanSvc.create({ application_id: app.id, customer_id: app.customer_id, customer_name: app.customer_name, principal_amount: app.amount, outstanding_balance: app.amount, interest_rate: app.interest_rate, term_months: app.term_months, monthly_payment: monthly, status: 'active', disbursed_date: today, maturity_date: maturity.toISOString().slice(0, 10) })
      await appSvc.update(app.id, { status: 'disbursed', disbursed_date: today })
      await logAction({ action: 'loan_disbursed', entityType: 'Loan', details: `${app.customer_name} — ${formatCurrency(app.amount)}`, userName, severity: 'critical' })
      try { await sendDecisionEmail({ recipientId: app.created_by, subject: `Loan Disbursed: ${app.customer_name}`, message: `Hello,\n\nThe loan for ${app.customer_name} (${formatCurrency(app.amount)}) has been disbursed. Monthly payment: ${formatCurrency(monthly)}.\n\n— Infinity Bank Operations` }) } catch { /* best-effort */ }
      load()
    } catch (e) { alert(e.message) }
  }

  const markRepaid = async (app) => {
    await appSvc.update(app.id, { status: 'repaid' })
    const ls = await loanSvc.list(); const loan = ls.find((l) => l.application_id === app.id)
    if (loan) await loanSvc.update(loan.id, { status: 'repaid', outstanding_balance: 0 })
    await logAction({ action: 'loan_repaid', entityType: 'LoanApplication', entityId: app.id, details: app.customer_name, userName })
    load()
  }

  const canReview = (a) => a.status === 'pending' && ((a.approval_route === 'manager' && canApprove) || (a.approval_route === 'senior' && isAdmin))
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const ScoreBar = ({ label, value }) => (
    <div><div className="flex justify-between mb-1 text-xs"><span className="text-slate-500">{label}</span><span className="font-medium text-slate-700">{value}</span></div>
      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: value >= 75 ? '#10b981' : value >= 50 ? '#f59e0b' : '#f43f5e' }} /></div></div>
  )

  return (
    <div>
      <div className="flex justify-between items-end mb-6">
        <div><h2 className="text-2xl font-semibold text-slate-900">Loan Applications</h2><p className="text-sm text-slate-500 mt-1">Risk-scored applications with routed approvals</p></div>
        <button onClick={() => setOpen(true)} className="bg-[#009944] hover:bg-[#007a35] text-white px-4 py-2 rounded-lg text-sm flex items-center gap-1.5"><Plus className="w-4 h-4" /> New Application</button>
      </div>
      {loading ? <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div> : apps.length === 0 ? (
        <div className="text-center py-16 text-slate-400">No loan applications yet.</div>
      ) : (
        <div className="space-y-4">
          {apps.map((a) => (
            <div key={a.id} className="bg-white rounded-2xl border border-slate-200 p-5">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="font-semibold text-slate-900">{a.customer_name || '—'}</h3>
                    <StatusBadge label={LOAN_STATUS_META[a.status]?.label || a.status} color={LOAN_STATUS_META[a.status]?.color} />
                    {a.risk_level && <StatusBadge label={RISK_META[a.risk_level].label} color={RISK_META[a.risk_level].color} />}
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-sm text-slate-500 flex-wrap">
                    <span className="font-semibold text-slate-700 text-base">{formatCurrency(a.amount)}</span><span>·</span>
                    <span>{a.term_months} months @ {a.interest_rate}%</span><span>·</span>
                    <span>Score: <b className="text-slate-700">{a.risk_score ?? '—'}</b></span><span>·</span>
                    <span>Route: <b className="text-slate-700 capitalize">{a.approval_route}</b></span>
                  </div>
                  {a.reviewed_by_name && <p className="text-xs text-slate-400 mt-2">Reviewed by {a.reviewed_by_name}{a.approval_comments ? ` — "${a.approval_comments}"` : ''}</p>}
                </div>
                <div className="flex gap-2">
                  {canReview(a) && <>
                    <button onClick={() => { setRejecting(a); setComment('') }} className="px-3 py-1.5 rounded-lg border border-rose-200 text-rose-600 text-sm flex items-center gap-1"><X className="w-4 h-4" /> Reject</button>
                    <button onClick={() => decide(a, 'approved')} className="px-3 py-1.5 rounded-lg bg-[#009944] text-white text-sm flex items-center gap-1"><Check className="w-4 h-4" /> Approve</button>
                  </>}
                  {a.status === 'approved' && canApprove && <button onClick={() => disburse(a)} className="px-3 py-1.5 rounded-lg bg-violet-600 text-white text-sm flex items-center gap-1"><Banknote className="w-4 h-4" /> Disburse</button>}
                  {a.status === 'disbursed' && canApprove && <button onClick={() => markRepaid(a)} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-sm flex items-center gap-1"><Check className="w-4 h-4" /> Mark Repaid</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
            <h3 className="font-semibold text-slate-900 mb-4">New Loan Application</h3>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2"><label className="text-sm font-medium text-slate-700">Customer *</label>
                  <select value={form.customer_id} onChange={set('customer_id')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3"><option value="">Select…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                <div><label className="text-sm font-medium text-slate-700">Amount *</label><input type="number" value={form.amount} onChange={set('amount')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">Term (months) *</label><input type="number" value={form.term_months} onChange={set('term_months')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">Interest Rate (%)</label><input type="number" value={form.interest_rate} onChange={set('interest_rate')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">Employment</label><select value={form.employment_status} onChange={set('employment_status')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3"><option value="employed">Employed</option><option value="self_employed">Self Employed</option><option value="unemployed">Unemployed</option><option value="retired">Retired</option></select></div>
                <div><label className="text-sm font-medium text-slate-700">Monthly Income</label><input type="number" value={form.monthly_income} onChange={set('monthly_income')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">Monthly Expenses</label><input type="number" value={form.monthly_expenses} onChange={set('monthly_expenses')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">Existing Debt</label><input type="number" value={form.existing_debt} onChange={set('existing_debt')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div><label className="text-sm font-medium text-slate-700">Repayment History (0-100)</label><input type="number" value={form.repayment_history_score} onChange={set('repayment_history_score')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
                <div className="sm:col-span-2"><label className="text-sm font-medium text-slate-700">Purpose</label><textarea value={form.purpose} onChange={set('purpose')} rows={2} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" /></div>
              </div>
              <div className="bg-slate-50 rounded-xl p-5 border border-slate-200">
                <div className="flex items-center gap-2 mb-4"><TrendingUp className="w-4 h-4 text-[#009944]" /><h4 className="font-semibold text-slate-800 text-sm">Live Risk Assessment</h4></div>
                <div className="text-center py-3"><div className="text-4xl font-bold text-slate-900">{live.riskScore}</div><div className="text-xs text-slate-400">Risk Score (0-100)</div></div>
                <div className="flex justify-center mb-4"><StatusBadge label={RISK_META[live.riskLevel].label} color={RISK_META[live.riskLevel].color} /></div>
                <div className="space-y-2 text-xs"><ScoreBar label="Affordability" value={live.breakdown.affordability} /><ScoreBar label="Employment" value={live.breakdown.employment} /><ScoreBar label="Repayment History" value={live.breakdown.history} /></div>
                <div className="mt-4 pt-4 border-t border-slate-200">
                  <div className="flex justify-between text-sm"><span className="text-slate-500">Monthly Payment</span><span className="font-semibold text-slate-800">{formatCurrency(live.monthlyPayment)}</span></div>
                  <div className="flex justify-between text-sm mt-1"><span className="text-slate-500">Approval Route</span><span className="font-semibold text-[#009944]">{RISK_META[live.riskLevel].route}</span></div>
                  {live.riskLevel === 'high' && <div className="flex items-start gap-1.5 mt-3 text-xs text-rose-600 bg-rose-50 rounded-lg p-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5" />High risk — requires senior review.</div>}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600">Cancel</button>
              <button onClick={submit} disabled={saving} className="px-4 py-2 rounded-lg bg-[#009944] text-white hover:bg-[#007a35] disabled:opacity-50">{saving ? 'Submitting…' : 'Submit Application'}</button>
            </div>
          </div>
        </div>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setRejecting(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <h3 className="font-semibold text-slate-900 mb-4">Reject Loan Application</h3>
            <label className="text-sm font-medium text-slate-700">Reason</label>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setRejecting(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600">Cancel</button>
              <button onClick={() => decide(rejecting, 'rejected')} className="px-4 py-2 rounded-lg bg-rose-600 text-white">Confirm Rejection</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}