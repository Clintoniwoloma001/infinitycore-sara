import React, { useEffect, useState } from 'react'
import { Briefcase, FileText, History, Landmark, Mail, MapPin, Phone, TrendingUp, X } from 'lucide-react'
import DocumentList from './DocumentList'
import DocumentUpload from './DocumentUpload'
import { ErrorState } from './PageStates'
import { documentService } from '../services/documentService'
import { supabase } from '../supabaseClient'
import { formatCurrency, formatDate, StatusBadge } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

export default function Customer360Modal({ customer, onClose, onAction }) {
  const [activeTab, setActiveTab] = useState('overview')
  const [documents, setDocuments] = useState([])
  const [loans, setLoans] = useState([])
  const [repayments, setRepayments] = useState([])
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { permissions } = useAuth()

  const loadData = async () => {
    if (!customer?.id) return
    setLoading(true)
    setError('')
    try {
      const [docsResult, loansResult, repaymentsResult, activityResult] = await Promise.allSettled([
        documentService.list('customer', customer.id),
        supabase.from('loans').select('*').eq('customer_id', customer.id).order('created_at', { ascending: false }),
        supabase.from('repayments').select('*').eq('customer_id', customer.id).order('created_at', { ascending: false }),
        supabase.from('audit_logs').select('*').eq('entity_id', customer.id).order('created_at', { ascending: false }).limit(10),
      ])

      if (docsResult.status === 'fulfilled') setDocuments(docsResult.value || [])
      if (loansResult.status === 'fulfilled' && !loansResult.value.error) setLoans(loansResult.value.data || [])
      if (repaymentsResult.status === 'fulfilled' && !repaymentsResult.value.error) setRepayments(repaymentsResult.value.data || [])
      if (activityResult.status === 'fulfilled' && !activityResult.value.error) setActivity(activityResult.value.data || [])

      const errors = [loansResult, repaymentsResult, activityResult]
        .filter((result) => result.status === 'fulfilled' && result.value.error)
        .map((result) => result.value.error.message)
      if (docsResult.status === 'rejected') errors.push(docsResult.reason?.message || 'Documents unavailable')
      if (errors.length) setError(errors.join(' | '))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [customer?.id])

  if (!customer) return null

  const tabs = [
    { key: 'overview', label: 'Overview', icon: Briefcase },
    { key: 'documents', label: 'Documents', icon: FileText },
    { key: 'loans', label: 'Loans', icon: Landmark },
    { key: 'history', label: 'History', icon: History },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Customer 360</h2>
            <p className="text-xs text-slate-500 mt-0.5">Profile, documents, loans, repayments, and activity</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition" title="Close">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="px-6 py-4 bg-emerald-50 border-b border-emerald-100">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-slate-900">{customer.name}</h3>
              <div className="flex flex-wrap gap-4 mt-2 text-sm text-slate-600">
                {customer.email && <span className="flex items-center gap-1"><Mail className="w-4 h-4" />{customer.email}</span>}
                {customer.phone && <span className="flex items-center gap-1"><Phone className="w-4 h-4" />{customer.phone}</span>}
                {customer.address && <span className="flex items-center gap-1"><MapPin className="w-4 h-4" />{customer.address}</span>}
              </div>
            </div>
            <div className="md:text-right">
              <StatusBadge label={customer.status || 'active'} color={customer.status === 'pending' ? 'amber' : 'emerald'} />
              {customer.credit_score && (
                <div className="mt-2 flex items-center gap-1 md:justify-end text-sm">
                  <TrendingUp className="w-4 h-4 text-orange-600" />
                  <span className="font-semibold text-slate-900">Score: {customer.credit_score}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-1 px-6 pt-4 border-b border-slate-200 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`flex items-center gap-2 pb-3 px-3 font-medium text-sm transition whitespace-nowrap border-b-2 ${activeTab === tab.key ? 'text-[#009944] border-[#009944]' : 'text-slate-600 border-transparent hover:text-slate-900'}`}>
                <Icon className="w-4 h-4" /> {tab.label}
              </button>
            )
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-center py-12">
              <div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin mx-auto" />
              <p className="text-slate-500 mt-3">Loading customer data...</p>
            </div>
          ) : (
            <div className="space-y-5">
              {error && <ErrorState title="Some customer data is unavailable" message={error} />}

              {activeTab === 'overview' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    ['Date of Birth', customer.date_of_birth ? formatDate(customer.date_of_birth) : 'N/A'],
                    ['National ID', customer.national_id || 'N/A'],
                    ['Employment Status', customer.employment_status || 'Not specified'],
                    ['Employer', customer.employer || 'Not specified'],
                    ['Monthly Income', formatCurrency(customer.monthly_income || 0)],
                    ['Account Number', customer.account_number || 'N/A'],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                      <p className="text-xs text-slate-500 mb-1">{label}</p>
                      <p className="font-medium text-slate-900">{value}</p>
                    </div>
                  ))}
                  {customer.notes && <div className="md:col-span-2 bg-slate-50 rounded-lg border border-slate-200 p-4"><p className="text-xs text-slate-500 mb-1">Notes</p><p className="text-sm text-slate-700">{customer.notes}</p></div>}
                </div>
              )}

              {activeTab === 'documents' && (
                <div className="space-y-4">
                  {permissions.canUploadDocuments && <DocumentUpload entityType="customer" entityId={customer.id} documentType="kyc" onSuccess={loadData} />}
                  <DocumentList documents={documents} entityType="customer" entityId={customer.id} canVerify={permissions.canVerifyDocuments} onDelete={loadData} />
                </div>
              )}

              {activeTab === 'loans' && (
                <div className="space-y-6">
                  <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500 text-left"><tr><th className="px-6 py-3 font-medium">Principal</th><th className="px-6 py-3 font-medium">Outstanding</th><th className="px-6 py-3 font-medium">Monthly</th><th className="px-6 py-3 font-medium">Status</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {loans.length === 0 && <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400">No loans for this customer</td></tr>}
                        {loans.map((loan) => <tr key={loan.id}><td className="px-6 py-3">{formatCurrency(loan.principal_amount)}</td><td className="px-6 py-3">{formatCurrency(loan.outstanding_balance)}</td><td className="px-6 py-3">{formatCurrency(loan.monthly_payment)}</td><td className="px-6 py-3"><StatusBadge label={loan.status || 'active'} color={loan.status === 'repaid' ? 'emerald' : 'blue'} /></td></tr>)}
                      </tbody>
                    </table>
                  </div>
                  <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500 text-left"><tr><th className="px-6 py-3 font-medium">Repayment</th><th className="px-6 py-3 font-medium">Due</th><th className="px-6 py-3 font-medium">Paid</th><th className="px-6 py-3 font-medium">Status</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                        {repayments.length === 0 && <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400">No repayments for this customer</td></tr>}
                        {repayments.map((repayment) => <tr key={repayment.id}><td className="px-6 py-3">{formatCurrency(repayment.amount)}</td><td className="px-6 py-3">{formatDate(repayment.due_date)}</td><td className="px-6 py-3">{formatDate(repayment.payment_date)}</td><td className="px-6 py-3"><StatusBadge label={repayment.status || 'pending'} color={repayment.status === 'paid' ? 'emerald' : 'amber'} /></td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === 'history' && (
                <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {activity.length === 0 && <div className="px-6 py-8 text-center text-slate-400 text-sm">No activity history for this customer</div>}
                  {activity.map((item) => (
                    <div key={item.id} className="px-6 py-4 flex items-center justify-between gap-4">
                      <div><p className="font-medium text-slate-800">{item.action?.replace(/_/g, ' ')}</p><p className="text-xs text-slate-500">{item.details || item.user_name || 'System event'}</p></div>
                      <span className="text-xs text-slate-400 whitespace-nowrap">{formatDate(item.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col gap-3 sm:flex-row">
          <button onClick={() => onAction?.('createCase')} className="flex-1 px-4 py-2 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 transition">Create Support Case</button>
          <button onClick={() => onAction?.('startLoan')} className="flex-1 px-4 py-2 bg-[#009944] text-white rounded-lg font-medium hover:bg-[#007a35] transition">Start Loan Application</button>
          <button onClick={onClose} className="px-4 py-2 text-slate-700 hover:text-slate-900 font-medium">Close</button>
        </div>
      </div>
    </div>
  )
}
