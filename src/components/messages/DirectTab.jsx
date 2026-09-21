import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MessageSquare, MoreVertical, Pin, Plus, Search, Trash2, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react'
import { supabase } from '../../supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  conversationPins, directChat, listAttachments, messageActions, resolveDirectory, unreadMessageTotal, uploadChatAttachment,
} from '../../services/corporateChatService'
import { readOutbox, syncOutbox } from '../../services/chatService'
import MessageBubble from './MessageBubble'
import Composer from './Composer'
import PersonAvatar from './PersonAvatar'
import { displayPersonName, personMatches } from './personUtils'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

function unreadCountsByThread(payload) {
  const result = {}
  if (!payload) return result
  const rows = Array.isArray(payload)
    ? payload
    : payload.counts || payload.threads || payload.direct || payload.data || null
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const id = row?.thread_id || row?.conversation_id || row?.id
      if (id) result[id] = Number(row.unread_count ?? row.unread ?? row.count ?? 0)
    }
    return result
  }
  if (rows && typeof rows === 'object') {
    for (const [id, count] of Object.entries(rows)) {
      if (typeof count === 'number') result[id] = count
    }
    return result
  }
  if (typeof payload === 'object') {
    for (const [id, count] of Object.entries(payload)) {
      if (typeof count === 'number') result[id] = count
    }
  }
  return result
}

const unreadTotal = (counts) => Object.values(counts || {}).reduce((sum, count) => sum + Number(count || 0), 0)

