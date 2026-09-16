import { supabase } from '../supabaseClient'

/**
 * Document Service - Manages file uploads and verification workflow
 *
 * CRITICAL FIX (Phase 24): `supabase.auth.getUser()` in supabase-js v2 returns
 * `{ data: { user }, error }`. The previous code destructured it as
 * `const { user } = await ...` which always yields `user === undefined`, so
 * `user.id` threw `undefined is not an object (evaluating '...id')` on every
 * upload. All callers now use the correct v2 shape AND null-guard the result.
 */

// Deterministic, safe storage basename — strips path separators, control
// characters and the leading-dot / reserved-name pitfalls of arbitrary file names.
function safeBaseName(name) {
  const cleaned = String(name || 'file')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)
  return cleaned || 'file'
}

async function requireUser() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  return data?.user || null
}

export const documentService = {
  /**
   * Upload a document to Supabase storage
   */
  async upload(file, entityType, entityId, documentType) {
    if (!file) throw new Error('No file selected.')
    if (!entityId) throw new Error('Employee record could not be resolved. Please refresh and retry.')

    // Validate file size (from config, default 10MB)
    const maxSizeMB = 10
    const maxSizeBytes = maxSizeMB * 1024 * 1024
    if (file.size > maxSizeBytes) {
      throw new Error(`File size exceeds ${maxSizeMB}MB limit`)
    }

    // Generate unique file path
    const safeName = safeBaseName(file.name)
    const fileName = `${entityType}/${entityId}/${Date.now()}-${safeName}`

    // Upload to storage
    const { data: storageData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(fileName, file, { contentType: file.type || 'application/octet-stream', upsert: false })

    if (uploadError) throw uploadError

    // Create document record in database
    const user = await requireUser()
    if (!user) throw new Error('You must be signed in to upload documents. Please sign in again.')

    const { data: doc, error: dbError } = await supabase
      .from('documents')
      .insert([
        {
          entity_type: entityType,
          entity_id: entityId,
          document_type: documentType,
          file_name: safeName,
          file_path: fileName,
          file_size: file.size,
          mime_type: file.type || 'application/octet-stream',
          uploaded_by: user.id,
          verification_status: 'pending',
        },
      ])
      .select()
      .single()

    if (dbError) throw dbError
    if (!doc) throw new Error('Document record missing after upload. Please retry.')

    return doc
  },

  /**
   * Upload a platform profile picture for an employee. Stored under the
   * dedicated `profile-photo/<employeeId>/...` path (separate from the
   * onboarding passport) so the Staff ID card photo is never affected.
   */
  async uploadProfilePicture(file, employeeId) {
    if (!file) throw new Error('No image selected.')
    if (!employeeId) throw new Error('Employee record could not be resolved. Please refresh and retry.')

    const maxSizeMB = 8
    const maxSizeBytes = maxSizeMB * 1024 * 1024
    if (file.size > maxSizeBytes) {
      throw new Error(`Image size exceeds ${maxSizeMB}MB limit`)
    }
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const fileName = `profile-photo/${employeeId}/${Date.now()}-photo.${ext}`

    const { data: storageData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(fileName, file, { upsert: false, contentType: file.type || 'image/jpeg' })

    if (uploadError) throw uploadError

    const user = await requireUser()
    if (!user) throw new Error('You must be signed in to upload a photo. Please sign in again.')

    const { data: doc, error: dbError } = await supabase
      .from('documents')
      .insert([
        {
          entity_type: 'employee',
          entity_id: employeeId,
          document_type: 'profile_picture',
          file_name: 'profile-photo.' + ext,
          file_path: fileName,
          file_size: file.size,
          mime_type: file.type || 'image/jpeg',
          uploaded_by: user.id,
          verification_status: 'verified',
        },
      ])
      .select()
      .single()

    if (dbError) throw dbError
    if (!doc) throw new Error('Failed to persist photo record. Please retry.')

    // Remove any previous profile picture so there is exactly ONE active.
    // Best effort — a failed cleanup must not fail the new upload.
    const previous = ((await this.list('employee', employeeId).catch(() => [])) || []).filter(
      (d) => d.document_type === 'profile_picture' && d.id !== doc.id
    )
    for (const o of previous) {
      if (o.file_path) {
        await supabase.storage.from('documents').remove([o.file_path]).catch(() => {})
      }
      await supabase.from('documents').delete().eq('id', o.id).catch(() => {})
    }
    return doc
  },

  /**
   * List documents for an entity
   */
  async list(entityType, entityId) {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('uploaded_at', { ascending: false })

    if (error) throw error
    return data || []
  },

  /**
   * Get a single document
   */
  async getById(id) {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error && error.code !== 'PGRST116') throw error
    return data || null
  },

  /**
   * Verify or reject a document
   */
  async verify(documentId, isVerified, notes = '') {
    const user = await requireUser()
    if (!user) throw new Error('You must be signed in to verify documents.')

    const { data, error } = await supabase
      .from('documents')
      .update({
        verification_status: isVerified ? 'verified' : 'rejected',
        verified_by: user.id,
        verified_at: new Date().toISOString(),
        verification_notes: notes,
      })
      .eq('id', documentId)
      .select()
      .single()

    if (error) throw error
    return data
  },

  /**
   * Get a signed URL for downloading a document
   */
  async getSignedUrl(filePath, expiresIn = 3600) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, expiresIn)

    if (error) throw error
    return data?.signedUrl || null
  },

  /**
   * Delete a document
   */
  async delete(documentId) {
    const document = await this.getById(documentId)
    if (!document) throw new Error('Document not found')

    // Delete from storage
    if (document.file_path) {
      const { error: storageError } = await supabase.storage
        .from('documents')
        .remove([document.file_path])
      if (storageError) throw storageError
    }

    // Delete from database
    const { error: dbError } = await supabase
      .from('documents')
      .delete()
      .eq('id', documentId)

    if (dbError) throw dbError
  },

  /**
   * Get document statistics for an entity
   */
  async getStats(entityType, entityId) {
    const docs = await this.list(entityType, entityId)
    return {
      total: docs.length,
      verified: docs.filter((d) => d.verification_status === 'verified').length,
      pending: docs.filter((d) => d.verification_status === 'pending').length,
      rejected: docs.filter((d) => d.verification_status === 'rejected').length,
    }
  },
}