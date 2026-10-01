/**
 * Employee identity reconciliation for the authoritative HR employee master.
 *
 * This module NEVER decides an identity on its own authority. It produces a
 * classification per workbook row plus the evidence behind it, and the
 * migration applies only the classifications that are safe:
 *
 *   - a workbook row is matched to an existing employee by UNIQUE staff id,
 *     then by UNIQUE email, then by UNIQUE normalised name;
 *   - a staff id that appears on MORE THAN ONE workbook row is an identity
 *     conflict and is never auto-merged, even when the names look unrelated,
 *     because the safe reading is "two people share a mistyped id";
 *   - anything else needs a human decision and is queued.
 *
 * Crucially, this module never proposes deleting or recreating an employee.
 * Every outcome is either "update this existing record" or "create a new
 * employee master row" — auth users and profiles are never touched.
 */

import { normalizeName } from './normalize.js';

export const IDENTITY = {
  /** One existing employee matched on a unique, reliable key. */
  MATCH_EXISTING: 'match_existing',
  /** Workbook-only person: needs a new employee master row (never an auth user). */
  NEW_EMPLOYEE: 'new_employee',
  /** Two or more workbook rows share a staff id -> must not be merged. */
  STAFF_ID_CONFLICT: 'staff_id_conflict',
  /** Two or more existing employees share the normalised name -> needs review. */
  DUPLICATE_NAME: 'duplicate_name',
  /** The row carries no usable identity at all. */
  UNIDENTIFIABLE: 'unidentifiable',
};

/** Outcomes that may be applied without a human decision. */
export const SAFE_IDENTITY = new Set([IDENTITY.MATCH_EXISTING, IDENTITY.NEW_EMPLOYEE]);

export function isSafeIdentity(kind) {
  return SAFE_IDENTITY.has(kind);
}

/**
 * Index the existing database employees for reconciliation.
 * @param {Array<{id:string, full_name:string, employee_code?:string, email?:string}>} existing
 */
export function buildExistingIndex(existing) {
  const byStaff = new Map();
  const byEmail = new Map();
  const byName = new Map();
  for (const e of existing) {
    const staff = String(e.employee_code == null ? '' : e.employee_code).trim().toUpperCase();
    if (staff) {
      if (!byStaff.has(staff)) byStaff.set(staff, []);
      byStaff.get(staff).push(e);
    }
    const mail = String(e.email == null ? '' : e.email).trim().toLowerCase();
    if (mail && mail !== 'n/a') {
      if (!byEmail.has(mail)) byEmail.set(mail, []);
      byEmail.get(mail).push(e);
    }
    const nm = normalizeName(e.full_name);
    if (nm) {
      if (!byName.has(nm)) byName.set(nm, []);
      byName.get(nm).push(e);
    }
  }
  return { byStaff, byEmail, byName, list: existing };
}

/**
 * Group workbook rows by person.
 *
 * A person who legitimately covers two locations appears as two rows with the
 * same staff id (or the same name) and different branches. That is ONE employee
 * with TWO branch assignments — never two employees. Rows sharing a staff id OR
 * a normalised name are folded into a single person record here, and the
 * branch labels are collected as assignments.
 */
export function groupWorkbookRows(rows) {
  // Union-find over ROW INDICES. Storing the row objects themselves here made
  // find() return undefined and silently left every row in its own group, so
  // one person covering two branches became two employees.
  const byStaff = new Map();
  const byName = new Map();
  // A staff id carrying more than one name is a conflict, so it must NOT be
  // used to merge rows — otherwise two different people who share a mistyped
  // id are fused into one "person" and one of them is written away.
  const staffNames = new Map();
  rows.forEach((r) => {
    const staff = String(r.staff_id || '').trim().toUpperCase();
    const nm = normalizeName(r.full_name);
    if (!staff || !nm) return;
    if (!staffNames.has(staff)) staffNames.set(staff, new Set());
    staffNames.get(staff).add(nm);
  });
  const contestedStaff = new Set([...staffNames].filter(([, s]) => s.size > 1).map(([k]) => k));

  rows.forEach((r, i) => {
    const staff = String(r.staff_id || '').trim().toUpperCase();
    const nm = normalizeName(r.full_name);
    if (staff && !contestedStaff.has(staff)) {
      if (!byStaff.has(staff)) byStaff.set(staff, []);
      byStaff.get(staff).push(i);
    }
    if (nm) {
      if (!byName.has(nm)) byName.set(nm, []);
      byName.get(nm).push(i);
    }
  });

  const parent = rows.map((_, i) => i);
  const find = x => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const link = map => {
    for (const list of map.values()) {
      if (list.length < 2) continue;
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
    }
  };
  link(byStaff);
  link(byName);

  const groups = new Map();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  return [...groups.values()];
}

/** Collect the distinct branch labels of a person, in workbook order. */
export function branchAssignmentsOf(personRows) {
  const seen = new Map();
  for (const r of personRows) {
    const b = String(r.branch || '').trim();
    if (!b) continue;
    if (!seen.has(b)) seen.set(b, []);
    seen.get(b).push(r.sheet);
  }
  return [...seen.entries()].map(([branch, sheets]) => ({ branch, sheets: [...new Set(sheets)] }));
}

