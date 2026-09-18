import React, { useEffect, useState } from 'react'
import { Settings, Clock, Calendar, MapPin, Shield, Loader2, CheckCircle2, History, Coins, Save } from 'lucide-react'
import { platformSettingsService } from '../services/platformSettingsService'
import { geofenceService } from '../services/geofenceService'
import { LoadingState, ErrorState } from '../components/PageStates'
import GeofenceEditor from '../components/attendance/GeofenceEditor'
import { setPlatformCurrency } from '../lib/utils'

const inputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'
const labelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const toggleCls = 'w-4 h-4 accent-[#009944]'
const DEFAULT_CURRENCY = { currency_code: 'NGN', currency_symbol: '₦', currency_position: 'prefix', currency_decimal_places: 2 }

function normalizeCurrency(settings = {}) {
  const decimals = settings.currency_decimal_places == null || settings.currency_decimal_places === ''
    ? Number.NaN
    : Number(settings.currency_decimal_places)
  return {
    currency_code: String(settings.currency_code || DEFAULT_CURRENCY.currency_code).toUpperCase(),
    currency_symbol: settings.currency_symbol || DEFAULT_CURRENCY.currency_symbol,
    currency_position: settings.currency_position === 'suffix' ? 'suffix' : 'prefix',
    currency_decimal_places: Number.isFinite(decimals) ? Math.min(2, Math.max(0, decimals)) : DEFAULT_CURRENCY.currency_decimal_places,
  }
}

const TABS = [
  { id: 'leave', label: 'Leave Settings', icon: Calendar },
  { id: 'hours', label: 'Working Hours', icon: Clock },
  { id: 'attendance', label: 'Attendance', icon: Shield },
  { id: 'geofence', label: 'Geofence', icon: MapPin },
  { id: 'currency', label: 'Currency', icon: Coins },
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
  const [currencyForm, setCurrencyForm] = useState(DEFAULT_CURRENCY)
  const [currencySaving, setCurrencySaving] = useState(false)

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
      const currency = normalizeCurrency(s)
      setCurrencyForm(currency)
      setPlatformCurrency({
        code: currency.currency_code,
        symbol: currency.currency_symbol,
        position: currency.currency_position,
        decimals: currency.currency_decimal_places,
      })
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

  const updateCurrency = (k, v) => setCurrencyForm((p) => ({ ...p, [k]: v }))

  const saveSettings = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      // Build settings diff
      const updates = {}
      Object.keys(form).forEach((k) => {
        const equal = Array.isArray(form[k]) || Array.isArray(settings[k])
          ? JSON.stringify(form[k] || []) === JSON.stringify(settings[k] || [])
          : form[k] === settings[k]
        if (!equal && k !== 'id' && k !== 'updated_at' && k !== 'updated_by') {
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

  const saveCurrency = async () => {
    const currency_code = String(currencyForm.currency_code || '').trim().toUpperCase()
    const currency_symbol = String(currencyForm.currency_symbol || '').trim()
    if (!currency_code) {
      setError('Currency code is required.')
      return
    }
    if (!currency_symbol) {
      setError('Currency symbol is required.')
      return
    }

    const payload = {
      currency_code,
      currency_symbol,
      currency_position: currencyForm.currency_position === 'suffix' ? 'suffix' : 'prefix',
      currency_decimal_places: Math.min(2, Math.max(0, Number(currencyForm.currency_decimal_places) || 0)),
    }

    setCurrencySaving(true)
    setError('')
    setSaved(false)
    try {
      await platformSettingsService.updateCurrency(payload)
      setCurrencyForm(payload)
      setSettings((current) => ({ ...(current || {}), ...payload }))
      setForm((current) => ({ ...current, ...payload }))
      setPlatformCurrency({
        code: payload.currency_code,
        symbol: payload.currency_symbol,
        position: payload.currency_position,
        decimals: payload.currency_decimal_places,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e?.message || 'Failed to save currency settings')
    } finally {
      setCurrencySaving(false)
    }
  }

  const previewDecimals = Number(currencyForm.currency_decimal_places) || 0
  const previewNumber = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: previewDecimals,
    maximumFractionDigits: previewDecimals,
  }).format(1234567.89)
  const currencyPreview = currencyForm.currency_position === 'suffix'
    ? `${previewNumber} ${currencyForm.currency_symbol || currencyForm.currency_code}`
    : `${currencyForm.currency_symbol || currencyForm.currency_code}${previewNumber}`

  if (loading) return <LoadingState label="Loading platform settings..." />

  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-semibold text-slate-900 mb-1">HR & Platform Settings</h2>
      <p className="text-sm text-slate-500 mb-6">Configure leave entitlements, working hours, attendance rules, geofences, and platform currency.</p>

      {error && <div className="mb-5"><ErrorState message={error} /></div>}
      {saved && (
        <div className="mb-5 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> Settings saved successfully.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 border-b border-slate-200">
        {TABS.map((t) => {          const Icon = t.icon
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
          <div>
            <label className={labelCls}>Working Days</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => {
                const active = (form.default_working_days || []).map((value) => String(value).slice(0, 3).toLowerCase()).includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => update('default_working_days', active
                      ? (form.default_working_days || []).filter((value) => String(value).slice(0, 3).toLowerCase() !== day)
                      : [...(form.default_working_days || []), day])}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium uppercase transition ${active ? 'bg-[#009944] text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  >
                    {day}
                  </button>
                )
              })}
            </div>
          </div>
          <p className="text-xs text-slate-400">These global working hours, days, and grace settings are consumed by every attendance channel. Branch geofences configure location only.</p>
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

      {/* Currency Settings */}
      {tab === 'currency' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <Coins className="w-5 h-5 text-[#009944]" />
              <h3 className="text-base font-semibold text-slate-900">Platform Currency</h3>
            </div>
            <p className="text-sm text-slate-500 mt-1">Set the currency used for payroll, salaries, reports, and offer letters.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Currency code</label>
              <input
                className={inputCls}
                value={currencyForm.currency_code}
                onChange={(e) => updateCurrency('currency_code', e.target.value.toUpperCase())}
                maxLength={5}
                placeholder="NGN"
              />
              <p className="text-xs text-slate-400 mt-1">ISO code, for example NGN, USD, or GBP.</p>
            </div>
            <div>
              <label className={labelCls}>Currency symbol</label>
              <input
                className={inputCls}
                value={currencyForm.currency_symbol}
                onChange={(e) => updateCurrency('currency_symbol', e.target.value)}
                maxLength={5}
                placeholder="₦"
              />
            </div>
            <div>
              <label className={labelCls}>Symbol position</label>
              <select className={inputCls} value={currencyForm.currency_position} onChange={(e) => updateCurrency('currency_position', e.target.value)}>
                <option value="prefix">Before amount (₦1,000.00)</option>
                <option value="suffix">After amount (1,000.00 ₦)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Decimal places</label>
              <select className={inputCls} value={currencyForm.currency_decimal_places} onChange={(e) => updateCurrency('currency_decimal_places', Number(e.target.value))}>
                <option value={0}>0 (₦1,000)</option>
                <option value={1}>1 (₦1,000.0)</option>
                <option value={2}>2 (₦1,000.00)</option>
              </select>
            </div>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Preview</p>
            <p className="text-2xl font-semibold text-slate-900 mt-1">{currencyPreview}</p>
            <p className="text-xs text-slate-500 mt-1">Example amount: 1,234,567.89 · Code: {currencyForm.currency_code || '—'}</p>
          </div>

          <SaveButton onClick={saveCurrency} saving={currencySaving} />
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
