const EMPTY_FILTERS = {
  branches: [],
  areas: [],
  departments: [],
  roles: [],
  designations: [],
  employees: [],
}

const EMPTY_DIRECTOR_SNAPSHOT = Object.freeze({
  generated_at: null,
  range: {},
  summary: {},
  filters: EMPTY_FILTERS,
  departments: [],
  branches: [],
  areas: [],
  staff: [],
  leave: [],
  roles: [],
  trend: [],
  loans: { status: {} },
})

const asObject = (value, fallback = {}) => value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
const asArray = (value) => Array.isArray(value) ? value : []

/**
 * Keep the Director workspace independent from partial or legacy RPC payloads.
 * Supabase can return a successful response with JSON null fields; React must
 * still receive the complete read-model shape it renders.
 */
export function normalizeDirectorSnapshot(value) {
  if (value == null) return {
    ...EMPTY_DIRECTOR_SNAPSHOT,
    filters: { ...EMPTY_FILTERS },
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Director intelligence returned an invalid data response. Please try again.')
  }

  const filters = asObject(value.filters)
  return {
    ...EMPTY_DIRECTOR_SNAPSHOT,
    ...value,
    range: asObject(value.range),
    summary: asObject(value.summary),
    filters: {
      ...EMPTY_FILTERS,
      ...filters,
      branches: asArray(filters.branches),
      areas: asArray(filters.areas),
      departments: asArray(filters.departments),
      roles: asArray(filters.roles),
      designations: asArray(filters.designations),
      employees: asArray(filters.employees),
    },
    departments: asArray(value.departments),
    branches: asArray(value.branches),
    areas: asArray(value.areas),
    staff: asArray(value.staff),
    leave: asArray(value.leave),
    roles: asArray(value.roles),
    trend: asArray(value.trend),
    loans: {
      status: {},
      ...asObject(value.loans),
      status: asObject(asObject(value.loans).status),
    },
  }
}

export default normalizeDirectorSnapshot
