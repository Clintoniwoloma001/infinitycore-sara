/**
 * Canonical normalisation for the authoritative HR employee master.
 *
 * Pure functions, no React, no Supabase — so web, Flutter and the node test
 * suite all agree on exactly how a name or branch is compared.
 *
 * The workbook stores names with trailing whitespace and inconsistent internal
 * spacing ("ORUSOSO  ISIOMA-NWALIGBE" has two spaces). Every comparison in this
 * module therefore runs on the normalised form, never the raw string.
 */

/** Uppercase, strip punctuation to spaces, collapse runs of whitespace. */
export function normalizeName(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Order-insensitive key: same words, any order. Catches "JUDE UKUAGHE" == "UKUAGHE JUDE". */
export function tokenSortKey(value) {
  const tokens = normalizeName(value).split(' ').filter(Boolean).sort();
  return tokens.join(' ');
}

/**
 * Prefix key: "UKUAGHE JUDE" -> "UKUAGHE JUDE".
 * A candidate employee matches when its normalised name starts with the label
 * plus a space, i.e. the workbook truncated the tail of the name.
 */
export function tokenPrefixKeys(value) {
  const tokens = normalizeName(value).split(' ').filter(Boolean);
  const keys = [];
  for (let i = tokens.length; i >= 1; i--) keys.push(tokens.slice(0, i).join(' '));
  return keys;
}

/** Levenshtein distance, iterative, bounded by `max` for cheapness. */
export function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[bl];
}

/**
 * Branch labels: "KOLA & ILE-EPO" vs "ILE-EPO", "LAGOS ISLAND2" vs
 * "LAGOS ISLAND 2". Normalised for comparison only — never written back to the
 * database, so historical branch text is preserved verbatim.
 */
export function normalizeBranch(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    // Split letter/digit boundaries: the workbook contains BOTH "LAGOS ISLAND2"
    // and "LAGOS ISLAND 2" as separate rows, and those are one branch.
    .replace(/([A-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens of a branch label with the merge conjunction removed, e.g. "KETU & HEAD OFFICE" -> ["KETU","HEAD","OFFICE"]. */
export function branchParts(value) {
  return normalizeBranch(value).split(' ').filter(Boolean);
}

/** True when the label reads as a combined/merged location rather than one place. */
export function isCombinedBranchLabel(value) {
  const raw = String(value == null ? '' : value).toUpperCase();
  if (/&/.test(raw) || raw.includes('/')) return true;
  const t = normalizeBranch(value);
  // "LAGOS ISLAND 2/IBEJU -LEKKI/AJAH" already caught above; also catch
  // space-joined duplicates like "OSOSO GBESIGE" is NOT one, so keep it narrow.
  return false;
}

/** Splits a merged branch label into its component place names. */
export function splitCombinedBranch(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .split(/&|\//)
    .map(s => normalizeBranch(s))
    .filter(Boolean);
}