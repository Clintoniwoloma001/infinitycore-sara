// ============================================================================
// Leave booking links (Phase 70b)
// ============================================================================
// A booking RESERVES a spot on the shared team calendar. It is not a leave
// request, it has no approval state, and it never becomes one on its own.
//
// The conversion RPC (convert_leave_booking_to_request) writes the SAME
// leave_requests row the hand-typed form writes, with the same status and the
// same approval level, so the request lands in the ONE existing approval chain.
// Nothing here re-implements approval, and the eligibility window is enforced
// on the server - the disabled button in the UI is only a courtesy.
import { supabase } from '../supabaseClient'

const unwrap = (data, error, fallback) => {
  if (error) {
    const message = error.message || String(error)
    const detail = message.split(/:(.+)/s).slice(1).join(':').trim() || message
    const err = new Error(detail)
    err.raw = message
    err.code = (message.split(':')[0] || '').trim()
    throw err
  }
  return data ?? fallback
}

export const leaveBookingService = {
  // ---- HR: link management ---------------------------------------------

  /** The raw key is returned HERE AND NOWHERE ELSE - only its hash is stored. */
  async createLink({ label, note, expiresOn }) {
    const { data, error } = await supabase.rpc('create_leave_booking_link', {
      p_label: label, p_note: note || null, p_expires_on: expiresOn || null,
    })
    return unwrap(data, error, {})
  },

  async listLinks() {
    const { data, error } = await supabase.rpc('list_leave_booking_links')
    return unwrap(data, error, { links: [], window_days: 14 })
  },

  async revokeLink(id) {
    const { data, error } = await supabase.rpc('revoke_leave_booking_link', { p_id: id })
    return unwrap(data, error, {})
  },

  // ---- HR: the eligibility window --------------------------------------

  async getWindow() {
    const { data, error } = await supabase.rpc('get_leave_booking_window')
    return unwrap(data, error, { value: 14, unit: 'days', days: 14 })
  },

  async saveWindow({ value, unit, reason }) {
    const { data, error } = await supabase.rpc('save_leave_booking_window', {
      p_value: value, p_unit: unit, p_reason: reason,
    })
    return unwrap(data, error, {})
  },

  // ---- Employee: the link itself ----------------------------------------

  async getLink(token) {
    const { data, error } = await supabase.rpc('get_leave_booking_link', { p_token: token })
    return unwrap(data, error, { ok: false, reason: 'invalid' })
  },

  async book({ token, leaveType, start, end, note }) {
    const { data, error } = await supabase.rpc('submit_leave_booking', {
      p_token: token, p_leave_type: leaveType,
      p_start: start, p_end: end, p_note: note || null,
    })
    return unwrap(data, error, {})
  },

  // ---- Employee: my bookings -------------------------------------------

  async myBookings() {
    const { data, error } = await supabase.rpc('get_my_leave_bookings')
    return unwrap(data, error, { bookings: [], window_days: 14 })
  },

  async convertToRequest(bookingId) {
    const { data, error } = await supabase.rpc('convert_leave_booking_to_request', {
      p_booking_id: bookingId,
    })
    return unwrap(data, error, {})
  },
}

/** "2 weeks before" / "14 days before" - the window as HR actually phrased it. */
export function describeWindow(days) {
  const n = Number(days) || 0
  if (n === 0) return 'on the start date itself'
  if (n % 7 === 0 && n >= 7) {
    const w = n / 7
    return `${w} week${w === 1 ? '' : 's'} before the start date`
  }
  return `${n} day${n === 1 ? '' : 's'} before the start date`
}
