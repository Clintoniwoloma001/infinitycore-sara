import React from 'react'
import { Link } from 'react-router-dom'
import Logo from '../../components/Logo'

// Branded public wrapper for the candidate-facing career pages. These pages
// are intentionally OUTSIDE the authenticated Layout (like OnboardingForm).

export default function CareersShell({ children, compact = false }) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/careers" className="flex items-center gap-2.5">
            <Logo size={28} />
            <div>
              <div className="text-sm font-bold text-slate-900 leading-none">Infinity Microfinance Bank Careers</div>
              <div className="text-[11px] text-slate-400 mt-0.5">Join a bank building the future</div>
            </div>
          </Link>
          {!compact && <Link to="/" className="text-sm text-slate-500 hover:text-[#009944]">Sign in</Link>}
        </div>
      </header>
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-8">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-4 text-xs text-slate-400 flex items-center justify-between">
          <span>© {new Date().getFullYear()} Infinity Microfinance Bank. All rights reserved.</span>
          <span>Equal opportunity employer.</span>
        </div>
      </footer>
    </div>
  )
}