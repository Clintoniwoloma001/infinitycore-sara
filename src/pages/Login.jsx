import React, { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { isLoginEmployeeId } from '../utils/employeeId'
import { FORGOT_NEUTRAL_MESSAGE, isCooldownError } from '../utils/passwordReset'
import Logo from '../components/Logo'

export default function Login() {
  // Shareable alias #/forgot-password opens the page directly in forgot mode.
  const location = useLocation()
  const [mode, setMode] = useState(() => (location.pathname === '/forgot-password' ? 'forgot' : 'signin')) // 'signin' | 'signup' | 'forgot'
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const { signIn, signInWithIdentifier, requestEmployeeIdSignup, forgotPassword } = useAuth()
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    setSent(false)
    try {
      if (mode === 'forgot') {
        // Neutral response by design: never reveal whether the email exists.
        try {
          await forgotPassword(identifier)
        } catch (err) {
          if (isCooldownError(err)) setError('Please wait a minute before requesting another link')
        }
        setSent(true)
        return
      }
      if (mode === 'signin') {
        // Employee-ID path: passwordless magic link; the browser never learns
        // the resolved email. No session exists yet, so we stay on the page.
        if (isLoginEmployeeId(identifier)) {
          await signInWithIdentifier(identifier)
          setSent(true)
          return
        }
        await signIn(identifier, password)
        // promoteSuperadmin is email-only and best-effort.
        try {
          const { promoteSuperadmin } = await import('../services/supabaseService')
          const res = await promoteSuperadmin(identifier)
          if (res?.promoted) { navigate('/'); return }
        } catch { /* best-effort */ }
        navigate('/')
        return
      }
      // mode === 'signup': passwordless employee-ID invitation.
      await requestEmployeeIdSignup(identifier)
      setSent(true)
    } catch (err) {
      setError(err.message || 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const backToSignIn = () => {
    setMode('signin')
    setPassword('')
    setError('')
    setSent(false)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0b0d] px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <Logo size={60} showTagline variant="light" className="mb-1" />
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          {mode === 'forgot' ? (
            <div>
              <h1 className="text-lg font-semibold text-slate-900 text-center mb-1">Forgot password</h1>
              <p className="text-sm text-slate-500 text-center mb-6">Enter your email and we'll send you a link to reset your password on InfinityCore.</p>
              {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3 mb-4">{error}</div>}
              {sent ? (
                <div className="space-y-4">
                  <div className="text-sm text-emerald-700 bg-emerald-50 rounded-lg p-3">{FORGOT_NEUTRAL_MESSAGE}</div>
                  <button type="button" onClick={backToSignIn} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium">Back to Sign In</button>
                </div>
              ) : (
                <form onSubmit={submit} className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-slate-700">Email</label>
                    <input type="email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                  </div>
                  <button type="submit" disabled={busy} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50">
                    {busy ? 'Sending…' : 'Send Reset Link'}
                  </button>
                  <button type="button" onClick={backToSignIn} className="w-full text-sm text-slate-500 hover:text-slate-700">Back to Sign In</button>
                </form>
              )}
            </div>
          ) : (
            <>
              <div className="flex gap-2 mb-6 p-1 bg-slate-100 rounded-lg">
                <button onClick={() => setMode('signin')} className={`flex-1 py-2 rounded-md text-sm font-medium transition ${mode === 'signin' ? 'bg-white text-slate-900 shadow' : 'text-slate-500'}`}>Sign In</button>
                <button onClick={() => setMode('signup')} className={`flex-1 py-2 rounded-md text-sm font-medium transition ${mode === 'signup' ? 'bg-white text-slate-900 shadow' : 'text-slate-500'}`}>Sign Up</button>
              </div>

              {mode === 'signin' ? (
                <form onSubmit={submit} className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-slate-700">Email or Employee ID</label>
                    <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required placeholder="Email or employee ID" className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                    {sent && isLoginEmployeeId(identifier) && identifier && (
                      <p className="text-xs text-emerald-600 mt-1.5">Magic link sent — check your inbox (and spam).</p>
                    )}
                  </div>

                  {!isLoginEmployeeId(identifier) && (
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-slate-700">Password</label>
                        <button type="button" onClick={() => { setMode('forgot'); setError('') }} className="text-xs text-[#009944] hover:text-[#007a35] font-medium">Forgot password?</button>
                      </div>
                      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                    </div>
                  )}

                  {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{error}</div>}

                  <button type="submit" disabled={busy} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50">
                    {busy ? 'Please wait…' : 'Sign In'}
                  </button>
                </form>
              ) : (
                sent ? (
                  <div className="space-y-4">
                    <div className="text-sm text-emerald-700 bg-emerald-50 rounded-lg p-3">
                      If an account exists for this employee, an invitation has been sent. Check your inbox (and spam), then set your password on the activation page.
                    </div>
                    <button type="button" onClick={backToSignIn} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium">Back to Sign In</button>
                  </div>
                ) : (
                  <form onSubmit={submit} className="space-y-4">
                    <div>
                      <label className="text-sm font-medium text-slate-700">Employee ID</label>
                      <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required placeholder="e.g. IMFB/26 or IMFB/14/0046" className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                      <p className="text-xs text-slate-400 mt-1.5">No password needed — an invitation will be emailed on record.</p>
                    </div>
                    {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{error}</div>}
                    <button type="submit" disabled={busy} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50">
                      {busy ? 'Creating account…' : 'Create Account'}
                    </button>
                  </form>
                )
              )}

              {mode === 'signin' && (
                <p className="text-xs text-slate-400 mt-4 text-center">
                  New to InfinityCore?{' '}
                  <button type="button" onClick={() => setMode('signup')} className="text-[#009944] hover:text-[#007a35] font-medium">
                    Sign up with your Employee ID
                  </button>
                </p>
              )}
              {mode === 'signup' && (
                <p className="text-xs text-slate-400 mt-4 text-center">
                  An invitation will be emailed on record — set your password on the activation page.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
