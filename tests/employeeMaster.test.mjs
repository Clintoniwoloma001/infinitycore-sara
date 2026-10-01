#!/usr/bin/env node
/**
 * Reconciliation domain tests for the authoritative HR employee master.
 *
 * Pure-function tests always run. The workbook-driven block runs only when the
 * reviewed master is present, so CI stays deterministic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  normalizeName, tokenSortKey, tokenPrefixKeys, editDistance,
  normalizeBranch, splitCombinedBranch,
} from '../src/domains/employeeMaster/normalize.js';
import {
  MATCH_TIER, AUTO_TIERS, isBlankLabel, isOrgBody, buildRosterIndex,
  resolveSupervisorLabel, resolveSupervisorChain, isAutoResolvable,
} from '../src/domains/employeeMaster/supervisors.js';
import {
  IDENTITY, buildExistingIndex, groupWorkbookRows, branchAssignmentsOf,
  classifyPerson, isSafeIdentity, findStaffIdConflicts,
} from '../src/domains/employeeMaster/identity.js';

test('normalizeName collapses the workbook defects', () => {
  assert.equal(normalizeName('OJABINENI MOSUNMOLA AINA '), 'OJABINENI MOSUNMOLA AINA');
  assert.equal(normalizeName('ORUSOSO  ISIOMA-NWALIGBE'), 'ORUSOSO ISIOMA NWALIGBE');
  assert.equal(normalizeName("OLAYEMI ODUNOLA"), 'OLAYEMI ODUNOLA');
  assert.equal(normalizeName(null), '');
});

test('tokenSortKey is order-insensitive, tokenPrefixKeys yields leading prefixes', () => {
  assert.equal(tokenSortKey('JUDE UKUAGHE'), tokenSortKey('UKUAGHE JUDE'));
  assert.deepEqual(tokenPrefixKeys('UKUAGHE JUDE OAMEN'), ['UKUAGHE JUDE OAMEN', 'UKUAGHE JUDE', 'UKUAGHE']);
});

test('editDistance', () => {
  assert.equal(editDistance('ABC', 'ABC'), 0);
  assert.equal(editDistance('ABC', 'ABD'), 1);
  assert.ok(editDistance('SHORT', 'MUCHLONGERSTRING', 2) > 2);
});

test('branch normalisation and combined-label split', () => {
  assert.equal(normalizeBranch('LAGOS ISLAND2'), 'LAGOS ISLAND 2');
  assert.deepEqual(splitCombinedBranch('KOLA & ILE-EPO'), ['KOLA', 'ILE EPO']);
  assert.deepEqual(splitCombinedBranch('MUSHIN/YABA'), ['MUSHIN', 'YABA']);
});

test('organisational bodies are never treated as employees', () => {
  for (const b of ['BOD', 'MCC', 'HRM', 'GMD/MD.HRM', 'BOARD OF DIRECTORS']) {
    assert.equal(isOrgBody(b), true, b);
  }
  assert.equal(isOrgBody('UKUAGHE JUDE OAMEN'), false);
  assert.equal(isBlankLabel('N/A'), true);
  assert.equal(isBlankLabel(''), true);
  assert.equal(isBlankLabel('ADEWUNMI GABRIEL OLUDOTUN'), false);
});

const roster = [
  { id: 'e1', full_name: 'UKUAGHE JUDE OAMEN' },
  { id: 'e2', full_name: 'ADEWUNMI GABRIEL OLUDOTUN' },
  { id: 'e3', full_name: 'AJISEGBEDE GBEMILEKE ABIGAIL' },
  { id: 'e4', full_name: 'UMUKORO KELECHI JULIE' },
  { id: 'e5', full_name: 'UGUTE EVELYN OGHENEFEJIRO' },
  { id: 'e6', full_name: 'OLAYEMI ODUNOLA MULIKAT' },
];
const idx = buildRosterIndex(roster);

test('exact supervisor label resolves deterministically', () => {
  const r = resolveSupervisorLabel('ADEWUNMI GABRIEL OLUDOTUN', idx);
  assert.equal(r.tier, MATCH_TIER.EXACT);
  assert.equal(r.resolved.id, 'e2');
  assert.ok(isAutoResolvable(r));
});

test('trailing whitespace in the label does not break resolution', () => {
  assert.equal(resolveSupervisorLabel('  ADEWUNMI GABRIEL OLUDOTUN  ', idx).resolved.id, 'e2');
});

test('truncated tail resolves as prefix_truncated and is auto-applicable', () => {
  const r = resolveSupervisorLabel('UKUAGHE JUDE', idx);
  assert.equal(r.tier, MATCH_TIER.PREFIX_TRUNCATED);
  assert.equal(r.resolved.id, 'e1');
});

test('reordered tokens resolve as token_permutation', () => {
  const r = resolveSupervisorLabel('OAMEN JUDE UKUAGHE', idx);
  assert.equal(r.tier, MATCH_TIER.TOKEN_PERMUTATION);
  assert.equal(r.resolved.id, 'e1');
});

test('mid-token truncation resolves as token_prefix_set', () => {
  assert.equal(resolveSupervisorLabel('AJISEGBEDE GBEMI', idx).resolved.id, 'e3');
  assert.equal(resolveSupervisorLabel('UMUKORO KELECH', idx).resolved.id, 'e4');
});

test('substring-only matches stay in review, never auto-linked', () => {
  const r = resolveSupervisorLabel('UGUTE FEJIRO', idx);
  assert.equal(r.tier, MATCH_TIER.TOKEN_AFFIX);
  assert.equal(r.resolved, null, 'a substring match must not auto-link a supervisor');
  assert.equal(isAutoResolvable(r), false);
});

test('duplicate employee names are never silently disambiguated', () => {
// ---------------------------------------------------------------- identity --
const existing = [
  { id: 'x1', full_name: 'OLAYEMI ODUNOLA MULIKAT', employee_code: 'IMFB/11/0020', email: 'o.olayemi@infinitymfb.com' },
  { id: 'x2', full_name: 'DISU HANNAH HALIMAT', employee_code: 'IMFB/10/0015', email: 'h.disu@infinitymfb.com' },
];
const eidx = buildExistingIndex(existing);

test('a unique staff id matches an existing employee', () => {
  const rows = [{ sheet: 'FRONT END', staff_id: 'IMFB/11/0020', full_name: 'OLAYEMI ODUNOLA MULIKAT', email: 'o.olayemi@infinitymfb.com', branch: 'KETU' }];
  const res = classifyPerson(rows, eidx);
  assert.equal(res.kind, IDENTITY.MATCH_EXISTING);
  assert.equal(res.employee.id, 'x1');
  assert.equal(res.matchKey, 'staff_id');
});

test('a workbook-only person becomes a new employee record, not a match', () => {
  const rows = [{ sheet: 'BACKEND', staff_id: 'IMFB/99/9999', full_name: 'NOBODY HERE', email: 'N/A', branch: 'KETU' }];
  const res = classifyPerson(rows, eidx);
  assert.equal(res.kind, IDENTITY.NEW_EMPLOYEE);
  assert.equal(res.employee, null);
});

test('a staff id reused by two different people is a conflict, never a merge', () => {
  const rows = [
    { sheet: 'BACKEND', staff_id: 'IMFB/20/0147', full_name: 'SIMON TUNDE ADEMOLA', email: 'N/A', branch: 'HEAD OFFICE' },
    { sheet: 'BACKEND', staff_id: 'IMFB/20/0147', full_name: 'OBASOYIN AYOKUNLE JOSEPH', email: 'j.obasoyin@infinitymfb.com', branch: 'BARIGA' },
  ];
  const ctx = { conflictingStaffIds: findStaffIdConflicts(rows) };
  assert.equal(ctx.conflictingStaffIds.size, 1);
  const groups = groupWorkbookRows(rows);
  assert.equal(groups.length, 2, 'different names must stay separate people');
  const kinds = groups.map(g => classifyPerson(g, eidx, ctx).kind);
  assert.deepEqual(kinds, [IDENTITY.STAFF_ID_CONFLICT, IDENTITY.STAFF_ID_CONFLICT]);
});

test('a conflicting staff id is not trusted for matching even with a real email', () => {
  const rows = [
    { sheet: 'BACKEND', staff_id: 'IMFB/10/0015', full_name: 'DISU HANNAH HALIMAT', email: 'h.disu@infinitymfb.com', branch: 'KETU' },
    { sheet: 'BACKEND', staff_id: 'IMFB/10/0015', full_name: 'SOMEONE ELSE ENTIRELY', email: 'x@infinitymfb.com', branch: 'ALABA' },
  ];
  const ctx = { conflictingStaffIds: findStaffIdConflicts(rows) };
  const real = classifyPerson([rows[0]], eidx, ctx);
  assert.equal(real.kind, IDENTITY.STAFF_ID_CONFLICT, 'must not match x2 on a contested staff id');
  assert.equal(real.employee, null);
});

test('one person across two branches is ONE identity with TWO assignments', () => {
  const rows = [
    { sheet: 'BACKEND', staff_id: 'IMFB/11/0020', full_name: 'OLAYEMI ODUNOLA MULIKAT', email: 'o.olayemi@infinitymfb.com', branch: 'KETU' },
    { sheet: 'BACKEND', staff_id: 'IMFB/11/0020', full_name: 'OLAYEMI ODUNOLA MULIKAT', email: 'o.olayemi@infinitymfb.com', branch: 'HEAD OFFICE' },
  ];
  const groups = groupWorkbookRows(rows);
  assert.equal(groups.length, 1, 'must not duplicate the employee');
  const res = classifyPerson(groups[0], eidx);
  assert.equal(res.kind, IDENTITY.MATCH_EXISTING);
  assert.equal(res.branches.length, 2);
  assert.deepEqual(res.branches.map(b => b.branch).sort(), ['HEAD OFFICE', 'KETU']);
});

test('duplicate existing employee names force review', () => {
  const dupIdx = buildExistingIndex([
    { id: 'z1', full_name: 'BISI AJAYI', employee_code: 'IMFB/20/0001' },
    { id: 'z2', full_name: 'BISI AJAYI', employee_code: 'IMFB/20/0002' },
  ]);
  const res = classifyPerson([{ sheet: 'FRONT END', staff_id: 'IMFB/77/0001', full_name: 'BISI AJAYI', email: 'b@infinitymfb.com', branch: 'KETU' }], dupIdx);
  assert.equal(res.kind, IDENTITY.DUPLICATE_NAME);
  assert.equal(isSafeIdentity(res.kind), false);
// ----------------------------------------------------- reviewed workbook ---
const WB = process.env.HR_MASTER_XLSX || '/Users/clintoniwolomaimaginr/Downloads/IT AUTOMATION LIST REVIEWED-2.xlsx';

test('reviewed workbook: 215 rows / 213 staff ids and the two known conflicts', { skip: fs.existsSync(WB) ? false : 'workbook not present' }, async () => {
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.readFile(WB);
  const H = ['sn','staff_id','full_name','confirmed','designation','department','branch','gender','email','sup1','sup2','sup3'];
  const rows = [];
  for (const sheet of wb.SheetNames) {
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' }).slice(1)) {
      const o = { sheet };
      H.forEach((h, i) => { o[h] = String(r[i] == null ? '' : r[i]).trim(); });
      if (o.staff_id || o.full_name) rows.push(o);
    }
  }
  assert.equal(wb.SheetNames.length, 2, 'both sheets are imported');
  assert.equal(rows.length, 215);
  const ids = new Set(rows.map(r => r.staff_id));
  assert.equal(ids.size, 213, 'exactly two staff ids repeat');

  const groups = groupWorkbookRows(rows);
  assert.equal(groups.length, 215, 'no person legitimately spans two rows in this file');
  const ctx = { conflictingStaffIds: findStaffIdConflicts(rows) };
  assert.equal(ctx.conflictingStaffIds.size, 2, 'IMFB/20/0147 and IMFB/23/0305 are reused');
  const conflicts = groups.filter(g => classifyPerson(g, eidx, ctx).kind === IDENTITY.STAFF_ID_CONFLICT);
  assert.equal(conflicts.length, 4, 'the two repeated ids produce four conflicted rows');

  const wbidx = buildRosterIndex(rows.map(r => ({ id: r.staff_id, full_name: r.full_name })));
  let auto = 0, review = 0;
  for (const g of groups) {
    const c = classifyPerson(g, eidx, ctx);
    assert.equal(isSafeIdentity(c.kind) || c.kind === IDENTITY.STAFF_ID_CONFLICT, true);
    const chain = resolveSupervisorChain(g[0], wbidx);
    for (const lv of [1, 2, 3]) {
      if (isAutoResolvable(chain[lv])) auto++;
      else if (!isBlankLabel(chain[lv].label)) review++;
    }
  }
  assert.ok(auto > 300, `expected most supervisor slots to auto-resolve, got ${auto}`);
  assert.ok(review > 0, 'some supervisor slots must require review');
  console.log(`      [workbook] supervisor slots auto=${auto} review=${review}`);
});
});

test('a row with no identity at all is flagged, not guessed', () => {
  const res = classifyPerson([{ sheet: 'BACKEND', staff_id: '', full_name: '', email: '', branch: 'KETU' }], eidx);
  assert.equal(res.kind, IDENTITY.UNIDENTIFIABLE);
});

test('branchAssignmentsOf keeps sheet provenance and order', () => {
  const a = branchAssignmentsOf([
    { sheet: 'BACKEND', branch: 'KETU' },
    { sheet: 'BACKEND', branch: 'KETU' },
    { sheet: 'FRONT END', branch: 'ALABA' },
  ]);
  assert.deepEqual(a.map(x => x.branch), ['KETU', 'ALABA']);
  assert.deepEqual(a[0].sheets, ['BACKEND']);
});
  const dup = buildRosterIndex([
    { id: 'd1', full_name: 'BISI AJAYI' },
    { id: 'd2', full_name: 'Bisi Ajayi' },
  ]);
  const r = resolveSupervisorLabel('BISI AJAYI', dup);
  assert.equal(r.tier, MATCH_TIER.AMBIGUOUS);
  assert.equal(r.resolved, null);
  assert.equal(r.candidates.length, 2);
});

test('ambiguous prefix falls to review rather than picking one', () => {
  const dup = buildRosterIndex([
    { id: 'p1', full_name: 'OKAFOR CHINEDU JR' },
    { id: 'p2', full_name: 'OKAFOR CHINEDU SR' },
  ]);
  const r = resolveSupervisorLabel('OKAFOR CHINEDU', dup);
  assert.equal(r.tier, MATCH_TIER.AMBIGUOUS, 'two employees share that prefix');
  assert.equal(r.resolved, null);
  assert.equal(r.candidates.length, 2);
});

test('a label that is itself an exact name resolves to that one person', () => {
  const two = buildRosterIndex([
    { id: 'q1', full_name: 'OKAFOR CHINEDU' },
    { id: 'q2', full_name: 'OKAFOR CHINEDU JR' },
  ]);
  const r = resolveSupervisorLabel('OKAFOR CHINEDU', two);
  assert.equal(r.tier, MATCH_TIER.EXACT);
  assert.equal(r.resolved.id, 'q1');
});

test('unknown person is unresolved; org body is its own tier', () => {
  assert.equal(resolveSupervisorLabel('EUNICE MANKANJUOLA', idx).tier, MATCH_TIER.UNRESOLVED);
  assert.equal(resolveSupervisorLabel('BOD', idx).tier, MATCH_TIER.ORG_BODY);
  assert.equal(resolveSupervisorLabel('', idx).tier, MATCH_TIER.UNRESOLVED);
});

test('AUTO_TIERS excludes every guessy tier', () => {
  for (const t of [MATCH_TIER.TOKEN_SUBSET, MATCH_TIER.TOKEN_AFFIX, MATCH_TIER.TYPO_VARIANT, MATCH_TIER.AMBIGUOUS, MATCH_TIER.UNRESOLVED, MATCH_TIER.ORG_BODY]) {
    assert.equal(AUTO_TIERS.has(t), false, `${t} must require review`);
  }
});

test('resolveSupervisorChain returns three independent levels', () => {
  const chain = resolveSupervisorChain({ sup1: 'UKUAGHE JUDE', sup2: 'BOD', sup3: 'ADEWUNMI GABRIEL OLUDOTUN' }, idx);
  assert.equal(chain[1].resolved.id, 'e1');
  assert.equal(chain[2].tier, MATCH_TIER.ORG_BODY);
  assert.equal(chain[3].resolved.id, 'e2');
});