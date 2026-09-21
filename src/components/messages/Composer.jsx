import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, FileAudio, FileText, Image as ImageIcon, Loader2, Mic, Paperclip, Play, Reply, Send,
  ShieldAlert, Square, Trash2, X,
} from 'lucide-react'
import { extractMentions, scanSensitiveContent } from '../../services/corporateChatService'
import { displayPersonName } from './personUtils'

const pickText = (p) => `${p.full_name || ''} ${p.name || ''} ${p.email || ''} ${p.position || ''} ${p.department || ''} ${p.employee_number || p.staff_id || p.staffId || ''}`.toLowerCase()

const ACCEPT_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv', 'text/plain', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'application/zip',
]
const ACCEPT_ATTR = `${ACCEPT_TYPES.join(',')},audio/*`
const MAX_FILES = 6
const MAX_FILE_MB = 25
const RECORDING_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

const prettySize = (bytes) => {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const isImage = (type) => (type || '').startsWith('image/')
const isAudio = (type) => (type || '').startsWith('audio/')
const formatDuration = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

function supportedRecordingMime() {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return ''
  return RECORDING_MIME_TYPES.find((type) => window.MediaRecorder.isTypeSupported?.(type)) || ''
}

function recordingErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'Microphone permission was denied. Allow microphone access and try again.'
  }
  if (error?.name === 'NotFoundError') return 'No microphone was found on this device.'
  if (error?.name === 'NotReadableError') return 'The microphone is already in use by another application.'
  return error?.message || 'Could not start voice recording.'
}

