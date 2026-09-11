// SARA domain — assistant/orchestration layer.
// SARA calls into other domain services (leave, payroll, onboarding, etc.)
// and must NEVER bypass their authorization or duplicate their business logic.
export * as agentService from '../../services/agentService'
export * as saraAlerts from '../../services/saraAlerts'
export { parseSaraCommand } from '../../services/saraCommandParser'
export * as saraIntelligence from '../../services/saraIntelligence'
export * as saraNlu from '../../services/saraNlu'
export * as saraPreReview from '../../services/saraPreReview'
export * as saraSettings from '../../services/saraSettings'
export * as saraStats from '../../services/saraStats'
export * as saraVoice from '../../services/saraVoice'
