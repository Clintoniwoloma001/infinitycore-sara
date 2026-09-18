import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowLeft, Building2, ChevronDown, Download, FileText, LayoutDashboard, Loader2, Plus, RefreshCw, Search, Settings2, ShieldCheck, ShieldX, Stethoscope } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import medicalScreeningService from '../services/medicalScreeningService'
import { medicalStatusBadge, medicalOutcomeBadge, screeningTypeLabel, formatMedDate, isReferralExpired } from '../components/medical/medicalUi'
import MedicalCardModal from '../components/medical/MedicalCardModal'

const TAB_GROUPS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'pending', label: 'Awaiting Hospital', match: (r) => !isReferralExpired(r) && ['draft', 'issued', 'qr_opened'].includes(r.status) },
  { id: 'progress', label: 'In Progress', match: (r) => r.status === 'screening_started' },
  { id: 'review', label: 'Awaiting Review', match: (r) => ['submitted', 'under_review'].includes(r.status) },
  { id: 'expiring', label: 'Expiring Soon', match: (r) => !isReferralExpired(r) && ['draft', 'issued', 'qr_opened', 'screening_started'].includes(r.status) && !!r.expires_at && new Date(r.expires_at) > new Date() && new Date(r.expires_at) - new Date() < 7 * 24 * 60 * 60 * 1000 },
  { id: 'completed', label: 'Completed', match: (r) => ['cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared'].includes(r.status) },
  { id: 'inactive', label: 'Expired / Revoked', match: (r) => r.status === 'revoked' || isReferralExpired(r) },
]

const settingsLabelCls = 'block text-sm font-medium text-slate-700 mb-1.5'
const settingsInputCls = 'w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]'

const REVIEW_OUTCOMES = [
  { value: 'cleared', label: 'Cleared — Fit for Work' },
  { value: 'cleared_with_restrictions', label: 'Cleared with Restrictions' },
  { value: 'further_review', label: 'Further Medical Review' },
  { value: 'not_cleared', label: 'Not Cleared' },
]

const AMENDABLE_STATUSES = ['submitted', 'under_review', 'cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared']
const EXTENDABLE_STATUSES = ['draft', 'issued', 'qr_opened', 'screening_started']

const PROGRESS_BUCKETS = [
  { key: 'pending', label: 'Pending', hint: 'Issued card awaiting the hospital', color: 'blue', match: (r) => !isReferralExpired(r) && ['draft', 'issued'].includes(r.status) },
  { key: 'scanned', label: 'Scanned', hint: 'QR scanned by the hospital', color: 'indigo', match: (r) => !isReferralExpired(r) && r.status === 'qr_opened' },
  { key: 'in_progress', label: 'In Progress', hint: 'Screening being worked on', color: 'violet', match: (r) => !isReferralExpired(r) && r.status === 'screening_started' },
  { key: 'review', label: 'Awaiting Review', hint: 'Submitted — awaiting HR decision', color: 'amber', match: (r) => ['submitted', 'under_review'].includes(r.status) },
  { key: 'completed', label: 'Completed', hint: 'Fitness decision finalised', color: 'emerald', match: (r) => ['cleared', 'cleared_with_restrictions', 'further_review', 'not_cleared'].includes(r.status) },
  { key: 'closed', label: 'Expired / Revoked', hint: 'Inactive cards no longer actionable', color: 'slate', match: (r) => r.status === 'revoked' || isReferralExpired(r) },
]

const BUCKET_CHIP = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  slate: 'bg-slate-100 text-slate-500 border-slate-200',
}

