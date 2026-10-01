import { buildRosterIndex, resolveSupervisorLabel } from "../src/domains/employeeMaster/supervisors.js";
import XLSX from "xlsx";
const wb = XLSX.readFile(process.argv[2] || "/tmp/hrw/master.xlsx");
const rows = [];
for (const sheet of wb.SheetNames) {
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: "" }).slice(1)) {
    const o = { id: String(r[1] || "").trim(), full_name: String(r[2] || "").trim() };
    if (o.id || o.full_name) rows.push(o);
  }
}
const idx = buildRosterIndex(rows);
for (const label of ["UGUTE FEJIRO","OBILOR IFEANYIN","OZIOKO COSMOS","EUNICE MANKANJUOLA","ORUSOSO  ISIOMA-NWALIGBE"]) {
  const r = resolveSupervisorLabel(label, idx);
  const best = r.suggestion ? (r.suggestion.full_name + "  [" + r.suggestion.id + "]") : (r.candidates.map(c => c.full_name).join(" | ") || "NO MATCH IN WORKBOOK");
  console.log(label.padEnd(30) + " -> " + r.tier.padEnd(18) + " " + String(r.score||"").padEnd(5) + " " + best);
}
