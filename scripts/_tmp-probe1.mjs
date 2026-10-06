import XLSX from 'xlsx';
import fs from 'fs';
const wb = XLSX.readFile('/Users/clintoniwolomaimaginr/Downloads/IT AUTOMATION LIST REVIEWED-3.xlsx', { cellDates: true });
const all = [];
for (const n of ['FRONT END', 'BACKEND']) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
  const hdr = rows[0];
  rows.slice(1).forEach((r) => {
    if (!r.some((c) => String(c).trim())) return;
    const o = { _sheet: n };
    hdr.forEach((h, i) => { o[h] = String(r[i] ?? '').trim(); });
    all.push(o);
  });
}
fs.writeFileSync('/tmp/emp_raw.json', JSON.stringify(all, null, 1));
const out = [];
const tally = (key) => {
  const m = {};
  all.forEach((r) => { m[r[key]] = (m[r[key]] || 0) + 1; });
  return m;
};
out.push('total employee rows ' + all.length);
out.push('cols ' + JSON.stringify(Object.keys(all[0])));
for (const key of ['BRANCH LOCATION', 'DEPARTMENT', 'CONFIRMED& UNCONFIRMED', 'GENDER', 'DESIGNATION']) {
  const m = tally(key);
  out.push('\n== ' + key + ' (' + Object.keys(m).length + ' distinct) ==');
  Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => out.push(String(v).padStart(4) + '  ' + JSON.stringify(k)));
}
fs.writeFileSync('/tmp/probe1.out', out.join('\n') + '\n');