function humanize(key) {
  return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function MedicalManagement() {
  const { hasPermission } = useAuth()
  const canManage = hasPermission('medical.manage')
  const location = useLocation()

  const [referrals, setReferrals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [screening, setScreening] = useState(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [action, setAction] = useState(null)
  const [actionForm, setActionForm] = useState({})
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showCard, setShowCard] = useState(false)
  const [showProgress, setShowProgress] = useState(false)

  const [providers, setProviders] = useState([])
  const [providerForm, setProviderForm] = useState({ name: '', address: '', contact_name: '', contact_phone: '', contact_email: '', status: 'active' })
  const [configList, setConfigList] = useState([])
  const [labTestsText, setLabTestsText] = useState('')
  const [settingsMsg, setSettingsMsg] = useState('')
  const [settingsErr, setSettingsErr] = useState('')
  const [settingsBusy, setSettingsBusy] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await medicalScreeningService.listReferrals()
      setReferrals(data || [])
    } catch (e) {
      setError(e?.message || 'Unable to load medical screenings')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([
        medicalScreeningService.listHospitalProviders().catch(() => []),
        medicalScreeningService.listConfig().catch(() => []),
      ])
      setProviders(p || [])
      setConfigList(c || [])
      const lab = (c || []).find((x) => x.config_key === 'lab_tests')
      if (lab && Array.isArray(lab.config_value)) setLabTestsText(lab.config_value.join('\n'))
    } catch { /* settings are best-effort */ }
  }, [])

  // Honor an arriving metric deep-link (e.g. "Expiring Soon" from the HR dashboard).
  useEffect(() => {
    const initial = location.state?.tab
    if (initial && [...TAB_GROUPS.map((g) => g.id), 'settings'].includes(initial)) setTab(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.tab])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadSettings() }, [loadSettings])

  // Opportunistic expiry alarms — fires at most one in-app notification per
  // expiring referral per 24h server-side; never blocks the page.
  useEffect(() => {
    medicalScreeningService.notifyExpiring().catch(() => {})
  }, [])

  const saveProvider = async () => {
    if (!providerForm.name.trim()) { setSettingsErr('Provider name is required.'); return }
    setSettingsBusy('provider')
    setSettingsErr('')
    try {
      await medicalScreeningService.upsertHospitalProvider({
        name: providerForm.name.trim(),
        address: providerForm.address || null,
        contact_name: providerForm.contact_name || null,
        contact_phone: providerForm.contact_phone || null,
        contact_email: providerForm.contact_email || null,
        status: providerForm.status || 'active',
      })
      setProviderForm({ name: '', address: '', contact_name: '', contact_phone: '', contact_email: '', status: 'active' })
      setSettingsMsg('Hospital provider saved.')
      await loadSettings()
    } catch (e) {
      setSettingsErr(e?.message || 'Could not save provider.')
    } finally {
      setSettingsBusy('')
    }
  }

  const saveLabTests = async () => {
    setSettingsBusy('lab')
    setSettingsErr('')
    try {
      const tests = labTestsText.split('\n').map((s) => s.trim()).filter(Boolean)
      await medicalScreeningService.upsertConfig('lab_tests', tests)
      setSettingsMsg('Required lab tests updated.')
      await loadSettings()
    } catch (e) {
      setSettingsErr(e?.message || 'Could not save lab tests.')
    } finally {
      setSettingsBusy('')
    }
  }

  const switchProviderStatus = async (p) => {
    setSettingsBusy(`prov-${p.id}`)
    setSettingsErr('')
    try {
      await medicalScreeningService.upsertHospitalProvider({ ...p, status: p.status === 'active' ? 'inactive' : 'active' })
      setSettingsMsg('Provider status updated.')
      await loadSettings()
    } catch (e) {
      setSettingsErr(e?.message || 'Could not update provider status.')
    } finally {
      setSettingsBusy('')
    }
  }

  const filtered = useMemo(() => {
    const group = TAB_GROUPS.find((g) => g.id === tab)
    const rows = (referrals || []).filter((r) => (group ? group.match(r) : true))
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter((r) =>
      [r.subject_name, r.reference, r.subject_identifier, r.hospital_name, r.subject_department, r.subject_position]
        .some((v) => String(v || '').toLowerCase().includes(q))
    )
  }, [referrals, tab, search])

  const counts = useMemo(() => {
    const c = { all: referrals.length }
    for (const g of TAB_GROUPS.slice(1)) c[g.id] = referrals.filter(g.match).length
    return c
  }, [referrals])

  const openDetail = async (referral, toggle = true) => {
    if (toggle && selected?.id === referral.id) { setSelected(null); setDetail(null); setScreening(null); return }
    setSelected(referral)
    setDetail(null)
    setScreening(null)
    setDetailBusy(true)
    try {
      const d = await medicalScreeningService.getResult(referral.id)
      const versions = [...(d?.screenings || [])].sort((a, b) => (a.version || 0) - (b.version || 0))
      setDetail({ ...d, versions })
      setScreening(versions[versions.length - 1] || null)
    } catch (e) {
      setError(e?.message || 'Unable to load referral details')
    } finally {
      setDetailBusy(false)
    }
  }

  const openAction = (type) => { setAction({ type }); setActionError(''); setActionForm({}) }

  const openFromProgress = async (referral) => {
    setShowProgress(false)
    setTab('all')
    await openDetail(referral, false)
  }

  const runAction = async () => {
    if (!selected) return
    setBusy(true)
    setActionError('')
    try {
      if (action.type === 'review') {
        if (!actionForm.outcome) { setActionError('Select a review outcome.'); setBusy(false); return }
        await medicalScreeningService.setStatus(selected.id, actionForm.outcome, actionForm.note)
      } else if (action.type === 'amend') {
        if (!screening) { setActionError('No screening selected.'); setBusy(false); return }
        if (!actionForm.outcome) { setActionError('Select the corrected outcome.'); setBusy(false); return }
        if (!actionForm.reason?.trim()) { setActionError('An amendment reason is required.'); setBusy(false); return }
        let results
        if (actionForm.results?.trim()) {
          try { results = JSON.parse(actionForm.results) } catch { setActionError('Corrected results must be valid JSON.'); setBusy(false); return }
        }
        const created = await medicalScreeningService.requestAmendment(screening.id, actionForm.reason)
        await medicalScreeningService.approveAmendment(created.amendment_id, {
          outcome: actionForm.outcome,
          outcome_notes: actionForm.outcome_notes || '',
          results,
          decision_notes: actionForm.decision_notes || '',
        })
      } else if (action.type === 'revoke') {
        await medicalScreeningService.revoke(selected.id, actionForm.reason)
      } else if (action.type === 'extend') {
        if (!actionForm.expiry_date) { setActionError('Choose a new expiry date.'); setBusy(false); return }
        await medicalScreeningService.extendExpiry(selected.id, actionForm.expiry_date)
      }
      setAction(null)
      await load()
      await openDetail(selected, false)
    } catch (e) {
      setActionError(e?.message || 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const downloadDoc = async (doc) => {
    if (!doc.file_path) return
    try {
      const url = await medicalScreeningService.getSignedUrl(doc.file_path)
      if (url) window.open(url, '_blank')
    } catch { /* ignore */ }
  }

  const detailBlock = (title, rows) => (
    rows.length ? (
      <div>
        <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1.5">{title}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          {rows.map(([label, value]) => (
            <div key={label}>
              <p className="text-[10px] text-slate-400 uppercase tracking-wide">{humanize(label)}</p>
              <p className="text-xs text-slate-700 mt-0.5 whitespace-pre-wrap break-words">{value !== null && value !== undefined && value !== '' ? String(value) : '—'}</p>
            </div>
          ))}
        </div>
      </div>
    ) : null
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Medical Screening Center</h2>
          <p className="text-sm text-slate-500 mt-0.5">Hospital referral cards, results and fitness decisions</p>
        </div>
        <div className="flex gap-2">
          {canManage && (
            <button onClick={() => setShowCard(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36]">
              <Plus className="w-4 h-4" /> Generate Referral Card
            </button>
          )}
          <button onClick={() => setShowProgress(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#009944] text-[#009944] text-sm font-medium hover:bg-emerald-50">
            <LayoutDashboard className="w-4 h-4" /> See Medicals Progress
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">{error}</div>}

      {showProgress && (
        <ProgressView referrals={referrals} onBack={() => setShowProgress(false)} onOpen={openFromProgress} />
      )}

      {!showProgress && (
      <>
      {/* Tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TAB_GROUPS.map((g) => (
          <button key={g.id} onClick={() => setTab(g.id)} className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${tab === g.id ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
            {g.label} · {counts[g.id] ?? 0}
          </button>
        ))}
        {canManage && (
          <button onClick={() => setTab('settings')} className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${tab === 'settings' ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
            <Settings2 className="w-3.5 h-3.5" /> Settings
          </button>
        )}
      </div>

      {tab === 'expiring' && filtered.length > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          These active referrals expire within 7 days. Contact the facility, or open a referral to extend its expiry.
        </p>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, reference, hospital…" className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" />
      </div>

      {/* List */}
      {tab === 'settings' ? (
        <div className="space-y-6">
          {settingsMsg && !settingsErr && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{settingsMsg}</div>}
          {settingsErr && <div className="rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-2">{settingsErr}</div>}

          {!canManage && <p className="text-sm text-slate-500">Only HR managers and admins can configure medical screening.</p>}

          {/* Hospital providers */}
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center gap-2">
              <Building2 className="w-4 h-4 text-[#009944]" />
              <h3 className="text-sm font-semibold text-slate-900">Hospital Providers</h3>
            </div>
            <p className="text-xs text-slate-500 mt-1">Facilities that can be assigned to a referral card.</p>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div><label className={settingsLabelCls}>Name *</label><input className={settingsInputCls} value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} /></div>
              <div><label className={settingsLabelCls}>Address</label><input className={settingsInputCls} value={providerForm.address} onChange={(e) => setProviderForm({ ...providerForm, address: e.target.value })} /></div>
              <div><label className={settingsLabelCls}>Contact name</label><input className={settingsInputCls} value={providerForm.contact_name} onChange={(e) => setProviderForm({ ...providerForm, contact_name: e.target.value })} /></div>
              <div><label className={settingsLabelCls}>Contact phone</label><input className={settingsInputCls} value={providerForm.contact_phone} onChange={(e) => setProviderForm({ ...providerForm, contact_phone: e.target.value })} /></div>
              <div><label className={settingsLabelCls}>Contact email</label><input className={settingsInputCls} value={providerForm.contact_email} onChange={(e) => setProviderForm({ ...providerForm, contact_email: e.target.value })} /></div>
              <div>
                <label className={settingsLabelCls}>Status</label>
                <select className={settingsInputCls} value={providerForm.status} onChange={(e) => setProviderForm({ ...providerForm, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
            {canManage && (
              <button onClick={saveProvider} disabled={settingsBusy === 'provider'} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {settingsBusy === 'provider' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add / Update Provider
              </button>
            )}

            <div className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
              {providers.length === 0 && <p className="text-sm text-slate-400 px-4 py-6 text-center">No hospital providers yet.</p>}
              {providers.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">{p.name} <span className={`ml-1 text-[10px] px-2 py-0.5 rounded-full ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{p.status}</span></p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {[p.address, p.contact_name, p.contact_phone, p.contact_email].filter(Boolean).join(' · ') || 'No contact details'}
                    </p>
                  </div>
                  {canManage && (
                    <button onClick={() => switchProviderStatus(p)} disabled={!!settingsBusy && settingsBusy !== `prov-${p.id}`} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                      {settingsBusy === `prov-${p.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {p.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Lab tests config */}
          <div className="bg-white border border-slate-200 rounded-xl p-6">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#009944]" />
              <h3 className="text-sm font-semibold text-slate-900">Required Lab Tests</h3>
            </div>
            <p className="text-xs text-slate-500 mb-4 mt-1">Shown on the hospital portal as the mandated investigations. One per line.</p>
            <textarea
              rows="6"
              value={labTestsText}
              onChange={(e) => setLabTestsText(e.target.value)}
              disabled={!canManage}
              className={settingsInputCls + ' !h-auto py-2 font-mono disabled:bg-slate-50 disabled:text-slate-400'}
              placeholder={'Urinalysis\nFull Blood Count\nBlood Glucose\nMalaria Screening'}
            />
            {canManage && (
              <button onClick={saveLabTests} disabled={settingsBusy === 'lab'} className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {settingsBusy === 'lab' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Save Lab Tests
              </button>
            )}

            <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {configList.map((c) => (
                <div key={c.config_key} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">{c.config_key}</p>
                  <p className="mt-1 text-xs text-slate-600 whitespace-pre-wrap break-words">
                    {Array.isArray(c.config_value) ? c.config_value.join(', ') : (typeof c.config_value === 'object' && c.config_value !== null ? JSON.stringify(c.config_value) : String(c.config_value ?? '—'))}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-12 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading referrals…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
          <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
            <Stethoscope className="w-7 h-7 text-slate-400" />
          </div>
          <h4 className="font-medium text-slate-700">No medical screenings</h4>
          <p className="text-sm text-slate-400 mt-1">Generate a referral card to start a hospital screening for a candidate or employee.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
          {filtered.map((r) => (
            <div key={r.id}>
              <button onClick={() => openDetail(r)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-semibold text-slate-900">{r.reference}</span>
                    {medicalStatusBadge(r.status)}
                    {isReferralExpired(r) && <span className="text-[10px] font-medium text-rose-600">Expired</span>}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    <span className="font-medium text-slate-700">{r.subject_name}</span> · {screeningTypeLabel(r.screening_type, r.other_screening_type)} · {r.subject_position || '—'} · {r.subject_department || '—'}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {r.hospital_name || 'No hospital assigned'} · Issued {formatMedDate(r.issued_at)} · Expires {formatMedDate(r.expires_at)}
                  </p>
                </div>
                <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${selected?.id === r.id ? 'rotate-180' : ''}`} />
              </button>

              {selected?.id === r.id && (
                <div className="px-4 pb-4 pt-1 bg-slate-50/50">
                  {detailBusy ? (
                    <div className="flex items-center justify-center py-8 text-slate-500 text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>
                  ) : (
                    <div className="space-y-4">
                      {/* Actions */}
                      {canManage && (
                        <div className="flex flex-wrap gap-2">
                          {['submitted', 'under_review'].includes(r.status) && (
                            <button onClick={() => openAction('review')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#009944] text-white text-xs font-medium hover:bg-[#007a36]">
                              <ShieldCheck className="w-3.5 h-3.5" /> Review Result
                            </button>
                          )}
                          {AMENDABLE_STATUSES.includes(r.status) && screening && (
                            <button onClick={() => openAction('amend')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-300 text-amber-700 text-xs font-medium hover:bg-amber-50">
                              <RefreshCw className="w-3.5 h-3.5" /> Amend Result
                            </button>
                          )}
                          {EXTENDABLE_STATUSES.includes(r.status) && (
                            <>
                              <button onClick={() => openAction('extend')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-300 text-blue-700 text-xs font-medium hover:bg-blue-50">
                                <ShieldX className="w-3.5 h-3.5" /> Extend Expiry
                              </button>
                              <button onClick={() => openAction('revoke')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-300 text-rose-700 text-xs font-medium hover:bg-rose-50">
                                <ShieldX className="w-3.5 h-3.5" /> Revoke
                              </button>
                            </>
                          )}
                        </div>
                      )}

                      {screening ? (
                        <>
                          {detail?.versions?.length > 1 && (
                            <div className="flex flex-wrap gap-2">
                              {detail.versions.map((v) => (
                                <button key={v.id} onClick={() => setScreening(v)} className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${screening.id === v.id ? 'border-[#009944] bg-emerald-50 text-[#009944]' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                                  v{v.version}{v.version === detail.versions[detail.versions.length - 1].version ? ' (current)' : ''}
                                </button>
                              ))}
                            </div>
                          )}

                          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                            <div className="bg-slate-50 px-4 py-2 flex items-center justify-between">
                              <p className="text-xs font-semibold text-slate-800">Medical Screening Result{screening.version > 1 ? ` — v${screening.version}` : ''}</p>
                              {medicalOutcomeBadge(screening.outcome)}
                            </div>
                            <div className="p-4 space-y-5">
                              {detailBlock('Officer & Date', [
                                ['Medical Officer', screening.medical_officer],
                                ['Screening Date', formatMedDate(screening.screening_date)],
                                ['Hospital', screening.hospital_name],
                              ])}
                              {Object.entries(screening.results || {}).map(([key, value]) => (
                                detailBlock(humanize(key), value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [['Value', value]])
                              ))}
                              {screening.outcome_notes && (
                                <div>
                                  <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Outcome Notes</p>
                                  <p className="text-xs text-slate-600 whitespace-pre-wrap">{screening.outcome_notes}</p>
                                </div>
                              )}
                              {screening.amendment_reason && (
                                <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
                                  <p className="text-[10px] text-violet-700 uppercase tracking-wide font-semibold">Amendment Reason</p>
                                  <p className="text-xs text-violet-800 mt-0.5 whitespace-pre-wrap">{screening.amendment_reason}</p>
                                </div>
                              )}
                              {screening.signature_data && (
                                <img src={screening.signature_data} alt="Signature" className="h-16 border border-slate-200 rounded-lg bg-white" />
                              )}
                            </div>
                          </div>

                          {detail?.documents?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-800 mb-2">Supporting Documents</p>
                              <div className="border border-slate-200 bg-white rounded-lg divide-y divide-slate-100 overflow-hidden">
                                {detail.documents.map((d) => (
                                  <div key={d.id} className="flex items-center justify-between px-3 py-2.5">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                      <p className="text-sm text-slate-800 truncate">{d.file_name}</p>
                                    </div>
                                    <button onClick={() => downloadDoc(d)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-slate-50">
                                      <Download className="w-3.5 h-3.5" /> Download
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {detail?.amendments?.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-800 mb-2">Amendment History</p>
                              <div className="border border-slate-200 bg-white rounded-lg divide-y divide-slate-100 overflow-hidden">
                                {detail.amendments.map((a) => (
                                  <div key={a.id} className="px-3 py-2.5">
                                    <div className="flex items-center justify-between">
                                      <p className="text-xs font-semibold text-slate-700 capitalize">{a.status}</p>
                                      <p className="text-[10px] text-slate-400">{formatMedDate(a.requested_at)} · {a.requested_by_name || 'HR'}</p>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-0.5">{a.reason}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-slate-400 py-3 text-center">
                          {r.status === 'revoked' ? 'This referral was revoked — no screening result exists.' : isReferralExpired(r) ? 'This referral expired before a screening was submitted.' : 'No screening result submitted yet.'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {/* Action modal */}
      {action && selected && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-1 capitalize">
              {action.type === 'review' ? 'Review Medical Result' : action.type === 'amend' ? 'Amend Medical Result' : action.type === 'revoke' ? 'Revoke Referral' : 'Extend Expiry'}
            </h3>
            <p className="text-sm text-slate-500 mb-4">{selected.subject_name} — <span className="font-mono">{selected.reference}</span></p>

            {action.type === 'review' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Decision *</label>
                  <select className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actionForm.outcome || ''} onChange={(e) => setActionForm((f) => ({ ...f, outcome: e.target.value }))}>
                    <option value="">Select decision…</option>
                    {REVIEW_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Review Note</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={actionForm.note || ''} onChange={(e) => setActionForm((f) => ({ ...f, note: e.target.value }))} placeholder="Optional note…" />
                </div>
              </div>
            )}

            {action.type === 'amend' && screening && (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">The original is preserved; approving creates a new immutable version.</p>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Corrected Outcome *</label>
                  <select className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actionForm.outcome || ''} onChange={(e) => setActionForm((f) => ({ ...f, outcome: e.target.value }))}>
                    <option value="">Select outcome…</option>
                    <option value="fit_for_work">Fit for Work</option>
                    <option value="fit_with_restrictions">Fit with Restrictions</option>
                    <option value="further_review">Further Medical Review Required</option>
                    <option value="not_cleared">Not Cleared</option>
                    <option value="pending">Pending</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Outcome Notes</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={actionForm.outcome_notes || ''} onChange={(e) => setActionForm((f) => ({ ...f, outcome_notes: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Corrected Results (JSON, optional)</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={4} value={actionForm.results ?? JSON.stringify(screening.results || {}, null, 2)} onChange={(e) => setActionForm((f) => ({ ...f, results: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason *</label>
                  <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={2} value={actionForm.reason || ''} onChange={(e) => setActionForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why is this record being amended?" />
                </div>
              </div>
            )}

            {action.type === 'revoke' && (
              <div>
                <p className="text-sm text-slate-600 mb-3">Revoking disables the QR immediately. Already-submitted results are not affected.</p>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Reason</label>
                <textarea className="w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" rows={3} value={actionForm.reason || ''} onChange={(e) => setActionForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Why is this referral being revoked?" />
              </div>
            )}

            {action.type === 'extend' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">New Expiry Date *</label>
                <input type="date" className="w-full h-10 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#009944]" value={actionForm.expiry_date || ''} onChange={(e) => setActionForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                <p className="text-xs text-slate-400 mt-2">The referral remains valid until this new date.</p>
              </div>
            )}

            {actionError && <p className="text-sm text-rose-600 mt-3">{actionError}</p>}

            <div className="flex justify-end gap-2 pt-5">
              <button onClick={() => setAction(null)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={runAction} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#009944] text-white text-sm font-medium hover:bg-[#007a36] disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <MedicalCardModal
        open={showCard}
        onClose={() => setShowCard(false)}
        allowPick
        onCreated={() => load()}
      />
    </div>
  )
}

function ProgressView({ referrals, onBack, onOpen }) {
  const buckets = PROGRESS_BUCKETS.map((b) => ({ ...b, count: (referrals || []).filter(b.match).length }))

  const byHospital = useMemo(() => {
    const map = new Map()
    for (const r of referrals || []) {
      const name = r.hospital_name || 'Unassigned'
      if (!map.has(name)) map.set(name, [])
      map.get(name).push(r)
    }
    return [...map.entries()]
      .map(([name, rows]) => ({ name, rows }))
      .sort((a, b) => (a.name === 'Unassigned' ? 1 : 0) - (b.name === 'Unassigned' ? 1 : 0) || b.rows.length - a.rows.length)
  }, [referrals])

  if (!referrals || referrals.length === 0) {
    return (
      <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
        <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
          <Stethoscope className="w-7 h-7 text-slate-400" />
        </div>
        <h4 className="font-medium text-slate-700">No medical screenings yet</h4>
        <p className="text-sm text-slate-400 mt-1">Generate a referral card to start tracking hospital progress.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Medical Screening Progress</h3>
          <p className="text-sm text-slate-500 mt-0.5">Referral cards per hospital: pending, scanned, being worked on, awaiting review, and completed.</p>
        </div>
        <button onClick={onBack} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 font-medium hover:bg-slate-50">
          <ArrowLeft className="w-4 h-4" /> Back to referrals
        </button>
      </div>

      {/* Overall summary per status bucket */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {buckets.map((b) => (
          <div key={b.key} className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${BUCKET_CHIP[b.color].split(' ')[0]}`} />
              <p className={`text-[11px] font-semibold ${BUCKET_CHIP[b.color].split(' ')[1]}`}>{b.label}</p>
            </div>
            <p className="text-2xl font-semibold text-slate-900 mt-1">{b.count}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">{b.hint}</p>
          </div>
        ))}
      </div>

      {/* Per-hospital breakdown */}
      <div className="space-y-4">
        {byHospital.map((h) => (
          <div key={h.name} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 bg-slate-50/70 flex flex-wrap items-center gap-2">
              <Building2 className="w-4 h-4 text-[#009944]" />
              <span className="text-sm font-semibold text-slate-800">{h.name}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 font-medium">{h.rows.length} card{h.rows.length === 1 ? '' : 's'}</span>
              <div className="flex flex-wrap gap-1.5 ml-auto">
                {PROGRESS_BUCKETS.map((b) => {
                  const c = h.rows.filter(b.match).length
                  if (c === 0) return null
                  return (
                    <span key={b.key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${BUCKET_CHIP[b.color]}`}>
                      {b.label} · {c}
                    </span>
                  )
                })}
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {h.rows.map((r) => (
                <button key={r.id} onClick={() => onOpen(r)} className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-emerald-50/40 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-semibold text-slate-900">{r.reference}</span>
                      {medicalStatusBadge(r.status)}
                      {isReferralExpired(r) && <span className="text-[10px] font-medium text-rose-600">Expired</span>}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      <span className="font-medium text-slate-700">{r.subject_name}</span> · {screeningTypeLabel(r.screening_type, r.other_screening_type)} · {r.subject_position || '—'}
                    </p>
                  </div>
                  <div className="text-right text-[11px] text-slate-400">
                    <p>Issued {formatMedDate(r.issued_at)} · Expires {formatMedDate(r.expires_at)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
