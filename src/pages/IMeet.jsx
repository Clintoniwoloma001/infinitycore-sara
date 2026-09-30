// ===========================================================================
// IMeet — meetings, recordings and folders, on the web.
//
// THE POINT OF THIS PAGE IS THAT IT IS THE SAME DATA AS THE MOBILE APP.
// Web and Flutter both talk to one Supabase project, the same `imeet_*` tables
// and the same private `i-meet-audio` bucket, using the identical
// `<owner>/<meeting>/<recording>.<ext>` storage path. So a meeting recorded on
// a phone appears here on refresh with no sync step, and audio recorded here
// can be saved to a phone. Nothing is duplicated per-platform.
//
// Every list comes back already filtered by RLS: a folder shared with you on
// mobile is in `listFolders()` on the web, and its meetings and recordings are
// readable through the `imeet_can_view_folder` chain. The UI therefore never
// decides access — it renders what the server returned, which is why a
// revocation on one platform takes effect on the other at the next load.
//
// Download is the deliberate asymmetry: `can_download` is a per-member grant,
// so a view-only member sees the meeting but is never offered a download
// button. That mirrors the mobile sheet exactly.
// ===========================================================================
import React, { useCallback, useEffect, useState } from 'react'
import {
  Mic, Folder, FolderOpen, FolderPlus, Users, Share2, Download, FileText,
  Loader2, ChevronLeft, Lock, Eye, RotateCw, AlertTriangle, Clock, CalendarPlus,
} from 'lucide-react'
import imeetService from '../services/imeetService'
import { useAuth } from '../hooks/useAuth'
import { LoadingState, EmptyState, ErrorState } from '../components/PageStates'
import FolderShareDialog from '../components/imeet/FolderShareDialog'
import ScheduleMeetingDialog from '../components/imeet/ScheduleMeetingDialog'
import RecorderControls from '../components/imeet/RecorderControls'
import { formatDate } from '../lib/utils'

