import React, { useEffect, useState } from 'react'
import {
  ArchiveRestore, ArrowLeft, BarChart3, Download, Eye, Flag, FileText, Layers,
  Loader2, RefreshCw, ScrollText, ShieldAlert, X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import {
  channels as channelSvc, getCommunicationStats, listAuditLog, listReports,
  resolveReport, messageActions, listHolds, createHold, releaseHold,
  listRetentionPolicies, setRetentionPolicy, listExports, exportRecords,
  buildExportFile, resolveDirectory, listMessagingDirectory, directChat,
} from '../services/corporateChatService'

const ADMIN_ROLES = ['super_admin', 'admin', 'head_of_human_resources', 'hr_officer']

const STATUS_STYLE = {
  open: 'text-rose-700 bg-rose-50 border-rose-200',
  investigating: 'text-amber-700 bg-amber-50 border-amber-200',
  resolved: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  dismissed: 'text-slate-500 bg-slate-50 border-slate-200',
}

const SECTIONS = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'channels', label: 'Channels', icon: Layers },
  { key: 'moderation', label: 'Moderation', icon: Flag },
  { key: 'audit', label: 'Audit log', icon: ScrollText },
  { key: 'retention', label: 'Retention & Holds', icon: ShieldAlert },
  { key: 'exports', label: 'Exports', icon: Download },
  // Super Admin only — global DM transparency (spec Part 2).
  { key: 'dm_inspection', label: 'DM Inspection', icon: Eye, superOnly: true },
]

export default function CommunicationAdmin() {
  const { profile } = useAuth()
  const isAdmin = ADMIN_ROLES.includes(profile?.role)
  const isSuper = profile?.role === 'super_admin'
  const [section, setSection] = useState('overview')

  if (!isAdmin) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
        <ShieldAlert className="w-10 h-10 text-rose-400 mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-slate-900">Access denied</h2>
        <p className="text-sm text-slate-500 mt-1">The Communication Administration Centre is restricted to authorized administrators and HR.</p>
      </div>
    )
  }

  const Section = ({ icon: Icon, label, children }) => (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
        <Icon className="w-4 h-4 text-[#009944]" />
        <p className="text-sm font-semibold text-slate-900">{label}</p>
      </div>
      {children}
    </div>
  )

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-slate-900">Communication Administration</h2>
        <p className="text-sm text-slate-500 mt-1">Channels, moderation, retention and exports for the corporate communication platform.</p>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5 bg-white border border-slate-200 rounded-xl p-1.5 w-fit">
        {SECTIONS.filter((s) => !s.superOnly || isSuper).map((s) => {
          const Icon = s.icon
          const on = section === s.key
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${on ? 'bg-[#009944] text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              <Icon className="w-4 h-4" /> {s.label}
            </button>
          )
        })}
      </div>

      <AdminBody section={section} Section={Section} isSuper={isSuper} />
    </div>
  )
}

function AdminBody({ section, Section, isSuper }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    if (section === 'overview') {
      getCommunicationStats().then(setStats).catch(() => {})
    }
  }, [section])

  if (section === 'overview') return <OverviewStats Section={Section} />
  if (section === 'channels') return <ChannelsAdmin Section={Section} />
  if (section === 'moderation') return <ModerationAdmin Section={Section} />
  if (section === 'audit') return <AuditAdmin Section={Section} />
  if (section === 'retention') return <RetentionAdmin Section={Section} />
  if (section === 'dm_inspection') return isSuper
    ? <DmInspection Section={Section} />
    : <Section icon={Eye} label="DM Inspection"><div className="p-5 text-sm text-slate-500">Restricted to the Super Admin role.</div></Section>
  return <ExportsAdmin Section={Section} />
}

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold text-slate-900 mt-1">{value ?? '—'}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function OverviewStats({ Section }) {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getCommunicationStats().then(setStats).catch((e) => setError(e?.message || 'Stats unavailable'))
  }, [])

  return (
    <Section icon={BarChart3} label="Platform overview">
      <div className="p-5">
        <div>
          {error && <div className="mb-3 text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Messages sent" value={stats?.messages_sent} />
            <StatCard label="Active groups" value={stats?.active_groups} />
            <StatCard label="Active channels" value={stats?.active_channels} />
            <StatCard label="Published announcements" value={stats?.published_announcements} />
            <StatCard label="Official records" value={stats?.official_records} sub="permanent, immutable" />
            <StatCard label="Acknowledgements" value={`${stats?.acknowledged ?? '—'} / ${stats?.ack_total ?? '—'}`} sub={`${stats?.acknowledgement_rate ?? 0}% completion`} />
            <StatCard label="Open moderation reports" value={stats?.open_reports} />
            <StatCard label="My unacknowledged (mandatory)" value={stats?.unread_mandatory_announcements ?? 0} sub="announcements needing your ack" />
          </div>
        </div>
      </div>
    </Section>
  )
}

