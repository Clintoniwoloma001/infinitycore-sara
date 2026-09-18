import React, { useEffect, useState } from 'react'
import {
  BellRing, Check, CheckCheck, ChevronDown, ChevronRight, Landmark,
  Loader2, Megaphone, Plus, Send, X,
} from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { announcements as annSvc, resolveDirectory } from '../../services/corporateChatService'

const COMM_ADMIN_ROLES = ['super_admin', 'admin', 'hr_manager', 'hr_officer']

const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export default function AnnouncementsTab({ people, identity }) {
  const { profile, user } = useAuth()
  const isCommAdmin = COMM_ADMIN_ROLES.includes(profile?.role)
  const me = user?.id

  const [list, setList] = useState([])
  const [myAcks, setMyAcks] = useState({})
  const [ackStatus, setAckStatus] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [showCompose, setShowCompose] = useState(false)
  const [sending, setSending] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await annSvc.list()
      setList(data || [])
      await resolveDirectory((data || []).map((a) => a.author_id))
      const ackMap = {}
      for (const a of data || []) {
        if (a.requires_ack) {
          try {
            const mine = await annSvc.myAck(a.id)
            ackMap[a.id] = !!mine?.status || mine?.status === 'acknowledged'
          } catch (_) {}
        }
      }
      setMyAcks(ackMap)
      return data || []
    } catch (e) {
      setError(e?.message || 'Could not load announcements')
      return []
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const acknowledge = async (id) => {
    try {
      await annSvc.acknowledge(id)
      setMyAcks((prev) => ({ ...prev, [id]: true }))
      if (expanded === id) loadAckStatus(id)
    } catch (e) {
      setError(e?.message || 'Could not acknowledge')
    }
  }

  const loadAckStatus = async (id) => {
    try {
      const s = await annSvc.ackStatus(id)
      setAckStatus((prev) => ({ ...prev, [id]: s }))
      if (s?.pending_list) await resolveDirectory(s.pending_list.map((p) => p.user_id))
      if (s?.acknowledged_list) await resolveDirectory(s.acknowledged_list.map((p) => p.user_id))
      return s
    } catch (_) { return null }
  }

  const toggleExpand = async (id) => {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!ackStatus[id]) loadAckStatus(id)
  }

  const publish = async (payload) => {
    setPublishing(true)
    setError('')
    try {
      await annSvc.publish(payload)
      setShowCompose(false)
      await load()
    } catch (e) {
      setError(e?.message || 'Could not publish announcement')
    } finally {
      setPublishing(false)
    }
  }

  const unreadRequiringAck = list.filter((a) => a.requires_ack && !myAcks[a.id] && a.effective_date && new Date(a.effective_date) <= new Date())

  return (
    <div>
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#009944]/10 flex items-center justify-center text-[#009944]"><Megaphone className="w-5 h-5" /></div>
            <div>
              <p className="text-sm font-semibold text-slate-900">Announcements</p>
              <p className="text-xs text-slate-400">
                Official company communications
                {unreadRequiringAck.length > 0 && <span className="text-amber-600 font-medium"> · {unreadRequiringAck.length} require acknowledgement</span>}
              </p>
            </div>
          </div>
          {isCommAdmin && (
            <button onClick={() => setShowCompose(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> Publish
            </button>
          )}
        </div>

        {error && <div className="px-5 py-2 text-xs text-rose-600 bg-rose-50 border-b border-rose-100">{error}</div>}

        <div className="divide-y divide-slate-50 max-h-[72vh] overflow-y-auto">
          {loading && <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-300" /></div>}
          {!loading && list.length === 0 && <div className="px-5 py-12 text-center text-sm text-slate-400">No announcements published yet.</div>}

          {list.map((a) => {
            const isOpen = expanded === a.id
            const needsAck = a.requires_ack
            const iAcked = myAcks[a.id]
            const stats = ackStatus[a.id]
            const pendingList = stats?.pending_list || []
            return (
              <div key={a.id}>
                <button onClick={() => toggleExpand(a.id)} className="w-full text-left px-5 py-4 hover:bg-slate-50/60 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${a.priority === 'urgent' ? 'bg-amber-100 text-amber-700' : a.priority === 'high' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`}>
                      {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-slate-900">{a.title}</p>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5`}>
                          <Landmark className="w-3 h-3" /> Official
                        </span>
                        {a.requires_ack && (
                          <span className={`inline-flex items-center gap-1 text-[10px] font-medium rounded px-1.5 py-0.5 ${iAcked ? 'text-emerald-700 bg-emerald-50 border border-emerald-200' : 'text-amber-700 bg-amber-50 border border-amber-200'}`}>
                            {iAcked ? <CheckCheck className="w-3 h-3" /> : <BellRing className="w-3 h-3" />} {iAcked ? 'Acknowledged' : 'Acknowledgement required'}
                          </span>
                        )}
                        {a.priority === 'urgent' && <span className="text-[10px] font-bold text-amber-600 uppercase">Urgent</span>}
                      </div>
                      <p className={`text-sm text-slate-600 mt-1 whitespace-pre-wrap ${isOpen ? '' : 'line-clamp-2'}`}>{a.body}</p>
                      <div className="mt-1.5 text-[11px] text-slate-400 space-x-3 flex items-center flex-wrap gap-y-1">
                        <span>By {identity[a.author_id]?.name || 'Unknown'}</span>
                        <span>{fmtDate(a.published_at)}</span>
                        {a.target_type && <span className="capitalize">Target: {a.target_type}{a.target_value ? ` (${a.target_value})` : ''}</span>}
                        {stats && <span className="font-medium text-slate-500">{stats.acknowledged}/{stats.total} acknowledged{stats.pending > 0 ? ` · ${stats.pending} pending` : ''}</span>}
                      </div>
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-5 pb-4 pl-16">
                    {needsAck && !iAcked && (
                      <button
                        onClick={() => acknowledge(a.id)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]"
                      >
                        <Check className="w-4 h-4" /> I acknowledge this announcement
                      </button>
                    )}
                    {needsAck && stats && (
                      <div className="mt-3 rounded-xl border border-slate-200 overflow-hidden">
                        <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                          <p className="text-xs font-semibold text-slate-700">Acknowledgement status</p>
                          <span className="text-xs text-slate-500">{stats.acknowledged} of {stats.total} · {stats.pending} pending</span>
                        </div>
                        <div className="px-4 py-3 grid sm:grid-cols-2 gap-4">
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Acknowledged</p>
                            <div className="space-y-1 max-h-40 overflow-y-auto">
                              {(stats.acknowledged_list || []).map((r) => (
                                <div key={r.user_id} className="flex items-center justify-between text-xs text-slate-600">
                                  <span>{identity[r.user_id]?.name || 'Unknown'}</span>
                                  <span className="text-slate-400">{fmtDate(r.acknowledged_at)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">Pending</p>
                            <div className="space-y-1 max-h-40 overflow-y-auto">
                              {pendingList.length === 0 && <p className="text-xs text-slate-400 italic">Everyone has acknowledged.</p>}
                              {pendingList.map((r) => (
                                <div key={r.user_id} className="text-xs text-amber-700">{identity[r.user_id]?.name || 'Unknown'}</div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {showCompose && (
        <ComposeModal
          people={people}
          publishing={publishing}
          onPublish={publish}
          onClose={() => setShowCompose(false)}
        />
      )}
    </div>
  )
}

function ComposeModal({ people, publishing, onPublish, onClose }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState('normal')
  const [targetType, setTargetType] = useState('organization')
  const [targetValue, setTargetValue] = useState('')
  const [requiresAck, setRequiresAck] = useState(false)
  const [effectiveDate, setEffectiveDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [directIds, setDirectIds] = useState(new Set())
  const [personSearch, setPersonSearch] = useState('')
  const [channels, setChannels] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (targetType !== 'channel' || channels.length) return
    import('../../services/corporateChatService').then(({ channels: cs }) =>
      cs.listMine().then((c) => setChannels(c || [])).catch(() => {})
    )
  }, [targetType, channels.length])

  const filtered = (people || []).filter((p) =>
    `${p.full_name || ''} ${p.email || ''} ${p.department || ''} ${p.position || ''}`.toLowerCase().includes(personSearch.toLowerCase())
  )

  const togglePerson = (id) => {
    setDirectIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const effectiveValue = targetType === 'employees' ? [...directIds].join(',') : targetValue

  const submit = async () => {
    if (!title.trim() || !body.trim()) { setError('Title and message are required'); return }
    setError('')
    await onPublish({
      title: title.trim(),
      body: body.trim(),
      priority,
      targetType,
      targetValue: targetType === 'organization' || targetType === 'employees' ? (targetType === 'employees' ? effectiveValue : null) : (targetValue.trim() || null),
      requiresAck,
      effectiveDate: effectiveDate || null,
      expiryDate: expiryDate || null,
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[88vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900">Publish Announcement</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          {error && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Title *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Message *</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Audience</label>
              <select value={targetType} onChange={(e) => setTargetType(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
                <option value="organization">All employees</option>
                <option value="branch">Branch</option>
                <option value="area">Area</option>
                <option value="department">Department</option>
                <option value="role">Role</option>
                <option value="channel">Channel members</option>
                <option value="employees">Specific people</option>
              </select>
            </div>
          </div>

          {targetType !== 'organization' && targetType !== 'employees' && (
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Target {targetType}</label>
              {targetType === 'channel' ? (
                <select value={targetValue} onChange={(e) => setTargetValue(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
                  <option value="">Select a channel…</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.display_name || c.name}</option>)}
                </select>
              ) : (
                <input value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder={targetType === 'role' ? 'e.g. branch_manager' : targetType === 'branch' || targetType === 'area' ? 'ID' : 'e.g. Technology'} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
              )}
              <p className="text-[11px] text-slate-400 mt-1">For branch/area use the branch/area ID; for department use the department name; for role use the role key; for channel use the channel ID.</p>
            </div>
          )}

          {targetType === 'employees' && (
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">People ({directIds.size} selected)</label>
              <input value={personSearch} onChange={(e) => setPersonSearch(e.target.value)} placeholder="Search people…" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-50 rounded-lg border border-slate-200">
                {filtered.length === 0 && <div className="px-3 py-4 text-sm text-slate-400">No matching people.</div>}
                {filtered.map((p) => (
                  <button key={p.id} type="button" onClick={() => togglePerson(p.id)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2">
                    <input type="checkbox" checked={directIds.has(p.id)} readOnly className="w-4 h-4 accent-[#009944]" />
                    <span className="text-sm text-slate-700">{p.full_name || p.email}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input id="reqack" type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} className="w-4 h-4 accent-[#009944]" />
            <label htmlFor="reqack" className="text-sm text-slate-700">Require written acknowledgement (for compliance notices)</label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Effective from</label>
              <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Expires</label>
              <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm" />
            </div>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-slate-100 text-right">
          <button
            onClick={submit}
            disabled={publishing || !title.trim() || !body.trim()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40"
          >
            {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Publish
          </button>
        </div>
      </div>
    </div>
  )
}