/** A transcription/summary stage chip, mirroring the mobile pipeline chips. */
function StageChip({ label, state }) {
  const tones = {
    done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    working: 'bg-amber-50 text-amber-700 border-amber-200',
    failed: 'bg-rose-50 text-rose-700 border-rose-200',
    idle: 'bg-slate-50 text-slate-500 border-slate-200',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[state] || tones.idle}`}>
      {state === 'working' && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  )
}

function transcriptChip(t) {
  if (t === 'ready') return { label: 'Transcript ready', state: 'done' }
  if (t === 'failed') return { label: 'Transcription failed', state: 'failed' }
  if (t === 'processing') return { label: 'Transcribing…', state: 'working' }
  return { label: 'Transcript pending', state: 'idle' }
}

function summaryChip(s) {
  if (s === 'ready') return { label: 'Summary ready', state: 'done' }
  if (s === 'failed') return { label: 'Summary failed', state: 'failed' }
  if (s === 'processing') return { label: 'Summarising…', state: 'working' }
  return { label: 'Summary pending', state: 'idle' }
}

/** One recording: stages, summary, transcript and the save actions. */
function RecordingCard({ recording, folder, onChanged }) {
  const [transcript, setTranscript] = useState(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState(null)

  const t = recording.transcription_status
  const s = recording.summary_status

  const toggleTranscript = async () => {
    if (showTranscript) {
      setShowTranscript(false)
      return
    }
    // Fetched on demand, never up-front: a meeting with a long history would
    // otherwise transfer every transcript just to render this list.
    setError(null)
    try {
      setTranscript(await imeetService.loadTranscript(recording.id))
      setShowTranscript(true)
    } catch (e) {
      setError(e.message || 'The transcript could not be loaded.')
    }
  }

  /**
   * Save the audio.
   *
   * The URL is minted per click by a server function that re-checks folder
   * membership AND the download grant, so revoking a member on mobile
   * immediately stops these links working here.
   */
  const download = async () => {
    setDownloading(true)
    setError(null)
    try {
      const url = await imeetService.getDownloadUrl(recording.id)
      if (!url) {
        setError('The recording is still being uploaded.')
        return
      }
      const a = document.createElement('a')
      a.href = url
      a.download = `recording-${recording.sequence || 1}.m4a`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      setError(e.message || 'The recording could not be downloaded.')
    } finally {
      setDownloading(false)
    }
  }

  const retry = async (stage) => {
    setError(null)
    try {
      await imeetService.retryStage(recording.id, stage)
      onChanged?.()
    } catch (e) {
      setError(e.message || 'That stage could not be retried.')
    }
  }

  // The download grant comes from the FOLDER, so a read-only share hides the
  // button instead of offering one the server will refuse.
  const canDownload = Boolean(folder?.can_download ?? true)

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
            #{recording.sequence}
          </span>
          <span className="text-sm font-medium text-slate-900">
            {recording.label || `Recording ${recording.sequence}`}
          </span>
          {recording.is_follow_up && (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
              Follow-up
            </span>
          )}
          {recording.duration_seconds > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              <Clock className="h-3 w-3" />
              {imeetService.formatDuration(recording.duration_seconds)}
            </span>
          )}
        </div>

        {canDownload ? (
          <button
            onClick={download}
            disabled={downloading}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Download
          </button>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
            <Eye className="h-3.5 w-3.5" />
            View only
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <StageChip {...transcriptChip(t)} />
        <StageChip {...summaryChip(s)} />
      </div>

      {(t === 'failed' || s === 'failed') && (
        <div className="mt-2 flex gap-3">
          {t === 'failed' && (
            <button onClick={() => retry('transcription')} className="inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline">
              <RotateCw className="h-3 w-3" />Retry transcription
            </button>
          )}
          {s === 'failed' && (
            <button onClick={() => retry('summary')} className="inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline">
              <RotateCw className="h-3 w-3" />Retry summary
            </button>
          )}
        </div>
      )}

      {recording.error_message && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {recording.error_message}
        </p>
      )}

      {recording.summary_overview && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Summary</p>
          <p className="mt-1 text-sm text-slate-700">{recording.summary_overview}</p>
        </div>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}
        </p>
      )}

      <button onClick={toggleTranscript} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#009944] hover:underline">
        <FileText className="h-3.5 w-3.5" />
        {showTranscript ? 'Hide transcript' : 'View transcript'}
      </button>
      {showTranscript && (
        <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
          {transcript || 'No transcript text was returned.'}
        </pre>
      )}
    </div>
  )
}
export default function IMeet() {
  const { user } = useAuth()
  const [folders, setFolders] = useState([])
  const [meetings, setMeetings] = useState([])
  const [selectedFolder, setSelectedFolder] = useState(null)
  const [detail, setDetail] = useState(null)
  const [shareFolder, setShareFolder] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  // Scheduling, folder creation and folder editing were all absent: a meeting
  // could only be born at the instant you pressed record, and there was no way
  // to make a folder at all, so "share this recording folder" had nothing to
  // share. These three drive the dialogs that close those gaps.
  const [scheduleTarget, setScheduleTarget] = useState(undefined) // undefined = closed, null = new
  const [manageFolder, setManageFolder] = useState(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)

  const loadFolders = useCallback(async () => {
    const f = await imeetService.listFolders()
    setFolders(f)
    return f
  }, [])

  /**
   * Select a folder and load its meetings.
   *
   * Declared before `createFolder` (which selects the folder it just created)
   * so both reference a single definition instead of two that could drift.
   */
  const selectFolder = async (f) => {
    setSelectedFolder(f)
    try {
      await loadMeetings(f.id)
    } catch (e) {
      setError(e.message || 'Meetings could not be loaded.')
    }
  }

  /** Create a folder, then select it so the user sees where meetings will go. */
  const createFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name) return
    setFolderBusy(true)
    setError(null)
    try {
      const folder = await imeetService.createFolder(name)
      setNewFolderName('')
      const f = await loadFolders()
      if (folder?.id) {
        const created = f.find((x) => x.id === folder.id)
        if (created) await selectFolder(created)
      }
    } catch (e) {
      setError(e.message || 'The folder could not be created.')
    } finally {
      setFolderBusy(false)
    }
  }, [newFolderName, loadFolders])

  const loadMeetings = useCallback(async (folderId) => {
    setMeetings(await imeetService.listMeetings({ folderId, limit: 50 }))
  }, [])

  const refresh = useCallback(async () => {
    try {
      await loadFolders()
      await loadMeetings(selectedFolder?.id || null)
    } catch { /* keep the last good view rather than blanking the page */ }
  }, [loadFolders, loadMeetings, selectedFolder])

  useEffect(() => {
    (async () => {
      try {
        const f = await loadFolders()
        await loadMeetings(null)
        setSelectedFolder(f[0] || null)
      } catch (e) {
        setError(e.message || 'I-Meet could not be loaded.')
      } finally {
        setLoading(false)
      }
    })()
  }, [loadFolders, loadMeetings])

  const openMeeting = async (meetingId) => {
    try {
      setDetail(await imeetService.getMeeting(meetingId))
    } catch (e) {
      setError(e.message || 'That meeting could not be opened.')
    }
  }

  /**
   * Persist a web capture using the SAME steps as mobile:
   * openMeeting → addRecording → uploadAudio → attachAudioPath.
   *
   * The recording row is created BEFORE the upload because the database
   * chooses the recording id, and that id is the final path segment the storage
   * policy is written around.
   */
  const onRecordingReady = useCallback(async ({ blob, durationSeconds, mime, meetingId }) => {
    if (!user) return
    setSaving(true)
    setError(null)
    try {
      // A follow-up must append to the meeting the user is looking at.
      // Ignoring `meetingId` and always calling openMeeting created a
      // brand-new meeting instead, fragmenting the history (rule 9).
      let targetMeetingId = meetingId
      if (!targetMeetingId) {
        const opened = await imeetService.openMeeting({
          title: selectedFolder ? `Meeting in ${selectedFolder.name}` : 'Meeting',
          folderId: selectedFolder?.id || null,
          startedAt: new Date().toISOString(),
        })
        targetMeetingId = opened.meetingId
      }
      const added = await imeetService.addRecording({
        meetingId: targetMeetingId,
        sequence: null,
        durationSeconds: Math.round(durationSeconds || 0),
        audioMime: mime,
      })
      const recordingId = added?.recording?.id || added?.recording_id
      if (!recordingId) throw new Error('The recording could not be created.')

      const path = await imeetService.uploadAudio({
        blob, ownerId: user.id, meetingId: targetMeetingId, recordingId, mime,
      })
      await imeetService.attachAudioPath(recordingId, path, blob.size, mime)

      // Run the AI pipeline, exactly as mobile does. Without this the web
      // capture sat at 'pending' forever, because nothing else was going to
      // invoke the transcribe function.
      imeetService
        .processRecording(recordingId)
        .catch(() => { /* the audio is durable; retry is offered on the card */ })

      await refresh()
      await openMeeting(targetMeetingId)
    } catch (e) {
      setError(e.message || 'The recording could not be saved.')
    } finally {
      setSaving(false)
    }
  }, [user, selectedFolder, refresh, openMeeting])

  if (loading) return <LoadingState label="Loading I-Meet…" />

  // The folder a meeting belongs to decides the download grant, so resolve it
  // rather than assuming the caller's own folder.
  const detailFolder = detail
    ? folders.find((f) => f.id === detail.folder_id) || null
    : null

  if (detail) {
    const isOwner = imeetService.isOwner(detailFolder)
    return (
      <div className="space-y-4">
        <button onClick={() => setDetail(null)} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ChevronLeft className="h-4 w-4" />All meetings
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{detail.title || 'Meeting'}</h1>
            <p className="text-sm text-slate-500">
              {detail.started_at ? formatDate(detail.started_at) : 'No date'}
              {detail.location ? ` · ${detail.location}` : ''}
              {detailFolder ? ` · ${detailFolder.name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Edit covers rename, reschedule and moving between folders. */}
            <button
              onClick={() => setScheduleTarget(detail)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <CalendarPlus className="h-4 w-4" />Edit / reschedule
            </button>
            {detailFolder && (isOwner ? (
              <button onClick={() => setShareFolder(detailFolder)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                <Share2 className="h-4 w-4" />Share folder
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
                <Lock className="h-3.5 w-3.5" />Shared with you
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          {detail.recordings?.length ? (
            detail.recordings.map((r) => (
              <RecordingCard key={r.id} recording={r} folder={detailFolder} onChanged={refresh} />
            ))
          ) : (
            <EmptyState title="No recordings yet" description="Record one below and Sara will transcribe and summarise it." />
          )}
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold text-slate-800">Record a follow-up</h2>
          <RecorderControls meetingId={detail.id} isFollowUp busy={saving} onRecordingReady={onRecordingReady} />
        </div>

        {shareFolder && <FolderShareDialog folder={shareFolder} onClose={() => setShareFolder(null)} />}
        {scheduleTarget !== undefined && (
          <ScheduleMeetingDialog
            folders={folders}
            meeting={scheduleTarget}
            onClose={() => setScheduleTarget(undefined)}
            onSaved={async () => {
              await refresh()
              await openMeeting(detail.id)
            }}
          />
        )}
      </div>
    )
  }
return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">I-Meet</h1>
        <p className="text-sm text-slate-500">
          Meetings recorded on any device, with Sara's transcript and summary.
        </p>
      </div>

      {error && <ErrorState title="I-Meet" message={error} />}

      {/* Always rendered, even with zero folders. Previously this block was
          hidden unless a folder already existed, so a brand-new user saw no
          folder UI at all and no way to create one. */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Folders</p>
        <div className="flex flex-wrap gap-2">
          {folders.map((f) => {
            const owned = imeetService.isOwner(f)
            const active = selectedFolder?.id === f.id
            return (
              <div key={f.id} className="group relative">
                <button
                  onClick={() => selectFolder(f)}
                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
                    active
                      ? 'border-[#009944] bg-emerald-50 text-[#007a37]'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {owned ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
                  {f.name}
                  {f.meeting_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500">
                      <Mic className="h-3 w-3" />{f.meeting_count}
                    </span>
                  )}
                  {f.member_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500">
                      <Users className="h-3 w-3" />{f.member_count}
                    </span>
                  )}
                  {!owned && !f.can_download && <Eye className="h-3.5 w-3.5 text-slate-400" />}
                </button>
                {/* Owner-only sharing, mirroring the mobile long-press. */}
                {owned && (
                  <button
                    onClick={() => setShareFolder(f)}
                    title={`Share "${f.name}"`}
                    className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-slate-900 p-1 text-white shadow group-hover:block"
                  >
                    <Share2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}

          {/* Creating a folder is the entry point for sharing, so it must be
              reachable without already owning a folder. */}
          <form
            onSubmit={(e) => { e.preventDefault(); createFolder() }}
            className="flex items-center gap-1.5"
          >
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="New folder name"
              maxLength={80}
              className="w-40 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm outline-none focus:border-[#009944]"
            />
            <button
              type="submit"
              disabled={folderBusy || !newFolderName.trim()}
              title="Create folder"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {folderBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
              Create
            </button>
          </form>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Meetings {selectedFolder ? `in ${selectedFolder.name}` : ''}
        </p>
        {meetings.length ? (
          meetings.map((m) => {
            const upcoming = m.status === 'scheduled'
              && new Date(m.started_at) > new Date()
            return (
            <button
              key={m.id}
              onClick={() => openMeeting(m.id)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left hover:bg-slate-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{m.title || 'Untitled meeting'}</p>
                <p className="text-xs text-slate-500">
                  {upcoming && (
                    <span className="mr-1.5 inline-flex items-center gap-0.5 font-medium text-[#009944]">
                      <CalendarPlus className="h-3 w-3" />Upcoming
                    </span>
                  )}
                  {m.started_at ? formatDate(m.started_at) : 'No date'}
                  {m.location ? ` · ${m.location}` : ''}
                </p>
              </div>
              {upcoming
                ? <Clock className="h-4 w-4 shrink-0 text-[#009944]" />
                : <Mic className="h-4 w-4 shrink-0 text-slate-300" />}
            </button>
            )
          })
        ) : (
          <EmptyState
            title="No meetings yet"
            description="Record something below, or from the I-Meet app on your phone. It will appear here."
          />
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-800">Record a meeting</h2>
        <RecorderControls busy={saving} onRecordingReady={onRecordingReady} />
      </div>

      <button
        onClick={() => setScheduleTarget(null)}
        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <CalendarPlus className="h-4 w-4" />Schedule a meeting
      </button>

      {scheduleTarget !== undefined && (
        <ScheduleMeetingDialog
          folders={folders}
          meeting={scheduleTarget}
          onClose={() => setScheduleTarget(undefined)}
          onSaved={refresh}
        />
      )}


      {shareFolder && <FolderShareDialog folder={shareFolder} onClose={() => setShareFolder(null)} />}
    </div>
  )
}