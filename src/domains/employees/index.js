// EMPLOYEES domain — employee master record + Employee 360 aggregation source.
// Employee 360 (EmployeeProfile.jsx) should read from this + the other
// domains below rather than querying Supabase directly for cross-domain data.
export { employeeService } from '../../services/employeeService'
