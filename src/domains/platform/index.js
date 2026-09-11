// PLATFORM domain — cross-cutting concerns used by multiple domains:
// documents, tasks/work management, platform-wide settings, user approvals,
// support cases. Kept separate so e.g. a Payroll change never has a reason
// to touch this file, and vice versa.
export { documentService } from '../../services/documentService'
export { taskService } from '../../services/taskService'
export { workManagementService } from '../../services/workManagementService'
export { workTaskService } from '../../services/workTaskService'
export { platformSettingsService } from '../../services/platformSettingsService'
export { supportCaseService } from '../../services/supportCaseService'
export { userApprovalService } from '../../services/userApprovalService'
