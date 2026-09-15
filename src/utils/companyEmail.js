// Company email generation helper.
// Derives a standardized corporate email (firstname.lastname@infinitybank.com)
// from a full name. Handles special characters and provides collision-free
// disambiguation via an integer suffix.

export const COMPANY_EMAIL_DOMAIN = 'infinitybank.com'

function slugifyPart(part) {
  return part
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[\d]+/, '')
}

// Build the local part (no suffix) from a full name.
// "Ada Obi-Onuora  the 3rd" -> "ada.oni-onuora"
export function buildCompanyEmailLocal(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length === 0) return ''
  const first = parts[0]
  const last = parts[parts.length - 1]
  // If only one token, use it as-is
  if (parts.length === 1) return slugifyPart(first)
  // Use the middle-most initial(s) when present: first + [middle initial] + last
  const middles = parts.slice(1, -1)
  const middlePart = middles.map((m) => m.charAt(0)).join('')
  const local = slugifyPart(first) + middlePart + '.' + slugifyPart(last)
  return local || ''
}

// Generate a company email. `exists` is an optional predicate used to ensure
// uniqueness (e.g. checking against existing employee emails). Returns an
// email or '' when the name can't produce a local part.
export function generateCompanyEmail(fullName, exists) {
  const base = buildCompanyEmailLocal(fullName)
  if (!base) return ''
  const candidate = (suffix) => `${base}${suffix ? '-' + suffix : ''}@${COMPANY_EMAIL_DOMAIN}`
  let email = candidate('')
  try {
    if (typeof exists === 'function') {
      let i = 1
      let guard = 0
      while (exists(email) && guard < 100) {
        email = candidate(i)
        i += 1
        guard += 1
      }
    }
  } catch {
    // Existence check is advisory — never throw during generation
  }
  return email
}

export default { generateCompanyEmail, buildCompanyEmailLocal, COMPANY_EMAIL_DOMAIN }