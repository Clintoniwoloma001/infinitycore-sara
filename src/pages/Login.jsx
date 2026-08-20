import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { promoteSuperadmin } from '../services/supabaseService'
import Logo from '../components/Logo'

export default function Login() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'signin') await signIn(email, password)
      else await signUp(email, password)
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0b0d] px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <Logo size={60} showTagline variant="light" className="mb-1" />
        </div>
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="flex gap-2 mb-6 p-1 bg-slate-100 rounded-lg">
            <button onClick={() => setMode('signin')} className={`flex-1 py-2 rounded-md text-sm font-medium transition ${mode === 'signin' ? 'bg-white text-slate-900 shadow' : 'text-slate-500'}`}>Sign In</button>
            <button onClick={() => setMode('signup')} className={`flex-1 py-2 rounded-md text-sm font-medium transition ${mode === 'signup' ? 'bg-white text-slate-900 shadow' : 'text-slate-500'}`}>Sign Up</button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="mt-1 w-full h-11 rounded-lg border border-slate-300 px-3 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
            </div>
            {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg p-3">{error}</div>}
            <button type="submit" disabled={busy} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50">
              {busy ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
          {mode === 'signup' && (
            <p className="text-xs text-slate-400 mt-4 text-center">New users are assigned the "staff" role by default. An admin can promote you from User Management.</p>
          )}
        </div>
      </div>
    </div>
  )
}
