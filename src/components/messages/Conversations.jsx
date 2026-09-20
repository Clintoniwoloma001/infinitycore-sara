import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Copy, Hash, Link2, Loader2, MailCheck, MessageSquare, Pin, Plus, RefreshCw, Search, Send, Share2, UserPlus, Users, X,
} from 'lucide-react'
import { supabase } from '../../supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  groups, channels, threads, messageActions, listReactions, listPinned, resolveDirectory,
  conversationPins, sendRichMessage, listAttachments, listMessageAcks, uploadChatAttachment,
  createMessageInvite, revokeMessageInvite, listMessageInvites, buildInviteUrl, waShareUrl,
} from '../../services/corporateChatService'
import MessageBubble from './MessageBubble'
import Composer from './Composer'

const AVATAR_PALETTE = [
  'bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-indigo-500', 'bg-teal-500', 'bg-fuchsia-500',
]

function hueFor(str = '') {
  let h = 0
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 997
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join('') || '?'

const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const COMM_ADMIN_ROLES = ['super_admin', 'admin', 'hr_manager', 'hr_officer']

// A name resolver that never leaks a raw UUID for unknown directory entries.
const displayPersonName = (person) => {
  const raw = person?.full_name || person?.name || ''
  return raw && (!person?.email || String(raw).toLowerCase() !== String(person?.email || '').toLowerCase())
    ? raw
    : 'Unknown User'
}

const typeLabel = (channel) => ({ branch: 'Branch', area: 'Area', department: 'Department', announcement: 'Announcements' })[channel.channel_type] || (channel.channel_type === 'role' ? 'Role' : 'Team')

export default function Conversations({ kind, people, identity }) {
  const { profile } = useAuth()
  const isCommAdmin = COMM_ADMIN_ROLES.includes(profile?.role)
  const [me, setMe] = useState(null)
  const [conversations, setConversations] = useState([])
  const [active, setActive] = useState(null)
  const [messages, setMessages] = useState([])
  const [reactions, setReactions] = useState({})
  const [pinned, setPinned] = useState([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [editingMsg, setEditingMsg] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [members, setMembers] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [taskModal, setTaskModal] = useState(null)
  const [myRole, setMyRole] = useState(null)
  const [pinnedConvs, setPinnedConvs] = useState([])
  const [attachments, setAttachments] = useState({})
  const [acks, setAcks] = useState({})
  const [ackBusy, setAckBusy] = useState(false)
  const bottomRef = useRef(null)
  const messageIdsRef = useRef(new Set())
  const isGroup = kind === 'group'
  const svc = isGroup ? groups : channels

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const id = data?.user?.id || null
      setMe(id)
      resolveDirectory(id ? [id] : [])
    })
  }, [])

  useEffect(() => {
    if (me) loadConversations()
  }, [me, kind])

  useEffect(() => {
    conversationPins.listMine().then(setPinnedConvs).catch(() => {})
  }, [kind, active?.id])

  const ensureIdents = useCallback(async (ids) => {
    try { await resolveDirectory((ids || []).filter(Boolean)) } catch (_) {}
  }, [])

  const markMessagesRead = useCallback(async (rows) => {
    if (!me) return
    const unread = (rows || []).filter((message) => message.sender_id !== me && !message.read_at && message.id)
    await Promise.all(unread.map((message) => messageActions.markRead(message.id)))
  }, [me])

  const loadConversations = async () => {
    setLoading(true)
    setError('')
    try {
      if (kind === 'channel') {
        try { await channels.ensureOrganizational() } catch (_) {}
      }
      const data = await svc.listMine()
      setConversations(data || [])
      return data || []
    } catch (e) {
      setError(e?.message || 'Failed to load conversations')
      return []
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const ids = new Set([me])
    for (const c of conversations) {
      if (isGroup && c.members) c.members.forEach((m) => ids.add(m.member_id))
      else ids.add(c.creator_id)
    }
    ensureIdents([...ids])
  }, [conversations, kind])

  const openConversation = async (c) => {
    setActive(c)
    setMessages([])
    setReactions({})
    setPinned([])
    setReplyTo(null)
    setEditingMsg(null)
    setShowMembers(false)
    setSearchResults([])
    setAttachments({})
    setAcks({})
    setError('')
    try {
      const data = await svc.messages(c.id, 300)
      const rows = data || []
      setMessages(rows)
      messageIdsRef.current = new Set(rows.map((m) => m.id).filter(Boolean))
      markMessagesRead(rows)
      const msgIds = rows.map((m) => m.id)
      ensureMessageExtras(msgIds)
      if (msgIds.length) {
        const rr = (await listReactions(msgIds)) || []
        const grouped = {}
        for (const r of rr) grouped[r.message_id] = grouped[r.message_id] || []
        for (const r of rr) grouped[r.message_id].push(r)
        setReactions(grouped)
      }
    } catch (_) {}
    try {
      const p = await listPinned(kind, c.id)
      setPinned(p || [])
    } catch (_) {}
    try {
      const mList = await svc.members(c.id)
      setMembers(mList || [])
      setMyRole((mList || []).find((m) => m.member_id === me)?.role || 'member')
      ensureIdents((mList || []).map((m) => m.member_id))
    } catch (_) {}
  }

  // Load attachments + acknowledgment rows for a batch of messages.
  const ensureMessageExtras = useCallback(async (msgIds) => {
    const ids = [...new Set((msgIds || []).filter(Boolean))]
    if (!ids.length) return
    try {
      const att = await listAttachments(ids)
      if (att?.length) {
        setAttachments((prev) => {
          const next = { ...prev }
          for (const a of att) {
            const existing = next[a.message_id] || []
            if (!existing.some((item) => item.id === a.id)) next[a.message_id] = [...existing, a]
          }
          return next
        })
      }
    } catch (_) {}
    try {
      const ackRows = await listMessageAcks(ids)
      if (ackRows?.length) {
        setAcks((prev) => {
          const next = { ...prev }
          for (const r of ackRows) { next[r.message_id] = next[r.message_id] || []; next[r.message_id].push(r) }
          return next
        })
      }
    } catch (_) {}
  }, [])

  // Message requiring MY acknowledgment (not the sender, no acknowledged row).
  const myAckRequired = useCallback((msg) => {
    if (!msg?.requires_ack || !me) return false
    if (msg.sender_id === me) return false
    const rows = acks[msg.id] || []
    return !rows.some((r) => r.user_id === me && r.status === 'acknowledged')
  }, [acks, me])

  const pendingAckMsgs = useMemo(
    () => (messages || []).filter((m) => myAckRequired(m)),
    [messages, myAckRequired],
  )

  const gateMsg = pendingAckMsgs[0] || null

  const myAckOf = (msg) => {
    if (!msg?.requires_ack || !me) return null
    return (acks[msg.id] || []).find((r) => r.user_id === me) || null
  }

  const handleAcknowledge = async (msg) => {
    if (!msg || ackBusy) return
    setAckBusy(true)
    setError('')
    try {
      await messageActions.acknowledgeMessage(msg.id)
      setAcks((prev) => {
        const rows = [...(prev[msg.id] || [])]
        const mine = rows.find((r) => r.user_id === me)
        const next = { ...prev, [msg.id]: rows }
        if (mine) {
          const updated = { ...mine, status: 'acknowledged', acknowledged_at: new Date().toISOString() }
          next[msg.id] = rows.map((r) => (r.user_id === me ? updated : r))
        } else {
          next[msg.id] = [...rows, { id: `mine-${Date.now()}`, message_id: msg.id, user_id: me, status: 'acknowledged', acknowledged_at: new Date().toISOString() }]
        }
        return next
      })
    } catch (e) {
      setError(e?.message || 'Could not acknowledge the message')
    } finally {
      setAckBusy(false)
    }
  }

  const togglePinConversation = async (e, c) => {
    e?.stopPropagation()
    try {
      if (conversationPins.isPinned(pinnedConvs, kind, c.id)) {
        await conversationPins.unpin(kind, c.id)
      } else {
        await conversationPins.pin(kind, c.id)
      }
      const list = await conversationPins.listMine()
      setPinnedConvs(list || [])
    } catch (err) {
      setError(err?.message || 'Could not update the pin')
    }
  }

  const sortedConvs = useMemo(() => {
    const order = (c) => (conversationPins.isPinned(pinnedConvs, kind, c.id) ? 0 : 1)
    return [...(conversations || [])].sort((a, b) => order(a) - order(b) || new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
  }, [conversations, pinnedConvs, kind])

  const send = async (body, mentionIds, opts = null) => {
    if (!active || sending) return false
    setSending(true)
    setError('')
    try {
      const rich = opts && (opts.priority || opts.requiresAck || (opts.files && opts.files.length > 0))
      let fresh = null
      if (rich) {
        let files = []
        let uploadErr = null
        if (opts.files?.length) {
          for (const f of opts.files) {
            try {
              const meta = await uploadChatAttachment(kind, active.id, f)
              files.push({
                file_name: meta.file_name,
                file_type: meta.file_type,
                  attachment_type: meta.attachment_type,
                  file_size: meta.file_size,
                  file_path: meta.file_path,
                  checksum: meta.checksum,
              })
            } catch (uerr) {
              uploadErr = uerr?.message || `Failed to upload ${f.name}`
              break
            }
          }
        }
        if (uploadErr) { setError(uploadErr); return false }
        if (replyTo) {
          fresh = await sendRichMessage('thread', replyTo.id, {
            body, priority: opts.priority, requiresAck: opts.requiresAck, files, mentionIds,
            parentMessageId: replyTo.id,
          })
        } else {
          fresh = await sendRichMessage(kind, active.id, {
            body, priority: opts.priority, requiresAck: opts.requiresAck, files, mentionIds,
          })
        }
      } else {
        fresh = replyTo
          ? await threads.reply(replyTo.id, body)
          : await svc.send(active.id, body, mentionIds)
      }
      if (fresh) {
        const message = {
          ...fresh,
          sender_id: fresh.sender_id || me,
          message_type: fresh.message_type || (replyTo ? 'thread' : kind),
          status: 'sent',
        }
        if (message.id) messageIdsRef.current.add(message.id)
        setMessages((prev) => (message.id && prev.some((row) => row.id === message.id) ? prev : [...prev, message]))
        setConversations((prev) => prev.map((c) => (c.id === active.id ? { ...c, updated_at: new Date().toISOString() } : c)))
        ensureMessageExtras([message.id])
      }
      setText('')
      setReplyTo(null)
      return true
    } catch (e) {
      setError(e?.message || 'Message not sent')
      return false
    } finally {
      setSending(false)
    }
  }

  const submitEdit = async (body) => {
    if (!editingMsg) return
    setSending(true)
    setError('')
    try {
      await messageActions.edit(editingMsg.id, body)
      setMessages((prev) => prev.map((m) => (m.id === editingMsg.id ? { ...m, body, edited_at: new Date().toISOString(), edit_count: (m.edit_count || 0) + 1 } : m)))
      setEditingMsg(null)
    } catch (e) {
      setError(e?.message || 'Could not edit message')
    } finally {
      setSending(false)
    }
  }

  const doSoftDelete = async (msg) => {
    if (!window.confirm('Delete this message? The record is preserved internally (soft delete).')) return
    try {
      await messageActions.softDelete(msg.id)
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, restricted_status: 'deleted' } : m)))
    } catch (e) {
      setError(e?.message || 'Could not delete message')
    }
  }

  const doPin = async (msg) => {
    try {
      if (msg.is_pinned) await messageActions.unpin(msg.id)
      else await messageActions.pin(msg.id)
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, is_pinned: !msg.is_pinned } : m)))
      const p = await listPinned(kind, active.id)
      setPinned(p || [])
    } catch (e) {
      setError(e?.message || 'Pinning is only available to group/channel moderators')
    }
  }

  const doOfficial = async (msg) => {
    try {
      await messageActions.markOfficial(msg.id)
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, is_official: true } : m)))
    } catch (e) {
      setError(e?.message || 'Not authorized')
    }
  }

  const doBookmark = async (msg) => {
    try { await messageActions.toggleBookmark(msg.id) } catch (e) { setError(e?.message || 'Could not bookmark') }
  }

  const doReport = async ({ msg, reason }) => {
    const REASON_MAP = {
      spam: 'inappropriate_content',
      harassment: 'harassment',
      'sensitive data': 'confidential_information',
      misinformation: 'misinformation',
      other: 'other',
    }
    try { await messageActions.report(msg.id, REASON_MAP[reason] || 'other') } catch (e) { setError(e?.message || 'Could not file report') }
  }

  const doTask = (msg) => setTaskModal({ msg })

  const toggleReaction = async (msg, emoji) => {
    try {
      const current = reactions[msg.id] || []
      const mine = current.find((r) => r.user_id === me && r.emoji === emoji)
      if (mine) await messageActions.removeReaction(msg.id, emoji)
      else await messageActions.addReaction(msg.id, emoji)
      const rr = (await listReactions([msg.id])) || []
      setReactions((prev) => ({ ...prev, [msg.id]: rr }))
    } catch (e) {
      setError(e?.message || 'Reaction failed')
    }
  }

  useEffect(() => {
    if (!active || !me) return
    const cond = isGroup ? `group_id=eq.${active.id}` : `channel_id=eq.${active.id}`
    const channel = supabase
      .channel(`messages_${kind}_${active.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: cond }, (payload) => {
         const msg = payload.new
         if (!msg || msg.sender_id === me || msg.message_type === 'thread' && msg.parent_message_id) return
         messageIdsRef.current.add(msg.id)
         setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
         ensureMessageExtras([msg.id])
         messageActions.markRead(msg.id).catch(() => {})
       })
       .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_attachments' }, (payload) => {
         const attachment = payload.new
         if (!attachment?.message_id || !messageIdsRef.current.has(attachment.message_id)) return
         setAttachments((prev) => {
           const existing = prev[attachment.message_id] || []
           if (existing.some((item) => item.id === attachment.id)) return prev
           return { ...prev, [attachment.message_id]: [...existing, attachment] }
         })
       })
       .subscribe((status) => setConnected(status === 'SUBSCRIBED'))
    return () => { supabase.removeChannel(channel) }
  }, [active, me, kind, ensureMessageExtras])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, active?.id])

  const doSearch = async () => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    try {
      const { searchMessages } = await import('../../services/corporateChatService')
      const filter = isGroup ? { group: active?.id } : { channel: active?.id }
      const rows = await searchMessages(searchQuery.trim(), filter)
      setSearchResults(Array.isArray(rows) ? rows : [])
      ensureIdents((Array.isArray(rows) ? rows : []).map((r) => r.sender_id))
    } catch (e) {
      setError(e?.message || 'Search failed')
    }
  }

  const name = (c) => (isGroup ? c.name : c.display_name || c.name)
  const identOf = (id) => identity[id]

  const allowed = useMemo(() => ({
    edit: true,
    delete: true,
    pin: ['owner', 'admin', 'moderator'].includes(myRole),
    official: isCommAdmin,
    report: true,
    task: true,
  }), [myRole, isCommAdmin])

  const actionError = (e) => setError(e?.message || 'Action failed')

  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-4">
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
            {isGroup ? <Users className="w-4 h-4 text-[#009944]" /> : <Hash className="w-4 h-4 text-[#009944]" />}
            {isGroup ? 'Groups' : 'Channels'}
          </p>
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1 rounded-lg bg-[#009944] text-white px-2.5 py-1.5 text-xs font-medium hover:bg-[#007a36]">
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-50">
          {loading && <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-300" /></div>}
          {!loading && conversations.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-slate-400">No {kind}s yet.<br /><button onClick={() => setShowCreate(true)} className="text-[#009944] hover:underline mt-1">Create one</button></div>
          )}
          {sortedConvs.map((c) => {
            const isActive = active?.id === c.id
            const isPinned = conversationPins.isPinned(pinnedConvs, kind, c.id)
            return (
              <button
                key={c.id}
                onClick={() => openConversation(c)}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors ${isActive ? 'bg-emerald-50/50' : ''}`}
              >
                <div className={`w-9 h-9 rounded-lg ${hueFor(name(c))} flex items-center justify-center text-xs font-semibold text-white shrink-0`}>
                  {isGroup ? initials(name(c)) : <Hash className="w-4 h-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 truncate">{name(c)}</p>
                  <p className="text-xs text-slate-400 truncate">
                    {isGroup ? `${c.members?.length || 0} members` : (c.description || typeLabel(c))}
                  </p>
                </div>
                {isPinned && <Pin className="w-3.5 h-3.5 text-[#009944] shrink-0 fill-[#009944]" />}
                <span
                  role="button"
                  tabIndex={0}
                  title={isPinned ? 'Unpin chat' : 'Pin chat'}
                  onClick={(e) => togglePinConversation(e, c)}
                  onKeyDown={(e) => e.key === 'Enter' && togglePinConversation(e, c)}
                  className={`p-1.5 rounded-lg shrink-0 ${isPinned ? 'text-[#009944] bg-emerald-50' : 'text-slate-300 hover:text-[#009944] hover:bg-slate-50'}`}
                >
                  <Pin className="w-3.5 h-3.5" />
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 flex flex-col min-h-[70vh]">
        {!active ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2 py-24">
            <MessageSquare className="w-8 h-8" />
            <p className="text-sm">Select a {kind} to open the conversation.</p>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-9 h-9 rounded-lg ${hueFor(name(active))} flex items-center justify-center text-xs font-semibold text-white shrink-0`}>
                  {isGroup ? initials(name(active)) : <Hash className="w-4 h-4" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{name(active)}</p>
                  <p className="text-[11px] text-slate-400">{connected ? 'Realtime enabled' : 'Connecting…'} · {members.length} member{members.length === 1 ? '' : 's'}{myRole ? ` · you are ${myRole}` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button title="Search in conversation" onClick={() => setSearchOpen((v) => !v)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"><Search className="w-4 h-4" /></button>
                 <button title="Manage members" aria-label="Manage members" onClick={() => setShowMembers((v) => !v)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"><Users className="w-4 h-4" /></button>
              </div>
            </div>

            {pinned.length > 0 && (
              <div className="px-4 py-2 border-b border-emerald-100 bg-emerald-50/40 max-h-28 overflow-y-auto space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Pinned</p>
                {pinned.map((p) => (
                  <div key={p.id} className="text-xs text-slate-600 flex items-start gap-1.5">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-emerald-600 mt-0.5 shrink-0"><path d="M16 3l5 5-4 1-4 4 1 4-5-5-4 4-1-4 4-4 4-1-4 4-4 4-1 4z" /></svg>
                     <span className="font-medium shrink-0">{identOf(p.sender_id)?.name || 'Unknown User'}:</span>
                    <span className="truncate">{p.body || '(message)'}</span>
                  </div>
                ))}
              </div>
            )}

            {searchOpen && (
              <div className="px-4 py-2 border-b border-slate-100">
                <div className="flex gap-2">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                    placeholder={`Search this ${kind}…`}
                    className="flex-1 h-9 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
                  />
                </div>
                {searchResults.length > 0 && (
                  <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                    {searchResults.map((r) => (
                      <div key={r.id} className="text-xs text-slate-600 border-b border-slate-50 pb-1 flex items-start gap-2">
                         <span className="text-slate-400 font-medium shrink-0">{identOf(r.sender_id)?.name || 'Unknown User'}</span>
                        <span className="truncate">{r.body}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-h-[48vh] min-h-[48vh] bg-slate-50/50">
              {messages.length === 0 && <div className="h-full flex items-center justify-center text-sm text-slate-400">No messages yet — start the conversation.</div>}
              {messages.map((m) => {
                const mine = m.sender_id === me
                const ident = identOf(m.sender_id)
                return (
                  <MessageBubble
                    key={m.id}
                    msg={{ ...m, my_user_id: me }}
                    mine={mine}
                    myUserId={me}
                    name={ident?.name || 'Unknown User'}
                    time={fmtTime(m.created_at)}
                    reactions={reactions[m.id]}
                    onToggleReaction={toggleReaction}
                    onReply={setReplyTo}
                    onEdit={mine ? setEditingMsg : null}
                    onSoftDelete={mine ? doSoftDelete : null}
                    onPin={allowed.pin ? doPin : null}
                    onOfficial={allowed.official ? doOfficial : null}
                    onReport={doReport}
                    onTask={doTask}
                    onBookmark={doBookmark}
                    allowed={allowed}
                    attachments={attachments[m.id] || []}
                    myAck={myAckOf(m)}
                    onAcknowledge={handleAcknowledge}
                  />
                )
              })}
              <div ref={bottomRef} />
            </div>

            {error && <div className="px-4 py-2 text-xs text-rose-600 bg-rose-50 border-t border-rose-100">{error}</div>}

            {gateMsg && (
              <div className="mx-3 mt-2 rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
                <div className="flex items-start gap-3">
                  <span className="w-9 h-9 rounded-full bg-amber-500 text-white flex items-center justify-center shrink-0">
                    <MailCheck className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-amber-800 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" /> Urgent message awaiting your acknowledgment
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      <span className="font-medium">{identOf(gateMsg.sender_id)?.name || 'Unknown User'}:</span>{' '}
                      {gateMsg.body}
                    </p>
                    <p className="text-[11px] text-amber-600/80 mt-1">
                      You cannot send new messages here until you acknowledge receipt of the urgent message above.
                    </p>
                  </div>
                  <button
                    onClick={() => handleAcknowledge(gateMsg)}
                    disabled={ackBusy}
                    className="inline-flex items-center gap-1.5 shrink-0 rounded-lg bg-amber-500 text-white px-3 py-2 text-xs font-semibold hover:bg-amber-600 disabled:opacity-50"
                  >
                    {ackBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MailCheck className="w-3.5 h-3.5" />}
                    I acknowledge receipt
                  </button>
                </div>
              </div>
            )}

            {editingMsg ? (
              <div className="p-3 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-slate-600">Editing your message</p>
                  <button onClick={() => setEditingMsg(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                </div>
                <textarea
                  defaultValue={editingMsg.body}
                  autoFocus
                  onChange={(e) => { editingMsg.next = e.target.value }}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]"
                  rows={2}
                />
                <div className="mt-2 text-right">
                  <button
                    onClick={() => editingMsg.next && submitEdit(editingMsg.next)}
                    disabled={sending || !editingMsg.next}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40"
                  >
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Save
                  </button>
                </div>
              </div>
            ) : (
              <Composer
                value={text}
                onChange={setText}
                onSend={send}
                sending={sending}
                disabled={!!gateMsg}
                people={people}
                allowRequireAck={['owner', 'admin', 'moderator'].includes(myRole)}
                replyTo={replyTo ? {
                  ...replyTo,
                  body: replyTo.body,
                  replyName: (identOf(replyTo.sender_id)?.name || 'message') + ` · ${isGroup ? 'Group' : 'Channel'}`,
                } : null}
                onCancelReply={() => setReplyTo(null)}
                placeholder={gateMsg ? `Acknowledge the urgent message to continue…` : `Message ${name(active)}…`}
              />
            )}
          </>
        )}
      </div>

      {showMembers && active && (
        <MemberPanel
          kind={kind}
          conversation={active}
          members={members}
          identity={identity}
          people={people}
          me={me}
          myRole={myRole}
          onClose={() => setShowMembers(false)}
          onChange={openConversation}
        />
      )}

      {showCreate && (
        <CreateConversationModal
          kind={kind}
          people={people}
          onClose={() => setShowCreate(false)}
          onCreated={(c) => {
            setShowCreate(false)
            loadConversations()
            if (c?.id) openConversation(c)
          }}
        />
      )}

      {taskModal && (
        <TaskModal
          msg={taskModal.msg}
          people={people}
          me={me}
          onClose={() => setTaskModal(null)}
          onSubmit={async (body) => {
            try {
              await messageActions.createTask(taskModal.msg.id, body)
            } catch (e) {
              actionError(e)
            }
            setTaskModal(null)
          }}
        />
      )}
    </div>
  )
}

function MemberPanel({ kind, conversation, members, identity, people, me, myRole, onClose, onChange }) {
  const { profile } = useAuth()
  const isCommAdmin = COMM_ADMIN_ROLES.includes(profile?.role)
  const canManage = ['owner', 'admin'].includes(myRole) || isCommAdmin
  const canChangeRoles = myRole === 'owner' || isCommAdmin
  const isGroup = kind === 'group'
  const svc = isGroup ? groups : channels
  const cname = isGroup ? conversation.name : conversation.display_name || conversation.name
  const panelTitle = isGroup ? 'Group Members' : 'Channel Members'
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [suspendFor, setSuspendFor] = useState(null)
  const [suspendDays, setSuspendDays] = useState(7)
  const [suspendUntil, setSuspendUntil] = useState('')
  const [suspendReason, setSuspendReason] = useState('')
  const [invites, setInvites] = useState([])
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteError, setInviteError] = useState('')
  const [newInviteUrl, setNewInviteUrl] = useState(null)
  const [syncing, setSyncing] = useState(false)

  const loadInvites = async () => {
    try { setInvites(await listMessageInvites(kind, conversation.id)) } catch (_) {}
  }
  useEffect(() => { if (canManage) loadInvites() }, [conversation.id, kind, canManage])

  const q = memberSearch.trim().toLowerCase()
  const filteredMembers = (members || []).filter((m) => {
    if (!q) return true
    const ident = identity[m.member_id]
    return `${ident?.name || ''} ${ident?.email || ''} ${ident?.department || ''} ${ident?.position || ''} ${ident?.staffId || ''} ${ident?.branch || ''}`.toLowerCase().includes(q)
  })
  const filteredAvailable = (people || []).filter((p) =>
    p.id !== me &&
    !members.some((m) => m.member_id === p.id) &&
    (!q || `${displayPersonName(p)} ${p.email || ''} ${p.department || ''} ${p.position || ''}`.toLowerCase().includes(q))
  )

  // Automatic membership is a channel concept; groups are always manual.
  const autoLabel = !isGroup && conversation?.is_auto
    ? `Automatic · ${String(conversation.auto_source || conversation.channel_type || '').replace(/_/g, ' ')}`
    : ''

  const addMember = async (id) => {
    setBusy(true)
    try { await svc.addMember(conversation.id, id); onChange(conversation) } catch { alert('Could not add member') }
    finally { setBusy(false); setPickerOpen(false) }
  }
  const removeMember = async (id) => {
    if (!window.confirm('Remove this member?')) return
    setBusy(true)
    try { await svc.removeMember(conversation.id, id); onChange(conversation) } catch { alert('Could not remove member') }
    finally { setBusy(false) }
  }
  const setRole = async (id, role) => {
    setBusy(true)
    try { await svc.updateMemberRole(conversation.id, id, role); onChange(conversation) } catch { alert('Only the owner can change roles') }
    finally { setBusy(false) }
  }

  const openSuspend = (id, days) => {
    setSuspendFor(id)
    setSuspendDays(days)
    setSuspendUntil('')
    setSuspendReason('')
  }

  const doSuspend = async (id) => {
    const until = suspendUntil
      ? new Date(suspendUntil)
      : new Date(Date.now() + suspendDays * 24 * 60 * 60 * 1000)
    if (isNaN(until.getTime()) || until <= new Date()) { alert('Suspension must end in the future'); return }
    setBusy(true)
    try {
      await svc.suspendMember(conversation.id, id, until.toISOString(), suspendReason.trim() || null)
      setSuspendFor(null)
      onChange(conversation)
    } catch { alert('Could not suspend member (owner/admin only)') }
    finally { setBusy(false) }
  }

  const doUnsuspend = async (id) => {
    setBusy(true)
    try {
      await svc.unsuspendMember(conversation.id, id)
      onChange(conversation)
    } catch { alert('Could not end suspension') }
    finally { setBusy(false) }
  }

  const fmtUntil = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const createInvite = async () => {
    setInviteBusy(true)
    setInviteError('')
    try {
      const res = await createMessageInvite(kind, conversation.id, {})
      if (res?.token) setNewInviteUrl(buildInviteUrl(res.token))
      else setNewInviteUrl(null)
      await loadInvites()
    } catch (e) {
      setInviteError(e?.message || 'Could not create an invite link')
    } finally {
      setInviteBusy(false)
    }
  }

  const revokeInvite = async (id) => {
    if (!window.confirm('Revoke this invite link? It stops working immediately.')) return
    setInviteBusy(true)
    setInviteError('')
    try {
      await revokeMessageInvite(id)
      setNewInviteUrl(null)
      await loadInvites()
    } catch (e) {
      setInviteError(e?.message || 'Could not revoke the invite')
    } finally {
      setInviteBusy(false)
    }
  }

  const copyInvite = async (url) => {
    try { await navigator.clipboard.writeText(url) } catch (_) { window.prompt('Copy this invite link:', url) }
  }

  const reSyncMembers = async () => {
    setSyncing(true)
    setInviteError('')
    try {
      const res = await channels.syncAuto(conversation.id)
      alert(`Members re-synced from the org chart${res?.added || res?.removed ? ` (${res.added || 0} added, ${res.removed || 0} removed)` : ' — already up to date'}.`)
      onChange(conversation)
    } catch (e) {
      setInviteError(e?.message || 'Could not re-sync members')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[85vh] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900">{panelTitle} · {cname}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        {canManage && (
          <div className="px-5 py-3 border-b border-slate-100 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => setPickerOpen((v) => !v)} className="inline-flex items-center gap-2 text-sm font-medium text-[#009944] hover:underline">
                <UserPlus className="w-4 h-4" /> {isGroup ? 'Add People' : 'Add Channel Member'}
              </button>
              {!isGroup && conversation?.is_auto && (
                <button onClick={reSyncMembers} disabled={syncing} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 hover:bg-slate-50 disabled:opacity-50">
                  {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Re-sync from org chart
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400 -mt-1">Owners (and communication administrators) can promote members to admin. Admins can oversee membership and moderation.</p>

            {pickerOpen && (
              <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-50">
                {filteredAvailable.length === 0 && <div className="px-3 py-4 text-sm text-slate-400">Everyone in the directory is already a member.</div>}
                {filteredAvailable.map((p) => (
                  <button key={p.id} onClick={() => addMember(p.id)} disabled={busy} className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm text-slate-700 disabled:opacity-50">
                    {displayPersonName(p)} · {p.department || p.position || ''}
                  </button>
                ))}
              </div>
            )}

            <div className="border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800 inline-flex items-center gap-1.5"><Link2 className="w-4 h-4 text-[#009944]" /> Invite via link</p>
                <button onClick={createInvite} disabled={inviteBusy} className="inline-flex items-center gap-1.5 text-xs font-medium bg-[#009944] text-white rounded-lg px-3 py-1.5 hover:bg-[#007a36] disabled:opacity-50">
                  {inviteBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create invite link
                </button>
              </div>
              {inviteError && <p className="text-[11px] text-rose-600 mt-1.5">{inviteError}</p>}
              {newInviteUrl && (
                <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-2.5">
                  <p className="text-[11px] text-emerald-700 mb-1.5">Anyone with this link can join as a member.</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <code className="flex-1 min-w-0 truncate text-xs text-slate-700 bg-white border border-slate-200 rounded-lg px-2 py-1.5">{newInviteUrl}</code>
                    <button onClick={() => copyInvite(newInviteUrl)} title="Copy link" className="p-1.5 rounded-lg border border-slate-200 hover:bg-white text-slate-600"><Copy className="w-3.5 h-3.5" /></button>
                    <a href={waShareUrl(newInviteUrl, cname)} target="_blank" rel="noreferrer" title="Share on WhatsApp" className="p-1.5 rounded-lg border border-slate-200 hover:bg-white text-slate-600"><Share2 className="w-3.5 h-3.5" /></a>
                  </div>
                </div>
              )}
              {invites.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto space-y-1">
                  {invites.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-2 text-[11px] text-slate-500 bg-white border border-slate-100 rounded-lg px-2.5 py-1.5">
                      <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${inv.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>{inv.status}</span>
                      <span className="flex-1 truncate">{inv.used_count} {inv.used_count === 1 ? 'use' : 'uses'}{inv.max_uses ? ` / ${inv.max_uses}` : ''}{inv.expires_at ? ` · until ${new Date(inv.expires_at).toLocaleDateString()}` : ' · no expiry'}</span>
                      {inv.status === 'active' && (
                        <button onClick={() => revokeInvite(inv.id)} disabled={inviteBusy} className="text-rose-500 hover:text-rose-700 hover:underline disabled:opacity-50">Revoke</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="px-5 py-2.5 border-b border-slate-100">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Members · {members.length}</p>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search members…"
                className="pl-7 h-8 w-44 rounded-lg border border-slate-200 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-[#009944]"
              />
            </div>
          </div>
        </div>

        <div className="overflow-y-auto divide-y divide-slate-50 max-h-[50vh]">
          {filteredMembers.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-400">No members match your search.</div>}
          {filteredMembers.map((m) => {
            const ident = identity[m.member_id]
            const memberName = displayPersonName(ident) || 'Unknown User'
            const isMe = m.member_id === me
            const isOwner = m.role === 'owner'
            const suspended = !!m.suspended_until
            const isSuspendForm = suspendFor === m.member_id
            return (
              <div key={m.member_id} className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-full ${hueFor(memberName)} flex items-center justify-center text-xs font-semibold text-white shrink-0`}>
                    {initials(memberName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{isMe ? 'You' : memberName}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {[ident?.position, ident?.department, ident?.staffId ? `#${ident.staffId}` : ''].filter(Boolean).join(' · ') || ident?.role || ''}
                    </p>
                    {(ident?.branch || ident?.employmentStatus) && (
                      <p className="text-[11px] text-slate-400 truncate">
                        {[ident?.branch, ident?.employmentStatus].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {autoLabel && m.auto_added && <p className="text-[11px] font-medium text-emerald-600">Automatic · {String(conversation.auto_source || conversation.channel_type || '').replace(/_/g, ' ')}</p>}
                    {!isGroup && m.auto_added && <p className="text-[11px] text-slate-400">Managed automatically from the org chart — manual edits are preserved.</p>}
                    {isOwner && !isMe && <p className="text-[11px] font-medium text-slate-500">Owner cannot be removed or suspended.</p>}
                    {suspended && (
                      <p className="text-[11px] font-medium text-amber-600 inline-flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Suspended until {fmtUntil(m.suspended_until)}{m.suspend_reason ? ` — ${m.suspend_reason}` : ''}
                      </p>
                    )}
                  </div>
                  {canChangeRoles && !isMe && !isOwner ? (
                    <select
                      value={m.role}
                      onChange={(e) => setRole(m.member_id, e.target.value)}
                      disabled={busy}
                      aria-label={`Role for ${memberName}`}
                      className="text-xs rounded-lg border border-slate-200 px-2 py-1 bg-white disabled:opacity-50"
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="moderator">Moderator</option>
                      <option value="member">Member</option>
                    </select>
                  ) : (
                    <span className="text-[11px] uppercase tracking-wide text-slate-400">{m.role}</span>
                  )}
                  {canManage && !isMe && !isOwner && (
                    <div className="flex items-center gap-2 shrink-0">
                      {suspended ? (
                        <button onClick={() => doUnsuspend(m.member_id)} disabled={busy} className="text-xs text-emerald-600 hover:text-emerald-800 hover:underline disabled:opacity-50">Resume</button>
                      ) : (
                        <button onClick={() => openSuspend(m.member_id, 7)} disabled={busy} className={`text-xs hover:underline disabled:opacity-50 ${isSuspendForm ? 'text-slate-400' : 'text-amber-600 hover:text-amber-800'}`}>Suspend</button>
                      )}
                      <button onClick={() => removeMember(m.member_id)} disabled={busy} className="text-xs text-rose-500 hover:text-rose-700 hover:underline disabled:opacity-50">Remove</button>
                    </div>
                  )}
                </div>
                {isSuspendForm && (
                  <div className="mt-2 ml-12 rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-2">
                    <p className="text-xs font-semibold text-amber-800">Suspend {memberName} from sending messages</p>
                    <p className="text-[11px] text-amber-700">They can still read everything in this {kind}; only sending is blocked until the date below.</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {[1, 7, 30].map((d) => (
                        <button
                          key={d}
                          onClick={() => { setSuspendDays(d); setSuspendUntil('') }}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${suspendDays === d && !suspendUntil ? 'bg-amber-500 text-white border-amber-500' : 'bg-white border-slate-200 text-slate-600 hover:border-amber-300'}`}
                        >
                          {d} {d === 1 ? 'day' : 'days'}
                        </button>
                      ))}
                      <input
                        type="datetime-local"
                        value={suspendUntil}
                        onChange={(e) => setSuspendUntil(e.target.value)}
                        className="text-xs h-8 rounded-lg border border-slate-200 px-2 bg-white"
                      />
                    </div>
                    <input
                      value={suspendReason}
                      onChange={(e) => setSuspendReason(e.target.value)}
                      placeholder="Reason (optional)"
                      className="w-full h-8 rounded-lg border border-slate-200 px-2 text-xs bg-white"
                    />
                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => setSuspendFor(null)} className="text-xs text-slate-500 hover:underline">Cancel</button>
                      <button
                        onClick={() => doSuspend(m.member_id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-500 text-white px-3 py-1.5 text-xs font-semibold hover:bg-amber-600 disabled:opacity-50"
                      >
                        {busy && <Loader2 className="w-3 h-3 animate-spin" />} Suspend member
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CreateConversationModal({ kind, people, onClose, onCreated }) {
  const isGroup = kind === 'group'
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const filtered = (people || []).filter((p) =>
    `${p.full_name || ''} ${p.email || ''} ${p.department || ''}`.toLowerCase().includes(search.toLowerCase())
  )

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const create = async () => {
    if (!name.trim()) { setError('A name is required'); return }
    setBusy(true)
    setError('')
    try {
      const memberIds = [...selected]
      const res = isGroup
        ? await groups.create({ name: name.trim(), description, memberIds })
        : await channels.create({ name: name.trim(), displayName: name.trim(), description, channelType: 'team', memberIds: memberIds.length ? memberIds : null })
      onCreated(res)
    } catch (e) {
      setError(e?.message || 'Could not create')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900">New {isGroup ? 'Group' : 'Channel'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3 border-b border-slate-100">
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={isGroup ? 'e.g. Product Team' : 'e.g. digital-banking'} className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
          </div>
          {isGroup && (
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What is this group about?" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Members ({selected.size} selected)</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
          {filtered.length === 0 && <div className="px-5 py-8 text-center text-sm text-slate-400">No matching people.</div>}
          {filtered.map((p) => {
            const checked = selected.has(p.id)
            return (
              <button key={p.id} onClick={() => toggle(p.id)} className="w-full text-left px-5 py-2.5 flex items-center gap-3 hover:bg-slate-50">
                <input type="checkbox" checked={checked} readOnly className="w-4 h-4 accent-[#009944]" />
                <div className={`w-8 h-8 rounded-full ${hueFor(displayPersonName(p))} flex items-center justify-center text-[10px] font-semibold text-white shrink-0`}>
                  {initials(displayPersonName(p))}
                </div>
                <div className="min-w-0 flex-1">
                     <p className="text-sm text-slate-800 truncate">{displayPersonName(p)}</p>
                  <p className="text-xs text-slate-400 truncate">{p.department || p.position || ''}</p>
                </div>
              </button>
            )
          })}
        </div>
        {error && <div className="px-5 py-2 text-xs text-rose-600">{error}</div>}
        <div className="px-5 py-4 border-t border-slate-100 text-right">
          <button
            onClick={create}
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create {kind}
          </button>
        </div>
      </div>
    </div>
  )
}

function TaskModal({ msg, people, me, onClose, onSubmit }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assignedTo, setAssignedTo] = useState(me)
  const [dueDate, setDueDate] = useState('')
  const [priority, setPriority] = useState('normal')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!title.trim()) return
    setBusy(true)
    await onSubmit({ title: title.trim(), description: description.trim() || null, assignedTo: assignedTo || null, dueDate: dueDate || null, priority })
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">Create action item</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 line-clamp-2">
          From message: &ldquo;{(msg.body || '').slice(0, 90)}{(msg.body || '').length > 90 ? '…' : ''}&rdquo;
        </p>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title *" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Details" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Assignee</label>
            <select value={assignedTo || ''} onChange={(e) => setAssignedTo(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
              <option value="">Unassigned</option>
               {people.map((p) => <option key={p.id} value={p.id}>{displayPersonName(p)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Due date</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm" />
          </div>
        </div>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full h-10 rounded-lg border border-slate-300 px-2 text-sm">
          <option value="low">Low priority</option>
          <option value="normal">Normal priority</option>
          <option value="high">High priority</option>
          <option value="urgent">Urgent</option>
        </select>
        <div className="text-right">
          <button onClick={submit} disabled={busy || !title.trim()} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-40">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create task
          </button>
        </div>
      </div>
    </div>
  )
}
