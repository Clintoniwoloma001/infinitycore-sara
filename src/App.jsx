import React, { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth, AuthProvider } from './hooks/useAuth'
import { supabase } from './supabaseClient'
import OnboardingFlow from './components/OnboardingFlow'
import AttendanceTerminal from './pages/AttendanceTerminal'
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
import OnboardingLinks from './pages/OnboardingLinks'
import OnboardingForm from './pages/OnboardingForm'
import GuarantorVerificationForm from './pages/GuarantorVerificationForm'
import Attendance from './pages/Attendance'
import AttendanceManagement from './pages/AttendanceManagement'
import EmployeeProfile from './pages/EmployeeProfile'
import DataImport from './pages/DataImport'
import HRQueries from './pages/HRQueries'
import Appraisals from './pages/Appraisals'
import WorkManagement from './pages/WorkManagement'
import PlatformSettings from './pages/PlatformSettings'

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
  OnboardingLinks,
  Attendance,
  AttendanceManagement,
  DataImport,
  HRQueries,
  Appraisals,
  WorkManagement,
  PlatformSettings,
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
  // Block pending/suspended users from accessing the app
  if (profile.status === 'pending') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center bg-white border border-slate-200 rounded-lg p-8">
        <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <h1 className="text-xl font-semibold text-slate-900 mb-2">Account Pending Approval</h1>
        <p className="text-sm text-slate-500">Your account is awaiting administrator approval. You will be able to access the system once an administrator approves your account.</p>
        <button onClick={() => { window.location.hash = '#/login'; window.location.reload() }} className="mt-4 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Sign Out</button>
      </div>
    </div>
  )
  if (profile.status === 'suspended') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center bg-white border border-slate-200 rounded-lg p-8">
        <div className="w-14 h-14 rounded-full bg-rose-100 flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        </div>
        <h1 className="text-xl font-semibold text-slate-900 mb-2">Account Suspended</h1>
        <p className="text-sm text-slate-500">Your account has been suspended. {profile.rejected_reason ? `Reason: ${profile.rejected_reason}` : 'Please contact your administrator.'}</p>
        <button onClick={() => { window.location.hash = '#/login'; window.location.reload() }} className="mt-4 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Sign Out</button>
      </div>
    </div>
  )
  if (profile.status === 'rejected') return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center bg-white border border-slate-200 rounded-lg p-8">
        <div className="w-14 h-14 rounded-full bg-rose-100 flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        </div>
        <h1 className="text-xl font-semibold text-slate-900 mb-2">Account Rejected</h1>
        <p className="text-sm text-slate-500">Your registration was not approved. {profile.rejected_reason ? `Reason: ${profile.rejected_reason}` : 'Please contact your administrator.'}</p>
        <button onClick={() => { window.location.hash = '#/login'; window.location.reload() }} className="mt-4 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Sign Out</button>
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
  const { role, user } = useAuth()
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const checkOnboarding = async () => {
      if (role === 'customer' || !user?.id) { setChecking(false); return }
      try {
        // Check if employee record exists and onboarding is complete
        const { data: emp } = await supabase
          .from('employees')
          .select('id')
          .eq('user_id', user.id)
          .limit(1)
        if (!emp || emp.length === 0) {
          // No employee record — show onboarding for non-customer users
          setShowOnboarding(true)
        } else {
          // Check digital file
          const { data: file } = await supabase
            .from('employee_digital_files')
            .select('onboarding_completed')
            .eq('employee_id', emp[0].id)
            .single()
          if (!file || !file.onboarding_completed) {
            setShowOnboarding(true)
          }
        }
      } catch {
        // Tables might not exist yet — don't block the user
      }
      setChecking(false)
    }
    checkOnboarding()
  }, [user?.id, role])

  if (checking) return <div className="flex justify-center items-center h-screen"><div className="w-8 h-8 border-4 border-slate-200 border-t-[#009944] rounded-full animate-spin" /></div>
  if (showOnboarding) return <OnboardingFlow onComplete={() => setShowOnboarding(false)} />
  return role === 'customer' ? <CustomerDashboard /> : <Dashboard />
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/attendance-terminal" element={<AttendanceTerminal />} />
          <Route path="/" element={<Protected><Home /></Protected>} />
          <Route path="/onboarding/:token" element={<OnboardingForm />} />
          <Route path="/guarantor-verification/:token" element={<GuarantorVerificationForm />} />
          {protectedRoutes.filter((route) => route.path !== '/').map((route) => (
            <Route key={route.path} path={route.path} element={<Protected><ProtectedModule route={route} /></Protected>} />
          ))}
          <Route path="/customers/:id" element={<Protected><ProtectedModule route={{ path: '/customers', element: 'Customers', permissions: ['customers.read'] }} /></Protected>} />
          <Route path="/employees/:id" element={<Protected><ProtectedModule route={{ path: '/employees', element: 'EmployeeProfile', permissions: ['hr.employee.read'] }} /></Protected>} />
          <Route path="/onboarding-review/:id" element={<Protected><ProtectedModule route={{ path: '/onboarding-links', element: 'OnboardingReview', permissions: ['hr.onboarding.read'] }} /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
