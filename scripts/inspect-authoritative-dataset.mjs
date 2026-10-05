/**
 * Inspect the filtered dataset: branch distribution, multi-branch coverage and
 * spot-checks. Read-only — prints, changes nothing.
 */
import { buildDataset, tidyName } from './build-authoritative-employees.mjs'
import { readWorkbook } from './build-authoritative-employees.mjs'

const { people, excludedRows, meta } = buildDataset()

// Histogram of branches-per-person after de-duplication.
const hist = {}
people.forEach((p) => { hist[p.branches.length] = (hist[p.branches.length] || 0) + 1 })
console.log('branches-per-person histogram:', JSON.stringify(hist))

// How many rows had a multi-branch cell BEFORE de-duplication?
const { rows } = readWorkbook()
const rawMulti = rows.filter((r) => {
  const s = String(r['BRANCH LOCATION'] || '').trim()
  return s.split(/[,/|;]/).map((x) => x.trim()).filter(Boolean).length > 1
})
console.log('workbook rows whose BRANCH LOCATION cell holds >1 branch:', rawMulti.length)
rawMulti.slice(0, 12).forEach((r) => console.log(`   ${r['STAFF ID NO.']} | ${r['FULL NAME']} | ${r['BRANCH LOCATION']}`))

const peopleWithManyBranches = people.filter((p) => p.branches.length > 1)
console.log('\npeople with >1 branch after de-duplication:', peopleWithManyBranches.length)
peopleWithManyBranches.slice(0, 10).forEach((p) => console.log(`   ${p.staff_id} | ${p.full_name} | ${p.branches.join(' + ')}`))

// Excluded staff must be entirely absent.
console.log('\nexclusion verification:')
for (const id of ['IMFB/20/0147', 'IMFB/23/0305']) {
  console.log(`   ${id} present in insert set: ${people.some((p) => p.staff_id === id)}`)
}
console.log(`   a.shittu@infinitymfb.com present: ${people.some((p) => p.email === 'a.shittu@infinitymfb.com')}`)

// Email 'N/A' must be stored as NULL, not as the literal string.
const naEmails = people.filter((p) => p.email === 'n/a' || p.email === '')
console.log(`\nemails equal to 'n/a' or empty in output: ${naEmails.length} (must be 0)`)

console.log(`\ntotals: raw=${meta.raw} excluded=${meta.excluded} insert=${meta.kept}`)
console.log(`excluded staff ids: ${[...new Set(excludedRows.map((r) => r.staff_id))].join(', ')}`)