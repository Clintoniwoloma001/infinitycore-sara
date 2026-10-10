import { supabase } from '../supabaseClient'

// Coverage view reads the imported metric values so the operator can see what
// has been imported for whom and for which dates. Read-only; no scoring here.
export const directorCoverageService = {
  async load() {
    const { data, error } = await supabase
      .from('director_metric_values')
      .select('employee_id, as_of_date, metric_key')
    if (error) throw error
    return data || []
  },
}

export default directorCoverageService
