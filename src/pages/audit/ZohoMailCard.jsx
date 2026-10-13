// ============================================================================
// ZohoMailCard — Audit Command Centre (Head of Audit / admin only)
// ============================================================================
// The Connect / Test-Connection UI for the Zoho Mail OAuth foundation.
//
// This is deliberately a SELF-CONTAINED component with its own hooks. It is
// rendered by AuditCommandCenter only when `canManage` is true, so injecting it
// cannot change the parent page's hook order (the class of bug Phase 73 fixed).
//
// All OAuth work is server-side (src/services/zohoMailService.js): this card
// only (a) opens the server-built authorize URL, (b) reads a MASKED status, and
// (c) runs the no-send verification test. It NEVER sees the client secret, the
// refresh/access token, or the encryption key, and it NEVER sends email.
//
// The role gate here mirrors the server (zoho-mail-status allows only
// super_admin / admin / head_of_audit). `canManage` is the same set, so this
// card is drawn only for someone the server would also allow.
import React, { useCallback, useEffect, useState } from 'react'
import { Mail, RefreshCw, Loader2, CheckCircle2, AlertTriangle, ShieldCheck, PlugZap } from 'lucide-react'
import {
  connectZohoMail,
  getZohoMailStatus,
  testZohoMailConnection,
} from '../../services/zohoMailService'
import { SectionCard } from './auditUi'

const primaryBtn = 'inline-flex items-center gap-1.5 rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-50'
const ghostBtn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50'

function StatusPill({ status }) {
  if (!status) return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">Unknown</span>
  if (status.connected && status.ok !== false) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Connected</span>
  }
  if (status.connected) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />Connected — verify</span>
  }
  if (status.configured === false) {
    return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">Not configured</span>
  }
  return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">Not connected</span>
}

export default function ZohoMailCard() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState(null)   // { tone: 'ok'|'error', text }
  const [test, setTest] = useState(null)       // last no-send test result

  const refresh = useCallback(async () => {
    setLoading(true)
    const s = await getZohoMailStatus()
    setStatus(s)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const onConnect = async () => {
    setNotice(null); setConnecting(true)
    try {
      const res = await connectZohoMail()
      if (res?.ok) {
        setNotice({ tone: 'ok', text: 'Zoho Mail authorized. Run "Test connection" to verify the sending mailbox. No email was sent.' })
        setTest(null)
        await refresh()
      } else if (res?.cancelled) {
        setNotice({ tone: 'error', text: 'Authorization was cancelled before it completed.' })
      } else {
        setNotice({ tone: 'error', text: res?.error || 'Could not start Zoho authorization.' })
      }
    } finally {
      setConnecting(false)
    }
  }

  const onTest = async () => {
    setNotice(null); setTesting(true)
    try {
      const res = await testZohoMailConnection()
      setTest(res)
      if (res?.ok) {
        setNotice({ tone: 'ok', text: res.message || 'Connection verified. No email was sent.' })
      } else {
        setNotice({ tone: 'error', text: res?.message || res?.error || 'The connection test did not pass.' })
      }
      await refresh()
    } catch (e) {
      setNotice({ tone: 'error', text: e.message || 'Connection test failed.' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <SectionCard
      title="Zoho Mail (audit reminders)"
      description="Connect the Head of Audit mailbox for future audit-reminder email. Sending stays disabled until explicitly enabled — this only connects and verifies."
      action={
        <div className="flex items-center gap-2">
          <button onClick={refresh} className={ghostBtn} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</button>
          <button onClick={onConnect} className={primaryBtn} disabled={connecting}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            {status?.connected ? 'Reconnect' : 'Connect Zoho Mail'}
          </button>
          <button onClick={onTest} className={ghostBtn} disabled={testing || !status?.connected}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Test connection
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 text-slate-600"><Mail className="h-4 w-4 text-slate-400" />Status</span>
          <StatusPill status={status} />
          {status?.scopes && (
            <span className="text-xs text-slate-400">Scopes: <code className="rounded bg-slate-100 px-1 py-0.5">{status.scopes}</code></span>
          )}
        </div>

        {notice && (
          <p className={`rounded-lg px-3 py-2 text-sm ${notice.tone === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {notice.text}
          </p>
        )}

        {test?.ok && (
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/40 p-3 text-sm">
            <div className="font-medium text-emerald-800">Verified sending mailbox</div>
            <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              <div><dt className="inline text-slate-500">Account ID: </dt><dd className="inline font-mono text-slate-800">{test.accountId || '—'}</dd></div>
              <div><dt className="inline text-slate-500">Primary address: </dt><dd className="inline text-slate-800">{test.primaryEmail || '—'}</dd></div>
              <div className="sm:col-span-2"><dt className="inline text-slate-500">Permitted From addresses: </dt><dd className="inline text-slate-800">{(test.fromAddresses || []).join(', ') || '—'}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-slate-500">
              Sending is <strong>not</strong> enabled (readyToSend is false). No email was sent by this test.
            </p>
          </div>
        )}

        {test && !test.ok && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
            {test.message || test.error || 'The test did not pass. Check the server configuration and the granted Zoho scopes.'}
          </p>
        )}

        <p className="text-xs text-slate-400">
          Authorization runs server-side. The browser never sees the client secret, refresh token, or encryption key.
        </p>
      </div>
    </SectionCard>
  )
}