/**
 * Staff ids used by MORE THAN ONE distinct person in the workbook.
 *
 * This is deliberately computed across the WHOLE workbook rather than inside a
 * grouped person, because grouping splits those rows apart by name — which
 * would otherwise hide the conflict and let each row fall through to
 * "new employee" on a staff id that is known to be unreliable.
 *
 * @returns {Map<string, string[]>} staff id (upper case) -> the names using it
 */
export function findStaffIdConflicts(rows) {
  const byStaff = new Map();
  for (const r of rows) {
    const staff = String(r.staff_id || '').trim().toUpperCase();
    const nm = normalizeName(r.full_name);
    if (!staff || !nm) continue;
    if (!byStaff.has(staff)) byStaff.set(staff, new Set());
    byStaff.get(staff).add(nm);
  }
  const out = new Map();
  for (const [staff, names] of byStaff) if (names.size > 1) out.set(staff, [...names].sort());
  return out;
}

/**
 * Classify one grouped person against the existing database.
 *
 * @param {Array<object>} personRows workbook rows belonging to one person
 * @param {object} index result of buildExistingIndex
 * @returns {{kind:string, employee:object|null, matchKey:string|null, reason:string, rows:Array, staffIds:Array, emails:Array, branches:Array, sheets:Array}}
 */
export function classifyPerson(personRows, index, ctx = {}) {
  const staffIds = [...new Set(personRows.map(r => String(r.staff_id || '').trim().toUpperCase()).filter(Boolean))];
  const emails = [...new Set(personRows.map(r => String(r.email || '').trim().toLowerCase()).filter(e => e && e !== 'n/a'))];
  const branches = branchAssignmentsOf(personRows);
  const sheets = [...new Set(personRows.map(r => r.sheet))];
  const base = { rows: personRows, staffIds, emails, branches, sheets, employee: null, matchKey: null };

  const lead = personRows[0] || {};
  const nm = normalizeName(lead.full_name);

  if (!staffIds.length && !nm) {
    return { ...base, kind: IDENTITY.UNIDENTIFIABLE, reason: 'Row carries neither a staff id nor a full name.' };
  }

  // A staff id reused by DIFFERENT people is untrustworthy as a match key.
  // Checked before anything else so a conflicting row can never silently
  // overwrite an existing employee, and can never be merged with the other
  // person sharing the id.
  const conflicted = staffIds.filter(s => ctx.conflictingStaffIds && ctx.conflictingStaffIds.has(s));
  if (conflicted.length) {
    const details = conflicted.map(s => `${s}: ${(ctx.conflictingStaffIds.get(s) || []).join(' / ')}`).join('; ');
    return {
      ...base, kind: IDENTITY.STAFF_ID_CONFLICT,
      reason: `Staff id is used by more than one person in the workbook (${details}). Treated as separate people; the id is not trusted for matching.`,
    };
  }

  // Multiple names inside one group means the grouping merged rows it should
  // not have — keep them apart rather than write one person's data onto another.
  const distinctNames = [...new Set(personRows.map(r => normalizeName(r.full_name)).filter(Boolean))];
  if (distinctNames.length > 1) {
    return {
      ...base, kind: IDENTITY.STAFF_ID_CONFLICT,
      reason: `Grouped rows carry ${distinctNames.length} different names (${distinctNames.join(' / ')}); they are not merged.`,
    };
  }

  // --- match against the existing database, strongest key first -------------
  for (const staff of staffIds) {
    const hit = index.byStaff.get(staff);
    if (hit && hit.length === 1) return { ...base, kind: IDENTITY.MATCH_EXISTING, employee: hit[0], matchKey: 'staff_id', reason: `Unique staff id ${staff}.` };
    if (hit && hit.length > 1) {
      return { ...base, kind: IDENTITY.DUPLICATE_NAME, reason: `Staff id ${staff} matches ${hit.length} existing employees.` };
    }
  }
  for (const mail of emails) {
    const hit = index.byEmail.get(mail);
    if (hit && hit.length === 1) return { ...base, kind: IDENTITY.MATCH_EXISTING, employee: hit[0], matchKey: 'email', reason: `Unique email ${mail}.` };
    if (hit && hit.length > 1) {
      return { ...base, kind: IDENTITY.DUPLICATE_NAME, reason: `Email ${mail} matches ${hit.length} existing employees.` };
    }
  }
  if (nm) {
    const hit = index.byName.get(nm);
    if (hit && hit.length === 1) {
      return {
        ...base, kind: IDENTITY.MATCH_EXISTING, employee: hit[0], matchKey: 'name',
        reason: 'Matched on normalised full name. Verified by HR before any attribute is overwritten.',
      };
    }
    if (hit && hit.length > 1) {
      return { ...base, kind: IDENTITY.DUPLICATE_NAME, reason: `${hit.length} existing employees share the name "${nm}".` };
    }
  }
  return {
    ...base, kind: IDENTITY.NEW_EMPLOYEE, matchKey: null,
    reason: 'No existing employee matched on staff id, email or name.',
  };
}
