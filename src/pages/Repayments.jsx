import React, { useEffect, useState } from 'react'
import { Plus, Check } from 'lucide-react'
import { repayments as svc, loans as loanSvc, logAction } from '../services/supabaseService'
import { formatCurrency, formatDate, StatusBadge } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

export default function Repayments() {
  const [items, setItems] = useState([])
  const [loans, setLoans] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ loan_id: '', amount: '', due_date: '', payment_method: 'bank_transfer' })
  const { canApprove, name: userName } = useAuth()

  const load = async () => { setLoading(true); try { const [r, l] = await Promise.all([svc.list(), loanSvc.list()]); setItems(r); setLoans(l) } finally { setLoading(false) } }
  useEffect(() => { load() }, [])

  const markPaid = async (r) => {
    await svc.update(r.id, { status: 'paid', payment_date: new Date().toISOString().slice(0, 10) })
    const loan = loans.find((l) => l.id === r.loan_id)
    if (loan) {
      const bal = Math.max(loan.outstanding_balance - r.amount, 0)
      await loanSvc.update(loan.id, { outstanding_balance: bal, status: bal === 0 ? 'repaid' : loan.status })
    }
    await logAction({ action: 'repayment_recorded', entityType: 'Repayment', entityId: r.id, details: `${formatCurrency(r.amount)}`, userName })
    load()
  }

  const create = async () => {
    if (!form.loan_id || !form.amount || !form.due_date) return alert('All fields required')
    const loan = loans.find((l) => l.id === form.loan_id)
    await svc.create({ loan_id: form.loan_id, customer_id: loan?.customer_id || '', customer_name: loan?.customer_name || '', amount: Number(form.amount), due_date: form.due_date, status: 'pending', payment_method: form.payment_method })
    await logAction({ action: 'repayment_scheduled', entityType: 'Repayment', details: `${formatCurrency(form.amount)} due ${form.due_date}`, userName })
    setOpen(false); setForm({ loan_id: '', amount: '', due_date: '', payment_method: 'bank_transfer' }); load()
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const sc = (s) => s === 'paid' ? 'emerald' : s === 'late' ? 'rose' : 'amber'

  return (
    <div>
      <div className="flex justify-between items-end mb-6">
        <div><h2 className="text-2xl font-semibold text-slate-900">Repayments</h2><p className="text-sm text-slate-500 mt-1">Loan repayment schedules and collections</p></div>
        {canApprove && <button onClick={() => setOpen(true)} className="bg-[#009944] hover:bg-[#007a35] text-white px-4 py-2 rounded-lg text-sm flex items-center gap-1.5"><Plus className="w-4 h-4" /> Schedule</button>}
      </div>
      {loading ? <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div> : items.length === 0 ? (
        <div className="text-center py-16 text-slate-400">No repayments.</div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-left"><tr><th className="px-6 py-3 font-medium">Customer</th><th className="px-6 py-3 font-medium">Amount</th><th className="px-6 py-3 font-medium">Due</th><th className="px-6 py-3 font-medium">Status</th><th className="px-6 py-3 font-medium text-right">Action</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 font-medium text-slate-700">{r.customer_name || '—'}</td>
                  <td className="px-6 py-3 text-slate-600">{formatCurrency(r.amount)}</td>
                  <td className="px-6 py-3 text-slate-600">{formatDate(r.due_date)}</td>
                  <td className="px-6 py-3"><StatusBadge label={r.status} color={sc(r.status)} /></td>
                  <td className="px-6 py-3 text-right">{r.status !== 'paid' && canApprove && <button onClick={() => markPaid(r)} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-sm flex items-center gap-1 ml-auto"><Check className="w-4 h-4" /> Mark Paid</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <h3 className="font-semibold text-slate-900 mb-4">Schedule Repayment</h3>
            <div className="space-y-4">
              <div><label className="text-sm font-medium text-slate-700">Loan</label><select value={form.loan_id} onChange={set('loan_id')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3"><option value="">Select…</option>{loans.filter((l) => l.status === 'active').map((l) => <option key={l.id} value={l.id}>{l.customer_name} — {formatCurrency(l.outstanding_balance)}</option>)}</select></div>
              <div><label className="text-sm font-medium text-slate-700">Amount</label><input type="number" value={form.amount} onChange={set('amount')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
              <div><label className="text-sm font-medium text-slate-700">Due Date</label><input type="date" value={form.due_date} onChange={set('due_date')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3" /></div>
              <div><label className="text-sm font-medium text-slate-700">Method</label><select value={form.payment_method} onChange={set('payment_method')} className="mt-1 w-full h-10 rounded-md border border-slate-300 px-3"><option value="bank_transfer">Bank Transfer</option><option value="cash">Cash</option><option value="card">Card</option></select></div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600">Cancel</button>
              <button onClick={create} className="px-4 py-2 rounded-lg bg-[#009944] text-white hover:bg-[#007a35]">Schedule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}