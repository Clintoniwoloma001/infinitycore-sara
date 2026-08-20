import React from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth, AuthProvider } from './hooks/useAuth'
import Layout from './components/Layout'
import { AccessDenied } from './components/PageStates'
import { canAccessRoute, protectedRoutes } from './config/navigation'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Customers from './pages/Customers'
import Loans from './pages/Loans'
import Repayments from './pages/Repayments'
import LeaveRequests from './pages/LeaveRequests'
import LeaveBalances from './pages/LeaveBalances'
import AuditLogs from './pages/AuditLogs'
import Users from './pages/Users'
import CustomerDashboard from './pages/CustomerDashboard'
import MyWork from './pages/MyWork'
import HRDashboard from './pages/HRDashboard'
import Employees from './pages/Employees'
import Recruitment from './pages/Recruitment'
import Assessments from './pages/Assessments'
import Interviews from './pages/Interviews'
import Payroll from './pages/Payroll'
import OfferLetters from './pages/OfferLetters'
import Branches from './pages/Branches'
import Reports from './pages/Reports'

const pageComponents = {
  Dashboard,
  Customers,
  Loans,
  Repayments,
  LeaveRequests,
  LeaveBalances,
  AuditLogs,
  Users,
  MyWork,
  HRDashboard,
  Employees,
  Recruitment,
  Assessments,
  Interviews,
  Payroll,
  OfferLetters,
  Branches,
  Reports,
}

function Protected({ children }) {
  const { user, profile, loading, authError, profileError } = useAuth()
  if (authError) return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0b0d] px-4">
      <div className="max-w-md text-center">
        <h1 className="text-white text-xl font-semibold mb-2">Authentication system not initialized</h1>
        <p className="text-white/60 text-sm">Please check configuration.</p>
      </div>
    </div>
  )
  if (loading) return <div className="flex justify-center items-center h-screen"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (!profile) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center bg-white border border-slate-200 rounded-lg p-8">
        <h1 className="text-xl font-semibold text-slate-900 mb-2">Profile unavailable</h1>
        <p className="text-sm text-slate-500">{profileError || 'Your account is authenticated, but no profile record is available yet.'}</p>
      </div>
    </div>
  )
  return <Layout>{children}</Layout>
}

function ProtectedModule({ route }) {
  const auth = useAuth()
  if (!canAccessRoute(route, auth)) return <AccessDenied />
  const Page = pageComponents[route.element]
  return Page ? <Page /> : <Navigate to="/" replace />
}

function Home() {
  const { role } = useAuth()
  return role === 'customer' ? <CustomerDashboard /> : <Dashboard />
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Protected><Home /></Protected>} />
          {protectedRoutes.filter((route) => route.path !== '/').map((route) => (
            <Route key={route.path} path={route.path} element={<Protected><ProtectedModule route={route} /></Protected>} />
          ))}
          <Route path="/customers/:id" element={<Protected><ProtectedModule route={{ path: '/customers', element: 'Customers', permissions: ['customers.read'] }} /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
