import { supabase } from '../supabaseClient'

export async function listUnmatchedReplies() {
  const { data, error } = await supabase.from('audit_unmatched_replies').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function listEmailReplies(findingId) {
  const { data, error } = await supabase.from('audit_email_replies').select('*').eq('finding_id', findingId).order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}
