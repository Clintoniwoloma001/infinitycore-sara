import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Menu, X, LogOut } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import Logo from './Logo'
import { canAccessRoute, routeConfig } from '../config/navigation'
import NotificationBell from './NotificationBell'
import Sara from './sara/Sara'

export default function Layout({ children }) {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const { role, roleMetadata, name, email, signOut } = auth
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
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-full bg-[#FF8C00] flex items-center justify-center text-black font-semibold text-sm">{name?.charAt(0)?.toUpperCase()}</div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{name}</div>
              <div className="text-[11px] text-white/50 truncate">{roleMetadata?.label || role}</div>
            </div>
          </div>
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
          <div className="max-w-7xl mx-auto px-4 lg:px-8 py-6">{children}</div>
        </main>
      </div>
      <Sara />
    </div>
  )
}
