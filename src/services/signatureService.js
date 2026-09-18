import { supabase } from '../supabaseClient'

function dataUrlToBlob(dataUrl) {
  const [header, body] = String(dataUrl || '').split(',')
  if (!header || !body) throw new Error('The signature could not be prepared.')
  const mime = header.match(/data:(.*?);base64/)?.[1] || 'image/png'
  const binary = atob(body)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

export function processSignatureImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth || image.width
      canvas.height = image.naturalHeight || image.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) {
        reject(new Error('Signature image processing is unavailable in this browser.'))
        return
      }
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < pixels.data.length; i += 4) {
        const r = pixels.data[i]
        const g = pixels.data[i + 1]
        const b = pixels.data[i + 2]
        const whiteness = Math.min(r, g, b)
        const alpha = Math.max(0, Math.min(255, 255 - whiteness))
        pixels.data[i + 3] = Math.round((pixels.data[i + 3] * alpha) / 255)
      }
      context.putImageData(pixels, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('The selected signature image could not be read.'))
    image.src = dataUrl
  })
}

export async function fileToProcessedSignature(file) {
  if (!file || file.type !== 'image/png') throw new Error('Please select a PNG signature image.')
  if (file.size > 5 * 1024 * 1024) throw new Error('Signature image must be 5MB or smaller.')
  return processSignatureImage(await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('The selected signature image could not be read.'))
    reader.readAsDataURL(file)
  }))
}

export async function uploadSignature({ dataUrl, scope, id = null }) {
  const processed = await processSignatureImage(dataUrl)
  const blob = dataUrlToBlob(processed)
  const prefix = scope === 'employee' ? `signatures/employees/${id}` : `signatures/${scope === 'hr_manager' ? 'hr-manager' : 'management'}`
  const path = `${prefix}/${crypto.randomUUID()}.png`
  const { error } = await supabase.storage.from('documents').upload(path, blob, {
    contentType: 'image/png',
    upsert: false,
  })
  if (error) throw error
  return { path, preview: processed }
}

export async function getSignatureUrl(path) {
  if (!path) return null
  if (/^data:image\//.test(path)) return path
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(path, 3600)
  if (error) throw error
  const signedUrl = data?.signedUrl || null
  if (!signedUrl) return null
  try {
    const response = await fetch(signedUrl)
    if (!response.ok) return signedUrl
    const blob = await response.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('Signature preview could not be prepared.'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return signedUrl
  }
}

export const signatureService = {
  async getPlatformSignatures() {
    const { data, error } = await supabase
      .from('hr_platform_settings')
      .select('management_signature_path, hr_manager_signature_path')
      .eq('id', 1)
      .single()
    if (error) throw error
    return {
      management: await getSignatureUrl(data?.management_signature_path),
      hrManager: await getSignatureUrl(data?.hr_manager_signature_path),
    }
  },

  async getEmployeeSignature(employeeId) {
    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('signature_url')
      .eq('id', employeeId)
      .single()
    if (employeeError) throw employeeError
    const { data: submissions, error: submissionError } = await supabase
      .from('employee_onboarding_submissions')
      .select('signature_data, status, onboarding_status, created_at')
      .eq('employee_id', employeeId)
      .in('status', ['approved', 'completed'])
      .order('created_at', { ascending: false })
      .limit(10)
    if (submissionError && submissionError.code !== 'PGRST116') throw submissionError
    const onboarding = (submissions || []).find((row) => /^data:image\//.test(row.signature_data || ''))
    const source = onboarding?.signature_data || employee?.signature_url || null
    return { source: onboarding ? 'onboarding' : employee?.signature_url ? 'profile' : null, url: await getSignatureUrl(source), path: employee?.signature_url || null }
  },

  async updatePlatformSignature(type, path) {
    const { data, error } = await supabase.rpc('update_hr_signature', {
      p_signature_type: type,
      p_signature_path: path,
    })
    if (error) throw error
    return data
  },

  async updateEmployeeSignature(employeeId, path) {
    const { data, error } = await supabase.rpc('update_employee_signature', {
      p_employee_id: employeeId,
      p_signature_path: path,
    })
    if (error) throw error
    return data
  },
}

export default signatureService
