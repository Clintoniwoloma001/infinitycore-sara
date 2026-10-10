import React, { useState } from 'react'
import { Crown } from 'lucide-react'
import { rpcWithRetry } from '../services/rpcHelper'
import { directorIntelligenceService } from '../services/directorIntelligenceService'
import { DirectorGlobalFilterBar } from '../components/directorIntelligence/DirectorGlobalFilterBar'
import { DirectorScorecardCards } from '../components/directorIntelligence/DirectorScorecardCards'
import { DirectorBestWorstStaff } from '../components/directorIntelligence/DirectorBestWorstStaff'
import { DirectorBranchStaffTable } from '../components/directorIntelligence/DirectorBranchStaffTable'
import { DirectorDeepDive } from '../components/directorIntelligence/DirectorDeepDive'
import { iso } from './DirectorDashboard'

const EMPTY_SCORE = {
  portfolio: null, par_amount: null, par_pct: null, pass_watch: null,
  substandard: null, doubtful: null, lost: null, caseload: null,
  disbursement: null,
  overall: { total: null, grade: '', grade_hex: '#009944', score_complete: false, previous_total: null },
  period: '', as_of: null,
};

const defaultStart = iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

export function DirectorIntelligenceDeepDive() {
  const [filters, setFilters] = useState({ period: 'month', department: '', branchId: '', area: '', role: '', designationId: '', employeeId: '', startDate: defaultStart, endDate: iso(new Date()) });
  const [scorecards, setScorecards] = useState(EMPTY_SCORE);
  const [branchBreakdown, setBranchBreakdown] = useState({ branches: [], managers: [], areas: [], best: [], worst: [], per_branch: {} });
  const [bestWorst, setBestWorst] = useState({ best: [], worst: [], per_branch: {} });
  const [deepDiveOpen, setDeepDiveOpen] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('');
  const [branchId, setBranchId] = useState('');
  const [staffTableOpen, setStaffTableOpen] = useState(false);
  const [staffTable, setStaffTable] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadScorecards = async () => {
    setLoading(true); setError('');
    try {
      const data = await rpcWithRetry(() => directorIntelligenceService.getScorecards(filters.startDate || defaultStart, filters.endDate || iso(new Date()), filters.area ? [filters.area] : null, filters.department ? [filters.department] : null, filters.position ? [filters.position] : null));
      setScorecards(data.scorecards || EMPTY_SCORE);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadBranchBreakdown = async () => {
    setLoading(true); setError('');
    try {
      const data = await rpcWithRetry(() => directorIntelligenceService.getBranchBreakdown(filters.startDate || defaultStart, filters.endDate || iso(new Date()), branchId ? [branchId] : null, null, filters.department ? [filters.department] : null, filters.position ? [filters.position] : null));
      setBranchBreakdown(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadBestWorst = async () => {
    setLoading(true); setError('');
    try {
      const data = await rpcWithRetry(() => directorIntelligenceService.getTopStaff(filters.startDate || defaultStart, filters.endDate || iso(new Date()), branchId ? [branchId] : null, null, filters.department ? [filters.department] : null, filters.position ? [filters.position] : null, 5));
      setBestWorst(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadStaffTable = async (bid) => {
    setLoading(true); setError('');
    try {
      const data = await rpcWithRetry(() => directorIntelligenceService.getBranchStaff(bid, filters.startDate || defaultStart, filters.endDate || iso(new Date()), filters.department ? [filters.department] : null, filters.position ? [filters.position] : null, null, 'overall_score', 'desc'));
      setStaffTable(data.staff || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const handlePeriod = (p) => {
    setFilters(f => ({ ...f, period: p, startDate: f.startDate || filters.startDate, endDate: f.endDate || filters.endDate }));
    loadScorecards(); loadBranchBreakdown(); loadBestWorst();
  };

  const handleDatePreset = (p) => {
    const end = iso(new Date());
    setFilters(f => ({ ...f, period: p, startDate: f.startDate || (p === 'today' ? end : defaultStart), endDate: end }));
    loadScorecards(); loadBranchBreakdown(); loadBestWorst();
  };

  const handleFilterChange = (key, value) => {
    setFilters(f => ({ ...f, [key]: value || '' }));
    if (key === 'area' || key === 'department' || key === 'position') {
      loadScorecards(); loadBranchBreakdown(); loadBestWorst();
    }
  };

  const handleMetricSelect = (key) => { setSelectedMetric(key); setDeepDiveOpen(true); };
  const handleBranchSelect = (bid) => { setBranchId(bid); loadStaffTable(bid); setStaffTableOpen(true); };

  const areaManagers = branchBreakdown.managers?.map(m => ({ id: m.manager, name: m.manager })) || [];
  const positions = branchBreakdown.branches?.map(b => b.positions) || [];
  const uniquePositions = [...new Set(positions.flatMap(p => p || []).map(x => x.name ?? x))].filter(Boolean);

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.24em] text-[#009944]"><Crown className="h-3.5 w-3.5"/>Director Intelligence</div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-3xl">Scorecards &amp; rankings, drilled server-side</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">Every figure is produced ONCE by the existing MPR engine and returned by the Director RPCs. The global filter bar below is sticky: change any filter and the scorecards, branch breakdown, best/worst and staff table all re-fetch.</p>
          </div>
          <button onClick={loadScorecards} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm hover:border-[#009944] hover:text-[#009944] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"><span className={`h-4 w-4 ${loading?'animate-spin':''}`} />Refresh</button>
        </div>
      </header>

      <DirectorGlobalFilterBar filters={filters} setFilters={handleFilterChange} options={{ branches: [], areaManagers, departments: [], roles: [], positions: uniquePositions, designations: [] }}/>

      {scorecards.portfolio === undefined ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800"><p className="text-sm text-slate-500">Preparing scorecards…</p></div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/30 p-6 dark:border-rose-900"><p className="text-sm text-rose-700">{error}</p><button onClick={loadScorecards} className="mt-2 text-sm font-semibold text-rose-700">Retry</button></div>
      ) : (
        <DirectorScorecardCards scorecards={scorecards} fetched onSelectMetric={handleMetricSelect} onSelectBranch={handleBranchSelect} />
      )}

      <DirectorBestWorstStaff data={bestWorst} onSelect={async (id) => setStaffTableOpen(true)} />

      {staffTableOpen && staffTable.length > 0 && (
        <DirectorBranchStaffTable staff={staffTable} branchName={branchId ? (branchBreakdown.branches?.find(b => b.branch_id === bid)?.branch_name) : 'Selected branch'} period={scorecards.period || '—'} onSelectEmployee={null} columns={['overall_score', 'portfolio', 'par_pct', 'caseload', 'full_name']} sortDir="desc" onSort={() => {}} />
      )}

      <DirectorDeepDive open={deepDiveOpen} metricKey={selectedMetric} data={branchBreakdown} onClose={() => setDeepDiveOpen(false)} />
    </div>
  );
}

