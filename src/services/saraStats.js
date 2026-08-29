import { supabase } from '../supabaseClient'

// ------------------------------------------------------------------
// SARA read helpers — always RLS-scoped. These return plain counts for
// entities the authenticated user is permitted to see; a failed read
// returns null (never throws) so SARA can say "I couldn't fetch that"
// instead of lying or crashing.
// ------------------------------------------------------------------

// filters: { status } style equality map. Reference-scoped by RLS.
export async function countRows(table, filters = null, _ctx = {}) {
  try {
    let q = supabase.from(table).select('id', { count: 'exact', head: true })
    if (filters) {
      for (const [col, val] of Object.entries(filters)) {
        const [field, op] = col.split('__')
        if (op === 'gte') q = q.gte(field, val)
        else if (op === 'lte') q = q.lte(field, val)
        else q = q.eq(field, val)
      }
    }
    const { count, error } = await q
    if (error) return null
    return count || 0
  } catch {
    return null
  }
}