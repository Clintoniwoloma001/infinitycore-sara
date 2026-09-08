import React, { useEffect, useState } from 'react'
import { Settings, Clock, Calendar, MapPin, Shield, Loader2, CheckCircle2, History, Save } from 'lucide-react'
import { platformSettingsService } from '../services/platformSettingsService'
import { geofenceService } from '../services/geofenceService'
import { LoadingState, ErrorState } from '../components/PageStates'
import GeofenceEditor from '../components/attendance/GeofenceEditor'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const toggleCls = 'w-4 h-4 accent-[#009944]'

const TABS = [
  { id: 'leave', label: 'Leave Settings', icon: Calendar },
  { id: 'hours', label: 'Working Hours', icon: Clock },
  { id: 'attendance', label: 'Attendance', icon: Shield },
  { id: 'geofence', label: 'Geofence', icon: MapPin },
  { id: 'audit', label: 'Audit Trail', icon: History },
]

export default function PlatformSettings() {
  const [tab, setTab] = useState('leave')
  const [settings, setSettings] = useState(null)
  const [branches, setBranches] = useState([])
  const [selectedBranch, setSelectedBranch] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [auditTrail, setAuditTrail] = useState([])
  const [form, setForm] = useState({})

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [s, brs, audit] = await Promise.all([
        platformSettingsService.get(),
        geofenceService.list(),
        platformSettingsService.getAuditTrail(30).catch(() => []),
      ])
      setSettings(s)
      setForm(s)
      setBranches(brs)
      setAuditTrail(audit)
      if (brs.length > 0) setSelectedBranch(brs[0])
    } catch (e) {
      setError(e?.message || 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  const saveSettings = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      // Build settings diff
      const updates = {}
      Object.keys(form).forEach((k) => {
        if (form[k] !== settings[k] && k !== 'id' && k !== 'updated_at' && k !== 'updated_by') {
          updates[k] = form[k]
        }
      })
      if (Object.keys(updates).length > 0) {
        await platformSettingsService.update(updates)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        await load()
      }
    } catch (e) {
      setError(e?.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const saveGeofence = async (branchId, updates) => {
    setSaving(true)
    try {
      await geofenceService.update(branchId, updates)
      await load()
    } catch (e) {
      setError(e?.message || 'Failed to save geofence')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <LoadingState label="Loading platform settings..." />

  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-semibold text-slate-900 mb-1">HR & Platform Settings</h2>
      <p className="text-sm text-slate-500 mb-6">Configure leave entitlements, working hours, attendance rules, and geofences.</p>

      {error && <div className="mb-5"><ErrorState message={error} /></div>}
      {saved && (
        <div className="mb-5 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> Settings saved successfully.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 border-b border-slate-200">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${tab === t.id ? 'bg-[#009944] text-white' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          )
        })}
      </div>

      {/* Leave Settings */}
      {tab === 'leave' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <NumField label="Annual Leave (days)" value={form.leave_annual_days} onChange={(v) => update('leave_annual_days', v)} />
            <NumField label="Sick Leave (days)" value={form.leave_sick_days} onChange={(v) => update('leave_sick_days', v)} />
            <NumField label="Casual Leave (days)" value={form.leave_casual_days} onChange={(v) => update('leave_casual_days', v)} />
            <NumField label="Maternity Leave (days)" value={form.leave_maternity_days} onChange={(v) => update('leave_maternity_days', v)} />
            <NumField label="Paternity Leave (days)" value={form.leave_paternity_days} onChange={(v) => update('leave_paternity_days', v)} />
            <NumField label="Compassionate Leave (days)" value={form.leave_compassionate_days} onChange={(v) => update('leave_compassionate_days', v)} />
            <NumField label="Study Leave (days)" value={form.leave_study_days} onChange={(v) => update('leave_study_days', v)} />
            <NumField label="Unpaid Leave (days)" value={form.leave_unpaid_days} onChange={(v) => update('leave_unpaid_days', v)} />
          </div>
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <Toggle label="Approval required for leave requests" checked={form.leave_approval_required} onChange={(v) => update('leave_approval_required', v)} />
            <Toggle label="Attachment required for leave requests" checked={form.leave_attachment_required} onChange={(v) => update('leave_attachment_required', v)} />
            <Toggle label="Allow unused days to carry forward" checked={form.leave_carry_forward} onChange={(v) => update('leave_carry_forward', v)} />
          </div>
          <SaveButton onClick={saveSettings} saving={saving} />
        </div>
      )}

      {/* Working Hours */}
      {tab === 'hours' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>Default Work Start Time</label>
              <input type="time" className={inputCls} value={form.default_work_start_time || '08:00'} onChange={(e) => update('default_work_start_time', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Default Work End Time</label>
              <input type="time" className={inputCls} value={form.default_work_end_time || '17:00'} onChange={(e) => update('default_work_end_time', e.target.value)} />
            </div>
            <NumField label="Grace Period (minutes)" value={form.default_grace_period_minutes} onChange={(v) => update('default_grace_period_minutes', v)} />
            <NumField label="Break Duration (minutes)" value={form.default_break_duration_minutes} onChange={(v) => update('default_break_duration_minutes', v)} />
            <NumField label="Overtime Threshold (minutes)" value={form.overtime_threshold_minutes} onChange={(v) => update('overtime_threshold_minutes', v)} />
          </div>
          <p className="text-xs text-slate-400">Branch-specific overrides can be configured in the Geofence tab.</p>
          <SaveButton onClick={saveSettings} saving={saving} />
        </div>
      )}

      {/* Attendance Settings */}
      {tab === 'attendance' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
          <div className="space-y-3">
            <Toggle label="Require GPS for clock-in" checked={form.require_gps_clock_in} onChange={(v) => update('require_gps_clock_in', v)} />
            <Toggle label="Require GPS for clock-out" checked={form.require_gps_clock_out} onChange={(v) => update('require_gps_clock_out', v)} />
            <Toggle label="Geofence enforcement enabled" checked={form.geofence_enabled} onChange={(v) => update('geofence_enabled', v)} />
            <Toggle label="Allow manual attendance correction (HR)" checked={form.allow_manual_correction} onChange={(v) => update('allow_manual_correction', v)} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-3 border-t border-slate-100">
            <NumField label="Default Geofence Radius (metres)" value={form.default_geofence_radius} onChange={(v) => update('default_geofence_radius', v)} />
            <NumField label="Late Threshold (minutes)" value={form.late_threshold_minutes} onChange={(v) => update('late_threshold_minutes', v)} />
            <NumField label="Early Departure Threshold (minutes)" value={form.early_departure_threshold_minutes} onChange={(v) => update('early_departure_threshold_minutes', v)} />
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
            <Shield className="w-4 h-4 inline mr-1" />
            These settings materially affect attendance validation. Changes are recorded in the audit trail.
          </div>
          <SaveButton onClick={saveSettings} saving={saving} />
        </div>
      )}

      {/* Geofence Settings */}
      {tab === 'geofence' && (
        <div className="space-y-4">
          {branches.length === 0 ? (
            <ErrorState title="No branches found" message="Create branches first before configuring geofences." />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {branches.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setSelectedBranch(b)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${selectedBranch?.id === b.id ? 'bg-[#009944] text-white border-[#009944]' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                  >
                    {b.branch_name}
                    {b.geofence_active && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                  </button>
                ))}
              </div>
              {selectedBranch && (
                <div className="bg-white rounded-2xl border border-slate-200 p-6">
                  <h3 className="text-base font-semibold text-slate-900 mb-1">{selectedBranch.branch_name}</h3>
                  <p className="text-sm text-slate-500 mb-5">Configure geofence, working hours, and grace period for this branch.</p>
                  <GeofenceEditor branch={selectedBranch} onSave={saveGeofence} busy={saving} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Audit Trail */}
      {tab === 'audit' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <h3 className="text-base font-semibold text-slate-900 mb-4">Settings Change History</h3>
          {auditTrail.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No settings changes recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {auditTrail.map((a) => (
                <div key={a.id} className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
                  <div className="w-2 h-2 rounded-full bg-[#009944] mt-1.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-700">{a.setting_key}</p>
                    <p className="text-xs text-slate-400">
                      From <span className="font-mono">{a.previous_value || '(empty)'}</span> → To <span className="font-mono">{a.new_value || '(empty)'}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {a.profiles?.full_name || 'Unknown'} · {new Date(a.changed_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NumField({ label, value, onChange }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input type="number" className={inputCls} value={value ?? 0} onChange={(e) => onChange(parseInt(e.target.value) || 0)} />
    </div>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
      <input type="checkbox" checked={checked || false} onChange={(e) => onChange(e.target.checked)} className={toggleCls} />
      {label}
    </label>
  )
}

function SaveButton({ onClick, saving }) {
  return (
    <button onClick={onClick} disabled={saving} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Settings
    </button>
  )
}
