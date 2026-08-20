import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../supabaseClient'
import { formatCurrency, StatusBadge } from '../lib/utils'
import { Wallet, Landmark, Clock, FileText, AlertCircle, TrendingUp } from 'lucide-react'
import Customer360Modal from '../components/Customer360Modal'

/**
 * Customer Dashboard - Customer-facing view
 * Distinct from internal staff operations dashboard
 * Shows personal account info, loans, applications
 * This is the customer experience of Infinity Bank
 */
export default function CustomerDashboard() {
  const { user, name, isCustomer } = useAuth()
  const [customer, setCustomer] = useState(null)
  const [loans, setLoans] = useState([])
  const [applications, setApplications] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (!user?.id) return

      try {
        // Get customer record created by this user (or linked by customer_id)
        const { data: cust } = await supabase
          .from('customers')
          .select('*')
          .eq('created_by', user.id)
          .single()

        if (cust) {
          setCustomer(cust)

          // Get active loans
          const { data: loansList } = await supabase
            .from('loans')
            .select('*')
            .eq('customer_id', cust.id)
            .eq('status', 'active')
          setLoans(loansList || [])

          // Get loan applications
          const { data: appsList } = await supabase
            .from('loan_applications')
            .select('*')
            .eq('customer_id', cust.id)
            .order('created_at', { ascending: false })
          setApplications(appsList || [])
        }
      } catch (e) {
        console.error('Error loading customer data:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [user?.id])

  if (loading) {
    return (
      <div className="text-center py-24">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mx-auto" />
        <p className="text-slate-500 mt-3">Loading your account...</p>
      </div>
    )
  }

  if (!customer) {
    return (
      <div className="text-center py-20">
        <AlertCircle className="w-12 h-12 text-amber-600 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-slate-900 mb-2">Customer Profile Not Found</h3>
        <p className="text-slate-600 mb-4">We couldn't find your customer profile. Please contact support.</p>
      </div>
    )
  }

  const handleAction = (action) => {
    switch (action) {
      case 'viewProfile':
        setSelectedCustomer(customer)
        setShowModal(true)
        break
      case 'applyLoan':
        // Would navigate to loan application form
        console.log('Navigate to loan application')
        break
      case 'uploadDocs':
        // Would open document upload modal
        console.log('Open document upload')
        break
      default:
        break
    }
  }

  return (
    <div>
      {/* Welcome Header */}
      <div className="mb-8">
        <h2 className="text-4xl font-bold text-slate-900">
          Welcome back, {name.split(' ')[0]} 👋
        </h2>
        <p className="text-slate-500 mt-2">Your Infinity Bank Digital Account</p>
      </div>

      {/* Account Balance Card */}
      <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl p-8 text-white mb-8 shadow-lg">
        <p className="text-sm opacity-90 mb-2">Available Balance</p>
        <h3 className="text-4xl font-bold mb-2">₦{formatCurrency(customer.account_balance || 0)}</h3>
        <p className="text-xs opacity-75">Account No: {customer.account_number || 'N/A'}</p>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <Landmark className="w-5 h-5 text-green-600" />
            <span className="text-xs font-semibold text-slate-500">ACTIVE LOANS</span>
          </div>
          <p className="text-3xl font-bold text-slate-900">{loans.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <Clock className="w-5 h-5 text-orange-600" />
            <span className="text-xs font-semibold text-slate-500">PENDING APPS</span>
          </div>
          <p className="text-3xl font-bold text-slate-900">
            {applications.filter((a) => a.status === 'pending').length}
          </p>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <TrendingUp className="w-5 h-5 text-slate-600" />
            <span className="text-xs font-semibold text-slate-500">CREDIT SCORE</span>
          </div>
          <p className="text-3xl font-bold text-slate-900">{customer.credit_score || 'Not Set'}</p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg border border-slate-200 p-6 mb-8">
        <h3 className="text-lg font-semibold text-slate-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <button
            onClick={() => handleAction('applyLoan')}
            className="p-4 rounded-lg bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 hover:shadow-md transition text-center"
          >
            <Wallet className="w-6 h-6 text-green-600 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-900">Apply for Loan</p>
          </button>
          <button
            onClick={() => handleAction('uploadDocs')}
            className="p-4 rounded-lg bg-gradient-to-br from-blue-50 to-sky-50 border border-blue-200 hover:shadow-md transition text-center"
          >
            <FileText className="w-6 h-6 text-blue-600 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-900">Upload Documents</p>
          </button>
          <button
            onClick={() => handleAction('viewProfile')}
            className="p-4 rounded-lg bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200 hover:shadow-md transition text-center"
          >
            <FileText className="w-6 h-6 text-purple-600 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-900">View Profile</p>
          </button>
          <button className="p-4 rounded-lg bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 hover:shadow-md transition text-center">
            <FileText className="w-6 h-6 text-amber-600 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-900">Contact Support</p>
          </button>
        </div>
      </div>

      {/* Active Loans */}
      {loans.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-6 mb-8">
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Landmark className="w-5 h-5 text-green-600" />
            Your Active Loans
          </h3>
          <div className="space-y-3">
            {loans.map((loan) => (
              <div key={loan.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div className="flex-1">
                  <p className="font-semibold text-slate-900">Principal: {formatCurrency(loan.principal_amount)}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Outstanding: {formatCurrency(loan.outstanding_balance)} • Monthly: {formatCurrency(loan.monthly_payment)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-slate-900">{loan.term_months} months</p>
                  <StatusBadge label={loan.status} color="green" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Applications */}
      {applications.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200">
            <h3 className="font-semibold text-slate-900">Recent Applications</h3>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs font-semibold">
              <tr>
                <th className="px-6 py-3 text-left">Amount</th>
                <th className="px-6 py-3 text-left">Purpose</th>
                <th className="px-6 py-3 text-left">Status</th>
                <th className="px-6 py-3 text-left">Applied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {applications.slice(0, 5).map((app) => (
                <tr key={app.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 font-medium text-slate-900">{formatCurrency(app.amount)}</td>
                  <td className="px-6 py-3 text-slate-600 text-xs">{app.purpose || 'General'}</td>
                  <td className="px-6 py-3">
                    <StatusBadge
                      label={app.status}
                      color={app.status === 'approved' ? 'green' : app.status === 'pending' ? 'yellow' : 'red'}
                    />
                  </td>
                  <td className="px-6 py-3 text-slate-500 text-xs">{new Date(app.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Customer 360 Modal */}
      {showModal && (
        <Customer360Modal
          customer={selectedCustomer}
          onClose={() => setShowModal(false)}
          onAction={handleAction}
        />
      )}
    </div>
  )
}
