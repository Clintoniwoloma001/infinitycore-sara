/**
 * Client for the authoritative HR employee master reconciliation.
 *
 * The heavy lifting (identity matching, supervisor resolution, conflict
 * detection) lives in src/domains/employeeMaster and is PURE, so the same rules
 * run in the browser, in node tests and — via hr_normalize_name /
 * hr_normalize_branch — in Postgres. This module only orchestrates: parse the
 * workbook, reconcile against the live roster, stage, then apply.
 *
 * Nothing here deletes or recreates an employee. The server decides what is
 * safe to apply; the client only reports what needs a human.
 */
import * as XLSX from 'xlsx';
import supabase from './supabaseService';
import {
  buildExistingIndex, groupWorkbookRows, classifyPerson,
  findStaffIdConflicts, isSafeIdentity,
} from '../domains/employeeMaster/identity';
import {
  buildRosterIndex, resolveSupervisorChain, isAutoResolvable, isBlankLabel,
} from '../domains/employeeMaster/supervisors';
import { normalizeBranch, splitCombinedBranch } from '../domains/employeeMaster/normalize';

const COLUMNS = ['sn','staff_id','full_name','confirmed','designation','department','branch','gender','email','sup1','sup2','sup3'];

/** FNV-1a — stable content hash so re-uploading the same file is a no-op. */
export function hashWorkbook(bytes) {
  let h = 0x811c9dc5;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a-${(h >>> 0).toString(16)}-${view.length}`;
}

/** Read both sheets, DETECTING the header row rather than assuming it. */
export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer);
  const rows = [];
  const sheets = [];
  for (const sheet of wb.SheetNames) {
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: '' });
    if (!raw.length) continue;
    const headerIdx = raw.findIndex(r => {
      const cells = r.map(c => String(c == null ? '' : c).trim().toLowerCase());
      return cells.includes('staff id no.') && cells.some(c => c.includes('full name'));
    });
    if (headerIdx < 0) { sheets.push({ name: sheet, skipped: 'no recognisable header row' }); continue; }
    sheets.push({ name: sheet, headerRow: headerIdx + 1 });
    for (const r of raw.slice(headerIdx + 1)) {
      const o = { sheet };
      COLUMNS.forEach((c, i) => { o[c] = String(r[i] == null ? '' : r[i]).trim(); });
      if (!o.staff_id && !o.full_name) continue;
      rows.push(o);
    }
  }
  return { rows, sheets };
}

async function loadRoster() {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, employee_code, email, department, position');
  if (error) throw new Error(`Could not load the employee roster: ${error.message}`);
  return data || [];
}

/**
 * Reconcile the workbook against the live roster. Returns a PREVIEW only —
 * nothing is written until applyMasterImport() is called.
 */
export async function previewMasterImport(file, asAtDate) {
  const bytes = await file.arrayBuffer();
  const hash = hashWorkbook(bytes);
  const { rows, sheets } = readWorkbook(bytes);
  if (!rows.length) throw new Error('No employee rows were found in that workbook.');

  const existing = await loadRoster();
  const existingIdx = buildExistingIndex(existing);
  const conflicts = findStaffIdConflicts(rows);
  const ctx = { conflictingStaffIds: conflicts };
  const rosterIdx = buildRosterIndex(rows.map(r => ({ id: r.staff_id, full_name: r.full_name })));

  const groups = groupWorkbookRows(rows);
  const people = [];
  const branchRows = [];
  const supLinks = [];
  const branchLabels = new Map();

  groups.forEach((group, i) => {
    const cls = classifyPerson(group, existingIdx, ctx);
    const lead = group[0] || {};
    const ref = `p${i}`;
    people.push({
      ref,
      staff_id: lead.staff_id || '',
      full_name: lead.full_name || '',
      confirmed: lead.confirmed || '',
      designation: lead.designation || '',
      department: lead.department || '',
      email: cls.emails[0] || '',
      sheets: cls.sheets,
      identity_kind: cls.kind,
      match_key: cls.matchKey,
      employee_id: cls.employee ? cls.employee.id : null,
      reason: cls.reason,
      needs_review: !isSafeIdentity(cls.kind),
    });

    // Workbook order preserved: the first label is the primary assignment.
    cls.branches.forEach((b, ordinal) => {
      branchRows.push({ person_ref: ref, branch_label: b.branch, source_sheet: b.sheets[0] || '', ordinal });
      const norm = normalizeBranch(b.branch);
      if (!branchLabels.has(norm)) {
        const parts = splitCombinedBranch(b.branch);
        branchLabels.set(norm, { branch_label: b.branch, is_combined: parts.length > 1, parts });
      }
    });

    const chain = resolveSupervisorChain(lead, rosterIdx);
    [1, 2, 3].forEach(lv => {
      const res = chain[lv];
      if (isBlankLabel(res.label)) return;
      if (res.tier === 'organisation_body') {
        supLinks.push({ person_ref: ref, level: lv, label: res.label, tier: res.tier,
          supervisor_employee_id: null, candidates: [], status: 'organisation_body' });
        return;
      }
      const auto = isAutoResolvable(res);
      supLinks.push({
        person_ref: ref, level: lv, label: res.label, tier: res.tier,
        supervisor_staff_id: auto ? res.resolved.id : null,
        candidates: (res.candidates || []).slice(0, 5).map(c => ({ staff_id: c.id, full_name: c.full_name })),
        status: auto ? 'applied' : 'pending',
      });
    });
  });

  const perPerson = new Map();
  branchRows.forEach(b => perPerson.set(b.person_ref, (perPerson.get(b.person_ref) || 0) + 1));

  return {
    file, fileName: file.name, hash, sheets, people, branchRows, supLinks,
    branchLabels: [...branchLabels.values()],
    conflicts,
    asAtDate,
    counts: {
      rows: rows.length,
      people: people.length,
      matched: people.filter(p => p.identity_kind === 'match_existing').length,
      new_employees: people.filter(p => p.identity_kind === 'new_employee').length,
      conflicts: people.filter(p => p.identity_kind === 'staff_id_conflict').length,
      duplicate_names: people.filter(p => p.identity_kind === 'duplicate_name').length,
      supervisors_applied: supLinks.filter(s => s.status === 'applied').length,
      supervisors_pending: supLinks.filter(s => s.status === 'pending').length,
      org_bodies: supLinks.filter(s => s.status === 'organisation_body').length,
      branch_assignments: branchRows.length,
      multi_branch_people: [...perPerson.values()].filter(n => n > 1).length,
      existing_roster: existing.length,
    },
  };
}

const CHUNK = 200;

/** Map in-browser refs to the database ids assigned during staging. */
function hydrate(withIds, supLinks, branchRows) {
  const byRef = new Map(withIds.map(p => [p.ref, p.id]));
  const byStaff = new Map(withIds.filter(p => p.id).map(p => [p.staff_id, p.employee_id]));
  return {
    branches: branchRows
      .map(b => ({ ...b, person_id: byRef.get(b.person_ref) }))
      .filter(b => b.person_id),
    supervisors: supLinks
      .map(s => ({
        ...s,
        person_id: byRef.get(s.person_ref),
        // the workbook roster is keyed by staff id, not employee id
        supervisor_employee_id: s.supervisor_staff_id ? (byStaff.get(s.supervisor_staff_id) || null) : null,
      }))
      .filter(s => s.person_id),
  };
}

/**
 * Stage then apply. Safe to re-run: the server keys everything on the file hash
 * and upserts, so a retry never creates a second set of employees.
 */
export async function applyMasterImport(preview) {
  const { data: sessionId, error: sErr } = await supabase.rpc('hr_master_stage_session', {
    p_filename: preview.fileName,
    p_file_hash: preview.hash,
    p_as_at: preview.asAtDate || null,
    p_totals: preview.counts,
    p_mapping_version: 'v1',
  });
  if (sErr) throw new Error(`Could not create the import session: ${sErr.message}`);

  for (let i = 0; i < preview.people.length; i += CHUNK) {
    const { error } = await supabase.rpc('hr_master_stage_people', {
      p_session: sessionId,
      p_people: preview.people.slice(i, i + CHUNK).map(p => ({
        staff_id: p.staff_id, full_name: p.full_name, confirmed: p.confirmed,
        designation: p.designation, department: p.department, email: p.email,
        sheets: p.sheets, identity_kind: p.identity_kind, match_key: p.match_key,
        employee_id: p.employee_id, reason: p.reason, needs_review: p.needs_review,
      })),
    });
    if (error) throw new Error(`Could not stage employees: ${error.message}`);
  }

  // First pass creates any missing employee master rows so the branch and
  // supervisor links can be resolved against real ids.
  const { data: firstPass, error: aErr } = await supabase.rpc('hr_master_apply_session', { p_session: sessionId });
  if (aErr) throw new Error(`Could not apply the import: ${aErr.message}`);

  const { data: peopleRows } = await supabase
    .from('hr_master_people').select('id, staff_id').eq('session_id', sessionId);
  const idByStaff = new Map((peopleRows || []).map(r => [r.staff_id, r.id]));
  const withIds = preview.people.map(p => ({
    ...p, id: idByStaff.get(p.staff_id) || null,
  }));
  const hydrated = hydrate(withIds, preview.supLinks, preview.branchRows);

  for (let i = 0; i < hydrated.branches.length; i += CHUNK) {
    const { error } = await supabase.rpc('hr_master_stage_person_branches', {
      p_session: sessionId, p_rows: hydrated.branches.slice(i, i + CHUNK) });
    if (error) throw new Error(`Could not stage branch assignments: ${error.message}`);
  }
  for (let i = 0; i < hydrated.supervisors.length; i += CHUNK) {
    const { error } = await supabase.rpc('hr_master_stage_supervisor_links', {
      p_session: sessionId, p_links: hydrated.supervisors.slice(i, i + CHUNK) });
    if (error) throw new Error(`Could not stage supervisors: ${error.message}`);
  }
  if (preview.branchLabels.length) {
    const { error } = await supabase.rpc('hr_master_stage_branch_links', {
      p_session: sessionId, p_links: preview.branchLabels });
    if (error) throw new Error(`Could not stage branches: ${error.message}`);
  }

  const { data: result, error: fErr } = await supabase.rpc('hr_master_apply_session', { p_session: sessionId });
  if (fErr) throw new Error(`Could not apply the import: ${fErr.message}`);

  return { sessionId, firstPass, result, counts: preview.counts };
}

/** Everything still awaiting a human decision for a session. */
export async function getReviewQueue(sessionId) {
  const [people, links, branches] = await Promise.all([
    supabase.from('hr_master_people').select('*').eq('session_id', sessionId).eq('needs_review', true),
    supabase.from('hr_master_supervisor_links').select('*').eq('session_id', sessionId).eq('status', 'pending'),
    supabase.from('hr_master_branch_links').select('*').eq('session_id', sessionId).eq('status', 'pending'),
  ]);
  return {
    people: people.data || [],
    supervisors: links.data || [],
    branches: branches.data || [],
    errors: [people.error, links.error, branches.error].filter(Boolean).map(e => e.message),
  };
}