function ChannelsAdmin({ Section }) {
  const [ls, setLs] = useState([])
  const [membersCount, setMembersCount] = useState({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await channelSvc.listAll()
      setLs(data || [])
      const counts = {}
      await Promise.all((data || []).map(async (c) => {
        try { const m = await channelSvc.members(c.id); counts[c.id] = m.length } catch (_) {}
      }))
      setMembersCount(counts)
    } catch (e) {
      setError(e?.message || 'Could not load channels')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const sync = async (id) => {
    setBusyId(id)
    setError('')
    try {
      const res = await channelSvc.syncAuto(id)
      const msg = res?.ok ? `Synced${res.added || res.removed ? ` (${res.added || 0} added, ${res.removed || 0} removed)` : ''}` : 'Synced'
      await load()
      alert(msg)
    } catch (e) {
      setError(e?.message || 'Sync failed')
    } finally {
      setBusyId(null)
    }
  }

  const bootstrap = async () => {
    setBusyId('__all__')
    setError('')
    try {
      const res = await channelSvc.ensureOrganizational()
      await load()
      alert(`Organizational channels ensured: ${res?.created || 0} created, ${res?.synced_channels || 0} synced.`)
    } catch (e) {
      setError(e?.message || 'Bootstrap failed')
    } finally {
      setBusyId(null)
    }
  }

  const typeTag = (c) => ({ branch: 'Branch', area: 'Area', department: 'Department', organization: 'Org', team: 'Team', announcement: 'Announcement', role: 'Role' })[c.channel_type] || c.channel_type

  return (
    <Section icon={Layers} label={`Channels (${ls.length})`}>
      <div className="px-5 pt-4 flex items-center gap-2">
        <button onClick={bootstrap} disabled={!!busyId} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
          {busyId === '__all__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Ensure organizational channels
        </button>
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
      <div className="p-5">
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline text-slate-300" /></td></tr>}
              {!loading && ls.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">No channels.</td></tr>}
              {ls.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-800">{c.display_name || c.name}</p>
                    <p className="text-xs text-slate-400 truncate max-w-[220px]">{c.description || ''}</p>
                  </td>
                  <td className="px-4 py-3"><span className="text-[11px] uppercase tracking-wide text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{typeTag(c)}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-500">{c.is_auto ? `${c.auto_source}${c.auto_source_role ? `/${c.auto_source_role}` : ''}` : 'manual'}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{membersCount[c.id] ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] rounded px-1.5 py-0.5 border ${c.status === 'active' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-slate-500 bg-slate-50 border-slate-200'}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {c.is_auto && (
                      <button onClick={() => sync(c.id)} disabled={!!busyId} className="inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline disabled:opacity-40">
                        {busyId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Sync members
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  )
}

function ModerationAdmin({ Section }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState({})

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listReports()
      setReports(data || [])
      await resolveDirectory((data || []).map((r) => r.reporter_id))
    } catch (e) {
      setError(e?.message || 'Could not load reports')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const act = async (report, status) => {
    setBusyId(report.id)
    setError('')
    try {
      await resolveReport(report.id, status, note[report.id] || '')
      await load()
    } catch (e) {
      setError(e?.message || 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  const restrict = async (report) => {
    if (!window.confirm('Restrict (remove) this message for all members? The original record is preserved.')) return
    setBusyId(report.id)
    setError('')
    try {
      await messageActions.restrict(report.message_id, 'removed by moderation')
      await resolveReport(report.id, 'resolved', note[report.id] || 'message restricted by moderation')
      await load()
    } catch (e) {
      setError(e?.message || 'Could not restrict message')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Section icon={Flag} label={`Moderation queue (${reports.filter((r) => r.status === 'open' || r.status === 'investigating').length} open)`}>
      <div className="p-5">
        {error && <div className="mb-3 text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}
        <div className="space-y-3">
          {loading && <div className="py-10 text-center"><Loader2 className="w-5 h-5 animate-spin text-slate-300" /></div>}
          {!loading && reports.length === 0 && <div className="py-10 text-center text-sm text-slate-400">No reports. A clean environment is a happy one.</div>}
          {reports.map((r) => (
            <div key={r.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[11px] rounded px-1.5 py-0.5 border ${STATUS_STYLE[r.status] || STATUS_STYLE.open}`}>{r.status}</span>
                    <span className="text-xs font-medium text-slate-700">{r.reason?.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="text-sm text-slate-600 mt-1.5 capitalize">{r.details || 'No details provided'}</p>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Reported {new Date(r.created_at).toLocaleString()} · message {r.message_id?.slice(0, 8)}…
                  </p>
                </div>
                <div className="shrink-0 flex gap-2">
                  {r.status === 'open' && (
                    <button onClick={() => act(r, 'investigating')} disabled={!!busyId} className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-40">Investigate</button>
                  )}
                  <button onClick={() => restrict(r)} disabled={!!busyId} className="text-xs px-2.5 py-1.5 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40">Restrict message</button>
                  <button onClick={() => act(r, 'dismissed')} disabled={!!busyId} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">Dismiss</button>
                  <button onClick={() => act(r, 'resolved')} disabled={!!busyId} className="text-xs px-2.5 py-1.5 rounded-lg bg-[#009944] text-white hover:bg-[#007a36] disabled:opacity-40">Resolve</button>
                </div>
              </div>
              <input
                value={note[r.id] || ''}
                onChange={(e) => setNote((prev) => ({ ...prev, [r.id]: e.target.value }))}
                placeholder="Resolution note (optional)"
                className="mt-2 w-full h-9 rounded-lg border border-slate-200 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-[#009944]"
              />
            </div>
          ))}
        </div>
      </div>
    </Section>
  )
}

function AuditAdmin({ Section }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    listAuditLog(300)
      .then((d) => setLogs(d || []))
      .catch((e) => setError(e?.message || 'Could not load audit log'))
      .finally(() => setLoading(false))
  }, [])

  const entityName = (e) => e?.replace(/_/g, ' ')
  const actionName = (a) => a?.replace(/_/g, ' ')

  return (
    <Section icon={ScrollText} label="Communication audit trail">
      <div className="p-5">
        {error && <div className="mb-3 text-xs text-rose-600">{error}</div>}
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading && <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline text-slate-300" /></td></tr>}
              {!loading && logs.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">No audit entries.</td></tr>}
              {logs.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50/50 align-top">
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(l.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{l.actor_id?.slice(0, 8) || 'system'}…</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{entityName(l.entity_type)}</td>
                  <td className="px-4 py-3 text-xs text-slate-700">{actionName(l.action)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500 max-w-[320px] truncate" title={JSON.stringify(l.before_change || l.after_change || l.metadata)}>
                    {JSON.stringify(l.before_change || l.after_change || l.metadata || {})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 mt-2">Audit rows are append-only and written by the database for every communication action.</p>
      </div>
    </Section>
  )
}

function RetentionAdmin({ Section }) {
  const [policies, setPolicies] = useState([])
  const [holds, setHolds] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [days, setDays] = useState('')
  const [forever, setForever] = useState(false)
  const [holdForm, setHoldForm] = useState({ open: false, scope: 'channel', scopeId: '', reason: '', endDate: '' })
  const [channels, setChannels] = useState([])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [p, h] = await Promise.all([listRetentionPolicies(), listHolds()])
      setPolicies(p || [])
      setHolds(h || [])
    } catch (e) {
      setError(e?.message || 'Could not load retention data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    channelSvc.listAll().then((c) => setChannels(c || [])).catch(() => {})
  }, [])

  const savePolicy = async (key, label) => {
    setError('')
    try {
      await setRetentionPolicy(key, label, forever ? null : parseInt(days || '0', 10) || 0, forever)
      setEditing(null)
      load()
    } catch (e) {
      setError(e?.message || 'Could not save policy')
    }
  }

  const placeHold = async () => {
    setError('')
    try {
      if (!holdForm.reason.trim()) { setError('A reason is required'); return }
      if (!holdForm.scopeId && holdForm.scope !== 'conversation') { setError('Select a subject'); return }
      await createHold(holdForm.scope, holdForm.scopeId || null, holdForm.reason.trim(), holdForm.endDate ? new Date(holdForm.endDate).toISOString() : null)
      setHoldForm({ open: false, scope: 'channel', scopeId: '', reason: '', endDate: '' })
      load()
    } catch (e) {
      setError(e?.message || 'Could not place hold')
    }
  }

  const release = async (hold) => {
    if (!window.confirm('Release this retention hold?')) return
    setError('')
    try {
      await releaseHold(hold.id, 'released by administrator')
      load()
    } catch (e) {
      setError(e?.message || 'Could not release hold')
    }
  }

  return (
    <div className="space-y-4">
      <Section icon={ShieldAlert} label="Retention policies">
        <div className="p-5">
          {error && <div className="mb-3 text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}
          <div className="space-y-2">
            {loading && <div className="py-6 text-center"><Loader2 className="w-5 h-5 animate-spin text-slate-300" /></div>}
            {policies.map((p) => (
              <div key={p.id} className="rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800">{p.label}</p>
                  <p className="text-xs text-slate-400">{p.is_forever ? 'Keep forever' : `${p.retention_days ?? 0} days`} · key: {p.policy_key}</p>
                </div>
                {editing === p.id ? (
                  <div className="flex items-center gap-2">
                    <input type="number" value={days} onChange={(e) => setDays(e.target.value)} placeholder="Days" className="w-20 h-9 rounded-lg border border-slate-300 px-2 text-sm" />
                    <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} className="accent-[#009944]" /> Forever</label>
                    <button onClick={() => savePolicy(p.policy_key, p.label)} className="text-xs px-3 py-2 rounded-lg bg-[#009944] text-white hover:bg-[#007a36]">Save</button>
                    <button onClick={() => setEditing(null)} className="text-xs px-2 py-2 hover:text-slate-500"><X className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <button onClick={() => { setEditing(p.id); setDays(String(p.retention_days || '')); setForever(!!p.is_forever) }} className="text-xs font-medium text-[#009944] hover:underline">Edit</button>
                )}
              </div>
            ))}
            {!loading && policies.length === 0 && <div className="py-6 text-center text-sm text-slate-400">No retention policies configured.</div>}
          </div>
        </div>
      </Section>

      <Section icon={ArchiveRestore} label={`Retention holds (${holds.length})`}>
        <div className="px-5 pt-4">
          <button onClick={() => setHoldForm((f) => ({ ...f, open: !f.open }))} className="text-sm font-medium text-[#009944] hover:underline">
            {holdForm.open ? 'Cancel' : 'Place a retention hold'}
          </button>
        </div>
        <div className="p-5">
          {holdForm.open && (
            <div className="mb-4 rounded-xl border border-slate-200 p-4 space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-500 block mb-1">Scope</label>
                  <select value={holdForm.scope} onChange={(e) => setHoldForm((f) => ({ ...f, scope: e.target.value, scopeId: '' }))} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
                    <option value="channel">Channel</option>
                    <option value="group">Group</option>
                    <option value="conversation">Conversation (all)</option>
                    <option value="message">Message</option>
                  </select>
                </div>
                {holdForm.scope !== 'conversation' && (
                  <div>
                    <label className="text-xs font-medium text-slate-500 block mb-1">Subject</label>
                    {holdForm.scope === 'channel' ? (
                      <select value={holdForm.scopeId} onChange={(e) => setHoldForm((f) => ({ ...f, scopeId: e.target.value }))} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
                        <option value="">Select a channel…</option>
                        {channels.map((c) => <option key={c.id} value={c.id}>{c.display_name || c.name}</option>)}
                      </select>
                    ) : (
                      <input value={holdForm.scopeId} onChange={(e) => setHoldForm((f) => ({ ...f, scopeId: e.target.value }))} placeholder="ID" className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm" />
                    )}
                  </div>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-500 block mb-1">Reason *</label>
                  <input value={holdForm.reason} onChange={(e) => setHoldForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why is this under hold?" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500 block mb-1">End date (optional)</label>
                  <input type="date" value={holdForm.endDate} onChange={(e) => setHoldForm((f) => ({ ...f, endDate: e.target.value }))} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm" />
                </div>
              </div>
              <button onClick={placeHold} className="px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">Place hold</button>
            </div>
          )}
          <div className="space-y-2">
            {holds.length === 0 && <div className="py-6 text-center text-sm text-slate-400">No active retention holds.</div>}
            {holds.map((h) => (
              <div key={h.id} className="rounded-xl border border-slate-200 px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-800">{h.scope}{h.scope_id ? ` · ${h.scope_id.slice(0, 8)}…` : ''}</p>
                  <p className="text-xs text-slate-400">Reason: {h.reason}{h.end_date ? ` · until ${new Date(h.end_date).toLocaleDateString()}` : ' · indefinite'}</p>
                </div>
                {h.status === 'active' ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">Active</span>
                    <button onClick={() => release(h)} className="text-xs font-medium text-[#009944] hover:underline">Release</button>
                  </span>
                ) : (
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">Released</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  )
}

function ExportsAdmin({ Section }) {
  const [exports, setExports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ format: 'csv', query: '', messageType: '', dateFrom: '', dateTo: '', reason: '' })
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const d = await listExports()
      setExports(d || [])
    } catch (e) {
      setError(e?.message || 'Could not load exports')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const filters = {}
      if (form.messageType) filters.message_type = form.messageType
      if (form.dateFrom) filters.date_from = form.dateFrom
      if (form.dateTo) filters.date_to = form.dateTo
      const res = await exportRecords({
        format: form.format,
        scope: 'search',
        reason: form.reason.trim() || 'Communication export',
        query: form.query.trim() || null,
        filters,
      })
      if (res?.data) buildExportFile(form.format, { rows: res.data, title: 'communication-export' })
      else alert('Export recorded (no rows matched your search).')
      await load()
    } catch (e) {
      setError(e?.message || 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section icon={Download} label="Communication exports">
      <div className="p-5 space-y-5">
        {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}
        <div className="rounded-xl border border-slate-200 p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Format</label>
              <select value={form.format} onChange={(e) => setForm((f) => ({ ...f, format: e.target.value }))} className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm">
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="pdf">PDF (print)</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Message type</label>
              <select value={form.messageType} onChange={(e) => setForm((f) => ({ ...f, messageType: e.target.value }))} className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm">
                <option value="">All types</option>
                <option value="direct">Direct</option>
                <option value="group">Group</option>
                <option value="channel">Channel</option>
                <option value="announcement">Announcements</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Search query</label>
              <input value={form.query} onChange={(e) => setForm((f) => ({ ...f, query: e.target.value }))} placeholder="Keyword…" className="w-full h-9 rounded-lg border border-slate-300 px-3 text-sm" />
            </div>
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">From</label>
              <input type="date" value={form.dateFrom} onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))} className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">To</label>
              <input type="date" value={form.dateTo} onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))} className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Reason (audit)</label>
              <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why are you exporting?" className="w-full h-9 rounded-lg border border-slate-300 px-3 text-sm" />
            </div>
          </div>
          <div className="text-right">
            <button onClick={run} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Run export
            </button>
          </div>
          <p className="text-[11px] text-slate-400">Exports include only records you are authorized to view. Every export is recorded in the audit trail.</p>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr><th className="px-4 py-3">When</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Format</th><th className="px-4 py-3">Scope</th><th className="px-4 py-3">Rows</th><th className="px-4 py-3">Reason</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline text-slate-300" /></td></tr>}
              {!loading && exports.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No exports yet.</td></tr>}
              {exports.map((x) => (
                <tr key={x.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(x.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{x.actor_name || x.actor_id?.slice(0, 8)}</td>
                  <td className="px-4 py-3"><span className="text-[11px] uppercase tracking-wide text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">{x.format}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-600">{x.scope}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">{x.row_count}</td>
                  <td className="px-4 py-3 text-xs text-slate-400 max-w-[240px] truncate">{x.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  )
}

// ----------------------------------------------------------------------------
// Super Admin DM Inspection (spec Part 2 — global transparency).
// Pick a staff member -> list their DM threads -> open a transcript -> export
// CSV/JSON/PDF. "Return to My Direct Messages" resets the panel. Read access
// comes from the widened chat_threads/can_read_message RLS (is_super_admin).
// ----------------------------------------------------------------------------
function DmInspection({ Section }) {
  const { user } = useAuth()
  const [people, setPeople] = useState([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [threads, setThreads] = useState([])
  const [activeThreadId, setActiveThreadId] = useState(null)
  const [messages, setMessages] = useState([])
  const [identity, setIdentity] = useState({})
  const [loadingPeople, setLoadingPeople] = useState(true)
  const [loadingThreads, setLoadingThreads] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    listMessagingDirectory()
      .then((rows) => { if (active) setPeople((rows || []).filter((r) => r.id !== user?.id)) })
      .catch((e) => setError(e?.message || 'Could not load the staff directory'))
      .finally(() => active && setLoadingPeople(false))
    return () => { active = false }
  }, [user?.id])

  const nameOf = (id) => identity[id]?.name || people.find((p) => p.id === id)?.full_name || identity[id]?.email || 'Unknown User'

  const loadThreads = async (userId) => {
    setLoadingThreads(true)
    setError('')
    setThreads([])
    setMessages([])
    setActiveThreadId(null)
    try {
      const list = await directChat.listThreadsForUser(userId)
      setThreads(list || [])
      const ids = (list || []).flatMap((t) => [t.member_a, t.member_b])
      const dir = await resolveDirectory([...ids, userId])
      setIdentity(dir || {})
      if ((list || []).length === 0) setError('No direct-message threads found for this user.')
    } catch (e) {
      setError(e?.message || 'Could not load threads (RLS may be denying access).')
    } finally {
      setLoadingThreads(false)
    }
  }

  const onPickPerson = (userId) => {
    setSelectedUserId(userId)
    loadThreads(userId)
  }

  const openThread = async (threadId) => {
    setActiveThreadId(threadId)
    setLoadingMessages(true)
    setError('')
    try {
      const rows = await directChat.listMessages(threadId, 500)
      setMessages(rows || [])
      const dir = await resolveDirectory((rows || []).map((m) => m.sender_id))
      setIdentity((prev) => ({ ...prev, ...(dir || {}) }))
    } catch (e) {
      setError(e?.message || 'Could not load this transcript.')
    } finally {
      setLoadingMessages(false)
    }
  }

  const exportTranscript = async (format) => {
    if (!messages.length) return
    setExporting(true)
    try {
      const rows = messages.map((m) => ({ ...m, sender_label: nameOf(m.sender_id) }))
      buildExportFile(format, {
        rows,
        title: `dm-inspection-${nameOf(selectedUserId).replace(/\s+/g, '-').toLowerCase()}`,
      })
      try {
        await exportRecords({
          format,
          scope: 'search',
          reason: 'Super Admin DM inspection',
          query: `thread:${activeThreadId}`,
          filters: { kind: 'dm_inspection', inspected_user: selectedUserId },
        })
      } catch (_) { /* recording is best-effort */ }
    } catch (e) {
      setError(e?.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  const returnToMine = () => {
    setSelectedUserId('')
    setThreads([])
    setMessages([])
    setActiveThreadId(null)
    setError('')
  }


  const selectedPerson = people.find((p) => p.id === selectedUserId)

  return (
    <Section icon={Eye} label="Direct-message inspection (Super Admin)">
      <div className="p-5 space-y-5">
        {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}

        <div className="rounded-xl border border-slate-200 p-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <label className="text-xs font-medium text-slate-500 block mb-1">Inspect a staff member</label>
            <select
              value={selectedUserId}
              disabled={loadingPeople}
              onChange={(e) => e.target.value && onPickPerson(e.target.value)}
              className="w-full h-9 rounded-lg border border-slate-300 px-2 text-sm bg-white"
            >
              <option value="">{loadingPeople ? 'Loading directory…' : 'Select a user…'}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name || p.email || p.id}</option>
              ))}
            </select>
          </div>
          <button
            onClick={returnToMine}
            disabled={!selectedUserId}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            <ArrowLeft className="w-4 h-4" /> Return to My Direct Messages
          </button>
        </div>

        {selectedUserId && (
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                <p className="text-sm font-semibold text-slate-900">Threads for {selectedPerson?.full_name || nameOf(selectedUserId)}</p>
              </div>
              <div className="max-h-[320px] overflow-y-auto divide-y divide-slate-50">
                {loadingThreads && <div className="px-4 py-6 text-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline text-slate-300" /></div>}
                {!loadingThreads && threads.length === 0 && <div className="px-4 py-6 text-center text-slate-400 text-sm">No threads.</div>}
                {!loadingThreads && threads.map((t) => {
                  const other = t.member_a === selectedUserId ? t.member_b : t.member_a
                  const on = activeThreadId === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => openThread(t.id)}
                      className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 ${on ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm text-slate-800 truncate">{nameOf(other)}</span>
                        <span className="block text-xs text-slate-400 truncate">{t.last_message || 'No messages yet'}</span>
                      </span>
                      <span className="text-[11px] text-slate-400 whitespace-nowrap">{t.last_message_at ? new Date(t.last_message_at).toLocaleDateString() : ''}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">Transcript</p>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => exportTranscript('csv')} disabled={exporting || !messages.length} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-white disabled:opacity-40">
                    {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} CSV
                  </button>
                  <button onClick={() => exportTranscript('pdf')} disabled={exporting || !messages.length} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-white disabled:opacity-40">
                    <FileText className="w-3 h-3" /> PDF
                  </button>
                </div>
              </div>
              <div className="p-4 space-y-3 max-h-[320px] overflow-y-auto">
                {loadingMessages && <div className="py-6 text-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin inline text-slate-300" /></div>}
                {!loadingMessages && !activeThreadId && <div className="py-6 text-center text-slate-400 text-sm">Select a thread to view its transcript.</div>}
                {!loadingMessages && activeThreadId && messages.length === 0 && <div className="py-6 text-center text-slate-400 text-sm">No messages in this thread.</div>}
                {!loadingMessages && messages.map((m) => (
                  <div key={m.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-700">{nameOf(m.sender_id)}</span>
                      <span className="text-[11px] text-slate-400">{m.created_at ? new Date(m.created_at).toLocaleString() : ''}</span>
                    </div>
                    <p className="text-sm text-slate-800 mt-1 whitespace-pre-wrap break-words">{m.body}</p>
                    {m.restricted_status && m.restricted_status !== 'active' && (
                      <span className="inline-block mt-1 text-[10px] uppercase tracking-wide text-rose-600 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5">{m.restricted_status}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <p className="text-[11px] text-slate-400">Global DM transparency is reserved to the Super Admin role. Inspection exports are recorded in the audit trail.</p>
      </div>
    </Section>
  )
}


