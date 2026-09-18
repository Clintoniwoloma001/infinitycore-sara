import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, LockKeyhole, Mail } from 'lucide-react'
import Logo from '../components/Logo'
import { supabase } from '../supabaseClient'
import { useAuth } from '../hooks/useAuth'

const MIN_PASSWORD_LENGTH = 8

function readAuthParams() {
  const query = new URLSearchParams(window.location.search)
  const rawHash = window.location.hash.replace(/^#/, '')
  const hashParts = rawHash.split('#')
  const routePart = hashParts[0] || ''
  const hashQuery = routePart.includes('?') ? routePart.split('?').slice(1).join('?') : ''
  const routeParams = new URLSearchParams(hashQuery)
  const authPart = hashParts.length > 1
    ? hashParts.slice(1).join('#')
    : (routePart.startsWith('/') ? '' : routePart)
  const authParams = new URLSearchParams(authPart)

  const get = (key) => query.get(key) || routeParams.get(key) || authParams.get(key) || ''
  return {
    accessToken: get('access_token'),
    refreshToken: get('refresh_token'),
    code: get('code'),
    tokenHash: get('token_hash'),
    type: get('type'),
  }
}

function clearAuthParams() {
  const cleanUrl = `${window.location.pathname}#/activate-account`
  window.history.replaceState({}, document.title, cleanUrl)
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function activationError(code) {
  if (code === 'expired') return 'This invitation has expired. Ask HR to send a new invitation.'
  if (code === 'revoked') return 'This invitation is no longer valid. Ask HR to send a new invitation.'
  if (code === 'email_mismatch') return 'This invitation is for a different email address and cannot be used here.'
  if (code === 'already_activated') return 'This InfinityCore account has already been activated. Use the normal sign-in page.'
  return 'This invitation is invalid or has already been used. Ask HR to send a new invitation.'
}

export default function ActivateAccount() {
  const navigate = useNavigate()
  const { refreshProfile } = useAuth()
  const [email, setEmail] = useState('')
  const [context, setContext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [complete, setComplete] = useState(false)

  useEffect(() => {
    let mounted = true

    const initialize = async () => {
      setLoading(true)
      setError('')
      try {
        const params = readAuthParams()

        if (params.code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(params.code)
          if (exchangeError) throw exchangeError
        } else if (params.tokenHash) {
          const tokenType = params.type === 'recovery' ? 'recovery' : 'invite'
          const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: params.tokenHash, type: tokenType })
          if (verifyError) throw verifyError
        } else if (params.accessToken && params.refreshToken) {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: params.accessToken,
            refresh_token: params.refreshToken,
          })
          if (sessionError) throw sessionError
        }

        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user?.email) throw new Error('invalid_invitation')

        const sessionEmail = session.user.email
        // Do not leave access/recovery tokens in browser history after the
        // session has been established, even if invitation validation fails.
        clearAuthParams()
        const { data: invitation, error: invitationError } = await supabase.rpc('get_employee_invitation_context')
        if (invitationError) throw invitationError
        if (!invitation?.ok) {
          if (mounted) setEmail(sessionEmail)
          throw new Error(invitation?.code || 'invalid_invitation')
        }
        if (invitation.email && normalizeEmail(invitation.email) !== normalizeEmail(sessionEmail)) {
          throw new Error('email_mismatch')
        }

        if (mounted) {
          setEmail(invitation.email || sessionEmail)
          setContext(invitation)
        }
      } catch (e) {
        if (mounted) setError(activationError(e?.message || e?.code))
      } finally {
        if (mounted) setLoading(false)
      }
    }

    initialize()
    return () => { mounted = false }
  }, [])

  const validatePassword = () => {
    if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return 'Use at least one uppercase letter, one lowercase letter, and one number.'
    }
    if (password !== confirmPassword) return 'Passwords do not match.'
    return ''
  }

  const submit = async (event) => {
    event.preventDefault()
    const validationError = validatePassword()
    if (validationError) {
      setError(validationError)
      return
    }

    setSaving(true)
    setError('')
    try {
      const { error: passwordError } = await supabase.auth.updateUser({ password })
      if (passwordError) throw passwordError

      const { data: activation, error: activationRpcError } = await supabase.rpc('activate_employee_invitation')
      if (activationRpcError) throw activationRpcError
      if (!activation?.ok && activation?.code !== 'already_activated') {
        throw new Error(activation?.code || 'activation_failed')
      }

      await refreshProfile()
      setComplete(true)
      setTimeout(() => navigate('/', { replace: true }), 900)
    } catch (e) {
      setError(e?.message?.includes('expired') ? activationError('expired') : activationError(e?.message || 'activation_failed'))
    } finally {
      setSaving(false)
    }
  }

  const shell = (children) => (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0b0d] px-4 py-8">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-7"><Logo size={60} showTagline variant="light" /></div>
        <div className="bg-white rounded-2xl shadow-2xl p-7 sm:p-8">{children}</div>
      </div>
    </div>
  )

  if (loading) {
    return shell(<div className="py-12 flex justify-center"><Loader2 className="w-8 h-8 text-[#009944] animate-spin" /></div>)
  }

  if (complete) {
    return shell(
      <div className="text-center py-7">
        <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4"><CheckCircle2 className="w-7 h-7 text-emerald-600" /></div>
        <h1 className="text-xl font-semibold text-slate-900">Account activated</h1>
        <p className="text-sm text-slate-500 mt-2">Your password is saved. Taking you to InfinityCore…</p>
      </div>
    )
  }

  if (error || !context) {
    return shell(
      <div className="text-center py-5">
        <div className="w-14 h-14 rounded-full bg-rose-100 flex items-center justify-center mx-auto mb-4"><AlertCircle className="w-7 h-7 text-rose-600" /></div>
        <h1 className="text-xl font-semibold text-slate-900">Invitation unavailable</h1>
        <p className="text-sm text-slate-500 mt-2">{error || activationError('invalid_invitation')}</p>
        <button onClick={() => navigate('/login')} className="mt-6 w-full h-11 rounded-lg bg-[#009944] text-white font-medium hover:bg-[#007a35]">Go to Sign In</button>
      </div>
    )
  }

  return shell(
    <>
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-3"><LockKeyhole className="w-6 h-6 text-[#009944]" /></div>
        <h1 className="text-2xl font-semibold text-slate-900">Welcome to InfinityCore</h1>
        <p className="text-sm text-slate-500 mt-2">Set Your Password</p>
        <p className="text-xs text-slate-400 mt-1">Your InfinityCore account has been created. Set your password to activate your account.</p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
          <div className="relative">
            <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={email} readOnly aria-readonly="true" className="w-full h-11 rounded-lg border border-slate-200 bg-slate-50 px-3 pl-9 text-sm text-slate-600" />
          </div>
          <p className="text-xs text-slate-400 mt-1">This is the email address your InfinityCore invitation was sent to.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">New Password</label>
          <div className="relative">
            <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" required className="w-full h-11 rounded-lg border border-slate-300 px-3 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
            <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-1">At least 8 characters, including uppercase, lowercase, and a number.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm Password</label>
          <div className="relative">
            <input type={showConfirm ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" required className="w-full h-11 rounded-lg border border-slate-300 px-3 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
            <button type="button" onClick={() => setShowConfirm((value) => !value)} aria-label={showConfirm ? 'Hide confirmed password' : 'Show confirmed password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}
        <button type="submit" disabled={saving} className="w-full h-11 rounded-lg bg-[#009944] hover:bg-[#007a35] text-white font-medium disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Set Password'}
        </button>
      </form>
    </>
  )
}
