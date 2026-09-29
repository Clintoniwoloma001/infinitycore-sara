// Supabase Edge Function: imeet-transcribe
//
// Server-side AI for I-Meet. It is the ONLY place meeting audio is transcribed
// and summarised, and it:
//
//   - AUTHENTICATES the caller from their Bearer JWT and re-checks that they
//     own the recording (never trusts a client-declared owner),
//   - downloads the private `i-meet-audio` object with the SERVICE ROLE key,
//   - transcribes with OpenAI Whisper (`whisper-1`),
//   - summarises through the EXISTING shared AI router (`aiGenerateJson`), so
//     I-Meet inherits the platform's provider failover and audit trail instead
//     of introducing a second, conflicting AI architecture,
//   - writes transcript and summary back with INDEPENDENT statuses, so a failed
//     summary can never destroy a good transcript (rule 10) and a failed
//     transcription can never destroy the audio (rule 11).
//
// Provider keys live in function secrets, never in the Flutter bundle:
//   supabase secrets set OPENAI_API_KEY=…            (required for Whisper)
//                     GEMINI_API_KEY=… GROQ_API_KEY=… (optional summary tiers)
//
// EXTERNAL DEPENDENCY: transcription requires OPENAI_API_KEY. Without it this
// function marks the stage FAILED and says so — it never fabricates a
// transcript.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { aiGenerateJson } from '../_shared/aiRouter.ts'

const AUDIO_BUCKET = 'i-meet-audio'
const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const WHISPER_MODEL = 'whisper-1'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024 // 25 MB, the Whisper hard limit
const MAX_TRANSCRIPT_CHARS = 200_000

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  })
}

