// The "Share Tracking Access" form. Duration is expressed the way HR thinks
// about it (forever / hours / days / until a date) and converted to the ISO-8601
// duration the server expects.
import React, { useState } from 'react'
import { trackingService } from '../../services/employeeTrackingService'
import { ROLES } from '../../constants/roles'

export default function GrantForm({ onNotice, onSaved }) {
  const [targetType, setTargetType] = useState('role')
  const [targetRole, setTargetRole] = useState(ROLES.HEAD_OF_HUMAN_RESOURCES)
  const [duration, setDuration] = useState('forever')
  const [hours, setHours] = useState('')
  const [days, setDays] = useState('')
  const [until, setUntil] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true); onNotice(null)
    try {
      const payload = { targetType, reason: reason || null }
      if (targetType !== 'role') {
        throw new Error('Individual-user grants are created server-side. Choose a role to share with.')
      }
      payload.targetRole = targetRole

      if (duration === 'forever') payload.duration = 'forever'
      else if (duration === 'hours') payload.duration = `PT${Number(hours) || 0}H`
      else if (duration === 'days') payload.duration = `P${Number(days) || 0}D`
      else if (duration === 'until') {
        if (!until) throw new Error('Choose the date and time the access should expire.')
        payload.duration = 'forever'
        payload.expiresAt = new Date(until).toISOString()
      }

      await trackingService.grant(payload)
      onNotice({ tone: 'ok', text: 'Access shared. It takes effect on their next request.' })
      setHours(''); setDays(''); setReason('')
      onSaved()
    } catch (err) {
      onNotice({ tone: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  const roles = Object.values(ROLES).filter((r) => r !== ROLES.CUSTOMER)

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
      <h2 className="font-semibold text-slate-900">Share tracking access</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Share with</span>
          <select value={targetType} onChange={(e) => setTargetType(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="role">A role</option>
            <option value="user">A specific user</option>
          </select>
        </label>

        {targetType === 'role' && (
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Role</span>
            <select value={targetRole} onChange={(e) => setTargetRole(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Duration</span>
          <select value={duration} onChange={(e) => setDuration(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
            <option value="forever">Forever</option>
            <option value="hours">For a number of hours</option>
            <option value="days">For a number of days</option>
            <option value="until">Until a date and time</option>
          </select>
        </label>
        {duration === 'hours' && (
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Hours</span>
            <input type="number" min="1" value={hours} onChange={(e) => setHours(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
        )}
        {duration === 'days' && (
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Days</span>
            <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
        )}
        {duration === 'until' && (
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Expires</span>
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
        )}
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Reason (optional)</span>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      </div>

      <button type="submit" disabled={saving}
        className="rounded-lg bg-[#009944] px-4 py-2 text-sm font-medium text-white hover:bg-[#007a36] disabled:opacity-60">
        {saving ? 'Sharing...' : 'Share access'}
      </button>
    </form>
  )
}
