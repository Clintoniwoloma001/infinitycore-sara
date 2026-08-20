import React, { useEffect, useState } from 'react'
import { BarChart3, BriefcaseBusiness, Landmark, Users, Wallet } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { ErrorState, LoadingState } from '../components/PageStates'
import { formatCurrency } from '../lib/utils'

const list = async (table) => {
  const { data, error } = await supabase.from(table).select('*')
  return { data: data || [], error }
}

export default function Reports() {
  const [state, setState] = useState({ loading: true, data: {}, errors: [] })

  useEffect(() => {
    let active = true
    const load = async () => {
      const entries = await Promise.all([
        ['customers', list('customers')],
        ['loanApplications', list('loan_applications')],
        ['loans', list('loans')],
        ['repayments', list('repayments')],
        ['employees', list('employees')],
        ['candidates', list('hr_candidates')],
      ].map(async ([key, promise]) => [key, await promise]))

      if (!active) return
      const data = {}
      const errors = []
      entries.forEach(([key, result]) => {
        data[key] = result.data
        if (result.error) errors.push(`${key}: ${result.error.message}`)
      })
      setState({ loading: false, data, errors })
    }
    load()
    return () => { active = false }
  }, [])

  if (state.loading) return <LoadingState label="Loading reports..." />

  const { customers = [], loanApplications = [], loans = [], repayments = [], employees = [], candidates = [] } = state.data
  const outstanding = loans.reduce((sum, loan) => sum + Number(loan.outstanding_balance || 0), 0)
  const repaymentsTotal = repayments.reduce((sum, repayment) => sum + Number(repayment.amount || 0), 0)

  const cards = [
    { label: 'Customer Count', value: customers.length, icon: Users, accent: '#009944' },
    { label: 'Loan Applications', value: loanApplications.length, icon: Landmark, accent: '#f59e0b' },
    { label: 'Active Loans', value: loans.filter((loan) => loan.status === 'active').length, icon: Landmark, accent: '#6366f1' },
    { label: 'Repayments', value: repayments.length, icon: Wallet, accent: '#14b8a6' },
    { label: 'Outstanding Balances', value: formatCurrency(outstanding), icon: Wallet, accent: '#f43f5e' },
    { label: 'Repayments Recorded', value: formatCurrency(repaymentsTotal), icon: BarChart3, accent: '#0ea5e9' },
    { label: 'Employees', value: employees.length, icon: BriefcaseBusiness, accent: '#84cc16' },
    { label: 'Recruitment Candidates', value: candidates.length, icon: Users, accent: '#a855f7' },
  ]

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Reports</h2>
        <p className="text-sm text-slate-500 mt-1">Operational reporting from available Supabase datasets</p>
      </div>

      {state.errors.length > 0 && <div className="mb-6"><ErrorState title="Some report datasets are not available" message={state.errors.join(' | ')} /></div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map(({ label, value, icon: Icon, accent }) => (
          <div key={label} className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
                <p className="text-2xl font-semibold text-slate-900 mt-1">{value}</p>
              </div>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}>
                <Icon className="w-5 h-5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
