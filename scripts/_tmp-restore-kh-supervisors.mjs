// One-off repair for LOCAL DEV ONLY: regenerate the employee_supervisors rows
// for the synthetic `IMFB-KH-*` seed staff. Those links were lost when the KH
// employee rows were briefly deleted during a production-shape simulation;
// they are recreated from the documented source data using the same rules the
// Phase 26 seed applies (exact trimmed lower-case full-name match, level 1-3,
// skipped on self-reference or ambiguity).
import { readFileSync, writeFileSync } from 'node:fs';

const md = readFileSync('INFINITYCORE_BANK_SOURCE_DATA_AND_PERFORMANCE_DEFAULTS.md', 'utf8').split('\n');
const rows = [];
for (const line of md) {
  const c = line.split('|').map((s) => s.trim());
  // | S/N | STAFF ID | FULL NAME | EMAIL | DESIGNATION | DEPARTMENT | BRANCH | 1ST | 2ND | 3RD | ... |
  if (c.length >= 13 && /^IMFB-KH-\d+$/.test(c[2])) {
    const dash = (v) => (!v || v === '-' || v === '—' ? null : v);
    rows.push({ staff: c[2], name: c[3], sup: [dash(c[8]), dash(c[9]), dash(c[10])] });
  }
}
console.log('parsed KH rows:', rows.length);
if (!rows.length) process.exit(1);

const esc = (s) => s.replace(/'/g, "''");
const vals = [];
for (const r of rows) {
  const arr = r.sup.map((s) => (s ? `'${esc(s)}'` : 'null')).join(', ');
  vals.push(`('${r.staff}', '${esc(r.name)}', ${arr})`);
}
writeFileSync('/tmp/kh_sup.sql', `create temp table _kh_sup (staff_id text primary key, full_name text, s1 text, s2 text, s3 text);\ninsert into _kh_sup values\n${vals.join(',\n')};\n`);
console.log('wrote /tmp/kh_sup.sql');
