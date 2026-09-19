import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { promoteSuperadmin } from '../services/supabaseService'
import Logo from '../components/Logo'

export default function Login() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { signIn, signUp, forgotPassword } = useAuth()
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'signin') await signIn(email, password)
      else if (mode === 'signup') await signUp(email, password)
      else {
        await forgotPassword(resetEmail)
        setResetSent(true)
        setBusy(false)
        return
      }
      try {
        const res = await promoteSuperadmin(email)
        if (res?.promoted) { navigate('/'); return }
      } catch { /* best-effort */ }
      navigate('/')
    } catch (err) {
      setError(err.message || 'Authentication failed')
    } finally {
      setBusy(false)
    }
  }

  const backToSignIn = () => {
    setMode('signin')
    setResetSent(false)
    setError('')
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
              {resetSent ? (
                <div className="text-center">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm p-3 mb-4">
                    Reset link sent. Check your inbox (and spam) for the password reset email.
                  </div>
                  <button onClick={backToSignIn} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium">Back to Sign In</button>
                </div>
              ) : (
                <form onSubmit={submit} className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-slate-700">Email</label>
                    <input type="email" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} required className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                  </div>
                  {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{error}</div>}
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
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-700">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                </div>
                {mode === 'signin' && (
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-slate-700">Password</label>
                      <button type="button" onClick={() => { setMode('forgot'); setError('') }} className="text-xs text-[#009944] hover:text-[#007a35] font-medium">Forgot password?</button>
                    </div>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                  </div>
                )}
                {mode === 'signup' && (
                  <div>
                    <label className="text-sm font-medium text-slate-700">Password</label>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
                  </div>
                )}
                {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{error}</div>}
                <button type="submit" disabled={busy} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50">
                  {busy ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
                </button>
              </form>
              {mode === 'signup' && (
                <p className="text-xs text-slate-400 mt-4 text-center">New accounts start as pending customers. An administrator must approve your account before you can access the system.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
