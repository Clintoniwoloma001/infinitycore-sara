import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'
import { sendInAppNotification } from './notificationService'

// Check integration connection status for the current user
export async function getConnectionStatus(provider) {
  try {
    // We can't read integration_connections directly (RLS denies all client access).
    // Instead, we invoke the Edge Function which checks server-side.
    // For now, use a lightweight check: try to invoke the create function
    // and interpret the response.
    return { connected: false, status: 'unknown' }
  } catch {
    return { connected: false, status: 'unknown' }
  }
}

// Check Google Calendar connection by attempting a dry-run
export async function checkGoogleCalendar() {
  try {
    const { data, error } = await supabase.functions.invoke('create-google-meet', {
      body: { _check: true },
    })
    if (error) return { connected: false, status: 'not_configured' }
    if (data?.status === 'not_connected') return { connected: false, status: 'not_connected' }
    if (data?.status === 'not_configured') return { connected: false, status: 'not_configured' }
    return { connected: true, status: 'connected' }
  } catch {
    return { connected: false, status: 'error' }
  }
}

// Check Zoom connection
export async function checkZoom() {
  try {
    const { data, error } = await supabase.functions.invoke('create-zoom-meeting', {
      body: { _check: true },
    })
    if (error) return { connected: false, status: 'not_configured' }
    if (data?.status === 'not_connected') return { connected: false, status: 'not_connected' }
    if (data?.status === 'not_configured') return { connected: false, status: 'not_configured' }
    return { connected: true, status: 'connected' }
  } catch {
    return { connected: false, status: 'error' }
  }
}

// Initiate Google OAuth flow
export function connectGoogleCalendar(userId) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!clientId) return { url: null, error: 'VITE_GOOGLE_CLIENT_ID not configured' }

  const redirectUri = encodeURIComponent(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-callback?provider=google_calendar`)
  const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email')
  const state = `google_calendar:${userId}`
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`
  return { url: authUrl }
}

// Initiate Zoom OAuth flow
export function connectZoom(userId) {
  const clientId = import.meta.env.VITE_ZOOM_CLIENT_ID
  if (!clientId) return { url: null, error: 'VITE_ZOOM_CLIENT_ID not configured' }

  const redirectUri = encodeURIComponent(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-callback?provider=zoom`)
  const state = `zoom:${userId}`
  const authUrl = `https://zoom.us/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&state=${state}`
  return { url: authUrl }
}

// Create a Google Meet via Edge Function
export async function createGoogleMeet({ summary, description, startDateTime, endDateTime, attendeeEmail, interviewId }) {
  try {
    const { data, error } = await supabase.functions.invoke('create-google-meet', {
      body: { summary, description, startDateTime, endDateTime, attendeeEmail, interviewId },
    })
    if (error) throw error
    return data
  } catch (e) {
    return { status: 'failed', error: e?.message || 'Edge function call failed' }
  }
}

// Create a Zoom meeting via Edge Function
export async function createZoomMeeting({ topic, description, startDateTime, durationMinutes, interviewId }) {
  try {
    const { data, error } = await supabase.functions.invoke('create-zoom-meeting', {
      body: { topic, description, startDateTime, durationMinutes, interviewId },
    })
    if (error) throw error
    return data
  } catch (e) {
    return { status: 'failed', error: e?.message || 'Edge function call failed' }
  }
}

// Send candidate email via Edge Function
export async function sendInterviewEmail(interviewId, resend = false) {
  try {
    const { data, error } = await supabase.functions.invoke('send-interview-email', {
      body: { interviewId, resend },
    })
    if (error) throw error
    return data
  } catch (e) {
    return { status: 'failed', error: e?.message || 'Edge function call failed' }
  }
}

// Full scheduling workflow: create interview → create meeting → send email
export async function scheduleInterviewWithMeeting({
  hrService,
  interviewData,
  user,
  candidates,
}) {
  const steps = { interview: null, meeting: null, email: null }
  const errors = []

  // Step 1: Create the interview record
  try {
    const interview = await hrService.scheduleInterview(interviewData)
    steps.interview = interview
    logAction({ action: 'INTERVIEW_SCHEDULED', entityType: 'Interview', entityId: interview.id, details: `Interview scheduled for ${interviewData.candidate_name}` })
  } catch (e) {
    return { steps, error: e?.message || 'Failed to create interview' }
  }

  // Step 2: Create meeting if virtual with Google Meet or Zoom
  if (interviewData.interview_type === 'VIRTUAL' && (interviewData.platform === 'Google Meet' || interviewData.platform === 'Zoom')) {
    const startDateTime = interviewData.scheduled_date
    const endDateTime = new Date(new Date(startDateTime).getTime() + (interviewData.duration_minutes || 30) * 60000).toISOString()
    const summary = `Interview: ${interviewData.candidate_name} — ${interviewData.position || 'Position'}`
    const description = interviewData.interview_instructions || `Interview for ${interviewData.position || 'the position'}`

    let meetingResult
    if (interviewData.platform === 'Google Meet') {
      meetingResult = await createGoogleMeet({
        summary,
        description,
        startDateTime,
        endDateTime,
        attendeeEmail: interviewData.candidate_email,
        interviewId: steps.interview.id,
      })
    } else if (interviewData.platform === 'Zoom') {
      meetingResult = await createZoomMeeting({
        topic: summary,
        description,
        startDateTime,
        durationMinutes: interviewData.duration_minutes || 30,
        interviewId: steps.interview.id,
      })
    }

    steps.meeting = meetingResult

    if (meetingResult?.status === 'created' && meetingResult?.meetingUrl) {
      // Update interview with meeting details
      const updateData = {
        meeting_url: meetingResult.meetingUrl,
        external_provider: interviewData.platform === 'Google Meet' ? 'google_meet' : 'zoom',
        external_event_id: meetingResult.externalEventId || null,
        external_meeting_id: meetingResult.externalMeetingId || null,
        meeting_start_at: startDateTime,
        meeting_end_at: endDateTime,
      }
      try {
        await hrService.updateInterview(steps.interview.id, updateData)
        steps.interview = { ...steps.interview, ...updateData }
      } catch (e) {
        errors.push('Failed to save meeting details to interview')
      }
    } else if (meetingResult?.status === 'not_connected' || meetingResult?.status === 'not_configured') {
      errors.push(`${interviewData.platform} not connected — meeting link needs manual entry`)
    } else if (meetingResult?.status === 'failed') {
      errors.push(`Meeting creation failed: ${meetingResult.error || 'unknown error'}`)
    }
  }

  // Step 3: Send candidate email
  if (steps.interview?.id && interviewData.candidate_email) {
    const emailResult = await sendInterviewEmail(steps.interview.id, false)
    steps.email = emailResult

    if (emailResult?.status === 'sent') {
      // In-app notification to HR
      sendInAppNotification({
        userId: user.id,
        title: 'Interview Scheduled',
        message: `Interview invitation sent to ${interviewData.candidate_name} (${interviewData.candidate_email})`,
        link: '#/interviews',
        type: 'interview',
      }).catch(() => {})
    } else if (emailResult?.status === 'not_configured') {
      errors.push('Email provider not configured — candidate notification pending')
    } else if (emailResult?.status === 'failed') {
      errors.push(`Email failed: ${emailResult.error || 'unknown error'}`)
    }
  } else if (!interviewData.candidate_email) {
    errors.push('No candidate email — notification skipped')
  }

  return { steps, errors }
}
