// Shared identity/avatar helpers for the messaging modules.

/**
 * Resolve a person's display name using the fallback hierarchy:
 * 1. profile full/display name
 * 2. employee full name
 * 3. email
 * 4. "Unknown User" only if no identity record exists at all.
 */
export function displayPersonName(person) {
  if (!person) return 'Unknown User'
  const raw = person.full_name || person.name || ''
  const email = person.email || ''
  if (raw && raw.toLowerCase() !== email.toLowerCase()) return raw
  if (email) return email
  if (person.user_id || person.id || person.userId) return 'Unknown User'
  return 'Unknown User'
}

/**
 * Initials for avatar fallback.
 */
export function initials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('') || '?'
}

const AVATAR_PALETTE = [
  'bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-indigo-500', 'bg-teal-500', 'bg-fuchsia-500',
]

export function hueFor(str = '') {
  let h = 0
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 997
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

/**
 * Search filter for the messaging people directory.
 * Covers: name, email, employee number/staff id, department, position/role, branch.
 */
export function personMatches(person, query) {
  if (!query) return true
  const q = query.toLowerCase()
  const name = displayPersonName(person).toLowerCase()
  return [
    name,
    (person.email || '').toLowerCase(),
    (person.employee_number || person.staff_id || person.staffId || '').toLowerCase(),
    (person.department || '').toLowerCase(),
    (person.position || person.role || '').toLowerCase(),
    (person.branch || '').toLowerCase(),
  ].some((field) => field.includes(q))
}

/**
 * Can this person be messaged?
 * True for platform admins, and for accounts whose app profile exists
 * (`hasAccount`) AND is `active`. Members whose profile row is missing,
 * still pending, suspended or rejected get "No account yet" / status labels
 * in the member panel and their "Message" action is disabled.
 */
export function isActiveAccount(person) {
  if (!person) return false
  if (['super_admin', 'admin'].includes(person.role)) return true
  if (person.hasAccount === false) return false
  const status = String(person.profileStatus || person.profile_status || '').toLowerCase()
  return status === 'active' || status === ''
}
