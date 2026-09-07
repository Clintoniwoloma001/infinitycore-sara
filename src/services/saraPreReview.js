// ------------------------------------------------------------------
// SARA Pre-Review Engine — Smart Automated Reporting & Approval Analyst
//
// Rules-based analysis of onboarding submission data.
// Identifies empty required fields, missing documents, incomplete
// sections, guarantor status, and correction history.
//
// This is decision-support, not autonomous decision-making.
// SARA never fabricates findings — every recommendation is derived
// from the actual submitted data.
// ------------------------------------------------------------------

import { REVIEW_SECTIONS } from '../components/review/sectionConfig'

// Fields that are genuinely required for a complete onboarding.
// These map to the actual form fields in OnboardingForm.jsx.
const REQUIRED_FIELDS = {
  personal: ['surname', 'first_name', 'email', 'phone', 'date_of_birth', 'sex', 'residential_address'],
  contact: ['emergency_contact_name', 'emergency_contact_phone', 'department', 'position'],
  next_of_kin: ['next_of_kin_name', 'next_of_kin_relationship', 'next_of_kin_phone'],
  guarantor: ['guarantor_full_name', 'guarantor_email'],
}

const FIELD_LABELS = {}
REVIEW_SECTIONS.forEach((section) => {
  if (section.fields) {
    section.fields.forEach((f) => { FIELD_LABELS[f.key] = f.label })
  }
})

