import React, { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Menu, X, LogOut } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import Logo from './Logo'
import { canAccessRoute, routeConfig } from '../config/navigation'
import NotificationBell from './NotificationBell'
import PersonAvatar from './messages/PersonAvatar'
import { resolveDirectory } from '../services/corporateChatService'
import Sara from './sara/Sara'
import OnboardingFlow from './OnboardingFlow'
import OnboardingStatusBanner from './OnboardingStatusBanner'
import onboardingStatusService, { ONBOARDING_STATES } from '../services/onboardingStatusService'
import {
  clearOnboardingDismiss,
  dismissInitialOnboarding,
  dismissOnboardingBanner,
  isInitialOnboardingDismissed,
  isOnboardingBannerDismissed,
} from '../utils/onboardingState'

export default function Layout({ children }) {
  const [open, setOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingStatus, setOnboardingStatus] = useState(null)
  const [onboardingLoading, setOnboardingLoading] = useState(true)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [onboardingRefreshKey, setOnboardingRefreshKey] = useState(0)
  const [identityMap, setIdentityMap] = useState(null)
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const { user, profile, role, roleMetadata, name, email, signOut } = auth
  const { actualRole } = auth
  const groups = routeConfig
    .map((group) => ({ ...group, items: group.items.filter((item) => canAccessRoute(item, auth)) }))
    .filter((group) => group.items.length > 0)

  const logout = async () => {
    await signOut()
    navigate('/login')
  }

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }

  // Self identity for the sidebar avatar (real name + profile photo when set).
  useEffect(() => {
    if (!user?.id) { setIdentityMap(null); return }
    let active = true
    resolveDirectory([user.id])
      .then((map) => { if (active) setIdentityMap(map) })
      .catch(() => {})
    return () => { active = false }
  }, [user?.id])

  // Onboarding is read once per authenticated user, not once per pathname.
  // The server-backed status decides whether a wizard is appropriate; local
  // storage only suppresses a reminder the user has explicitly dismissed.
  useEffect(() => {
    let active = true
    const load = async () => {
      setOnboardingLoading(true)
      setShowOnboarding(false)
      setOnboardingStatus(null)
      if (!user?.id || !profile || (profile.status && profile.status !== 'active') || actualRole === 'customer') {
        setOnboardingLoading(false)
        return
      }

      const status = await onboardingStatusService.getMyStatus(user.id)
      if (!active) return
      setOnboardingStatus(status)
      setBannerDismissed(isOnboardingBannerDismissed(user.id))

      // Admin identities without an employee record are not candidates for
      // self-service onboarding. Other working roles may enter it once.
      const canPromptInitial = !['super_admin', 'admin'].includes(actualRole)
      if (status?.state === ONBOARDING_STATES.NOT_STARTED && canPromptInitial && !isInitialOnboardingDismissed(user.id)) {
        setShowOnboarding(true)
      }
      setOnboardingLoading(false)
    }
    load()
    return () => { active = false }
  }, [actualRole, onboardingRefreshKey, profile, user?.id])

  const openOnboarding = () => {
    if (user?.id) {
      clearOnboardingDismiss(user.id)
      setBannerDismissed(false)
    }
    setShowOnboarding(true)
  }

  const closeOnboarding = () => {
    if (user?.id && onboardingStatus?.state === ONBOARDING_STATES.NOT_STARTED) {
      dismissInitialOnboarding(user.id)
    }
    setShowOnboarding(false)
  }

  const completeOnboarding = () => {
    if (user?.id) clearOnboardingDismiss(user.id)
    setShowOnboarding(false)
    setOnboardingStatus((current) => current ? { ...current, state: ONBOARDING_STATES.COMPLETED, progress: 100 } : current)
    setOnboardingRefreshKey((key) => key + 1)
  }

  const dismissBanner = () => {
    if (user?.id) dismissOnboardingBanner(user.id)
    setBannerDismissed(true)
  }

  const showBanner = !onboardingLoading
    && !showOnboarding
    && !bannerDismissed
    && onboardingStatus
    && onboardingStatus.state !== ONBOARDING_STATES.COMPLETED
    && (onboardingStatus.employeeId || !['super_admin', 'admin'].includes(actualRole))

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      {open && <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed lg:static inset-y-0 left-0 z-40 w-72 bg-[#0a0b0d] text-white flex flex-col transition-transform duration-300 ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="flex items-center gap-3 px-6 h-20 border-b border-white/10">
          <Logo size={36} variant="light" />
          <button onClick={() => setOpen(false)} className="ml-auto lg:hidden text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.section}>
              <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-white/35">{group.section}</div>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = isActive(item.path)
                  const Icon = item.icon
                  return (
                    <Link key={item.path} to={item.path} onClick={() => setOpen(false)} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${active ? 'bg-[#009944] text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`}>
                      <Icon className="w-[18px] h-[18px]" /> {item.label}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-white/10">
          <Link to="/profile" onClick={() => setOpen(false)} className="flex items-center gap-3 mb-3 hover:bg-white/5 rounded-lg p-1 -m-1 transition-colors">
            <PersonAvatar person={identityMap?.[user?.id] || { full_name: name, email }} sizeClass="w-9 h-9" textClass="text-sm" />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{name}</div>
              <div className="text-[11px] text-white/50 truncate">{roleMetadata?.label || role}</div>
            </div>
          </Link>
          <button onClick={logout} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-white/60 hover:bg-white/5 hover:text-white">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-md border-b border-slate-200 h-16 flex items-center px-4 lg:px-8">
          <button onClick={() => setOpen(true)} className="lg:hidden text-slate-600 mr-3"><Menu className="w-6 h-6" /></button>
          <div>
            <h1 className="font-semibold text-slate-800">InfinityCore Operations</h1>
            <p className="text-xs text-slate-400">AUTH STATUS: {email ? 'Authenticated' : 'Not authenticated'}</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 lg:px-8 py-6">
            {showBanner && <OnboardingStatusBanner status={onboardingStatus} onContinue={openOnboarding} onDismiss={dismissBanner} />}
            {children}
          </div>
        </main>
      </div>
      <Sara />
      {showOnboarding && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Employee onboarding">
          <div className="flex min-h-full items-center justify-center">
            <div className="w-full max-w-2xl overflow-hidden rounded-2xl shadow-2xl">
              <OnboardingFlow embedded onComplete={completeOnboarding} onDismiss={closeOnboarding} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
