import React, { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Landmark, Link2, Loader2, Search, X } from 'lucide-react'
import { employeeService } from '../../services/employeeService'
import { bankoneNameEnquiryService } from '../../services/bankone/bankoneNameEnquiryService'
import { NIGERIAN_BANKS, findBankByCode } from '../../constants/nigerianBanks'

const btnPrimary = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-50'
const btnGhost = 'inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50'
const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'

// BankOne Account Linking — resolve a salary account holder name through the
// BankOne name-enquiry edge function, then save the verified bank details onto
// the employee record. The lookup must succeed before linking; nothing is
// auto-saved from the provider response.
export default function BankOneLinkModal({ employees = [], onClose, onLinked }) {
  const [employeeId, setEmployeeId] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [bankCode, setBankCode] = useState('')
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const selected = useMemo(
    () => employees.find((e) => e.employee_id === employeeId) || null,
    [employees, employeeId],
  )
  const selectedBank = findBankByCode(bankCode)

  const resetResult = () => { setResult(null); setError(''); setNotice('') }

  const canLookup = Boolean(employeeId && accountNumber.trim() && bankCode) && busy === ''

  const handleLookup = async () => {
    setBusy('lookup'); setError(''); setNotice(''); setResult(null)
    try {
      const res = await bankoneNameEnquiryService.nameEnquiry({
        accountNumber: accountNumber.trim(),
        bankCode,
        bankName: selectedBank?.name,
      })
      if (!res.success || !res.accountName) {
        setError(res.error || 'BankOne did not return an account holder name for these details.')
        setResult(res)
      } else {
        setResult(res)
        setNotice('Account name resolved. Confirm to link this account.')
      }
    } catch (e) {
      setError(e?.message || 'The account name enquiry failed.')
    } finally {
      setBusy('')
    }
  }

  const handleLink = async () => {
    if (!selected) { setError('Select an employee first.'); return }
    if (!result?.accountName) { setError('Resolve the account name before linking.'); return }
    setBusy('link'); setError(''); setNotice('')
    try {
      await employeeService.updateHrFields(selected.employee_id, {
        bank_name: selectedBank?.name || result.bankName || null,
        account_number: accountNumber.trim(),
        account_name: result.accountName,
        bank_sort_code: bankCode,
      })
      setNotice('Bank account linked and saved to the employee record.')
      if (typeof onLinked === 'function') onLinked(selected.employee_id)
    } catch (e) {
      setError(e?.message || 'Could not save the linked bank account.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-[#009944]/5 rounded-t-xl">
          <div className="flex items-center gap-2">
            <Landmark className="w-5 h-5 text-[#009944]" />
            <h3 className="text-lg font-semibold text-slate-900">Link Bank Account (BankOne)</h3>
          </div>
          <button onClick={onClose} disabled={busy !== ''} className="text-slate-400 hover:text-slate-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {(error || notice) && (
            <div className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
              {error ? <AlertTriangle className="w-4 h-4 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 mt-0.5" />}
              <span>{error || notice}</span>
            </div>
          )}

          <div>
            <label className={labelCls}>Employee</label>
            <select
              className={inputCls}
              value={employeeId}
              onChange={(e) => { setEmployeeId(e.target.value); resetResult(); setAccountNumber(''); setBankCode('') }}
            >
              <option value="">Select employee…</option>
              {employees.map((e) => (
                <option key={e.employee_id} value={e.employee_id}>
                  {e.employee_name}{e.employee_code ? ` · ${e.employee_code}` : ''}
                </option>
              ))}
            </select>
            {selected?.account_number && (
              <p className="mt-1 text-xs text-slate-500">
                Current on record: {selected.bank_name || '—'} · {selected.account_number}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Bank</label>
              <select className={inputCls} value={bankCode} onChange={(e) => { setBankCode(e.target.value); resetResult() }}>
                <option value="">Select bank…</option>
                {NIGERIAN_BANKS.map((b) => (
                  <option key={b.code} value={b.code}>{b.name} ({b.code})</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Account number (NUBAN)</label>
              <input
                className={inputCls}
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit account number"
                value={accountNumber}
                onChange={(e) => { setAccountNumber(e.target.value.replace(/\D/g, '')); resetResult() }}
              />
            </div>
          </div>

          <button className={btnGhost} onClick={handleLookup} disabled={!canLookup}>
            {busy === 'lookup' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Look up account name
          </button>

          {result?.accountName && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs uppercase tracking-wide text-emerald-700">Resolved account name</p>
              <p className="text-base font-semibold text-emerald-900">{result.accountName}</p>
              <p className="mt-1 text-xs text-emerald-700">
                {selectedBank?.name || result.bankName || '—'} · {accountNumber}
                {result.accountType ? ` · ${result.accountType}` : ''}
                {result.accountStatus ? ` · ${result.accountStatus}` : ''}
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button className={btnGhost} onClick={onClose} disabled={busy !== ''}>Cancel</button>
            <button className={btnPrimary} onClick={handleLink} disabled={!result?.accountName || busy !== ''}>
              {busy === 'link' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} Confirm &amp; Link
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