const fmtTime = (iso) => {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function DirectTab({ people, identity, onUnreadChange, openThreadId, onThreadOpened }) {
  const { user, profile } = useAuth()
  const me = user?.id
  const myName = displayPersonName({ full_name: profile?.full_name, email: user?.email })

  const [threads, setThreads] = useState([])
  const [activeThread, setActiveThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [attachments, setAttachments] = useState({})
  const [unreadByThread, setUnreadByThread] = useState({})
  const [reactions, setReactions] = useState({})
  const [text, setText] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [personSearch, setPersonSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [connected, setConnected] = useState(false)
  const [pinnedConvs, setPinnedConvs] = useState([])
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const bottomRef = useRef(null)
  const messageIdsRef = useRef(new Set())

  const updatePendingCount = () => setPendingCount(readOutbox(me).length)

  const loadThreads = async () => {
    try {
      const data = await directChat.listThreads()
      let counts = {}
      let unreadPayload = null
      try {
        unreadPayload = await directChat.unreadCounts()
        counts = unreadCountsByThread(unreadPayload)
      } catch (_) {}
      const nextThreads = (data || []).map((thread) => ({
        ...thread,
        unread_count: counts[thread.id] ?? Number(thread.unread_count || 0),
      }))
      setThreads(nextThreads)
      setUnreadByThread(counts)
      onUnreadChange?.(Object.keys(counts).length ? unreadTotal(counts) : unreadMessageTotal(unreadPayload))
      await resolveDirectory(nextThreads.flatMap((t) => [t.member_a, t.member_b]))
      return nextThreads
    } catch (e) {
      setError(e?.message || 'Failed to load conversations')
      return []
    }
  }

  useEffect(() => {
    if (!me) return
    setLoading(true)
    Promise.all([
      loadThreads(),
      conversationPins.listMine().then(setPinnedConvs).catch((e) => {
        setError(e?.message || 'Could not load chat pins')
        return []
      }),
    ]).finally(() => {
      setLoading(false)
      updatePendingCount()
    })
  }, [me])

  // Open a DM thread requested from another tab (e.g. "Message" from a channel member).
  useEffect(() => {
    if (!openThreadId) return
    const open = async () => {
      let threadsList = threads
      if (threadsList.length === 0) {
        threadsList = await loadThreads()
      }
      const found = threadsList.find((t) => t.id === openThreadId)
      if (found) {
        setActiveThread(found)
      } else {
        try {
          const refreshed = await directChat.listThreads()
          const match = refreshed.find((t) => t.id === openThreadId)
          if (match) {
            setThreads((prev) => {
              if (prev.some((t) => t.id === match.id)) return prev
              return [match, ...prev]
            })
            setActiveThread(match)
          }
        } catch (_) {}
      }
      onThreadOpened?.()
    }
    open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadId])

  useEffect(() => {
    const goOnline = async () => {
      setOnline(true)
      if (me) {
        const { remaining } = await syncOutbox(me)
        if (remaining === 0) updatePendingCount()
      }
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [me])

  useEffect(() => {
    if (!activeThread) { setMessages([]); return }
    setMessages([])
    setAttachments({})
    messageIdsRef.current = new Set()
    const threadId = activeThread.id
    directChat.listMessages(threadId).then(async (msgs) => {
      const rows = msgs || []
      setMessages(rows)
      messageIdsRef.current = new Set(rows.map((m) => m.id).filter(Boolean))
      await ensureMessageExtras(rows.map((m) => m.id))
      const incoming = rows.filter((m) => m.sender_id !== me && !m.read_at)
      try {
        await directChat.markRead(threadId)
      } catch (_) {
        await Promise.all(incoming.map((m) => messageActions.markRead(m.id)))
      }
      setUnreadByThread((prev) => {
        const next = { ...prev, [threadId]: 0 }
        onUnreadChange?.(unreadTotal(next))
        return next
      })
      setThreads((prev) => prev.map((thread) => thread.id === threadId ? { ...thread, unread_count: 0 } : thread))
      const ids = rows.map((m) => m.id)
      if (ids.length) {
        import('../../services/corporateChatService').then(({ listReactions }) =>
          listReactions(ids).then((rr) => {
            const grouped = {}
            for (const r of rr || []) grouped[r.message_id] = grouped[r.message_id] || []
            for (const r of rr || []) grouped[r.message_id].push(r)
            setReactions(grouped)
          }).catch(() => {})
        )
      }
    }).catch(() => setMessages([]))
  }, [activeThread])

  const ensureMessageExtras = async (messageIds) => {
    const ids = [...new Set((messageIds || []).filter(Boolean))]
    if (!ids.length) return
    try {
      const rows = await listAttachments(ids)
      if (!rows?.length) return
      setAttachments((prev) => {
        const next = { ...prev }
        for (const attachment of rows) {
          const existing = next[attachment.message_id] || []
          if (!existing.some((item) => item.id === attachment.id)) {
            next[attachment.message_id] = [...existing, attachment]
          }
        }
        return next
      })
    } catch (_) {}
  }

  useEffect(() => {
    if (!activeThread || !me) return
    const channel = supabase
      .channel(`direct_${activeThread.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `thread_id=eq.${activeThread.id}` }, (payload) => {
        const msg = payload.new
        if (!msg) return
        messageIdsRef.current.add(msg.id)
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          if (msg.sender_id === me) {
            const idx = prev.findIndex((m) => m.sender_id === me && m.body === msg.body && m.status === 'queued')
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...msg, status: 'sent' }
              return next
            }
          }
          return [...prev, msg]
        })
        setThreads((prev) =>
          prev.map((t) => (t.id === activeThread.id ? { ...t, last_message: msg.body, last_message_at: msg.created_at, last_sender_id: msg.sender_id } : t))
        )
        if (msg.sender_id !== me) {
          messageActions.markRead(msg.id).catch(() => {})
          directChat.markRead(activeThread.id).catch(() => {})
        }
        ensureMessageExtras([msg.id])
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
  }, [activeThread, me])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, activeThread])

  const otherMember = (t) => (t.member_a === me ? t.member_b : t.member_a)

  const personName = (id) => {
    if (id === me) return myName
    const ident = identity[id]
    if (ident?.name) return ident.name
    return 'Unknown User'
  }

  const openNewChat = async (personId) => {
    setCreating(true)
    setError('')
    try {
      const thread = await directChat.getOrCreate(personId)
      if (!thread?.id) throw new Error('Could not create conversation')
      const fresh = await loadThreads()
      const full = fresh.find((t) => t.id === thread.id)
      setActiveThread(full || thread)
      setShowNew(false)
      await resolveDirectory([personId])
    } catch (e) {
      setError(e?.message || 'Failed to start conversation')
    } finally {
      setCreating(false)
    }
  }

  const isPinned = (threadId) => conversationPins.isPinned(pinnedConvs, 'direct', threadId)
  const isMuted = !!activeThread?.is_muted

  const togglePinChat = async () => {
    if (!activeThread || actionBusy) return
    setActionBusy(true)
    setError('')
    try {
      if (isPinned(activeThread.id)) await conversationPins.unpin('direct', activeThread.id)
      else await conversationPins.pin('direct', activeThread.id)
      setPinnedConvs(await conversationPins.listMine())
      setThreadMenuOpen(false)
    } catch (e) {
      setError(e?.message || 'Could not update the chat pin')
    } finally {
      setActionBusy(false)
    }
  }

  const toggleMuteChat = async () => {
    if (!activeThread || actionBusy) return
    const muted = !activeThread.is_muted
    setActionBusy(true)
    setError('')
    try {
      await directChat.setMuted(activeThread.id, muted)
      const updated = { ...activeThread, is_muted: muted }
      setActiveThread(updated)
      setThreads((prev) => prev.map((thread) => (thread.id === updated.id ? updated : thread)))
      setThreadMenuOpen(false)
    } catch (e) {
      setError(e?.message || 'Could not update mute settings')
    } finally {
      setActionBusy(false)
    }
  }

  const deleteChatForMe = async () => {
    if (!activeThread || actionBusy) return
    if (!window.confirm('Delete this chat for you? The other person will keep the conversation.')) return
    setActionBusy(true)
    setError('')
    try {
      await directChat.deleteForMe(activeThread.id)
      setThreads((prev) => prev.filter((thread) => thread.id !== activeThread.id))
      setPinnedConvs((prev) => prev.filter((pin) => !(pin.conversation_type === 'direct' && pin.conversation_id === activeThread.id)))
      setActiveThread(null)
      setMessages([])
      setThreadMenuOpen(false)
    } catch (e) {
      setError(e?.message || 'Could not delete the chat for you')
    } finally {
      setActionBusy(false)
    }
  }

  const sortedThreads = useMemo(() => (
    [...threads].sort((a, b) => (
      Number(isPinned(a.id)) - Number(isPinned(b.id))
      || new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
    ))
  ), [threads, pinnedConvs])

  const send = async (bodyValue, mentionIds, opts = {}) => {
    const body = (bodyValue || '').trim()
    const selectedFiles = opts.files || []
    const rich = selectedFiles.length > 0 || !!opts.priority
    if ((!body && selectedFiles.length === 0) || !activeThread || sending) return false
    setSending(true)
    setError('')
    try {
      if (rich) {
        const uploaded = []
        for (const file of selectedFiles) {
          const meta = await uploadChatAttachment('direct', activeThread.id, file)
          uploaded.push({
            file_name: meta.file_name,
            file_type: meta.file_type,
            attachment_type: meta.attachment_type,
            file_size: meta.file_size,
            file_path: meta.file_path,
            checksum: meta.checksum,
          })
        }
        const fresh = await directChat.sendRich(activeThread.id, {
          body,
          priority: opts.priority,
          requiresAck: false,
          files: uploaded,
          mentionIds,
        })
        const message = {
          ...fresh,
          id: fresh?.id,
          thread_id: fresh?.thread_id || activeThread.id,
          sender_id: fresh?.sender_id || me,
          message_type: 'direct',
          status: 'sent',
        }
        if (message.id) {
          messageIdsRef.current.add(message.id)
          setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
          await ensureMessageExtras([message.id])
        }
      } else {
        const optimistic = {
          id: `optimistic_${Date.now()}`,
          thread_id: activeThread.id,
          sender_id: me,
          body,
          status: 'queued',
          created_at: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, optimistic])
        try {
          const fresh = await directChat.send(activeThread.id, body)
          if (fresh?.id) {
            const message = { ...fresh, thread_id: fresh.thread_id || activeThread.id, sender_id: fresh.sender_id || me, message_type: 'direct', status: 'sent' }
            messageIdsRef.current.delete(optimistic.id)
            messageIdsRef.current.add(message.id)
            setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? message : m)))
          } else {
            setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...m, status: 'sent' } : m)))
          }
        } catch {
          const { sendMessage: queueOffline } = await import('../../services/chatService')
          await queueOffline({ threadId: activeThread.id, body, senderId: me })
          updatePendingCount()
        }
      }
      setText('')
      return true
    } catch (e) {
      setError(e?.message || 'Message or attachment was not sent')
      return false
    } finally {
      setSending(false)
    }
  }

  const flushOutbox = async () => {
    const { remaining } = await syncOutbox(me)
    if (remaining === 0) {
      updatePendingCount()
      if (activeThread) directChat.listMessages(activeThread.id).then(setMessages).catch(() => {})
    }
  }

  const toggleReaction = async (msg, emoji) => {
    try {
      const { messageActions, listReactions } = await import('../../services/corporateChatService')
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

  const doBookmark = async (msg) => {
    try {
      const { messageActions } = await import('../../services/corporateChatService')
      await messageActions.toggleBookmark(msg.id)
    } catch (e) {
      setError(e?.message || 'Could not bookmark')
    }
  }

  const doReport = async ({ msg, reason }) => {
    try {
      const { messageActions } = await import('../../services/corporateChatService')
      const REASON_MAP = { spam: 'inappropriate_content', harassment: 'harassment', 'sensitive data': 'confidential_information', misinformation: 'misinformation', other: 'other' }
      await messageActions.report(msg.id, REASON_MAP[reason] || 'other')
    } catch (e) {
      setError(e?.message || 'Could not file report')
    }
  }

  const filteredPeople = personSearch
    ? people.filter((p) => personMatches(p, personSearch))
    : people

  return (
    <div className="grid lg:grid-cols-[320px_1fr] gap-4">
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-800">Direct Messages</p>
          <div className="flex items-center gap-2">
            {online ? <span className="inline-flex items-center gap-1 text-emerald-600 text-[11px]"><Wifi className="w-3.5 h-3.5" /> Online</span> : <span className="inline-flex items-center gap-1 text-amber-600 text-[11px]"><WifiOff className="w-3.5 h-3.5" /> Offline</span>}
            <button onClick={() => setShowNew(true)} className="inline-flex items-center gap-1 rounded-lg bg-[#009944] text-white px-2 py-1.5 text-xs font-medium hover:bg-[#007a36]">
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          </div>
        </div>
        {pendingCount > 0 && (
          <button onClick={flushOutbox} className="w-full px-4 py-2 bg-amber-50 text-amber-700 text-xs flex items-center justify-between hover:bg-amber-100">
            {pendingCount} message{pendingCount === 1 ? '' : 's'} queued offline — <span className="font-semibold underline">Sync now</span>
          </button>
        )}
          <div className="max-h-[65vh] overflow-y-auto divide-y divide-slate-50">
          {loading && <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-300" /></div>}
          {!loading && threads.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-slate-400">No conversations yet.<br /><button onClick={() => setShowNew(true)} className="text-[#009944] hover:underline mt-1">Start one</button></div>
          )}
           {sortedThreads.map((t) => {
             const other = otherMember(t)
             const active = activeThread?.id === t.id
             const unread = Number(t.unread_count ?? unreadByThread[t.id] ?? 0)
             return (
              <button
                key={t.id}
                onClick={() => { setActiveThread(t); setThreadMenuOpen(false) }}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors ${active ? 'bg-emerald-50/50' : ''}`}
              >
                <PersonAvatar person={identity[other] || people.find((p) => p.id === other)} sizeClass="w-9 h-9" textClass="text-xs" />
                 <div className="min-w-0 flex-1">
                   <p className="text-sm font-medium text-slate-800 truncate">{personName(other)}</p>
                   <p className="text-xs text-slate-400 truncate">{t.last_sender_id === me ? 'You: ' : ''}{t.last_message || 'Say hello'}</p>
                 </div>
                 {unread > 0 && (
                   <span className="min-w-[18px] h-[18px] rounded-full bg-[#009944] px-1.5 text-center text-[10px] font-semibold leading-[18px] text-white shrink-0">
                     {unread > 99 ? '99+' : unread}
                   </span>
                 )}
                 {isPinned(t.id) && <Pin className="w-3.5 h-3.5 text-[#009944] shrink-0 fill-[#009944]" />}
                {t.is_muted && <VolumeX className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                {t.last_message_at && <span className="text-[10px] text-slate-300 shrink-0">{fmtTime(t.last_message_at)}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 flex flex-col min-h-[65vh]">
        {!activeThread ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2 py-24">
            <MessageSquare className="w-8 h-8" />
            <p className="text-sm">Pick a conversation or start a new direct message.</p>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                <PersonAvatar person={identity[otherMember(activeThread)] || people.find((p) => p.id === otherMember(activeThread))} sizeClass="w-9 h-9" textClass="text-xs" />
                <div>
                  <p className="text-sm font-semibold text-slate-800">{personName(otherMember(activeThread))}</p>
                  <p className="text-[11px] text-slate-400">{connected ? 'Realtime enabled' : 'Connecting…'}</p>
                </div>
                </div>
                <div className="relative">
                  <button
                    type="button"
                    title="Chat options"
                    aria-label="Chat options"
                    onClick={() => setThreadMenuOpen((open) => !open)}
                    className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </button>
                  {threadMenuOpen && (
                    <div className="absolute right-0 top-10 z-30 w-52 rounded-xl border border-slate-200 bg-white shadow-lg py-1 text-sm">
                      <button type="button" onClick={togglePinChat} disabled={actionBusy} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700 disabled:opacity-50">
                        <Pin className="w-4 h-4" /> {isPinned(activeThread.id) ? 'Unpin chat' : 'Pin chat'}
                      </button>
                      <button type="button" onClick={toggleMuteChat} disabled={actionBusy} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700 disabled:opacity-50">
                        {isMuted ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />} {isMuted ? 'Unmute chat' : 'Mute chat'}
                      </button>
                      <button type="button" onClick={deleteChatForMe} disabled={actionBusy} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-rose-600 disabled:opacity-50">
                        <Trash2 className="w-4 h-4" /> Delete chat for me
                      </button>
                    </div>
                  )}
                </div>
            </div>

            {error && <div className="px-4 py-2 text-xs text-rose-600 bg-rose-50 border-b border-rose-100">{error}</div>}

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-h-[52vh] min-h-[52vh] bg-slate-50/50">
              {messages.length === 0 && <div className="h-full flex items-center justify-center text-sm text-slate-400">No messages yet — say hi!</div>}
              {messages.map((m) => {
                const mine = m.sender_id === me
                return (
                  <MessageBubble
                    key={m.id}
                    msg={{ ...m, my_user_id: me }}
                    mine={mine}
                    myUserId={me}
                     name={personName(m.sender_id)}
                     time={fmtTime(m.created_at)}
                     reactions={reactions[m.id]}
                     attachments={attachments[m.id] || []}
                    onToggleReaction={toggleReaction}
                    onEdit={mine ? async (msg) => {
                      const next = window.prompt('Edit message', msg.body)
                      if (!next || next === msg.body) return
                      try {
                        const { messageActions } = await import('../../services/corporateChatService')
                        await messageActions.edit(msg.id, next)
                        setMessages((prev) => prev.map((x) => (x.id === msg.id ? { ...x, body: next, edited_at: new Date().toISOString(), edit_count: (x.edit_count || 0) + 1 } : x)))
                      } catch (e) { setError(e?.message || 'Could not edit') }
                    } : null}
                    onSoftDelete={mine ? async (msg) => {
                      if (!window.confirm('Delete this message? The record is preserved internally.')) return
                      try {
                        const { messageActions } = await import('../../services/corporateChatService')
                        await messageActions.softDelete(msg.id)
                        setMessages((prev) => prev.map((x) => (x.id === msg.id ? { ...x, restricted_status: 'deleted' } : x)))
                      } catch (e) { setError(e?.message || 'Could not delete') }
                    } : null}
                    onReport={doReport}
                    onBookmark={doBookmark}
                    allowed={{ edit: true, delete: true, report: true }}
                  />
                )
              })}
              <div ref={bottomRef} />
            </div>

            <Composer
              value={text}
              onChange={setText}
              onSend={send}
              sending={sending}
              people={people}
              allowRequireAck={false}
              placeholder="Type a message…"
            />
          </>
        )}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">New Message</h3>
              <button onClick={() => setShowNew(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="px-5 py-3 border-b border-slate-100">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input value={personSearch} onChange={(e) => setPersonSearch(e.target.value)} placeholder="Search people…" className={inputCls.replace('w-full', 'w-full pl-9')} />
              </div>
            </div>
            <div className="max-h-[50vh] overflow-y-auto divide-y divide-slate-50">
              {filteredPeople.length === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400">No matching people.</div>}
              {filteredPeople.map((p) => (
                 <button key={p.id} onClick={() => openNewChat(p.id)} disabled={creating} className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-emerald-50/50 disabled:opacity-50">
                    <PersonAvatar person={p} sizeClass="w-9 h-9" textClass="text-xs" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800">{displayPersonName(p)}</p>
                     <p className="text-xs text-slate-400 truncate">
                        {[p.department, p.position, p.role, p.employee_number || p.staff_id || p.staffId, p.email].filter(Boolean).join(' · ')}
                      </p>
                   </div>
                 </button>
              ))}
            </div>
            {creating && <div className="px-5 py-4 text-center text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Starting conversation…</div>}
          </div>
        </div>
      )}
    </div>
  )
}
