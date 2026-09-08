import { supabase } from '../supabaseClient'
import { logAction } from './supabaseService'

// ------------------------------------------------------------------
// Onboarding Field Correction Service
//
// Preserves: original value + HR comment + corrected value +
// approval status + approver + approval date
// Never overwrites the original — correction is a separate record.
// ------------------------------------------------------------------

export const onboardingCorrectionService = {
  async listCorrections(submissionId) {
    const { data, error } = await supabase
      .from('onboarding_field_corrections')
      .select('*')
      .eq('submission_id', submissionId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async requestCorrection({ submissionId, verificationId, fieldName, fieldLabel, originalValue, hrComment, requestedById, requestedByName }) {
    const { data, error } = await supabase
      .from('onboarding_field_corrections')
      .insert({
        submission_id: submissionId,
        verification_id: verificationId || null,
        field_name: fieldName,
        field_label: fieldLabel,
        original_value: originalValue,
        hr_comment: hrComment,
        status: 'requested',
        requested_by: requestedById,
        requested_by_name: requestedByName,
      })
      .select()
      .single()
    if (error) throw error

    await logAction({
      action: 'onboarding_correction_requested',
      entityType: 'onboarding_submission',
      entityId: submissionId,
      details: `Correction requested for field "${fieldLabel}"`,
      userName: requestedByName,
    })

    return data
  },

  async submitCorrection(correctionId, correctedValue) {
    const { data, error } = await supabase
      .from('onboarding_field_corrections')
      .update({
        corrected_value: correctedValue,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
      })
      .eq('id', correctionId)
      .select()
      .single()
    if (error) throw error
    return data
  },

  async approveCorrection(correctionId, approverId, approverName) {
    const { data, error } = await supabase
      .from('onboarding_field_corrections')
      .update({
        status: 'approved',
        approved_by: approverId,
        approved_by_name: approverName,
        approved_at: new Date().toISOString(),
      })
      .eq('id', correctionId)
      .select()
      .single()
    if (error) throw error

    await logAction({
      action: 'onboarding_correction_approved',
      entityType: 'onboarding_correction',
      entityId: correctionId,
      details: `Correction approved by ${approverName}`,
      userName: approverName,
    })

    return data
  },

  async rejectCorrection(correctionId, approverId, approverName) {
    const { data, error } = await supabase
      .from('onboarding_field_corrections')
      .update({
        status: 'rejected',
        approved_by: approverId,
        approved_by_name: approverName,
        approved_at: new Date().toISOString(),
      })
      .eq('id', correctionId)
      .select()
      .single()
    if (error) throw error
    return data
  },
}

export default onboardingCorrectionService
