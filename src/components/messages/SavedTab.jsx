import React, { useEffect, useState } from 'react'
import { AtSign, Bookmark, Loader2, MessageCircle, X } from 'lucide-react'
import { listMyBookmarks, listMyMentions, resolveDirectory } from '../../services/corporateChatService'

const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export default function SavedTab({ identity }) {
  const [bookmarks, setBookmarks] = useState([])
  const [mentions, setMentions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [removeHighlight, setRemoveHighlight] = useState(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [b, mn] = await Promise.all([listMyBookmarks(), listMyMentions()])
      setBookmarks(b || [])
      setMentions(mn || [])
      await resolveDirectory([
        ...(b || []).map((x) => x.message?.sender_id).filter(Boolean),
        ...(mn || []).map((x) => x.message?.sender_id).filter(Boolean),
        ...(mn || []).map((x) => x.user_id).filter(Boolean),
      ])
      return {}
    } catch (e) {
      setError(e?.message || 'Could not load activity')
      return {}
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const removeBookmark = async (bookmarkId, messageId) => {
    const { messageActions } = await import('../../services/corporateChatService')
    try {
      await messageActions.toggleBookmark(messageId)
      setRemoveHighlight(bookmarkId)
      setTimeout(() => {
        setBookmarks((prev) => prev.filter((x) => x.id !== bookmarkId))
        setRemoveHighlight(null)
      }, 300)
    } catch (e) {
      setError(e?.message || 'Could not remove bookmark')
    }
  }

  const Row = ({ icon, iconCls, title, body, senderId, when, onRemove, fading }) => (
    <div className={`px-5 py-3.5 flex items-start gap-3 transition-opacity ${fading ? 'opacity-30' : ''}`}>
      <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconCls}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-800 truncate">{title}</p>
          {onRemove && (
            <button onClick={onRemove} className="text-slate-300 hover:text-rose-500 p-0.5 shrink-0"><X className="w-4 h-4" /></button>
          )}
        </div>
        {body && <p className="text-sm text-slate-600 whitespace-pre-wrap line-clamp-2">{body}</p>}
        <p className="text-[11px] text-slate-400 mt-1">
          {identity[senderId]?.name ? `${identity[senderId].name} · ` : ''}{when}
        </p>
      </div>
    </div>
  )

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <Bookmark className="w-4 h-4 text-[#009944]" />
          <p className="text-sm font-semibold text-slate-900">Saved messages</p>
          <span className="text-xs text-slate-400 ml-auto">{bookmarks.length}</span>
        </div>
        {error && <div className="px-5 py-2 text-xs text-rose-600 bg-rose-50 border-b border-rose-100">{error}</div>}
        <div className="divide-y divide-slate-50 max-h-[68vh] overflow-y-auto">
          {loading && <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-300" /></div>}
          {!loading && bookmarks.length === 0 && (
            <div className="px-5 py-12 text-center text-sm text-slate-400">Nothing saved yet. Bookmark messages from any conversation.</div>
          )}
          {bookmarks.map((b) => (
            <Row
              key={b.id}
              icon={<MessageCircle className="w-4 h-4 text-[#009944]" />}
              iconCls="bg-[#009944]/10"
              title={b.message?.title || 'Saved message'}
              body={b.message?.body}
              senderId={b.message?.sender_id}
              when={fmtDate(b.created_at)}
              onRemove={() => removeBookmark(b.id, b.message_id)}
              fading={removeHighlight === b.id}
            />
          ))}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
          <AtSign className="w-4 h-4 text-[#009944]" />
          <p className="text-sm font-semibold text-slate-900">Mentions</p>
          <span className="text-xs text-slate-400 ml-auto">{mentions.length}</span>
        </div>
        <div className="divide-y divide-slate-50 max-h-[68vh] overflow-y-auto">
          {loading && <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-300" /></div>}
          {!loading && mentions.length === 0 && (
            <div className="px-5 py-12 text-center text-sm text-slate-400">No mentions yet. Use @ in a message to bring a colleague in.</div>
          )}
          {mentions.map((m) => (
            <Row
              key={m.id}
              icon={<AtSign className="w-4 h-4 text-[#009944]" />}
              iconCls="bg-[#009944]/10"
              title={m.message?.title || 'You were mentioned'}
              body={m.message?.body}
              senderId={m.message?.sender_id}
              when={fmtDate(m.created_at)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}