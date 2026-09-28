// ============================================================================
// BankOne branch resolution (including MERGED-branch detection)
// ============================================================================
// The InfinityCore `branches` master is not clean: it contains case duplicates
// ("Head Office" / "HEAD OFFICE"), punctuation variants ("IBEJU LEKKI" /
// "IBEJU-LEKKI") and genuinely MERGED rows ("AGEGE & EGBEDA", "MUSHIN/YABA",
// "KETU & HEAD OFFICE"). This module classifies each BankOne branch against that
// master and, critically, DETECTS the merge case so a human is asked to split
// rather than the importer silently forcing several BankOne branches onto one
// InfinityCore branch (which would fabricate a branch-level number).
import { normalizeBranch } from './normalize.js'

export const BRANCH_MATCH = {
  SAVED: 'saved_mapping',
  EXACT: 'exact',
  NORMALIZED: 'normalized',
  CASE_VARIANT: 'case_variant',
  MERGED: 'merged',
  MISSING: 'missing',
}

/** Separators that indicate one InfinityCore row covers several real branches. */
const MERGE_SPLIT = /\s*[&/]\s*/i

/**
 * Build the branch index.
 * branches: [{ id, branch_name }]
 */
export function createBranchIndex(branches) {
  const list = branches || []
  const byName = new Map()
  const merged = new Map()
  for (const b of list) {
    const n = normalizeBranch(b.branch_name)
    if (!n) continue
    // Key by case-folded too, so "Head Office"/"HEAD OFFICE" collapse.
    const key = n
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(b)
    if (MERGE_SPLIT.test(b.branch_name || '')) {
      const parts = b.branch_name.split(MERGE_SPLIT).map((p) => normalizeBranch(p)).filter(Boolean)
      if (parts.length > 1) merged.set(key, { branch: b, parts })
    }
  }
  return { list, byName, merged }
}

/**
 * Resolve one BankOne branch name.
 * @returns { status, matchType, branchId, branch, confidence, reason,
 *            mergeCandidates }
 *   status is 'auto_resolved' | 'pending_review' | 'unresolved'
 */
export function resolveBranch(rawName, index, savedMappings = new Map()) {
  const normalized = normalizeBranch(rawName)
  const base = { sourceName: rawName, normalizedSourceName: normalized }

  if (!normalized) {
    return { ...base, status: 'unresolved', matchType: BRANCH_MATCH.MISSING, confidence: 0, reason: 'No branch name was present on the row.' }
  }

  // 1. A saved mapping wins outright, so later imports need no question.
  const saved = savedMappings.get(normalized)
  if (saved && saved.status === 'active' && saved.canonical_branch_id) {
    const b = index.list.find((x) => x.id === saved.canonical_branch_id)
    if (b) {
      return {
        ...base, status: 'auto_resolved', matchType: BRANCH_MATCH.SAVED,
        branchId: b.id, branch: b, confidence: 1,
        reason: 'Resolved by a saved BankOne branch mapping.',
      }
    }
    return {
      ...base, status: 'pending_review', matchType: BRANCH_MATCH.SAVED,
      confidence: 1, reason: 'A saved branch mapping points at a branch that no longer exists.',
    }
  }

  // Exact (already case/space folded).
  const exact = index.byName.get(normalized) || []
  if (exact.length === 1) {
    return {
      ...base, status: 'auto_resolved', matchType: BRANCH_MATCH.EXACT,
      branchId: exact[0].id, branch: exact[0], confidence: 1,
      reason: 'Exact branch name match (case and spacing normalised).',
    }
  }
  if (exact.length > 1) {
    return {
      ...base, status: 'pending_review', matchType: BRANCH_MATCH.EXACT,
      confidence: 0.6, candidates: exact,
      reason: `${exact.length} InfinityCore branches share this name; choose one.`,
    }
  }

  // MERGED: an InfinityCore row like "KETU & HEAD OFFICE" or "MUSHIN/YABA"
  // covers several real branches. Never auto-resolve - that would merge or
  // invent a branch. Surface the split for a human decision.
  // Map.find returns a [key, value] tuple, so unwrap entry[1].
  const mergedEntry = index.merged.get(normalized)
    || [...index.merged.entries()].find(([, v]) => v.parts.includes(normalized))
  if (mergedEntry) {
    const mergedHit = mergedEntry[1]
    return {
      ...base, status: 'pending_review', matchType: BRANCH_MATCH.MERGED,
      confidence: 0.7, branch: mergedHit.branch, branchId: mergedHit.branch.id,
      mergeCandidates: mergedHit.parts,
      reason: `InfinityCore has a combined branch "${mergedHit.branch.branch_name}" containing this BankOne branch. Confirm a mapping or split it.`,
    }
  }

  return {
    ...base, status: 'unresolved', matchType: BRANCH_MATCH.MISSING,
    confidence: 0, candidates: [],
    reason: 'No InfinityCore branch matches this BankOne branch.',
  }
}

/** Every InfinityCore branch whose name contains this BankOne branch name. */
export function fuzzyBranchCandidates(rawName, branches) {
  const n = normalizeBranch(rawName)
  if (!n) return []
  return (branches || [])
    .filter((b) => {
      const f = normalizeBranch(b.branch_name)
      return f.includes(n) || n.includes(f)
    })
    .map((b) => ({ ...b, parts: b.branch_name.split(MERGE_SPLIT).map((p) => normalizeBranch(p)).filter(Boolean) }))
}

/**
 * Which InfinityCore branches are MERGED, i.e. cover more than one BankOne
 * branch. Drives the "BRANCH STRUCTURE REVIEW" panel.
 */
export function detectMergedBranches(bankoneBranchNames, branches) {
  const out = []
  for (const b of branches || []) {
    const parts = (b.branch_name || '').split(MERGE_SPLIT).map((p) => normalizeBranch(p)).filter(Boolean)
    if (parts.length < 2) continue
    const covered = (bankoneBranchNames || [])
      .map((x) => normalizeBranch(x))
      .filter((x) => parts.includes(x))
    if (covered.length) {
      out.push({ branch: b, covers: covered, allParts: parts })
    }
  }
  return out
}
