import React, { useEffect, useState } from 'react'
import {
  AlertTriangle, Bookmark, CheckCheck, ChevronRight, CloudDownload, FileText, Image as ImageIcon,
  Landmark, Loader2, MailCheck, Pin, Reply, ShieldAlert, Volume2, X,
} from 'lucide-react'
import { getAttachmentSignedUrl, scanSensitiveContent } from '../../services/corporateChatService'
import PersonAvatar from './PersonAvatar'

const attachmentUrlCache = new Map()

const PRIORITY_STYLES = {
  urgent: 'border-amber-400 shadow-[0_0_0_1px_#fbbf24]',
  high: 'border-orange-300',
  normal: '',
}

export default function MessageBubble({
  msg,
  mine,
  myUserId,
  name,
  person = null,
  contextName,
  time,
  reactions = [],
  onToggleReaction,
  onReply,
  onEdit,
  onSoftDelete,
  onPin,
  onOfficial,
  onBookmark,
  onReport,
  onTask,
  allowed = {},
  isBookmarked = false,
  attachments = [],
  myAck = null,
  onAcknowledge = null,
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [error, setError] = useState('')

  const restricted = msg.restricted_status && msg.restricted_status !== 'active'
  const hiddenBody = restricted || msg.is_deleted
  const sensitive = !mine && !hiddenBody ? scanSensitiveContent(msg.body) : []

  const reactionSummary = Object.entries(
    (reactions || []).reduce((acc, r) => {
      acc[r.emoji] = acc[r.emoji] || { count: 0, me: false }
      acc[r.emoji].count += 1
      if (r.user_id === myUserId) acc[r.emoji].me = true
      return acc
    }, {})
  )

  const doReport = async (reason) => {
    setReporting(true)
    setError('')
    try {
      await onReport({ msg, reason })
      setReportOpen(false)
    } catch (e) {
      setError(e?.message || 'Could not file report')
    } finally {
      setReporting(false)
    }
  }

  const closeMenu = () => setMenuOpen(false)

  return (
    <div className={`flex items-start ${mine ? 'justify-end' : 'justify-start'} group`}>
      {!mine && <PersonAvatar person={person} sizeClass="w-7 h-7 mr-2 mt-1" textClass="text-[10px]" />}
      <div className={`max-w-[78%] relative ${mine ? 'order-1' : 'order-2'}`}>
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm ${
            mine
              ? 'bg-[#009944] text-white rounded-br-sm'
              : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'
          } ${restricted ? 'opacity-80' : ''} ${PRIORITY_STYLES[msg.priority] || ''}`}
        >
          {!mine && (
            <p className={`text-xs font-semibold truncate mb-0.5 ${msg.is_official ? 'text-amber-600' : 'text-slate-500'}`}>
              {name}
              {msg.priority === 'urgent' && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600 font-medium">
                  <AlertTriangle className="w-3 h-3" /> Urgent
                </span>
              )}
              {msg.priority === 'high' && msg.requires_ack && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 text-orange-600 font-medium">
                  <MailCheck className="w-3 h-3" /> Important
                </span>
              )}
            </p>
          )}

          {msg.requires_ack && (
            <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide ${mine ? 'text-amber-100' : 'text-orange-600'}`}>
                <MailCheck className="w-3 h-3" /> Requires acknowledgment
              </span>
              {!mine && myAck?.status !== 'acknowledged' && onAcknowledge && (
                <button
                  onClick={() => onAcknowledge(msg)}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 hover:bg-amber-100"
                >
                  <MailCheck className="w-3 h-3" /> I acknowledge receipt
                </button>
              )}
              {!mine && myAck?.status === 'acknowledged' && (
                <span className={`inline-flex items-center gap-1 text-[10px] ${mine ? 'text-emerald-100' : 'text-emerald-600'}`}>
                  <CheckCheck className="w-3 h-3" /> You acknowledged
                </span>
              )}
            </div>
          )}

          {(msg.is_official || msg.is_pinned) && (
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {msg.is_official && (
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide ${mine ? 'text-amber-100' : 'text-amber-600'}`}>
                  <Landmark className="w-3 h-3" /> Official Record
                </span>
              )}
              {msg.is_pinned && (
                <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wide ${mine ? 'text-emerald-100' : 'text-slate-400'}`}>
                  <Pin className="w-3 h-3" /> Pinned
                </span>
              )}
            </div>
          )}

          {msg.title && <p className={`font-semibold ${mine ? 'text-white' : 'text-slate-900'}`}>{msg.title}</p>}

          {hiddenBody ? (
            <p className={`italic ${mine ? 'text-emerald-100' : 'text-slate-400'}`}>
              {restricted ? 'This message was removed by a moderator.' : 'This message was deleted.'}
            </p>
          ) : (
            <p className="whitespace-pre-wrap break-words">{msg.body}</p>
          )}

          {sensitive.length > 0 && (
            <p className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
              <ShieldAlert className="w-3 h-3" /> Possible sensitive content: {sensitive.join(', ')}
            </p>
          )}

          {attachments.length > 0 && (
            <div className={`mt-1.5 space-y-1.5 ${mine ? 'text-right' : ''}`}>
              {attachments.map((a) => <FileAttachment key={a.id || a.file_path} attachment={a} mine={mine} />)}
            </div>
          )}

          {msg.edit_count > 0 && !hiddenBody && (
            <p className={`text-[10px] mt-0.5 italic ${mine ? 'text-emerald-100/80' : 'text-slate-400'}`}>
              edited · {msg.edit_count} revision{msg.edit_count === 1 ? '' : 's'} preserved
            </p>
          )}

          <div className={`mt-1 flex items-center gap-2 ${mine ? 'justify-end' : 'justify-between'}`}>
            <div className={`text-[10px] flex items-center gap-1 ${mine ? 'text-emerald-100' : 'text-slate-400'}`}>
              {time}
              {mine && (msg.status === 'queued' ? <span className="italic">queued</span> : <CheckCheck className="w-3 h-3" />)}
            </div>
            {contextName && (
              <span className={`text-[10px] ${mine ? 'text-emerald-100/70' : 'text-slate-400'}`}>
                {contextName}
              </span>
            )}
          </div>
        </div>

        {/* quick action rail */}
        <div className={`absolute -top-2.5 hidden group-hover:flex items-center gap-0.5 rounded-full border border-slate-200 bg-white shadow-sm p-0.5 z-10 ${mine ? '-left-2' : '-right-2'}`}>
          <button title="React" onClick={() => onToggleReaction?.(msg, '👍')} className="px-1.5 py-1 rounded-full hover:bg-slate-100 text-slate-500"><span className="text-xs">👍</span></button>
          {onReply && (
            <button title="Reply in thread" onClick={() => onReply?.(msg)} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500"><Reply className="w-3.5 h-3.5" /></button>
          )}
          <button title="Save" onClick={() => onBookmark?.(msg)} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500">
            <Bookmark className={`w-3.5 h-3.5 ${isBookmarked ? 'fill-[#009944] text-[#009944]' : ''}`} />
          </button>
          <button title="More" onClick={() => setMenuOpen((v) => !v)} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500"><MoreDots /></button>
        </div>

        {menuOpen && (
          <div className={`absolute z-30 mt-1 w-56 rounded-xl border border-slate-200 bg-white shadow-lg py-1 text-sm ${mine ? 'left-0' : 'right-0'}`}>
            {onReply && (
              <button onClick={() => { closeMenu(); onReply(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700">
                <Reply className="w-4 h-4" /> Reply in thread
              </button>
            )}
            {allowed.edit && !msg.is_official && (
              <button onClick={() => { closeMenu(); onEdit(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700">
                <EditIcon /> Edit message
              </button>
            )}
            {allowed.delete && !msg.is_official && (
              <button onClick={() => { closeMenu(); onSoftDelete(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-rose-600">
                <TrashIcon /> Delete message
              </button>
            )}
            {allowed.pin && (
              <button onClick={() => { closeMenu(); onPin(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700">
                <Pin className="w-4 h-4" /> {msg.is_pinned ? 'Unpin' : 'Pin to conversation'}
              </button>
            )}
            {allowed.official && !msg.is_official && (
              <button onClick={() => { closeMenu(); onOfficial(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-amber-700">
                <Landmark className="w-4 h-4" /> Mark as official record
              </button>
            )}
            {allowed.task && (
              <button onClick={() => { closeMenu(); onTask(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700">
                <TaskIcon /> Create task from message
              </button>
            )}
            {onToggleReaction && (
              <button onClick={() => { closeMenu(); onBookmark(msg) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-slate-700">
                <Bookmark className="w-4 h-4" /> {isBookmarked ? 'Remove bookmark' : 'Bookmark'}
              </button>
            )}
            {allowed.report && (
              <button onClick={() => { closeMenu(); setReportOpen(true) }} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2 text-rose-600">
                <FlagIcon /> Report to moderation
              </button>
            )}
          </div>
        )}

        {reportOpen && (
          <div className="absolute z-40 right-0 mt-1 w-64 rounded-xl border border-slate-200 bg-white shadow-lg p-3 text-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-700">Report this message</p>
              <button onClick={() => setReportOpen(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
            </div>
            {['spam', 'harassment', 'sensitive data', 'misinformation', 'other'].map((r) => (
              <button key={r} onClick={() => doReport(r)} disabled={reporting} className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 capitalize border-b border-slate-50 last:border-0 disabled:opacity-50">
                {r}
              </button>
            ))}
            {error && <p className="text-xs text-rose-600 mt-1">{error}</p>}
          </div>
        )}

        {reactionSummary.length > 0 && (
          <div className={`flex items-center gap-1 mt-0.5 flex-wrap ${mine ? 'justify-end' : 'justify-start'}`}>
            {reactionSummary.map(([emoji, info]) => (
              <button
                key={emoji}
                onClick={() => onToggleReaction?.(msg, emoji)}
                className={`text-[11px] px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1 ${info.me ? 'bg-emerald-50 border-[#009944] text-[#007a36]' : 'bg-white border-slate-200 text-slate-500'}`}
              >
                <span>{emoji}</span>
                <span className="font-medium">{info.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Small local icons (kept inline to avoid extra imports in the action menu)
function MoreDots() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
}
function EditIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
}
function TrashIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
}
function TaskIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
}
function FlagIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
}

function attachmentTypeOf(attachment) {
  const explicit = String(attachment?.attachment_type || '').toLowerCase()
  if (explicit.includes('voice')) return 'voice_note'
  if (explicit.startsWith('image/')) return 'image'
  if (explicit.startsWith('audio/')) return 'audio'
  if (explicit) return explicit
  const type = String(attachment?.file_type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (type === 'application/pdf') return 'pdf'
  if (type.includes('spreadsheet') || type.includes('excel') || type === 'text/csv') return 'spreadsheet'
  if (type.includes('presentation') || type.includes('powerpoint')) return 'presentation'
  if (type.includes('word') || type.includes('document') || type === 'text/plain') return 'document'
  if (type.includes('zip') || type.includes('compressed')) return 'archive'
  return 'file'
}

function attachmentTypeLabel(type) {
  const labels = {
    voice: 'Voice note',
    voice_note: 'Voice note',
    audio: 'Audio',
    image: 'Image',
    video: 'Video',
    pdf: 'PDF',
    document: 'Document',
    spreadsheet: 'Spreadsheet',
    presentation: 'Presentation',
    archive: 'Archive',
    file: 'File',
  }
  return labels[type] || 'File'
}

const isImageAttachment = (attachment) => attachmentTypeOf(attachment) === 'image'
const isAudioAttachment = (attachment) => ['audio', 'voice', 'voice_note'].includes(attachmentTypeOf(attachment))

function prettySize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Secure attachment rendering: files stay private in the documents bucket,
// so every render fetches a short-lived signed URL (cached per file_path).
function FileAttachment({ attachment, mine }) {
  const [url, setUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const type = attachmentTypeOf(attachment)
  const label = attachmentTypeLabel(type)
  const isImg = isImageAttachment(attachment)
  const isAudio = isAudioAttachment(attachment)

  const loadUrl = async () => {
    if (!attachment.file_path) {
      setLoadError('Attachment unavailable')
      return
    }
    if (attachmentUrlCache.has(attachment.file_path)) {
      setUrl(attachmentUrlCache.get(attachment.file_path))
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const signed = await getAttachmentSignedUrl(attachment.file_path, 3600)
      if (signed) attachmentUrlCache.set(attachment.file_path, signed)
      setUrl(signed)
      if (!signed) setLoadError('Attachment unavailable')
    } catch (_) {
      setUrl(null)
      setLoadError('Attachment unavailable')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadUrl() }, [attachment.file_path])

  const openFile = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.download = attachment.file_name || 'attachment'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  if (isImg) {
    return (
      <div className={`max-w-[240px] rounded-lg overflow-hidden border ${mine ? 'border-emerald-200' : 'border-slate-200'}`}>
        <div className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${mine ? 'text-emerald-700 bg-emerald-50' : 'text-slate-500 bg-slate-50'}`}>
          {label}
        </div>
        <button
          type="button"
          onClick={openFile}
          disabled={!url}
          className="block w-full disabled:cursor-not-allowed"
          title={attachment.file_name || label}
        >
          {loading && <div className="w-32 h-24 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-slate-300" /></div>}
          {url && <img src={url} alt={attachment.file_name || 'Image attachment'} onError={() => { setUrl(null); setLoadError('Attachment could not be displayed') }} className="max-h-56 w-auto object-cover" />}
          {!url && !loading && <div className="w-32 h-24 flex flex-col gap-1 items-center justify-center text-slate-400"><ImageIcon className="w-5 h-5" /><span className="text-[10px]">{loadError}</span></div>}
        </button>
      </div>
    )
  }

  if (isAudio) {
    return (
      <div className={`rounded-lg border px-2.5 py-2 ${mine ? 'border-emerald-100 bg-emerald-50/40 text-slate-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
        <div className="flex items-center gap-2 text-xs">
          <Volume2 className="w-3.5 h-3.5 shrink-0 text-[#009944]" />
          <span className="font-semibold">{label}</span>
          <span className="max-w-[170px] truncate text-slate-500">{attachment.file_name || 'Audio attachment'}</span>
          {attachment.file_size ? <span className="ml-auto text-[10px] text-slate-400">{prettySize(attachment.file_size)}</span> : null}
        </div>
        {loading && <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Loading secure audio…</div>}
        {url && <audio controls preload="metadata" src={url} className="mt-1 h-8 w-full" onError={() => setLoadError('Audio could not be played')} />}
        {!url && !loading && <p className="mt-1 text-[11px] text-slate-400">{loadError || 'Attachment unavailable'}</p>}
        {url && <button type="button" onClick={openFile} className="mt-1 text-[10px] font-medium text-[#007a36] hover:underline">Download {label.toLowerCase()}</button>}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={openFile}
      disabled={!url}
      className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-60 ${mine ? 'border-emerald-100 bg-emerald-50/40 text-slate-800' : 'border-slate-200 bg-slate-50 text-slate-700'} hover:shadow-sm`}
      title={attachment.file_name ? `${attachment.file_name} · download` : 'Download file'}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" /> : <FileText className="w-3.5 h-3.5 text-[#009944]" />}
      <span className="font-semibold text-[10px] uppercase tracking-wide text-[#007a36]">{label}</span>
      <span className="max-w-[170px] truncate font-medium">{attachment.file_name || 'attachment'}</span>
      {attachment.file_size ? <span className={mine ? 'text-emerald-100/70' : 'text-slate-400'}>{prettySize(attachment.file_size)}</span> : null}
      {!url && !loading && <span className="text-[10px] text-slate-400">{loadError || 'Unavailable'}</span>}
      <CloudDownload className={`w-3 h-3 ${mine ? 'text-emerald-100' : 'text-slate-400'}`} />
    </button>
  )
}
