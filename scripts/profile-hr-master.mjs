#!/usr/bin/env node
/**
 * Profiles the reviewed HR master workbook (FRONT END / BACKEND sheets).
 *
 * Read-only. Prints the identity hazards that must be resolved BEFORE any
 * migration is applied: duplicate staff ids, duplicate names, duplicate emails,
 * the branch vocabulary, and supervisor labels that are not employee names.
 *
 * Usage: node scripts/profile-hr-master.mjs <workbook.xlsx>
 */
import XLSX from 'xlsx';

const FILE = process.argv[2] || '/tmp/hrw/master.xlsx';
const H = ['sn','staff_id','full_name','confirmed','designation','department','branch','gender','email','sup1','sup2','sup3'];

const wb = XLSX.readFile(FILE);
console.log('FILE:', FILE);
console.log('SHEETS:', JSON.stringify(wb.SheetNames));

const all = [];
for (const sheet of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' }).slice(1);
  let kept = 0;
  for (const r of rows) {
    const o = { sheet };
    H.forEach((h, i) => { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
    if (!o.staff_id && !o.full_name) continue;
    kept++;
    all.push(o);
  }
  console.log(`sheet ${sheet}: data rows=${kept}`);
}
console.log('TOTAL rows=' + all.length);

const ids = all.map(o => o.staff_id).filter(Boolean);
console.log('staff_id present=' + ids.length + ' unique=' + new Set(ids).size);

const byId = new Map();
for (const o of all) {
  if (!o.staff_id) continue;
  if (!byId.has(o.staff_id)) byId.set(o.staff_id, []);
  byId.get(o.staff_id).push(o);
}
const dupIds = [...byId.entries()].filter(([, v]) => v.length > 1);
console.log(`--- duplicated staff ids (${dupIds.length}) ---`);
for (const [k, v] of dupIds) {
  console.log('  ', k, 'x' + v.length);
  for (const o of v) console.log('      ', o.sheet, '|', o.full_name, '|', o.email, '|', o.branch, '|', o.designation);
}

const norm = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const byName = new Map();
for (const o of all) {
  const n = norm(o.full_name);
  if (!n) continue;
  if (!byName.has(n)) byName.set(n, []);
  byName.get(n).push(o);
}
const dupNames = [...byName.entries()].filter(([, v]) => v.length > 1);
console.log(`duplicate NAMES=${dupNames.length}`);
for (const [k, v] of dupNames.slice(0, 20)) {
  console.log('  ', k, 'x' + v.length, v.map(o => o.sheet + ':' + o.staff_id).join(' | '));
}

console.log('confirmed values:', JSON.stringify([...new Set(all.map(o => o.confirmed))]));

const branches = new Map();
for (const o of all) {
  if (!o.branch) continue;
  if (!branches.has(o.branch)) branches.set(o.branch, new Set());
  branches.get(o.branch).add(o.sheet);
}
console.log(`--- branch vocabulary (${branches.size}) ---`);
for (const [b, s] of [...branches.entries()].sort()) console.log('  ', JSON.stringify(b), [...s].join('+'));

const depts = new Map();
for (const o of all) if (o.department) depts.set(o.department, (depts.get(o.department) || 0) + 1);
console.log(`--- departments (${depts.size}) ---`);
for (const [d, n] of [...depts.entries()].sort()) console.log('  ', JSON.stringify(d), n);

const supNames = new Set();
for (const o of all) for (const lv of ['sup1','sup2','sup3']) if (o[lv]) supNames.add(o[lv]);
const empNames = new Set(all.map(o => norm(o.full_name)));
const notPerson = [...supNames].filter(v => !empNames.has(norm(v)));
console.log(`distinct supervisor labels=${supNames.size}  not-an-employee-name=${notPerson.length}`);
for (const v of notPerson.sort()) console.log('   NONPERSON:', JSON.stringify(v));

const emails = all.map(o => o.email).filter(Boolean);
const byEmail = new Map();
for (const e of emails) {
  if (e === 'N/A') continue;
  const k = e.toLowerCase();
  if (!byEmail.has(k)) byEmail.set(k, 0);
  byEmail.set(k, byEmail.get(k) + 1);
}
const dupEmails = [...byEmail.entries()].filter(([, n]) => n > 1);
console.log(`emails present=${emails.length} bad(N/A)=${emails.filter(e => e === 'N/A').length} duplicated=${dupEmails.length}`);
for (const [e, n] of dupEmails) console.log('   DUPEMAIL:', e, 'x' + n);

const desigs = new Set(all.map(o => o.designation).filter(Boolean));
console.log(`distinct designations=${desigs.size}`);
console.log(JSON.stringify([...desigs].sort()));

const crossSheet = dupIds.filter(([, v]) => new Set(v.map(o => o.sheet)).size > 1);
console.log('cross-sheet same-staff-id groups=' + crossSheet.length);