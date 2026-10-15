import React, { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../hooks/useAuth'
import Logo from '../components/Logo'
import {
  MIN_PASSWORD_LENGTH,
  decideRecoveryEntry,
  passwordRules,
  mapRecoveryError,
  isSessionGoneError,
} from '../utils/passwordReset'

// Public route (registered OUTSIDE the auth guards in App.jsx): users with a
// pending/suspended profile and signed-out users must both be able to reset.
export default function ResetPassword() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { completePasswordReset } = useAuth()

  // status: 'verifying' | 'ready' | 'invalid' | 'success'
  const [status, setStatus] = useState('verifying')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  // React StrictMode runs effects twice in dev; verifyOtp must run exactly once
  // (the recovery token_hash is single-use).
  const bootedRef = useRef(false)

  const tokenHash = searchParams.get('token_hash')
  const tokenType = searchParams.get('type')

  useEffect(() => {
    if (!bootedRef.current) {
      bootedRef.current = true
      const entry = decideRecoveryEntry({ tokenHash, type: tokenType })
      const run = async () => {
        if (entry === 'invalid') {
          setStatus('invalid')
          return
        }
        if (entry === 'verify') {
          setStatus('verifying')
          const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' })
          if (error) {
            setStatus('invalid')
            return
          }
          // Clean the single-use token out of the URL.
          setSearchParams({}, { replace: true })
          setStatus('ready')
          return
        }
        // No params: only proceed when a recovery session already exists
        // (redirect path where the token was consumed before navigation).
        const { data } = await supabase.auth.getSession()
        setStatus(data?.session ? 'ready' : 'invalid')
      }
      run()
    }

    // Fallback: the redirect path may establish the recovery session slightly
    // after mount (or on a later navigation) — treat it as verified.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setSearchParams({}, { replace: true })
        setStatus('ready')
      }
    })
    return () => subscription.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rules = passwordRules(password, confirm, MIN_PASSWORD_LENGTH)

  const submit = async (e) => {
    e.preventDefault()
    if (!rules.valid || submitting) return
    setFormError('')
    setSubmitting(true)
    try {
      await completePasswordReset(password)
      // End every OTHER session; this device keeps the (fresh) session until
      // the local sign-out below.
      try { await supabase.auth.signOut({ scope: 'others' }) } catch { /* best-effort */ }
      setStatus('success')
      setTimeout(async () => {
        try { await supabase.auth.signOut() } catch { /* best-effort */ }
        window.location.hash = '#/login'
      }, 2000)
    } catch (err) {
      if (isSessionGoneError(err)) {
        setStatus('invalid')
      } else {
        setFormError(mapRecoveryError(err, MIN_PASSWORD_LENGTH))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const requestNewLink = () => navigate('/forgot-password')

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0b0d] px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <Logo size={60} showTagline variant="light" className="mb-1" />
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          {status === 'verifying' && (
            <div className="flex flex-col items-center py-8">
              <Loader2 size={32} className="animate-spin text-[#009944]" />
              <p className="text-sm text-slate-500 mt-4">Verifying your reset link…</p>
            </div>
          )}

          {status === 'invalid' && (
            <div className="text-center">
              <h1 className="text-lg font-semibold text-slate-900 mb-2">This reset link is no longer valid</h1>
              <p className="text-sm text-slate-500 mb-6">
                Reset links can only be used once and expire after 1 hour. Request a new link and we'll email you another one.
              </p>
              <button
                type="button"
                onClick={requestNewLink}
                className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium"
              >
                Request a new link
              </button>
            </div>
          )}

          {status === 'success' && (
            <div className="text-center">
              <div className="text-sm text-emerald-700 bg-emerald-50 rounded-lg p-3 mb-4">Password updated</div>
              <p className="text-sm text-slate-500">Sign in with your new password…</p>
            </div>
          )}

          {status === 'ready' && (
            <>
              <h1 className="text-lg font-semibold text-slate-900 text-center mb-1">Set a new password</h1>
              <p className="text-sm text-slate-500 text-center mb-6">Choose a password for your Infinity Core account.</p>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-700">New password</label>
                  <div className="relative mt-1">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      className="w-full h-11 rounded-lg border border-slate-300 px-3 pr-11 focus:outline-none focus:ring-2 focus:ring-[#009944]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Confirm new password</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                    className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]"
                  />
                </div>
                <ul className="space-y-1">
                  {rules.checks.map((check) => (
                    <li key={check.id} className={`text-xs flex items-center gap-2 ${check.ok ? 'text-emerald-600' : 'text-slate-400'}`}>
                      <span aria-hidden>{check.ok ? '✓' : '○'}</span> {check.label}
                    </li>
                  ))}
                </ul>
                {formError && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{formError}</div>}
                <button
                  type="submit"
                  disabled={!rules.valid || submitting}
                  className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50"
                >
                  {submitting ? 'Updating…' : 'Update password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
