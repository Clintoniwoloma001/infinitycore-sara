/**
 * Supervisor-label resolution for the authoritative HR employee master.
 *
 * The workbook's supervisor columns are free text, and 47 of the 53 distinct
 * labels in the reviewed file are NOT an exact employee FULL NAME. They are a
 * mix of:
 *   - truncated names            "UKUAGHE JUDE"        -> UKUAGHE JUDE OAMEN
 *   - reordered names            "JUDE UKUAGHE"        -> UKUAGHE JUDE OAMEN
 *   - misspelled / partial words "UMUKORO KELECH"      -> UMUKORO KELECHI JULIE
 *   - people who are NOT employees of this workbook
 *   - organisational bodies      "BOD", "MCC", "HRM"
 *
 * Rule: only DETERMINISTIC, unique-candidate matches may be auto-linked.
 * Anything ambiguous, merely similar, or not-a-person goes to the review queue.
 * A supervisory relationship is a real approval authority, so silently linking
 * the wrong person is worse than leaving it unresolved.
 */

import { normalizeName, tokenSortKey, tokenPrefixKeys, editDistance } from './normalize.js';

/** Match tiers, ordered from most to least trustworthy. */
export const MATCH_TIER = {
  EXACT: 'exact',
  PREFIX_TRUNCATED: 'prefix_truncated',
  TOKEN_PERMUTATION: 'token_permutation',
  TOKEN_PREFIX_SET: 'token_prefix_set',
  TOKEN_AFFIX: 'token_affix',
  TOKEN_MAJORITY: 'token_majority',
  TOKEN_SUBSET: 'token_subset',
  TYPO_VARIANT: 'typo_variant',
  AMBIGUOUS: 'ambiguous',
  ORG_BODY: 'organisation_body',
  UNRESOLVED: 'unresolved',
};

/**
 * Tiers that may be applied without a human decision.
 *
 * TOKEN_PREFIX_SET is included because it is deterministic: every token of the
 * label must be a leading substring of a *distinct* token of exactly one
 * employee ("AJISEGBEDE GBEMI" -> AJISEGBEDE GBEMILEKE ABIGAIL). Requiring the
 * candidate to be unique is what makes it safe — two people whose names share
 * the same prefixes fall through to the review queue instead.
 *
 * TOKEN_SUBSET, TOKEN_AFFIX and TYPO_VARIANT are deliberately excluded: they
 * can match a different person who merely shares part of a name, and a
 * supervisory relationship is a real approval authority.
 */
export const AUTO_TIERS = new Set([
  MATCH_TIER.EXACT,
  MATCH_TIER.PREFIX_TRUNCATED,
  MATCH_TIER.TOKEN_PERMUTATION,
  MATCH_TIER.TOKEN_PREFIX_SET,
]);

/**
 * Organisational bodies and offices that appear in the supervisor columns.
 * These are NOT people and must never be turned into employee accounts.
 * Kept as data so authorised HR can extend it without a code change.
 */
export const DEFAULT_ORG_BODIES = [
  'BOD', 'BOARD', 'BOARD OF DIRECTORS', 'MD', 'MD/CEO', 'CEO',
  'MCC', 'MANAGEMENT CONTROL COMMITTEE', 'CREDIT COMMITTEE',
  'HRM', 'HUMAN RESOURCES MANAGEMENT', 'GMD/MD.HRM', 'GMD', 'MD.HRM',
  'AUDIT COMMITTEE', 'RISK COMMITTEE', 'BOARD OF AUDIT',
];

/** A label that is a placeholder rather than a real value. */
export function isBlankLabel(value) {
  const v = String(value == null ? '' : value).trim().toUpperCase();
  if (!v) return true;
  return v === 'N/A' || v === 'NA' || v === '-' || v === 'NONE' || v === 'NULL';
}

export function isOrgBody(value, extraBodies = []) {
  const n = normalizeName(value);
  if (!n) return false;
  const bodies = new Set([...DEFAULT_ORG_BODIES, ...extraBodies].map(normalizeName));
  if (bodies.has(n)) return true;
  // "GMD/MD.HRM" normalises to "GMD MD HRM"; accept a compound label that
  // contains every token of a known multi-word body.
  const tokens = new Set(n.split(' '));
  for (const body of bodies) {
    const bt = body.split(' ').filter(Boolean);
    if (bt.length > 1 && bt.every(t => tokens.has(t))) return true;
  }
  return false;
}

/**
 * Resolve one supervisor label against the roster.
 * @returns {{tier:string, resolved:object|null, candidates:Array, label:string}}
 */