/** Coarse media type from the stored mime/extension. Whisper is picky. */
function whisperFormat(mime, path) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('webm')) return 'webm'
  if (m.includes('flac')) return 'flac'
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4'
  const ext = String(path || '').split('.').pop()?.toLowerCase() || ''
  return ['mp3', 'wav', 'ogg', 'webm', 'flac', 'm4a', 'mp4'].includes(ext)
    ? (ext === 'm4a' ? 'mp4' : ext)
    : 'mp4'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ ok: false, error: 'not_authenticated' }, 401)

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!SERVICE_KEY) return json({ ok: false, error: 'server_misconfigured' }, 500)

  // Caller-scoped client: RLS applies, so the caller only reaches their own rows.
  const caller = createClient(SUPABASE_URL, SERVICE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  // Service client: private object download and status write-back only, both
  // after ownership has been re-checked above.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY)

  let recordingId = ''
  let stage = 'transcription'
  try {
    const body = await req.json()
    recordingId = String(body?.recording_id || '')
    if (body?.stage) stage = String(body.stage)
    if (!recordingId) return json({ ok: false, error: 'recording_id_required' }, 400)

    // Ownership is decided by the caller's own client, so nobody can
    // transcribe another user's meeting by guessing an id.
    const { data: rec, error: readErr } = await caller
      .from('imeet_recordings')
      .select('id, meeting_id, audio_path, audio_mime, audio_bytes, transcript, transcription_status, summary_status, is_follow_up, sequence')
      .eq('id', recordingId)
      .maybeSingle()
    if (readErr) return json({ ok: false, error: 'lookup_failed' }, 500)
    if (!rec) return json({ ok: false, error: 'not_found_or_unauthorized' }, 404)
    if (!rec.audio_path) return json({ ok: false, error: 'no_audio' }, 409)

    const { data: meeting } = await caller
      .from('imeet_meetings')
      .select('id, title, owner_id')
      .eq('id', rec.meeting_id)
      .maybeSingle()

    // Mark ONLY this stage failed. Everything already produced survives, which
    // is what makes a retry safe.
    const fail = async (error, message) => {
      await admin.rpc('imeet_mark_stage', {
        p_recording_id: recordingId,
        p_stage: stage,
        p_error: message,
        p_failed: true,
      })
      return json({ ok: false, error, message }, 200)
    }

    if (stage === 'transcription') {
      if (!OPENAI_KEY) {
        // Honest failure, never a fabricated transcript.
        return await fail(
          'transcription_unavailable',
          'Transcription is not configured on this deployment (OPENAI_API_KEY is not set).',
        )
      }
      if ((rec.audio_bytes ?? 0) > MAX_AUDIO_BYTES) {
        return await fail('audio_too_large', 'The recording exceeds the 25 MB transcription limit.')
      }

      await admin.rpc('imeet_mark_stage', {
        p_recording_id: recordingId, p_stage: 'transcription',
        p_error: null, p_failed: false,
      })

      const { data: blob, error: dlErr } = await admin.storage
        .from(AUDIO_BUCKET)
        .download(rec.audio_path)
      if (dlErr || !blob) {
        return await fail('audio_download_failed', 'The stored audio could not be read.')
      }

      const bytes = new Uint8Array(await blob.arrayBuffer())
      const form = new FormData()
      form.append('file', new Blob([bytes]), `recording.${whisperFormat(rec.audio_mime, rec.audio_path)}`)
      form.append('model', WHISPER_MODEL)
      form.append('response_format', 'json')
      // Segment timestamps give a later speaker-labelling pass its anchors.
      form.append('timestamp_granularities[]', 'segment')

      let whisperRes
      try {
        whisperRes = await fetch(WHISPER_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_KEY}` },
          body: form,
        })
      } catch (e) {
        return await fail('transcription_network', `Whisper could not be reached: ${e}`)
      }
      if (!whisperRes.ok) {
        const detail = await whisperRes.text()
        return await fail('transcription_failed', `Whisper error ${whisperRes.status}: ${detail.slice(0, 300)}`)
      }

      const parsed = await whisperRes.json()
      const transcript = String(parsed?.text || '').trim()
      if (!transcript) {
        return await fail('transcription_empty', 'No speech was detected in this recording.')
      }

      const patch = {
        transcript: transcript.slice(0, MAX_TRANSCRIPT_CHARS),
        transcript_language: parsed?.language || null,
        transcript_provider: 'openai-whisper',
        transcription_status: 'ready',
        error_message: null,
        updated_at: new Date().toISOString(),
      }
      const { error: upErr } = await admin
        .from('imeet_recordings').update(patch).eq('id', recordingId)
      if (upErr) return json({ ok: false, error: 'persist_failed' }, 500)

      await admin
        .from('imeet_meetings')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', rec.meeting_id)

      return json({
        ok: true,
        stage: 'transcription',
        recording_id: recordingId,
        chars: patch.transcript.length,
        language: patch.transcript_language,
        provider: 'openai-whisper',
        // Tell the client to chain straight into the summary.
        next_stage: 'summary',
      })
    }

    // ---- stage: summary -------------------------------------------------
    if (!rec.transcript) {
      return await fail('no_transcript', 'There is no transcript to summarise yet.')
    }
    await admin.rpc('imeet_mark_stage', {
      p_recording_id: recordingId, p_stage: 'summary',
      p_error: null, p_failed: false,
    })

    const kind = rec.is_follow_up ? 'follow-up discussion' : 'main meeting recording'
    const prompt = `You are InfinityCore's meeting analyst. Summarise this ${kind}.

Meeting title: ${meeting?.title || 'Untitled meeting'}

TRANSCRIPT:
"""
${String(rec.transcript).slice(0, 60000)}
"""

Return ONLY these keys, as JSON:
- "overview": 3-6 sentence factual summary of what was actually discussed.
- "key_points": array of short strings, the main topics discussed.
- "decisions": array of short strings, ONLY decisions explicitly made in the text.
- "issues": array of short strings, problems or risks raised.
- "action_items": array of { "title", "detail", "owner", "due" }.
    "owner" must be a person named in the transcript; if nobody is clearly
    assigned, use null. "due" must be null unless a date was actually stated.

Do NOT invent facts. If a section has no content, return an empty array rather
than a plausible guess. Mark nothing as decided unless the transcript says so.`

    let value
    try {
      const routed = await aiGenerateJson(
        {
          prompt,
          json: true,
          temperature: 0.2,
          maxOutputTokens: 3000,
          rulesData: { hasTranscript: true, kind },
        },
        { feature: 'imeet_summary', actorUserId: null },
      )
      value = routed.value
    } catch (e) {
      // The transcript is already stored and stays stored: only the summary
      // failed, and the user can retry it.
      return await fail('summary_failed', `Summary generation failed: ${e}`)
    }

    const asStrings = (v) =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 25) : []
    const rawActions = Array.isArray(value?.action_items) ? value.action_items : []

    const { error: sErr } = await admin
      .from('imeet_recordings')
      .update({
        summary_overview: String(value?.overview || '').trim() || null,
        summary_key_points: asStrings(value?.key_points),
        summary_decisions: asStrings(value?.decisions),
        summary_issues: asStrings(value?.issues),
        summary_status: 'ready',
        summary_generated_at: new Date().toISOString(),
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', recordingId)
    if (sErr) return json({ ok: false, error: 'persist_failed' }, 500)

    // Action items become real rows, because "what did I owe last week" is a
    // query, not a text scrape (and is what SARA will consume).
    let created = 0
    for (const a of rawActions.slice(0, 25)) {
      const title = String(a?.title || '').trim()
      if (!title) continue
      const owner = String(a?.owner || '').trim()
      const { data: row } = await admin
        .from('imeet_action_items')
        .insert({
          meeting_id: rec.meeting_id,
          recording_id: recordingId,
          title: title.slice(0, 300),
          detail: a?.detail ? String(a.detail).slice(0, 1000) : null,
          // Inference recorded honestly: the model guessed, it did not hear
          // the person accept it.
          is_inferred: !owner,
        })
        .select('id')
        .maybeSingle()
      if (row) created += 1
    }

    await admin
      .from('imeet_meetings')
      .update({ status: 'ready', updated_at: new Date().toISOString() })
      .eq('id', rec.meeting_id)

    return json({
      ok: true,
      stage: 'summary',
      recording_id: recordingId,
      action_items_created: created,
      next_stage: null,
    })
  } catch (e) {
    // Never lose the recording to an unexpected error: mark the stage and
    // return, so the UI can offer a retry.
    if (recordingId) {
      try {
        await admin.rpc('imeet_mark_stage', {
          p_recording_id: recordingId,
          p_stage: stage,
          p_error: String(e).slice(0, 500),
          p_failed: true,
        })
      } catch { /* the DB write is best-effort here */ }
    }
    return json({ ok: false, error: 'unexpected', message: String(e) }, 200)
  }
})