function isEmpty(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function getFieldLabel(key) {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Analyze an onboarding submission and return a structured pre-review.
 *
 * @param {object} submission - The employee_onboarding_submissions row
 * @param {object|null} verification - The guarantor_verifications row (if any)
 * @param {array} corrections - onboarding_corrections rows
 * @param {array} guarantorCorrections - guarantor_corrections rows
 * @returns {object} SARA pre-review result
 */
export function analyzeOnboarding(submission, verification, corrections = [], guarantorCorrections = []) {
  const payload = submission?.payload || {}
  const issues = []
  const recommendations = []
  const attentionItems = []

  // ---- 1. Check required fields ----
  for (const [sectionId, fields] of Object.entries(REQUIRED_FIELDS)) {
    const section = REVIEW_SECTIONS.find((s) => s.id === sectionId)
    const sectionTitle = section?.title || sectionId
    let sectionHasGaps = false

    for (const fieldKey of fields) {
      if (isEmpty(payload[fieldKey])) {
        const label = getFieldLabel(fieldKey)
        issues.push({
          type: 'missing_field',
          section: sectionTitle,
          fieldKey,
          fieldLabel: label,
          severity: 'high',
          message: `${label} is required but was not provided.`,
        })
        recommendations.push({
          fieldKey,
          fieldLabel: label,
          section: sectionTitle,
          reason: `${label} is missing or empty.`,
          selected: true,
        })
        sectionHasGaps = true
      }
    }

    if (sectionHasGaps) {
      attentionItems.push(`Incomplete ${sectionTitle.toLowerCase()} — required fields are missing.`)
    }
  }

  // ---- 2. Check education and work history ----
  if (!payload.education || payload.education.length === 0) {
    issues.push({
      type: 'missing_section',
      section: 'Education',
      severity: 'medium',
      message: 'No education history was provided.',
    })
    attentionItems.push('No education records submitted.')
  }

  if (!payload.work_history || payload.work_history.length === 0) {
    issues.push({
      type: 'missing_section',
      section: 'Work History',
      severity: 'medium',
      message: 'No work history was provided.',
    })
    attentionItems.push('No previous work experience records submitted.')
  }

  // ---- 3. Check documents ----
  const documents = payload.documents || []
  if (documents.length === 0) {
    issues.push({
      type: 'missing_documents',
      section: 'Documents',
      severity: 'high',
      message: 'No documents were uploaded with this submission.',
    })
    attentionItems.push('No documents uploaded — passport photo, ID, and supporting documents are expected.')
  } else {
    const docCategories = documents.map((d) => d.category || d.document_type || 'other')
    const expectedDocs = ['passport', 'id', 'utility_bill', 'signature']
    const missingDocTypes = expectedDocs.filter((t) =>
      !docCategories.some((c) => c.toLowerCase().includes(t) || c.toLowerCase().includes(t.replace('_', ' ')))
    )
    if (missingDocTypes.length > 0) {
      issues.push({
        type: 'missing_documents',
        section: 'Documents',
        severity: 'medium',
        message: `Some expected document types may be missing: ${missingDocTypes.join(', ')}.`,
      })
      attentionItems.push(`Potentially missing documents: ${missingDocTypes.join(', ')}.`)
    }
  }

  // ---- 4. Check declaration ----
  if (!submission?.declaration_accepted && !payload.declaration_accepted) {
    issues.push({
      type: 'declaration',
      section: 'Declaration',
      severity: 'high',
      message: 'The declaration was not accepted.',
    })
    attentionItems.push('Declaration not accepted — this must be confirmed before approval.')
  }

  // ---- 5. Check guarantor status ----
  const guarantorStatus = verification?.status || 'pending_link'
  if (guarantorStatus === 'pending_link' || guarantorStatus === 'link_sent') {
    issues.push({
      type: 'guarantor_pending',
      section: 'Guarantor',
      severity: 'high',
      message: 'Guarantor verification has not been completed yet.',
    })
    attentionItems.push('Guarantor verification is still pending — link has not been completed.')
  } else if (guarantorStatus === 'submitted' || guarantorStatus === 'under_review') {
    issues.push({
      type: 'guarantor_pending',
      section: 'Guarantor',
      severity: 'medium',
      message: 'Guarantor verification has been submitted but not yet approved.',
    })
    attentionItems.push('Guarantor verification submitted — awaiting HR approval.')
  } else if (guarantorStatus === 'rejected') {
    issues.push({
      type: 'guarantor_rejected',
      section: 'Guarantor',
      severity: 'high',
      message: 'Guarantor verification was rejected.',
    })
    attentionItems.push('Guarantor verification was rejected — review required.')
  }

  // ---- 6. Check correction history ----
  const allCorrections = [...corrections, ...guarantorCorrections]
  const pendingCorrections = allCorrections.filter((c) => c.status === 'pending' || c.status === 'submitted')
  if (pendingCorrections.length > 0) {
    issues.push({
      type: 'pending_corrections',
      section: 'Corrections',
      severity: 'high',
      message: `${pendingCorrections.length} correction(s) are still pending resolution.`,
    })
    attentionItems.push(`${pendingCorrections.length} correction(s) pending — must be resolved before approval.`)
  }

  // ---- 7. Check for potential inconsistencies ----
  if (payload.phone && payload.emergency_contact_phone && payload.phone === payload.emergency_contact_phone) {
    issues.push({
      type: 'inconsistency',
      section: 'Contact',
      severity: 'low',
      message: 'Emergency contact phone number is the same as the candidate\'s phone — please confirm this is correct.',
    })
    attentionItems.push('Emergency contact shares the same phone number as the candidate — may need confirmation.')
  }

  if (payload.email && payload.guarantor_email && payload.email === payload.guarantor_email) {
    issues.push({
      type: 'inconsistency',
      section: 'Guarantor',
      severity: 'medium',
      message: 'Guarantor email is the same as the candidate\'s email — this may indicate an error.',
    })
    attentionItems.push('Guarantor email matches candidate email — please verify.')
  }

  // ---- Determine overall assessment ----
  const highSeverity = issues.filter((i) => i.severity === 'high')
  let assessment
  if (highSeverity.length > 0) {
    assessment = 'ATTENTION REQUIRED'
  } else if (issues.length > 0) {
    assessment = 'CORRECTION RECOMMENDED'
  } else {
    assessment = 'READY FOR HR REVIEW'
  }

  return {
    assessment,
    issues,
    recommendations,
    attentionItems,
    guarantorStatus,
    pendingCorrectionCount: pendingCorrections.length,
    totalIssues: issues.length,
    hasRecommendations: recommendations.length > 0,
  }
}

/**
 * Generate a human-sounding SARA summary message.
 */
export function saraGreeting(userName) {
  const name = userName ? userName.split(' ')[0] : 'there'
  const greetings = [
    `Hi ${name}. I've gone through this onboarding submission and here's what I found.`,
    `Hello ${name}. I've reviewed this candidate's onboarding — here's my summary.`,
    `Hi ${name}. I've taken a look at this submission and put together a quick pre-review for you.`,
  ]
  return greetings[Math.floor(Math.random() * greetings.length)]
}

/**
 * Generate a human-sounding assessment message.
 */
export function saraAssessmentMessage(analysis) {
  if (analysis.assessment === 'READY FOR HR REVIEW') {
    return "Everything looks complete on my end. No obvious gaps or issues jumped out. I'd still recommend you do a manual review before approving — but it's looking good."
  }
  if (analysis.assessment === 'CORRECTION RECOMMENDED') {
    return `I found ${analysis.totalIssues} minor issue(s) that you might want to look into. Nothing critical, but worth a quick check before you proceed. I've listed them below.`
  }
  return `I've flagged ${analysis.totalIssues} issue(s) that need your attention — ${analysis.issues.filter((i) => i.severity === 'high').length} of them are high priority. I'd recommend resolving these before moving forward. Here's the breakdown:`
}