/**
 * Token-majority candidates: at least MIN_MATCH of the label's tokens match a
 * token of the same employee (prefix or substring).
 *
 * This is what catches the real-world workbook defects:
 *   "UGUTE FEJIRO"        -> UGUTE EVELYN OGHENEFEJIRO   (FEJIRO inside OGHENEFEJIRO)
 *   "OBILOR IFEANYIN"     -> OBILOR IFEANYI SAMSON        (typo)
 *   "OZIOKO COSMOS"       -> OZIOKO COSMAS IKECHUKWU     (typo)
 *
 * Deliberately NOT auto-applied: every one of those is a fuzzy match, and a
 * supervisory relationship is an approval authority. The single best candidate
 * is surfaced for HR to confirm with one click, which also stores a permanent
 * mapping so it never has to be judged again.
 */
/**
 * One token matches another when it is equal, a prefix/substring of it, or
 * within a SINGLE character edit. The last case is what catches the workbook's
 * single-character typos: IFEANYI -> IFEANYIN, COSMAS -> COSMOS.
 */
function tokenMatches(labelToken, employeeToken) {
  if (employeeToken === labelToken) return true;
  if (employeeToken.startsWith(labelToken) || employeeToken.includes(labelToken)) return true;
  return editDistance(labelToken, employeeToken, 1) <= 1;
}

function tokenMajorityCandidates(index, labelNorm, minMatch = 2) {
  const tokens = labelNorm.split(' ').filter(Boolean);
  if (tokens.length < minMatch) return [];
  return index.list.map(e => {
    const matched = tokens.filter(t => e._tokens.some(x => tokenMatches(t, x))).length;
    return { emp: strip(e), matched };
  }).filter(r => r.matched >= minMatch)
    .sort((a, b) => b.matched - a.matched || a.emp._norm - b.emp._norm);
}

/** A label is a duplicated / misspelled form of a name the roster contains. */
export function resolveSupervisorLabel(label, index, opts = {}) {
  const raw = String(label == null ? '' : label).trim();
  const out = { label: raw, tier: MATCH_TIER.UNRESOLVED, resolved: null, candidates: [] };
  if (isBlankLabel(raw)) return out;
  if (isOrgBody(raw, opts.orgBodies)) {
    out.tier = MATCH_TIER.ORG_BODY;
    return out;
  }
  const n = normalizeName(raw);

  const exact = index.byExact.get(n);
  if (exact && exact.length === 1) {
    out.tier = MATCH_TIER.EXACT; out.resolved = exact[0]; return out;
  }
  if (exact && exact.length > 1) {
    // Two employees share this normalised name -> never silently pick one.
    out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = exact.slice(); return out;
  }

  const sk = tokenSortKey(raw);
  const perm = index.bySortKey.get(sk);
  if (perm && perm.length === 1 && sk !== n) {
    out.tier = MATCH_TIER.TOKEN_PERMUTATION; out.resolved = perm[0]; return out;
  }
  if (perm && perm.length > 1) {
    out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = perm.slice(); return out;
  }

  const pref = index.byPrefix.get(n);
  if (pref && pref.length === 1) {
    out.tier = MATCH_TIER.PREFIX_TRUNCATED; out.resolved = pref[0]; return out;
  }
  if (pref && pref.length > 1) {
    out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = pref.slice(); return out;
  }

  const sub = subsetCandidates(index, n);
  if (sub.length === 1) { out.tier = MATCH_TIER.TOKEN_SUBSET; out.candidates = sub; return out; }
  if (sub.length > 1) { out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = sub; return out; }

  // Mid-token truncation, e.g. "AJISEGBEDE GBEMI" -> AJISEGBEDE GBEMILEKE.
  const pre = affixCandidates(index, n, { strictPrefix: true, minTokenLen: 4 });
  if (pre.length === 1) { out.tier = MATCH_TIER.TOKEN_PREFIX_SET; out.resolved = pre[0]; return out; }
  if (pre.length > 1) { out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = pre; return out; }

  // Token present anywhere, e.g. "UGUTE FEJIRO" -> UGUTE EVELYN OGHENEFEJIRO.
  const aff = affixCandidates(index, n, { strictPrefix: false, minTokenLen: 5 });
  if (aff.length === 1) { out.tier = MATCH_TIER.TOKEN_AFFIX; out.candidates = aff; return out; }
  if (aff.length > 1) { out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = aff; return out; }

  const typo = typoCandidates(index, n);
  if (typo.length === 1) { out.tier = MATCH_TIER.TYPO_VARIANT; out.candidates = typo; return out; }
  if (typo.length > 1) { out.tier = MATCH_TIER.AMBIGUOUS; out.candidates = typo; return out; }

  // Last resort before giving up: a candidate matching most of the label's
  // tokens. Only a clear single winner is offered, and only for review.
  const maj = tokenMajorityCandidates(index, n, Math.min(2, n.split(' ').filter(Boolean).length));
  if (maj.length) {
    const top = maj[0];
    const tied = maj.filter(m => m.matched === top.matched).length === 1;
    out.tier = tied ? MATCH_TIER.TOKEN_MAJORITY : MATCH_TIER.AMBIGUOUS;
    out.candidates = maj.slice(0, 5).map(m => m.emp);
    out.score = `${top.matched}/${n.split(' ').filter(Boolean).length}`;
    if (tied) out.suggestion = top.emp;
    return out;
  }

  return out;
}

