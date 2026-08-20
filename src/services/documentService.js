import { supabase } from '../supabaseClient'

/**
 * Document Service - Manages file uploads and verification workflow
 */

export const documentService = {
  /**
   * Upload a document to Supabase storage
   */
  async upload(file, entityType, entityId, documentType) {
    // Validate file size (from config, default 10MB)
    const maxSizeMB = 10
    const maxSizeBytes = maxSizeMB * 1024 * 1024
    if (file.size > maxSizeBytes) {
      throw new Error(`File size exceeds ${maxSizeMB}MB limit`)
    }

    // Generate unique file path
    const fileName = `${entityType}/${entityId}/${Date.now()}-${file.name}`

    // Upload to storage
    const { data: storageData, error: uploadError } = await supabase.storage
      .from('documents')
      .upload(fileName, file)

    if (uploadError) throw uploadError

    // Create document record in database
    const { user } = await supabase.auth.getUser()
    const { data: doc, error: dbError } = await supabase
      .from('documents')
      .insert([
        {
          entity_type: entityType,
          entity_id: entityId,
          document_type: documentType,
          file_name: file.name,
          file_path: fileName,
          file_size: file.size,
          mime_type: file.type,
          uploaded_by: user.id,
          verification_status: 'pending',
        },
      ])
      .select()

    if (dbError) throw dbError
    return doc[0]
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
    return data
  },

  /**
   * Get a single document
   */
  async getById(id) {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  /**
   * Verify or reject a document
   */
  async verify(documentId, isVerified, notes = '') {
    const { user } = await supabase.auth.getUser()
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

    if (error) throw error
    return data[0]
  },

  /**
   * Get a signed URL for downloading a document
   */
  async getSignedUrl(filePath, expiresIn = 3600) {
    const { data, error } = await supabase.storage
      .from('documents')
      .createSignedUrl(filePath, expiresIn)

    if (error) throw error
    return data.signedUrl
  },

  /**
   * Delete a document
   */
  async delete(documentId) {
    const document = await this.getById(documentId)
    if (!document) throw new Error('Document not found')

    // Delete from storage
    const { error: storageError } = await supabase.storage
      .from('documents')
      .remove([document.file_path])

    if (storageError) throw storageError

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
