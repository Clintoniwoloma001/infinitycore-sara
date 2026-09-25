import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BriefcaseBusiness,
  CalendarDays, CheckCircle2, Clock3, Crown, Gauge, Landmark,
  Target, TrendingUp, UserRound, Users, Wallet, RefreshCw, X,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { useAuth } from '../hooks/useAuth'
import { directorIntelligenceService } from '../services/directorIntelligenceService'
import { filterDepartmentOptions } from '../constants/departments'
import { ErrorState, LoadingState } from '../components/PageStates'
import PersonAvatar from '../components/messages/PersonAvatar'
import { formatCurrency, formatDate } from '../lib/utils'

const PERIODS = ['today', 'week', 'month', 'quarter', 'custom']
const EMPTY_FILTERS = { period: 'month', department: '', branchId: '', area: '', role: '', designationId: '', employeeId: '', startDate: '', endDate: '' }

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const startOfWeek = (d) => { const x = new Date(d); const day = x.getDay() || 7; x.setDate(x.getDate() - day + 1); x.setHours(0,0,0,0); return x }
const quarterStart = (d) => new Date(d.getFullYear(), Math.floor(d.getMonth()/3)*3, 1)

export function dateWindow(period, custom = {}) {
  const now = new Date(); const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'custom' && custom.startDate && custom.endDate) return { startDate: custom.startDate, endDate: custom.endDate }
  if (period === 'today') return { startDate: iso(end), endDate: iso(end) }
  if (period === 'week') return { startDate: iso(startOfWeek(end)), endDate: iso(end) }
  if (period === 'quarter') return { startDate: iso(quarterStart(end)), endDate: iso(end) }
  return { startDate: iso(new Date(end.getFullYear(), end.getMonth(), 1)), endDate: iso(end) }
}

export function tenureLabel(joinDate, now = new Date()) {
  if (!joinDate) return 'Join date unavailable'
  const start = new Date(`${String(joinDate).slice(0,10)}T00:00:00`)
  if (Number.isNaN(start.getTime())) return 'Join date unavailable'
  let months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth()
  if (now.getDate() < start.getDate()) months -= 1
  months = Math.max(0, months)
  const years = Math.floor(months / 12); const remainder = months % 12
  if (!years) return `${remainder} month${remainder === 1 ? '' : 's'} in the business`
  if (!remainder) return `${years} year${years === 1 ? '' : 's'} in the business`
  return `${years} yr ${remainder} mo in the business`
}