/**
 * Resolve every supervisor slot of one employee.
 * @param {{sup1?:string,sup2?:string,sup3?:string}} employee
 * @returns {{1:object,2:object,3:object}} per-level resolution results
 */
export function resolveSupervisorChain(employee, index, opts) {
  return {
    1: resolveSupervisorLabel(employee.sup1, index, opts),
    2: resolveSupervisorLabel(employee.sup2, index, opts),
    3: resolveSupervisorLabel(employee.sup3, index, opts),
  };
}

/** True when a resolution may be applied to the database without review. */
export function isAutoResolvable(res) {
  return Boolean(res && AUTO_TIERS.has(res.tier) && res.resolved);
}
function strip(entry) {
  const { _norm, _sortKey, _tokens, ...rest } = entry;
  return rest;
}

/**
 * Index a roster of employees for fast resolution.
 * @param {Array<{id:string, full_name:string, staff_id?:string, email?:string}>} employees
 */
export function buildRosterIndex(employees) {
  const byExact = new Map();
  const bySortKey = new Map();
  const list = [];
  for (const e of employees) {
    const n = normalizeName(e.full_name);
    if (!n) continue;
    const entry = { ...e, _norm: n, _sortKey: tokenSortKey(e.full_name), _tokens: n.split(' ') };
    list.push(entry);
    if (!byExact.has(n)) byExact.set(n, []);
    byExact.get(n).push(e);
    const sk = entry._sortKey;
    if (!bySortKey.has(sk)) bySortKey.set(sk, []);
    bySortKey.get(sk).push(e);
  }
  // Prefix map: every leading-token prefix of every employee name, so a
  // truncated workbook label ("UKUAGHE JUDE") finds its full name.
  const byPrefix = new Map();
  for (const entry of list) {
    for (const key of tokenPrefixKeys(entry._norm)) {
      if (!byPrefix.has(key)) byPrefix.set(key, []);
      byPrefix.get(key).push(strip(entry));
    }
  }
  return { byExact, bySortKey, byPrefix, list };
}

/** Every employee containing all of the label's tokens. */
function subsetCandidates(index, labelNorm) {
  const tokens = labelNorm.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  return index.list.filter(e => {
    const set = new Set(e._tokens);
    return tokens.every(t => set.has(t));
  }).map(strip);
}

/** Candidates within a small edit distance of the flattened label. */
function typoCandidates(index, labelNorm) {
  const flat = labelNorm.replace(/ /g, '');
  return index.list.filter(e => {
    const ef = e._norm.replace(/ /g, '');
    if (ef.length < 6) return false;
    const d = editDistance(flat, ef, 2);
    return d > 0 && d <= 2;
  }).map(strip);
}

/**
 * Every label token is a leading substring of a DISTINCT employee token.
 *
 * This is the mid-token truncation the workbook is full of: staff cut
 * "GBEMILEKE" to "GBEMI". Matching token-by-token (rather than on whole tokens)
 * is what catches it. Each label token must consume a different employee token,
 * so one person cannot satisfy the same token twice.
 *
 * @param {boolean} strictPrefix true => label token must PREFIX the employee
 *   token; false => the token may be contained anywhere (catches
 *   "UGUTE FEJIRO" inside "UGUTE EVELYN OGHENEFEJIRO").
 */
function affixCandidates(index, labelNorm, { strictPrefix, minTokenLen }) {
  const tokens = labelNorm.split(' ').filter(Boolean);
  if (!tokens.length || tokens.some(t => t.length < minTokenLen)) return [];
  return index.list.filter(e => {
    const used = new Set();
    for (const t of tokens) {
      let hit = -1;
      for (let i = 0; i < e._tokens.length; i++) {
        if (used.has(i)) continue;
        const et = e._tokens[i];
        if (strictPrefix ? et.startsWith(t) : et.includes(t)) { hit = i; break; }
      }
      if (hit < 0) return false;
      used.add(hit);
    }
    return true;
  }).map(strip);
}