export default function Composer({
  value, onChange, onSend, sending, disabled, placeholder = 'Type a message…',
  people = [], replyTo, onCancelReply, allowRequireAck = true,
}) {
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionToken, setMentionToken] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [files, setFiles] = useState([])
  const [fileError, setFileError] = useState('')
  const [priority, setPriority] = useState('normal')
  const [requiresAck, setRequiresAck] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [voiceDraft, setVoiceDraft] = useState(null)
  const [voiceError, setVoiceError] = useState('')
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const recorderRef = useRef(null)
  const recordingStreamRef = useRef(null)
  const recordingChunksRef = useRef([])
  const recordingTimerRef = useRef(null)
  const recordingStartedAtRef = useRef(0)
  const discardRecordingRef = useRef(false)
  const voiceUrlRef = useRef(null)

  const wordMap = useMemo(() => {
    const map = new Map()
    for (const p of people || []) {
      const emailLocal = (p.email || '').split('@')[0]
      const tokens = `${p.full_name || ''} ${emailLocal}`.toLowerCase().split(/[\s.-]+/).filter(Boolean)
      for (const t of tokens) map.set(t, p.id)
    }
    return map
  }, [people])

  const candidates = useMemo(() => {
    if (!mentionOpen) return []
    const q = mentionToken.toLowerCase()
    return (people || [])
      .filter((p) => pickText(p).includes(q))
      .slice(0, 8)
  }, [mentionOpen, mentionToken, people])

  const messageValue = value || ''
  const canSend = messageValue.trim() || files.length > 0 || voiceDraft
  const sensitive = scanSensitiveContent(messageValue)

  const addFiles = (list) => {
    setFileError('')
    const incoming = Array.from(list || []).filter((f) => {
      const okType = !f.type || ACCEPT_TYPES.includes(f.type) || isAudio(f.type)
      const okSize = Number(f.size || 0) <= MAX_FILE_MB * 1024 * 1024
      if (!okType) setFileError(`"${f.name}" is not an allowed file type (images, audio, PDF, Word, Excel, PowerPoint, CSV, TXT).`)
      else if (!okSize) setFileError(`"${f.name}" exceeds the ${MAX_FILE_MB} MB limit.`)
      return okType && okSize
    })
    const next = [...files, ...incoming].slice(0, MAX_FILES)
    if (files.length + incoming.length > MAX_FILES) {
      setFileError(`You can attach up to ${MAX_FILES} files per message.`)
    }
    setFiles(next)
    if (fileRef.current) fileRef.current.value = ''
  }

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
    setFileError('')
  }

  const stopRecordingStream = () => {
    recordingStreamRef.current?.getTracks?.().forEach((track) => track.stop())
    recordingStreamRef.current = null
  }

  const clearRecordingTimer = () => {
    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current)
    recordingTimerRef.current = null
  }

  const discardVoiceDraft = () => {
    if (voiceUrlRef.current) URL.revokeObjectURL(voiceUrlRef.current)
    voiceUrlRef.current = null
    setVoiceDraft(null)
    setVoiceError('')
  }

  const startRecording = async () => {
    if (disabled || sending || recording) return
    setVoiceError('')
    if (typeof window === 'undefined' || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError('Voice notes are not supported by this browser or device.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (voiceDraft) discardVoiceDraft()
      recordingStreamRef.current = stream
      recordingChunksRef.current = []
      discardRecordingRef.current = false
      const mimeType = supportedRecordingMime()
      const recorder = mimeType ? new window.MediaRecorder(stream, { mimeType }) : new window.MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data?.size) recordingChunksRef.current.push(event.data)
      }
      recorder.onerror = () => setVoiceError('The browser could not finish recording. Please try again.')
      recorder.onstop = () => {
        clearRecordingTimer()
        stopRecordingStream()
        const chunks = recordingChunksRef.current
        recordingChunksRef.current = []
        recorderRef.current = null
        if (discardRecordingRef.current) return
        if (!chunks.length) {
          setVoiceError('No audio was recorded. Please try again.')
          return
        }
        const type = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm'
        const blob = new Blob(chunks, { type })
        if (blob.size > MAX_FILE_MB * 1024 * 1024) {
          setVoiceError(`The voice note exceeds the ${MAX_FILE_MB} MB limit.`)
          return
        }
        const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm'
        const filename = `voice-note-${Date.now()}.${extension}`
        const file = typeof File === 'function'
          ? new File([blob], filename, { type })
          : Object.assign(blob, { name: filename, lastModified: Date.now() })
        try { file.attachment_type = 'voice_note' } catch (_) {}
        const url = URL.createObjectURL(blob)
        if (voiceUrlRef.current) URL.revokeObjectURL(voiceUrlRef.current)
        voiceUrlRef.current = url
        const duration = Math.max(1, Math.round((Date.now() - (recordingStartedAtRef.current || Date.now())) / 1000))
        setVoiceDraft({ file, url, duration })
        setRecordingSeconds(0)
      }
      recorder.start()
      setRecording(true)
      setRecordingSeconds(0)
      recordingStartedAtRef.current = Date.now()
      recordingTimerRef.current = window.setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000)
    } catch (error) {
      stopRecordingStream()
      setVoiceError(recordingErrorMessage(error))
    }
  }

  const stopRecording = () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setRecording(false)
    try { recorder.stop() } catch (_) { setVoiceError('Could not stop the voice recording.') }
  }

  const cancelRecording = () => {
    discardRecordingRef.current = true
    clearRecordingTimer()
    recordingChunksRef.current = []
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch (_) {}
    }
    stopRecordingStream()
    recorderRef.current = null
    setRecording(false)
    setRecordingSeconds(0)
    setVoiceError('')
  }

  const onTextChange = (next) => {
    onChange(next)
    const at = next.lastIndexOf('@')
    if (at >= 0 && (at === 0 || /\s/.test(next[at - 1]))) {
      const token = next.slice(at + 1)
      if (!/\s/.test(token)) {
        setMentionToken(token)
        setMentionOpen(true)
        setMentionIndex(0)
        return
      }
    }
    setMentionOpen(false)
  }

  const insertMention = (person) => {
    const at = messageValue.lastIndexOf('@')
    const before = messageValue.slice(0, at)
    const name = displayPersonName(person).split(' ')[0]
    onChange(`${before}@${name} `)
    setMentionOpen(false)
    inputRef.current?.focus()
  }

  const submit = async () => {
    if (sending || disabled || !canSend) return
    const mentionIds = extractMentions(messageValue, wordMap)
    const selectedFiles = [...files, ...(voiceDraft ? [voiceDraft.file] : [])]
    const opts = {
      priority: priority === 'normal' ? null : priority,
      requiresAck: requiresAck && allowRequireAck && priority !== 'normal',
      files: selectedFiles,
    }
    try {
      const sent = await onSend(messageValue.trim(), mentionIds, opts)
      if (sent === false) return
      setFiles([])
      setRequiresAck(false)
      setPriority('normal')
      setFileError('')
      discardVoiceDraft()
    } catch (error) {
      setFileError(error?.message || 'Message could not be sent.')
    }
  }

  useEffect(() => () => {
    clearRecordingTimer()
    stopRecordingStream()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch (_) {}
    }
    if (voiceUrlRef.current) URL.revokeObjectURL(voiceUrlRef.current)
  }, [])

  const onKeyDown = (e) => {
    if (mentionOpen && candidates.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % candidates.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + candidates.length) % candidates.length); return }
      if (e.key === 'Enter') { e.preventDefault(); insertMention(candidates[mentionIndex]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionOpen(false); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const priorityOptions = [
    { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'Important' },
    { value: 'urgent', label: 'Urgent' },
  ]

  return (
    <div className="p-3 border-t border-slate-100 relative">
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-slate-500 flex items-center gap-1"><Reply className="w-3 h-3" /> Replying to {replyTo.replyName || 'message'}</p>
            <p className="text-xs text-slate-500 truncate">{replyTo.body || '(removed message)'}</p>
          </div>
          <button onClick={onCancelReply} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      {sensitive.length > 0 && (
        <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          <ShieldAlert className="w-4 h-4" /> This may contain sensitive data ({sensitive.join(', ')}). Be careful sharing customer or private information.
        </p>
      )}

      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <div key={i} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 pr-1.5 pl-2 py-1.5">
              {isImage(f.type)
                ? <ImageIcon className="w-4 h-4 text-[#009944]" />
                : isAudio(f.type)
                  ? <FileAudio className="w-4 h-4 text-[#009944]" />
                  : <FileText className="w-4 h-4 text-[#009944]" />}
              <span className="max-w-[180px] truncate text-xs text-slate-700">{f.name}</span>
              <span className="text-[10px] text-slate-400 whitespace-nowrap">{prettySize(f.size)}</span>
              <button onClick={() => removeFile(i)} className="text-slate-400 hover:text-rose-500 p-0.5"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}

      {recording && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
          <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" aria-hidden="true" />
          <span className="text-xs font-semibold text-rose-700">Recording {formatDuration(recordingSeconds)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={stopRecording} className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700">
              <Square className="h-3 w-3 fill-current" /> Stop
            </button>
            <button type="button" onClick={cancelRecording} className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100">
              <X className="h-3 w-3" /> Cancel
            </button>
          </div>
        </div>
      )}

      {voiceDraft && !recording && (
        <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5">
          <div className="flex items-center gap-2">
            <FileAudio className="h-4 w-4 shrink-0 text-[#009944]" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">Voice note · {formatDuration(voiceDraft.duration)}</span>
            <button type="button" onClick={discardVoiceDraft} className="text-slate-400 hover:text-rose-500" title="Discard voice note" aria-label="Discard voice note">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <audio controls preload="metadata" src={voiceDraft.url} className="h-8 min-w-0 flex-1" />
            <button type="button" onClick={submit} disabled={disabled || sending} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#009944] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[#007a36] disabled:opacity-40">
              <Play className="h-3 w-3 fill-current" /> Send voice note
            </button>
          </div>
        </div>
      )}

      {mentionOpen && candidates.length > 0 && (
        <div className="absolute bottom-full mb-2 left-3 right-3 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg divide-y divide-slate-50 z-20">
          {candidates.map((p, i) => (
            <button
              type="button"
              key={p.id}
              onClick={() => insertMention(p)}
              onMouseEnter={() => setMentionIndex(i)}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-slate-50 ${i === mentionIndex ? 'bg-slate-50' : ''}`}
            >
              <span className="w-7 h-7 rounded-full bg-slate-300 flex items-center justify-center text-[10px] font-semibold text-white shrink-0">
                {displayPersonName(p).split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]?.toUpperCase()).join('')}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-slate-800 truncate">{displayPersonName(p)}</span>
                <span className="block text-xs text-slate-400 truncate">{[p.position, p.department, p.role, p.employee_number || p.staff_id || p.staffId].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Attach files (images, PDF, Word, Excel…)"
          disabled={disabled}
          className="inline-flex items-center justify-center w-9 h-10 rounded-lg border border-slate-200 text-slate-500 hover:text-[#009944] hover:border-[#009944] hover:bg-emerald-50 shrink-0 disabled:opacity-40"
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={startRecording}
          title="Record a voice note"
          aria-label="Record a voice note"
          disabled={disabled || sending || recording}
          className="inline-flex items-center justify-center w-9 h-10 rounded-lg border border-slate-200 text-slate-500 hover:text-[#009944] hover:border-[#009944] hover:bg-emerald-50 shrink-0 disabled:opacity-40"
        >
          <Mic className="w-4 h-4" />
        </button>
        <textarea
          ref={inputRef}
          value={messageValue}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          className="w-full flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944] disabled:opacity-50 disabled:bg-slate-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !canSend || sending || recording}
          className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-[#009944] text-white hover:bg-[#007a36] disabled:opacity-40 shrink-0 self-end"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
            {priorityOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  const next = priority === o.value ? 'normal' : o.value
                  setPriority(next)
                  if (next === 'normal') setRequiresAck(false)
                }}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                  priority === o.value
                    ? o.value === 'urgent'
                      ? 'bg-amber-500 text-white'
                      : o.value === 'high'
                        ? 'bg-orange-500 text-white'
                        : 'bg-[#009944] text-white'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}
              >
                {o.label === 'Urgent' && <AlertTriangle className="w-3 h-3 inline mr-0.5" />}
                {o.label}
              </button>
            ))}
          </div>
          {priority !== 'normal' && allowRequireAck && (
            <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={requiresAck}
                onChange={(e) => setRequiresAck(e.target.checked)}
                disabled={disabled}
                className="w-3.5 h-3.5 accent-[#009944]"
              />
              Require acknowledgment
            </label>
          )}
          {priority !== 'normal' && !allowRequireAck && (
            <span className="text-[10px] text-slate-400 italic">Requires acknowledgment is available to moderators only</span>
          )}
        </div>
        {(fileError || voiceError) && <p className="text-[11px] text-rose-600">{fileError || voiceError}</p>}
        <div className="text-[10px] text-slate-300">Use @ to mention a colleague · Enter to send · Shift+Enter for a new line</div>
      </div>
    </div>
  )
}
