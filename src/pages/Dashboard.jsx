import React, { useEffect, useState } from 'react'
import RoleSwitcher from '../components/RoleSwitcher'
import PendingApprovalsWidget from '../components/PendingApprovalsWidget'
import { Link } from 'react-router-dom'
import { Users, Landmark, Wallet, Clock } from 'lucide-react'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { customers as customerSvc, loanApplications, loans as loanSvc, repayments as repaymentSvc } from '../services/supabaseService'
import { formatCurrency, StatusBadge } from '../lib/utils'
import { RISK_META, LOAN_STATUS_META } from '../lib/loanScoring'
import { useAuth } from '../hooks/useAuth'
import { ErrorState } from '../components/PageStates'

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [recent, setRecent] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { name } = useAuth()

  useEffect(() => {
    (async () => {
      try {
        setError('')
        const [c, la, l, r] = await Promise.all([
          customerSvc.list(), loanApplications.list(), loanSvc.list(), repaymentSvc.list(),
        ])
        const totalDisbursed = l.reduce((s, x) => s + (x.principal_amount || 0), 0)
        const pending = la.filter((a) => a.status === 'pending').length
        const riskData = ['low', 'medium', 'high'].map((k) => ({
          name: RISK_META[k].label,
          value: la.filter((a) => a.risk_level === k).length,
          color: k === 'low' ? '#10b981' : k === 'medium' ? '#f59e0b' : '#f43f5e',
        }))
        const statusData = Object.keys(LOAN_STATUS_META).map((k) => ({
          name: LOAN_STATUS_META[k].label,
          count: la.filter((a) => a.status === k).length,
        }))
        setStats({ customers: c.length, loans: l.length, totalDisbursed, pending, riskData, statusData })
        setRecent(la.slice(0, 6))
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e)
        setStats({ customers: 0, loans: 0, totalDisbursed: 0, pending: 0, riskData: [], statusData: [] })
        setRecent([])
        setError(e?.message || 'Unable to load dashboard data')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading) return <div className="flex justify-center py-24"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
  if (error) return <ErrorState title="Unable to load dashboard" message={error} />

  const StatCard = ({ icon: Icon, label, value, accent }) => (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 flex items-start gap-4">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accent}15`, color: accent }}><Icon className="w-5 h-5" /></div>
      <div><div className="text-xs font-medium text-slate-500 uppercase">{label}</div><div className="text-2xl font-semibold text-slate-900 mt-1">{value}</div></div>
    </div>
  )

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Welcome, {name.split(' ')[0]}</h2>
        <RoleSwitcher />
        <p className="text-sm text-slate-500 mt-1">Infinity Bank operations overview</p>
      </div>
      <PendingApprovalsWidget />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Users} label="Customers" value={stats.customers} accent="#009944" />
        <StatCard icon={Landmark} label="Active Loans" value={stats.loans} accent="#FF8C00" />
        <StatCard icon={Wallet} label="Total Disbursed" value={formatCurrency(stats.totalDisbursed)} accent="#6366f1" />
        <StatCard icon={Clock} label="Pending Applications" value={stats.pending} accent="#f59e0b" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Loan Status Distribution</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={stats.statusData}><XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fontSize: 12 }} /><Tooltip /><Bar dataKey="count" fill="#009944" radius={[6, 6, 0, 0]} /></BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-800 mb-4">Risk Level Breakdown</h3>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart><Pie data={stats.riskData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>{stats.riskData.map((d, i) => <Cell key={i} fill={d.color} />)}</Pie><Legend /><Tooltip /></PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">Recent Loan Applications</h3>
          <Link to="/loans" className="text-sm text-[#009944] hover:underline">View all</Link>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left"><tr><th className="px-6 py-3 font-medium">Customer</th><th className="px-6 py-3 font-medium">Amount</th><th className="px-6 py-3 font-medium">Risk</th><th className="px-6 py-3 font-medium">Status</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {recent.length === 0 && <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-400">No applications yet</td></tr>}
            {recent.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50">
                <td className="px-6 py-3 font-medium text-slate-700">{a.customer_name || '—'}</td>
                <td className="px-6 py-3 text-slate-600">{formatCurrency(a.amount)}</td>
                <td className="px-6 py-3">{a.risk_level && <StatusBadge label={RISK_META[a.risk_level].label} color={RISK_META[a.risk_level].color} />}</td>
                <td className="px-6 py-3"><StatusBadge label={LOAN_STATUS_META[a.status]?.label || a.status} color={LOAN_STATUS_META[a.status]?.color || 'slate'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
