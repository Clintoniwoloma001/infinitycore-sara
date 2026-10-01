/**
 * Dry-run the supervisor resolver against the real workbook and print the
 * per-tier breakdown. Read-only: proves the resolution rules on real data
 * without touching the database.
 *
 * Usage: node scripts/dryrun-hr-supervisors.mjs <workbook.xlsx>
 */
import XLSX from 'xlsx';
import { buildRosterIndex, resolveSupervisorChain, resolveSupervisorLabel, MATCH_TIER } from '../src/domains/employeeMaster/supervisors.js';

const FILE = process.argv[2] || '/tmp/hrw/master.xlsx';
const wb = XLSX.readFile(FILE);
const H = ['sn','staff_id','full_name','confirmed','designation','department','branch','gender','email','sup1','sup2','sup3'];
const rows = [];
for (const sheet of wb.SheetNames) {
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' }).slice(1)) {
    const o = { sheet };
    H.forEach((h, i) => { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    if (o.staff_id || o.full_name) rows.push(o);
  }
}
const index = buildRosterIndex(rows.map(r => ({ id: r.staff_id, full_name: r.full_name, staff_id: r.staff_id })));
console.log('roster=' + index.list.length);

const labelTiers = new Map();
for (const r of rows) {
  for (const lv of ['sup1','sup2','sup3']) {
    if (!r[lv]) continue;
    const res = resolveSupervisorLabel(r[lv], index);
    if (!labelTiers.has(r[lv])) labelTiers.set(r[lv], res);
  }
}
const counts = {};
for (const [, res] of labelTiers) counts[res.tier] = (counts[res.tier] || 0) + 1;
console.log('--- distinct supervisor labels by tier (' + labelTiers.size + ') ---');
for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log('  ', t.padEnd(20), n);

const slots = {};
for (const r of rows) {
  const chain = resolveSupervisorChain(r, index);
  for (const lv of [1, 2, 3]) {
    if (!r['sup' + lv]) continue;
    slots[lv] = slots[lv] || {};
    slots[lv][chain[lv].tier] = (slots[lv][chain[lv].tier] || 0) + 1;
  }
}
console.log('--- slots by level ---');
for (const lv of [1, 2, 3]) {
  const c = slots[lv] || {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const auto = Object.entries(c).filter(([t]) => ['exact','prefix_truncated','token_permutation'].includes(t)).reduce((a, [, n]) => a + n, 0);
  console.log(`  level ${lv}: total=${total} auto=${auto} review=${total - auto}`, JSON.stringify(c));
}

console.log('--- non-auto labels needing review ---');
for (const [label, res] of [...labelTiers.entries()].sort((a, b) => a[1].tier.localeCompare(b[1].tier))) {
  if (['exact','prefix_truncated','token_permutation'].includes(res.tier)) continue;
  const cand = (res.candidates || []).slice(0, 3).map(c => c.full_name).join(' ; ');
  console.log(`  [${res.tier}] ${JSON.stringify(label)} ${cand ? '-> ' + cand : ''}`);
}