import React, { useEffect, useRef, useState } from 'react'
import { MessageSquare, Plus, Send, WifiOff, Wifi, Loader2, X, Search, CheckCheck } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../hooks/useAuth'
import {
  getOrCreateThread,
  listMyThreads,
  listMessages,
  sendMessage as sendMessageQueued,
  syncOutbox,
  readOutbox,
  pairKey,
} from '../services/chatService'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

const initials = (name = '') => name.split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join('') || '?'

export default function Chat() {
  const { user, profile } = useAuth()
  const me = user?.id
  const myName = profile?.full_name || user?.email || 'Me'

  const [threads, setThreads] = useState([])
  const [activeThread, setActiveThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [people, setPeople] = useState([])
  const [showNew, setShowNew] = useState(false)
  const [personSearch, setPersonSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [connected, setConnected] = useState(false)
  const bottomRef = useRef(null)

  const updatePendingCount = () => setPendingCount(readOutbox(me).length)

  const loadThreads = async () => {
    try {
      const data = await listMyThreads()
      setThreads(data || [])
      return data || []
    } catch (e) {
      setError(e?.message || 'Failed to load conversations')
      return []
    }
  }

  useEffect(() => {
    if (!me) return
    setLoading(true)
    loadThreads().finally(() => {
      setLoading(false)
      updatePendingCount()
    })
  }, [me])

  // Connectivity + outbox flushing
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

  // Load members for the "new chat" picker (everyone except me)
  useEffect(() => {
    if (!showNew || !me) return
    supabase
      .from('profiles')
      .select('id, full_name, email, role, department, status')
      .neq('id', me)
      .order('full_name', { ascending: true })
      .then(({ data }) => setPeople(data || []))
      .catch(() => setPeople([]))
  }, [showNew, me])

  // Load messages for the active thread
  useEffect(() => {
    if (!activeThread) { setMessages([]); return }
    listMessages(activeThread.id).then(setMessages).catch(() => setMessages([]))
  }, [activeThread])

  // Realtime subscription for the active thread
  useEffect(() => {
    if (!activeThread || !me) return
    const channel = supabase
      .channel(`chat_${activeThread.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `thread_id=eq.${activeThread.id}` }, (payload) => {
        const msg = payload.new
        if (msg && msg.sender_id !== me) {
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
        }
        if (msg?.sender_id === me) {
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, status: 'sent' } : m)))
        }
        setThreads((prev) =>
          prev.map((t) =>
            t.id === activeThread.id
              ? { ...t, last_message: msg?.body || t.last_message, last_message_at: msg?.created_at || t.last_message_at }
              : t
          )
        )
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_threads', filter: `id=eq.${activeThread.id}` }, (payload) => {
        const t = payload.new
        setThreads((prev) => prev.map((x) => (x.id === t.id ? { ...x, last_message: t.last_message, last_message_at: t.last_message_at, last_sender_id: t.last_sender_id } : x)))
      })
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'))

    return () => { supabase.removeChannel(channel) }
  }, [activeThread, me])

  // Auto-scroll to the newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, activeThread])

  const otherMember = (t) => {
    if (!t) return null
    return t.member_a === me ? t.member_b : t.member_a
  }

  const nameOf = (id) => {
    if (id === me) return myName
    const t = threads.find((x) => otherMember(x) === id)
    return t?.other_name || t?.other_email || id?.slice(0, 8) || 'User'
  }

  // Peek at the people picker for display names
  const personName = (id) => {
    const p = people.find((x) => x.id === id)
    return p?.full_name || p?.email || id?.slice(0, 8) || 'User'
  }

  const about = (t) => {
    if (!t) return ''
    return t.member_a === me ? (t.member_b_name || t.member_b_email || t.member_b?.slice(0, 8)) : (t.member_a_name || t.member_a_email || t.member_a?.slice(0, 8))
  }

  const openNewChat = async (personId) => {
    setCreating(true)
    setError('')
    try {
      const thread = await getOrCreateThread(personId)
      if (!thread?.id) throw new Error('Could not create conversation')
      const fresh = await loadThreads()
      const full = fresh.find((t) => t.id === thread.id)
      setActiveThread(full || thread)
      setShowNew(false)
    } catch (e) {
      setError(e?.message || 'Failed to start conversation')
    } finally {
      setCreating(false)
    }
  }

  const send = async () => {
    const body = text.trim()
    if (!body || !activeThread || sending) return
    setSending(true)
    setError('')
    const res = await sendMessageQueued({ threadId: activeThread.id, body, senderId: me })
    setMessages((prev) => [...prev, res.optimistic])
    setThreads((prev) => prev.map((t) => (t.id === activeThread.id ? { ...t, last_message: body, last_message_at: new Date().toISOString(), last_sender_id: me } : t)))
    setText('')
    setSending(false)
    if (res.queued) updatePendingCount()
  }

  const flushOutbox = async () => {
    const { remaining } = await syncOutbox(me)
    if (remaining === 0) {
      updatePendingCount()
      if (activeThread) listMessages(activeThread.id).then(setMessages).catch(() => {})
    }
  }

  const filteredPeople = personSearch
    ? people.filter((p) => `${p.full_name || ''} ${p.email || ''} ${p.department || ''}`.toLowerCase().includes(personSearch.toLowerCase()))
    : people

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">Messages</h2>
          <p className="text-sm text-slate-500 mt-1 flex items-center gap-2">
            Internal team chat — messages are saved even when you're offline.
            {online ? <span className="inline-flex items-center gap-1 text-emerald-600"><Wifi className="w-3.5 h-3.5" /> Online</span> : <span className="inline-flex items-center gap-1 text-amber-600"><WifiOff className="w-3.5 h-3.5" /> Offline — queued locally</span>}
            {pendingCount > 0 && <button onClick={flushOutbox} className="inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline">{pendingCount} queued — Sync now</button>}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
          <Plus className="w-4 h-4" /> New Message
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}

      <div className="grid lg:grid-cols-[320px_1fr] gap-4">
        {/* Conversation list */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-800">Conversations</p>
          </div>
          <div className="max-h-[65vh] overflow-y-auto divide-y divide-slate-50">
            {loading && <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-300" /></div>}
            {!loading && threads.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-slate-400">No conversations yet.<br /><button onClick={() => setShowNew(true)} className="text-[#009944] hover:underline mt-1">Start one</button></div>
            )}
            {threads.map((t) => {
              const other = otherMember(t)
              const active = activeThread?.id === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveThread(t)}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 transition-colors ${active ? 'bg-emerald-50/50' : ''}`}
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 ${active ? 'bg-[#009944]' : 'bg-slate-400'}`}>{initials(personName(other) !== `User` ? personName(other) : other?.slice(0, 8))}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{personName(other)}</p>
                    <p className="text-xs text-slate-400 truncate">{t.last_sender_id === me ? 'You: ' : ''}{t.last_message || 'Say hello 👋'}</p>
                  </div>
                  {t.last_message_at && <span className="text-[10px] text-slate-300 shrink-0">{new Date(t.last_message_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                </button>
              )
            })}
          </div>
        </div>

        {/* Active conversation */}
        <div className="bg-white rounded-2xl border border-slate-200 flex flex-col min-h-[65vh]">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-slate-400 flex items-center justify-center text-xs font-semibold text-white">{initials(activeThread ? personName(otherMember(activeThread)) : '')}</div>
              <div>
                <p className="text-sm font-semibold text-slate-800">{activeThread ? personName(otherMember(activeThread)) : 'Select a conversation'}</p>
                {activeThread && <p className="text-[11px] text-slate-400">{connected ? 'Realtime enabled' : 'Connecting…'}</p>}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-h-[52vh] min-h-[52vh] bg-slate-50/50">
            {!activeThread && <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-2"><MessageSquare className="w-8 h-8" /><p className="text-sm">Pick a conversation or start a new message.</p></div>}
            {activeThread && messages.length === 0 && <div className="h-full flex items-center justify-center text-sm text-slate-400">No messages yet — say hi!</div>}
            {activeThread && messages.map((m) => {
              const mine = m.sender_id === me
              const isOptimistic = m.id?.startsWith('optimistic_')
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${mine ? 'bg-[#009944] text-white rounded-br-sm' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'}`}>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <div className={`text-[10px] mt-1 flex items-center gap-1 ${mine ? 'text-emerald-100' : 'text-slate-400'}`}>
                      {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      {mine && (m.status === 'sent' ? <CheckCheck className="w-3 h-3" /> : isOptimistic && <span className="italic">queued</span>)}
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>

          <div className="p-3 border-t border-slate-100">
            <div className="flex gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder={activeThread ? 'Type a message…' : 'Select a conversation first'}
                disabled={!activeThread}
                className={inputCls}
              />
              <button
                onClick={send}
                disabled={!activeThread || !text.trim() || sending}
                className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-[#009944] text-white hover:bg-[#007a36] disabled:opacity-40 shrink-0"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* New message modal */}
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
                <input value={personSearch} onChange={(e) => setPersonSearch(e.target.value)} placeholder="Search people…" className="w-full h-10 pl-9 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#009944]" />
              </div>
            </div>
            <div className="max-h-[50vh] overflow-y-auto divide-y divide-slate-50">
              {filteredPeople.length === 0 && <div className="px-5 py-10 text-center text-sm text-slate-400">No matching people.</div>}
              {filteredPeople.map((p) => (
                <button key={p.id} onClick={() => openNewChat(p.id)} disabled={creating} className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-emerald-50/50 disabled:opacity-50">
                  <div className="w-9 h-9 rounded-full bg-slate-400 flex items-center justify-center text-xs font-semibold text-white">{initials(p.full_name)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">{p.full_name || p.email}</p>
                    <p className="text-xs text-slate-400 truncate">{p.department || p.role || p.email}</p>
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