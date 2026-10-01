import XLSX from 'xlsx';

const FILE = process.argv[2] || '/tmp/hrw/master.xlsx';
const H = ['sn','staff_id','full_name','confirmed','designation','department','branch','gender','email','sup1','sup2','sup3'];
const wb = XLSX.readFile(FILE);
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const rows = [];
for (const sheet of wb.SheetNames) {
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' }).slice(1)) {
    const o = { sheet };
    H.forEach((h, i) => { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    if (o.staff_id || o.full_name) rows.push(o);
  }
}
const names = new Map();
for (const o of rows) { const n = norm(o.full_name); if (n && !names.has(n)) names.set(n, o); }
const nameList = [...names.keys()];

console.log('employees(unique names)=' + nameList.length);

// Classify each distinct supervisor label.
const labels = new Map();
for (const o of rows) for (const lv of ['sup1','sup2','sup3']) if (o[lv]) {
  if (!labels.has(o[lv])) labels.set(o[lv], { uses: 0, levels: new Set() });
  const e = labels.get(o[lv]); e.uses++; e.levels.add(lv);
}

const exact = [], prefix = [], subset = [], none = [];
for (const [raw, info] of labels) {
  const n = norm(raw);
  if (names.has(n)) { exact.push([raw, info]); continue; }
  // prefix: label tokens are a leading subset of an employee name (BankOne truncation)
  const pref = nameList.filter(c => c.startsWith(n + ' ') || c === n);
  if (pref.length) { prefix.push([raw, info, pref]); continue; }
  const sub = nameList.filter(c => n.includes(c) || c.includes(n));
  if (sub.length) { subset.push([raw, info, sub]); continue; }
  none.push([raw, info]);
}
const u = a => a.length;
console.log(`supervisor labels: exact=${u(exact)} prefix=${u(prefix)} tokenSubset=${u(subset)} NO_EMPLOYEE_MATCH=${u(none)}`);
console.log('--- prefix matches (likely BankOne/HR truncation) ---');
for (const [raw, info, cand] of prefix) console.log('  ', JSON.stringify(raw), '->', cand.length, cand.slice(0,3).join(' ; '));
console.log('--- token-subset matches (review) ---');
for (const [raw, info, cand] of subset) console.log('  ', JSON.stringify(raw), '->', cand.length, cand.slice(0,4).join(' ; '));
console.log('--- NO EMPLOYEE MATCH ---');
for (const [raw, info] of none.sort((a,b)=>b[1].uses-a[1].uses)) console.log('  ', JSON.stringify(raw), 'uses=' + info.uses, 'levels=' + [...info.levels].join(','));

// How many employee-supervisor SLOTS resolve at each level?
for (const lv of ['sup1','sup2','sup3']) {
  let slots = 0, res = 0, amb = 0;
  for (const o of rows) {
    if (!o[lv]) continue;
    slots++;
    const n = norm(o[lv]);
    if (names.has(n)) { res++; continue; }
    const pref = nameList.filter(c => c.startsWith(n + ' '));
    if (pref.length === 1) res++;
    else if (pref.length > 1) amb++;
  }
  console.log(`level ${lv}: slots=${slots} resolvable=${res} ambiguous=${amb} unresolved=${slots - res - amb}`);
}

// multi-branch employees (one name, >1 branch label)
const byPerson = new Map();
for (const o of rows) {
  const n = norm(o.full_name);
  if (!byPerson.has(n)) byPerson.set(n, []);
  byPerson.get(n).push(o);
}
console.log('--- employees appearing on more than one row ---');
for (const [n, list] of byPerson) {
  if (list.length > 1) {
    console.log('  ', n, 'rows=' + list.length, list.map(o => o.sheet + ':' + o.branch).join(' | '));
  }
}

// department label sanity
const NONDEPTS = ['MD/CEO','MD','M.D.','CEO','MANAGING DIRECTOR','CHAIRMAN','DIRECTOR','BOARD'];
console.log('dept values that look like titles:', JSON.stringify([...new Set(rows.map(o=>o.department).filter(d => NONDEPTS.includes(d.toUpperCase())))]));
// designations that look like departments (MULTI-LOCATION signal)
const depSet = new Set(rows.map(o => o.department));
console.log('designation values that equal a DEPARTMENT name:', JSON.stringify([...new Set(rows.map(o=>o.designation).filter(d=>depSet.has(d)))]));