const pct = (v) => v == null ? '—' : `${Number(v).toFixed(Number(v) % 1 ? 1 : 0)}%`
const label = (v) => String(v || '—').replaceAll('_', ' ')
const change = (current, previous) => Number(current || 0) - Number(previous || 0)
const Delta = ({ value, suffix = ' pts' }) => value == null ? <span className="text-slate-400">No comparison</span> : (
  <span className={`inline-flex items-center gap-1 text-xs font-semibold ${value > 0 ? 'text-emerald-700' : value < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
    {value > 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : value < 0 ? <ArrowDownRight className="h-3.5 w-3.5" /> : null}
    {value > 0 ? '+' : ''}{Number(value).toFixed(Number(value) % 1 ? 1 : 0)}{suffix}
  </span>
)

const panel = 'rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,.03)] dark:border-slate-800 dark:bg-slate-900/70'
const input = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none transition focus:border-[#009944] focus:ring-2 focus:ring-[#009944]/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200'

function MetricStrip({ snapshot }) {
  const s = snapshot.summary || {}
  const metrics = [
    ['Total staff', s.total_staff, Users, 'People in scope'], ['Active', s.active_staff, CheckCircle2, `${s.on_leave || 0} on leave`],
    ['Attendance', pct(s.attendance_rate), Gauge, <Delta value={change(s.attendance_rate,s.previous_attendance_rate)} />],
    ['KPI achievement', pct(s.kpi_achievement), Target, <Delta value={change(s.kpi_achievement,s.previous_kpi_achievement)} />],
    ['Target achievement', pct(s.target_achievement), TrendingUp, 'Existing target ledger'], ['Loan portfolio', formatCurrency(s.loan_portfolio), Landmark, `${formatCurrency(s.loans_disbursed)} disbursed`],
  ]
  return <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:grid-cols-3 xl:grid-cols-6 dark:border-slate-800 dark:bg-slate-900/70">
    {metrics.map(([name,value,Icon,detail],i) => <div key={name} className={`relative min-w-0 p-4 ${i ? 'border-l border-slate-100 dark:border-slate-800' : ''}`}><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.16em] text-slate-400"><Icon className="h-3.5 w-3.5 text-[#009944]" />{name}</div><div className="mt-2 truncate text-xl font-semibold tracking-tight text-slate-900 dark:text-white">{value ?? '—'}</div><div className="mt-1 truncate text-[11px] text-slate-400">{detail}</div></div>)}
  </div>
}

function FilterBar({ filters, setFilters, options }) {
  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value || '' }))
  const select = (key) => <select aria-label={key} className={`${input} min-w-36`} value={filters[key]} onChange={(e) => set(key,e.target.value)}><option value="">All {label(key.replace('Id',''))}</option>{(options?.[key === 'branchId' ? 'branches' : key] || []).map((o) => <option key={o.id} value={o.id}>{o.name || o.title}</option>)}</select>
  return <div className={`${panel} p-3`}><div className="flex items-center gap-2 overflow-x-auto pb-1"><div className="flex shrink-0 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">{PERIODS.map((p) => <button key={p} onClick={() => setFilters((f)=>({...f,period:p}))} className={`rounded-md px-3 py-1.5 text-[11px] font-semibold capitalize transition ${filters.period===p?'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white':'text-slate-500'}`}>{p}</button>)}</div>{select('department')}{select('branchId')}{select('area')}{select('role')}{select('designationId')}{select('employeeId')}{filters.period === 'custom' && <><input type="date" aria-label="Start date" className={input} value={filters.startDate} onChange={(e)=>set('startDate',e.target.value)}/><input type="date" aria-label="End date" className={input} value={filters.endDate} onChange={(e)=>set('endDate',e.target.value)}/></>}<button onClick={() => setFilters({...EMPTY_FILTERS})} className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">Reset</button></div></div>
}

function ExecutiveTrend({ data }) {
  const rows = (data || []).map((r) => ({ ...r, day: new Date(`${r.attendance_date}T00:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric'}) }))
  return <div className={`${panel} p-5`}><div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Operating pulse</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Attendance trajectory</h3></div><Activity className="h-5 w-5 text-slate-300" /></div><div className="h-56">{rows.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={rows}><defs><linearGradient id="directorAttendance" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#009944" stopOpacity={.28}/><stop offset="100%" stopColor="#009944" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#94a3b8" opacity={.18}/><XAxis dataKey="day" tick={{fontSize:10,fill:'#94a3b8'}} axisLine={false} tickLine={false}/><YAxis domain={[0,100]} tick={{fontSize:10,fill:'#94a3b8'}} axisLine={false} tickLine={false}/><Tooltip formatter={(v)=>`${v}%`} contentStyle={{borderRadius:12,border:'1px solid #e2e8f0',fontSize:12}}/><Area type="monotone" dataKey="attendance_rate" stroke="#009944" strokeWidth={2.5} fill="url(#directorAttendance)"/></AreaChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-sm text-slate-400">No attendance history in this period.</div>}</div></div>
}

function DepartmentTable({ rows, onSelect }) {
  const colors = ['#009944','#0f766e','#2563eb','#7c3aed','#d97706','#e11d48']
  return <div className={`${panel} overflow-hidden`}><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Primary lens</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Department scorecards</h3></div><span className="text-xs text-slate-400">Select to open intelligence</span></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50/80 text-[10px] uppercase tracking-wider text-slate-400 dark:bg-slate-800/50"><tr><th className="px-5 py-3 font-semibold">Department</th><th className="px-4 py-3 font-semibold">People</th><th className="px-4 py-3 font-semibold">Attendance</th><th className="px-4 py-3 font-semibold">KPI</th><th className="px-4 py-3 font-semibold">Targets</th><th className="px-4 py-3 font-semibold">Leave</th><th className="px-4 py-3 font-semibold">Overall</th><th className="px-4 py-3"/></tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
      {rows.map((d,i) => <tr key={d.id} onClick={()=>onSelect(d)} className="group cursor-pointer transition hover:bg-[#009944]/[.035]"><td className="px-5 py-4"><div className="flex items-center gap-3"><span className="h-8 w-1 rounded-full" style={{background:colors[i%colors.length]}}/><div><p className="font-semibold text-slate-800 dark:text-slate-100">{d.name}</p><p className="text-[11px] text-slate-400">{d.active_staff} active</p></div></div></td><td className="px-4 py-4 font-medium">{d.total_staff}</td><td className="px-4 py-4">{pct(d.attendance_rate)}</td><td className="px-4 py-4">{pct(d.kpi_completion)}</td><td className="px-4 py-4">{pct(d.target_completion)}</td><td className="px-4 py-4 text-slate-500">{d.on_leave}</td><td className="px-4 py-4"><div className="flex items-center gap-2"><div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-[#009944]" style={{width:`${Math.min(100,d.completion_rate||0)}%`}}/></div><span className="text-xs font-semibold">{pct(d.completion_rate)}</span></div></td><td className="px-4 py-4"><ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-1 group-hover:text-[#009944]"/></td></tr>)}
      {!rows.length && <tr><td colSpan="8" className="px-5 py-12 text-center text-sm text-slate-400">No departments match this scope.</td></tr>}
    </tbody></table></div></div>
}
function OrganizationTable({ title, rows, type }) {
  if (!rows?.length) return null
  return <div className={`${panel} overflow-hidden`}><div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800"><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Organization</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">{title}</h3></div><div className="divide-y divide-slate-100 dark:divide-slate-800">{rows.slice(0,8).map(r=><div key={r.id} className="grid grid-cols-[1fr_auto] gap-3 px-5 py-3 text-sm sm:grid-cols-[1fr_.45fr_.55fr_.55fr_.45fr] sm:items-center"><span className="font-medium text-slate-700 dark:text-slate-200">{r.name}</span><span className="text-xs text-slate-400">{r.total_staff} staff</span><span className="text-xs">Attendance {pct(r.attendance_rate)}</span><span className="text-xs">KPI {pct(r.kpi_completion)}</span><span className="text-xs text-[#009944]">{r.on_leave} on leave</span></div>)}</div></div>
}

function RolePerformance({ rows }) {
  const data = (rows || []).map((r) => ({ ...r, short: label(r.role).replace('Head of ','') }))
  return <div className={`${panel} p-5`}><div className="mb-4"><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Accountability</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Performance by role</h3></div><div className="h-64">{data.length?<ResponsiveContainer width="100%" height="100%"><BarChart data={data} layout="vertical" margin={{left:10,right:15}}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#94a3b8" opacity={.18}/><XAxis type="number" domain={[0,100]} tick={{fontSize:10,fill:'#94a3b8'}} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="short" width={105} tick={{fontSize:10,fill:'#64748b'}} axisLine={false} tickLine={false}/><Tooltip formatter={(v)=>`${v}%`} contentStyle={{borderRadius:12,border:'1px solid #e2e8f0',fontSize:12}}/><Bar dataKey="attendance_rate" name="Attendance" fill="#009944" radius={[0,5,5,0]} barSize={9}/><Bar dataKey="kpi_completion" name="KPI" fill="#2563eb" radius={[0,5,5,0]} barSize={9}/><Bar dataKey="target_completion" name="Targets" fill="#94a3b8" radius={[0,5,5,0]} barSize={9}/></BarChart></ResponsiveContainer>:<div className="flex h-full items-center justify-center text-sm text-slate-400">No role metrics in scope.</div>}</div></div>
}

function BusinessRibbon({ summary }) {
  const items = [
    ['Disbursed',formatCurrency(summary.loans_disbursed),Landmark,change(summary.loans_disbursed,summary.previous_loans_disbursed)],
    ['Repayments',formatCurrency(summary.repayments),Wallet,change(summary.repayments,summary.previous_repayments)],
    ['Recruitment',summary.active_recruitment,BriefcaseBusiness],
    ['Onboarding',summary.open_onboarding,UserRound],
    ['Leave approvals',summary.pending_leave,CalendarDays],
    ['Resumptions ≤14d',summary.upcoming_resumptions,Clock3],
  ]
  return <div className={`${panel} grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-6 dark:divide-slate-800`}>{items.map(([name,value,Icon,d])=><div key={name} className="p-4"><div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-slate-400"><span>{name}</span><Icon className="h-3.5 w-3.5"/></div><p className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{value ?? '—'}</p>{d!=null&&<div className="mt-1"><Delta value={d} suffix="" /></div>}</div>)}</div>
}

function AttendanceView({ staff }) {
  const rows = staff || []
  return <div className={`${panel} overflow-hidden`}><div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800"><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Verified records only</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Workforce attendance</h3></div><div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400 dark:bg-slate-800/50"><tr><th className="px-5 py-3">Employee</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Branch</th><th className="px-4 py-3">Days present</th><th className="px-4 py-3">Expected</th><th className="px-4 py-3">Rate</th><th className="px-4 py-3">Status</th></tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map(s=><tr key={s.id}><td className="px-5 py-3 font-medium text-slate-800 dark:text-slate-100">{s.full_name}</td><td className="px-4 py-3 text-slate-500">{s.department||'Unassigned'}</td><td className="px-4 py-3 text-slate-500">{s.branch_name||'—'}</td><td className="px-4 py-3 font-semibold">{s.attendance_present}</td><td className="px-4 py-3 text-slate-500">{s.expected_days}</td><td className="px-4 py-3">{pct(s.attendance_rate)}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${s.leave_count?'bg-blue-50 text-blue-700':s.employment_status==='active'?'bg-emerald-50 text-emerald-700':'bg-slate-100 text-slate-600'}`}>{s.leave_count?'On leave':label(s.employment_status)}</span></td></tr>)}</tbody></table></div></div>
}

function LeaveView({ rows, onEmployee }) {
  return <div className={`${panel} overflow-hidden`}><div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800"><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Workforce continuity</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Leave intelligence</h3></div><div className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map(l=><button key={l.id} onClick={()=>onEmployee(l.employee_id)} className="grid w-full gap-3 px-5 py-4 text-left transition hover:bg-slate-50 sm:grid-cols-[1.4fr_.8fr_.8fr_1fr_auto] sm:items-center dark:hover:bg-slate-800/40"><div><p className="font-semibold text-slate-800 dark:text-slate-100">{l.full_name}</p><p className="mt-1 text-xs text-slate-400">{l.position||'Position unavailable'} · {l.department||'Unassigned'}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Type</p><p className="mt-1 text-sm capitalize">{label(l.leave_type)}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Dates</p><p className="mt-1 text-sm">{formatDate(l.start_date)} — {formatDate(l.end_date)}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Resumption</p><p className="mt-1 text-sm font-medium">{formatDate(l.end_date)} {l.days_remaining>0&&<span className="text-[#009944]">· {l.days_remaining}d left</span>}</p></div><span className={`w-fit rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${l.status==='approved'?'bg-emerald-50 text-emerald-700':l.status==='pending'?'bg-amber-50 text-amber-700':'bg-rose-50 text-rose-700'}`}>{label(l.status)}</span></button>)}{!rows.length&&<div className="p-12 text-center text-sm text-slate-400">No leave activity in this scope.</div>}</div></div>
}

function StaffTable({ rows, onEmployee }) {
  return <div className={`${panel} overflow-hidden`}><div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800"><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">People lens</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Department workforce</h3></div><div className="overflow-x-auto"><table className="w-full min-w-[950px] text-left text-sm"><thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400 dark:bg-slate-800/50"><tr><th className="px-5 py-3">Employee</th><th className="px-4 py-3">Role / designation</th><th className="px-4 py-3">Branch / area</th><th className="px-4 py-3">Joined</th><th className="px-4 py-3">Tenure</th><th className="px-4 py-3">Attendance</th><th className="px-4 py-3">KPI</th><th className="px-4 py-3">Targets</th><th className="px-4 py-3">Status</th></tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map(s=><tr key={s.id} onClick={()=>onEmployee(s.id)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"><td className="px-5 py-3"><div className="flex items-center gap-3"><PersonAvatar person={s} sizeClass="w-9 h-9"/><div><p className="font-semibold text-slate-800 dark:text-slate-100">{s.full_name}</p><p className="text-[11px] text-slate-400">{label(s.platform_role)}</p></div></div></td><td className="px-4 py-3"><p className="text-slate-700 dark:text-slate-200">{s.position||'—'}</p><p className="text-[11px] text-slate-400">{s.designation_title||'—'}</p></td><td className="px-4 py-3"><p>{s.branch_name||'—'}</p><p className="text-[11px] text-slate-400">{s.area_name||'—'}</p></td><td className="px-4 py-3 text-slate-500">{formatDate(s.hire_date)}</td><td className="px-4 py-3 text-xs font-medium text-slate-600 dark:text-slate-300">{tenureLabel(s.hire_date)}</td><td className="px-4 py-3">{pct(s.attendance_rate)}</td><td className="px-4 py-3">{s.kpi_count?`${s.kpi_completed}/${s.kpi_count}`:'—'}</td><td className="px-4 py-3">{s.target_count?`${s.target_achieved}/${s.target_count}`:'—'}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${s.leave_count?'bg-blue-50 text-blue-700':s.employment_status==='active'?'bg-emerald-50 text-emerald-700':'bg-slate-100 text-slate-600'}`}>{s.leave_count?'On leave':label(s.employment_status)}</span></td></tr>)}</tbody></table></div></div>
}

function DetailStat({ label: name, value }) { return <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{name}</p><p className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{value ?? '—'}</p></div> }

function EmployeeDrawer({ employeeId, close }) {
  const [detail,setDetail] = useState(null); const [loading,setLoading] = useState(true); const [error,setError] = useState('')
  useEffect(()=>{ let live=true; setLoading(true); directorIntelligenceService.getEmployee(employeeId).then(d=>{if(live)setDetail(d)}).catch(e=>{if(live)setError(e.message)}).finally(()=>{if(live)setLoading(false)}); return ()=>{live=false} },[employeeId])
  const p=detail?.profile; const attendance=detail?.attendance||[]; const present=attendance.filter(a=>a.clock_in).length
  return <div className="fixed inset-0 z-[70] flex justify-end bg-slate-950/40 backdrop-blur-sm" onMouseDown={close}><aside onMouseDown={(e)=>e.stopPropagation()} className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-2xl dark:bg-slate-950"><div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/95 px-6 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"><div><p className="text-[10px] font-bold uppercase tracking-[.2em] text-[#009944]">Executive employee profile</p><h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{p?.full_name || 'Loading employee…'}</h2></div><button onClick={close} aria-label="Close employee detail" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-5 w-5"/></button></div><div className="p-6">{loading?<LoadingState label="Loading employee intelligence…"/>:error?<ErrorState message={error}/>:detail&&<div className="space-y-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center"><PersonAvatar person={detail.profile} sizeClass="w-20 h-20" textClass="text-xl"/><div><h3 className="text-2xl font-semibold text-slate-900 dark:text-white">{p.full_name}</h3><p className="mt-1 text-sm text-slate-500">{p.position||'Position unavailable'} · {p.designation||'Designation unavailable'}</p><p className="mt-2 text-xs font-semibold text-[#009944]">{tenureLabel(p.hire_date)}</p></div></div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><DetailStat label="Department" value={p.department}/><DetailStat label="Branch" value={p.branch}/><DetailStat label="Area" value={p.area}/><DetailStat label="Platform role" value={label(p.role)}/><DetailStat label="Join date" value={formatDate(p.hire_date)}/><DetailStat label="Status" value={label(p.status)}/></div>
    <div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#009944]">Historical performance</p><h3 className="mt-1 font-semibold text-slate-900 dark:text-white">Attendance, KPI and target ledger</h3></div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><DetailStat label="90-day attendance" value={attendance.length?pct(100*present/attendance.length):'No records'}/><DetailStat label="KPI assignments" value={detail.kpis.length}/><DetailStat label="Target assignments" value={detail.targets.length}/><DetailStat label="Leave records" value={detail.leave.length}/></div>
    <div className="grid gap-5 lg:grid-cols-2"><div className={`${panel} p-4`}><h4 className="text-sm font-semibold text-slate-900 dark:text-white">KPI assignments</h4><div className="mt-3 space-y-3">{detail.kpis.map(k=><div key={k.id} className="border-b border-slate-100 pb-3 last:border-0 dark:border-slate-800"><div className="flex justify-between gap-3 text-sm"><span className="font-medium">{k.kpi_name}</span><span>{k.actual_value}/{k.target_value} {k.unit}</span></div><p className="mt-1 text-[11px] text-slate-400">{label(k.status)} · {k.appraisal_year||'No year'}</p></div>)}{!detail.kpis.length&&<p className="text-sm text-slate-400">No KPI records available.</p>}</div></div>
    <div className={`${panel} p-4`}><h4 className="text-sm font-semibold text-slate-900 dark:text-white">Targets</h4><div className="mt-3 space-y-3">{detail.targets.map(t=>{const c=Number(t.target_value)?100*Number(t.current_value)/Number(t.target_value):0;return <div key={t.id}><div className="flex justify-between gap-3 text-sm"><span className="font-medium">{t.title}</span><span>{t.current_value}/{t.target_value} {t.unit}</span></div><div className="mt-2 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#009944]" style={{width:`${Math.min(100,c)}%`}}/></div></div>})}{!detail.targets.length&&<p className="text-sm text-slate-400">No target records available.</p>}</div></div></div>
    <div className={`${panel} p-4`}><h4 className="text-sm font-semibold text-slate-900 dark:text-white">Leave history</h4><div className="mt-3 space-y-2">{detail.leave.slice(0,8).map(l=><div key={l.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60"><span className="capitalize">{label(l.leave_type)} · {formatDate(l.start_date)}</span><span className="text-xs text-slate-400">{label(l.status)}</span></div>)}{!detail.leave.length&&<p className="text-sm text-slate-400">No leave history available.</p>}</div></div>
  </div>}</div></aside></div>
}

export default function DirectorDashboard() {
  const { profile, actualRole } = useAuth()
  const [filters,setFilters] = useState({...EMPTY_FILTERS}); const [snapshot,setSnapshot] = useState(null)
  const [loading,setLoading] = useState(true); const [error,setError] = useState(''); const [employeeId,setEmployeeId] = useState(null)
  const [tab,setTab] = useState('overview'); const [department,setDepartment] = useState(null)
  const load = async () => { setLoading(true); setError(''); try { const range=dateWindow(filters.period,filters); setSnapshot(await directorIntelligenceService.getSnapshot({...filters,...range})) } catch(e) { setError(e.message||'Director intelligence is unavailable. Apply the latest database migration.') } finally { setLoading(false) } }
  useEffect(()=>{ const t=setTimeout(load,180); return ()=>clearTimeout(t) },[filters.period,filters.department,filters.branchId,filters.area,filters.role,filters.designationId,filters.employeeId,filters.startDate,filters.endDate])
  const range=useMemo(()=>dateWindow(filters.period,filters),[filters]); const staff=useMemo(()=>department?(snapshot?.staff||[]).filter(s=>s.department===department):snapshot?.staff||[],[snapshot,department])
  // Executive titles (MD/CEO, Chairman, Director…) are roles, never departments.
  const filterOptions=useMemo(()=>({...(snapshot?.filters||{}),departments:filterDepartmentOptions(snapshot?.filters?.departments||[])}),[snapshot])
  const departmentRollup=useMemo(()=>filterDepartmentOptions(snapshot?.departments||[]),[snapshot])
  if (loading && !snapshot) return <LoadingState label="Preparing executive intelligence…"/>
  if (error && !snapshot) return <ErrorState message={error}/>
  if (!snapshot) return null
  const tabs=[['overview','Executive overview'],['attendance','Attendance'],['leave','Leave'],['performance','Performance']]
  return <div className="mx-auto max-w-[1600px] space-y-5">
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.24em] text-[#009944]"><Crown className="h-3.5 w-3.5"/>Director intelligence</div><h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-3xl">The business, at a glance.</h1><p className="mt-2 max-w-2xl text-sm text-slate-500">A read-only executive view of people, performance and balance-sheet activity across Infinity Core.</p></div><div className="flex items-center gap-2"><Link to="/attendance" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-[#009944] hover:text-[#009944] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"><Clock3 className="h-4 w-4"/>My attendance</Link><button onClick={load} disabled={loading} className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-500 shadow-sm hover:text-[#009944] disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900" aria-label="Refresh director intelligence"><RefreshCw className={`h-4 w-4 ${loading?'animate-spin':''}`}/></button></div></header>
    <FilterBar filters={filters} setFilters={setFilters} options={filterOptions}/>
    <MetricStrip snapshot={snapshot}/>
    <BusinessRibbon summary={snapshot.summary}/>
    <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">{tabs.map(([id,name])=><button key={id} onClick={()=>{setTab(id);setDepartment(null)}} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-semibold transition ${tab===id?'border-[#009944] text-[#009944]':'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>{name}</button>)}</div>
    {department&&<div className={`${panel} flex items-center justify-between px-5 py-3`}><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#009944]">Department intelligence</p><h2 className="font-semibold text-slate-900 dark:text-white">{department}</h2></div><button onClick={()=>setDepartment(null)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4"/></button></div>}
    {tab==='overview'&&<><DepartmentTable rows={departmentRollup} onSelect={(d)=>{setDepartment(d.name);setTab('attendance')}}/><div className="grid gap-5 xl:grid-cols-[1.45fr_1fr]"><ExecutiveTrend data={snapshot.trend}/><RolePerformance rows={snapshot.roles}/></div><div className="mt-5 grid gap-5 xl:grid-cols-2"><OrganizationTable title="Branch performance" rows={snapshot.branches}/><OrganizationTable title="Area performance" rows={snapshot.areas}/></div></>}
    {tab==='attendance'&&<><AttendanceView staff={staff}/><div className="mt-5"><StaffTable rows={staff} onEmployee={setEmployeeId}/></div></>}
    {tab==='leave'&&<LeaveView rows={snapshot.leave} onEmployee={setEmployeeId}/>} 
    {tab==='performance'&&<><div className="grid gap-5 xl:grid-cols-[1.45fr_1fr]"><ExecutiveTrend data={snapshot.trend}/><RolePerformance rows={snapshot.roles}/></div><div className="mt-5"><StaffTable rows={staff} onEmployee={setEmployeeId}/></div></>}
    <footer className="flex flex-col gap-2 border-t border-slate-200 pt-4 text-[11px] text-slate-400 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800"><span>Scope: {formatDate(range.startDate)} — {formatDate(range.endDate)} · Server aggregated</span><span>Signed in as {profile?.full_name||'Director'} · {label(actualRole)}</span></footer>
    {employeeId&&<EmployeeDrawer employeeId={employeeId} close={()=>setEmployeeId(null)}/>} 
  </div>
}

// End of Director executive workspace.
