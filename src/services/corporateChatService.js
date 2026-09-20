import { supabase } from '../supabaseClient'
import { APP_URL } from '../config/siteUrl'

// ------------------------------------------------------------------
// Corporate Communication Service — Infinity Bank
//
// Backs the Communication platform (direct chats, groups, channels,
// announcements, threads, mentions, reactions, pinning, bookmarks,
// reports, audit, exports, retention holds).
//
// SECURITY NOTES
//   - Every mutation that touches the message store goes through a
//     SECURITY DEFINER RPC so the database (not the client) enforces
//     the append-only / immutable-official-record model.
//   - Reads are RLS-scoped: this client can only ever read what the
//     authenticated user is a member of.
//   - Never place secrets here; the anon key is the only credential
//     used and it is the same one committed for the whole app.
// ------------------------------------------------------------------

let identityCache = null

// Resolve a batch of auth user ids into real employee identities.
// Cached per session so the UI never has to re-resolve the directory.
export async function resolveDirectory(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))]
  if (ids.length === 0) return {}
  if (identityCache) {
    const missing = ids.filter((id) => !identityCache[id])
    if (missing.length === 0) return identityCache
    const { data } = await supabase.rpc('resolve_user_identity', { p_user_ids: missing })
    if (data) identityCache = { ...identityCache, ...indexIdentityById(data) }
    return identityCache
  }
  const { data, error } = await supabase.rpc('resolve_user_identity', { p_user_ids: ids })
  if (error) throw error
  const map = indexIdentityById(data || [])
  identityCache = { ...(identityCache || {}), ...map }
  return identityCache
}

function indexIdentityById(records) {
  const map = {}
  for (const r of records || []) {
    if (!r?.user_id) continue
    const fullName = r.full_name && (!r.email || String(r.full_name).toLowerCase() !== String(r.email).toLowerCase())
      ? r.full_name
      : 'Unknown User'
    map[r.user_id] = {
      userId: r.user_id,
      employeeId: r.employee_id,
      name: fullName,
      email: r.email,
      role: r.role,
      department: r.department,
      position: r.position,
      staffId: r.staff_id,
      employmentStatus: r.employment_status,
      branch: r.branch,
      isFormerEmployee: r.is_former_employee,
      profilePicturePath: r.profile_picture_path,
      profileStatus: r.profile_status,
    }
  }
  return map
}

// A name resolver that NEVER leaks a raw UUID. Unknown participants
// render as an explicit "Unknown User" placeholder instead.
export function displayName(userId, ident) {
  if (!userId) return 'Unknown User'
  if (ident?.name) return ident.name
  return 'Unknown User'
}

// ------------------------------------------------------------------
// DIRECT MESSAGING (existing, preserved + identity-resolved)
// ------------------------------------------------------------------

export const directChat = {
  async getOrCreate(otherUserId) {
    const { data, error } = await supabase.rpc('get_or_create_chat_thread', { p_other_user: otherUserId })
    if (error) throw error
    if (data?.id) {
      const { error: restoreError } = await supabase.rpc('restore_chat_thread_for_me', { p_thread_id: data.id })
      if (restoreError) throw restoreError
    }
    return data
  },

  async send(threadId, body) {
    // send_chat_message_v2 returns hash fields; falls back to the
    // original RPC if the phase-40 migration hasn't run yet.
    try {
      const { data, error } = await supabase.rpc('send_chat_message_v2', { p_thread_id: threadId, p_body: body })
      if (error && error.message.includes('Could not find the function')) {
        const { data: d, error: e } = await supabase.rpc('send_chat_message', { p_thread_id: threadId, p_body: body })
        if (e) throw e
        return d
      }
      if (error) throw error
      return data
    } catch (e) {
      const { data, error } = await supabase.rpc('send_chat_message', { p_thread_id: threadId, p_body: body })
      if (error) throw error
      return data
    }
  },

  async sendRich(threadId, options = {}) {
    return sendRichMessage('direct', threadId, options)
  },

  async listThreads() {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) return []
    const { data, error } = await supabase
      .from('chat_threads')
      .select('*')
      .or(`member_a.eq.${user.user.id},member_b.eq.${user.user.id}`)
      .order('last_message_at', { ascending: false })
    if (error) throw error

    const threadIds = (data || []).map((thread) => thread.id).filter(Boolean)
    if (!threadIds.length) return []
    const { data: settings, error: settingsError } = await supabase
      .from('chat_thread_user_settings')
      .select('thread_id, is_muted, deleted_at')
      .eq('user_id', user.user.id)
      .in('thread_id', threadIds)
    if (settingsError) throw settingsError

    const settingsByThread = new Map((settings || []).map((setting) => [setting.thread_id, setting]))
    return (data || [])
      .filter((thread) => {
        const deletedAt = settingsByThread.get(thread.id)?.deleted_at
        // A deleted conversation reappears for this user when a new message
        // arrives, while the other participant keeps the original thread.
        return !deletedAt || (thread.last_message_at && new Date(thread.last_message_at) > new Date(deletedAt))
      })
      .map((thread) => ({ ...thread, ...(settingsByThread.get(thread.id) || {}) }))
  },

  async listMessages(threadId, limit = 200) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      .eq('message_type', 'direct')
      .order('created_at', { ascending: true })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async setMuted(threadId, muted) {
    const { data, error } = await supabase.rpc('set_chat_thread_muted', {
      p_thread_id: threadId,
      p_muted: !!muted,
    })
    if (error) throw error
    return data
  },

  async deleteForMe(threadId) {
    const { data, error } = await supabase.rpc('delete_chat_thread_for_me', { p_thread_id: threadId })
    if (error) throw error
    return data
  },

  async unreadCounts() {
    return getUnreadMessageCounts()
  },

  async markRead(threadId) {
    return markChatThreadRead(threadId)
  },
}

const MISSING_RPC_RE = /could not find the function|function .* does not exist|schema cache|not found/i

function isMissingRpc(error) {
  return MISSING_RPC_RE.test(error?.message || '')
}

async function callRpcCandidates(names, args = {}) {
  let lastError = null
  for (const name of names) {
    const { data, error } = await supabase.rpc(name, args)
    if (!error) return data
    lastError = error
    if (!isMissingRpc(error)) throw error
  }
  throw lastError || new Error(`No supported RPC found: ${names[0]}`)
}

// These RPCs are supplied by the additive chat engagement migration. The
// fallback names let a rolling deployment work while that migration is being
// applied without changing the existing message/read paths.
export async function getUnreadMessageCounts() {
  return callRpcCandidates([
    'get_unread_message_counts',
    'get_chat_unread_counts',
    'get_unread_chat_counts',
    'get_unread_counts',
  ])
}

export async function markChatThreadRead(threadId) {
  if (!threadId) return null
  return callRpcCandidates([
    'mark_chat_thread_read',
    'mark_thread_read',
    'mark_conversation_read',
  ], { p_thread_id: threadId })
}

export function unreadMessageTotal(payload) {
  if (typeof payload === 'number') return payload
  if (!payload) return 0
  if (typeof payload.total === 'number') return payload.total
  if (typeof payload.unread_count === 'number') return payload.unread_count
  const rows = Array.isArray(payload)
    ? payload
    : payload.counts || payload.threads || payload.direct || payload.data || null
  if (Array.isArray(rows)) {
    return rows.reduce((sum, row) => sum + Number(row?.unread_count ?? row?.unread ?? row?.count ?? 0), 0)
  }
  if (rows && typeof rows === 'object') {
    return Object.values(rows).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
  }
  if (typeof payload === 'object') {
    return Object.values(payload).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
  }
  return 0
}

// ------------------------------------------------------------------
// GROUPS
// ------------------------------------------------------------------

export const groups = {
  async listMine() {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) return []
    const { data, error } = await supabase
      .from('message_groups')
      .select('*, members:message_group_members(member_id, role, added_at)')
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async create({ name, description, memberIds }) {
    const { data, error } = await supabase.rpc('create_message_group', {
      p_name: name,
      p_description: description || null,
      p_member_ids: memberIds || [],
    })
    if (error) throw error
    return data
  },

  async update(groupId, { name, description }) {
    const { data, error } = await supabase.rpc('update_message_group', {
      p_group_id: groupId,
      p_name: name ?? null,
      p_description: description ?? null,
    })
    if (error) throw error
    return data
  },

  async setAvatar(groupId, avatarUrl) {
    const { data, error } = await supabase.rpc('set_group_avatar', { p_group_id: groupId, p_avatar_url: avatarUrl })
    if (error) throw error
    return data
  },

  async addMember(groupId, memberId) {
    const { data, error } = await supabase.rpc('add_group_member', { p_group_id: groupId, p_member_id: memberId })
    if (error) throw error
    return data
  },

  async removeMember(groupId, memberId) {
    const { data, error } = await supabase.rpc('remove_group_member', { p_group_id: groupId, p_member_id: memberId })
    if (error) throw error
    return data
  },

  async updateMemberRole(groupId, memberId, role) {
    const { data, error } = await supabase.rpc('update_group_member_role', {
      p_group_id: groupId, p_member_id: memberId, p_role: role,
    })
    if (error) throw error
    return data
  },

  async suspendMember(groupId, memberId, until, reason) {
    const { data, error } = await supabase.rpc('suspend_group_member', {
      p_group_id: groupId, p_member_id: memberId, p_until: until, p_reason: reason || null,
    })
    if (error) throw error
    return data
  },

  async unsuspendMember(groupId, memberId) {
    const { data, error } = await supabase.rpc('unsuspend_group_member', {
      p_group_id: groupId, p_member_id: memberId,
    })
    if (error) throw error
    return data
  },

  async members(groupId) {
    const { data, error } = await supabase
      .from('message_group_members')
      .select('*')
      .eq('group_id', groupId)
    if (error) throw error
    return data || []
  },

  async messages(groupId, limit = 200) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: true })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async send(groupId, body, mentions = []) {
    const { data, error } = await supabase.rpc('send_mention_message', {
      p_message_type: 'group',
      p_context_id: groupId,
      p_body: body,
      p_mention_ids: mentions.length ? mentions : null,
    })
    if (error) throw error
    return data
  },
}

// ------------------------------------------------------------------
// CHANNELS
// ------------------------------------------------------------------

export const channels = {
  async listMine() {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) return []
    const { data, error } = await supabase
      .from('message_channels')
      .select('*')
      .eq('status', 'active')
      .order('display_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async listAll() {
    const { data, error } = await supabase.from('message_channels').select('*').order('display_name', { ascending: true })
    if (error) throw error
    return data || []
  },

  async create({ name, displayName, description, channelType, isAuto, autoSource, autoSourceId, autoSourceRole, memberIds }) {
    const { data, error } = await supabase.rpc('create_message_channel', {
      p_name: name,
      p_display_name: displayName || null,
      p_description: description || null,
      p_channel_type: channelType || 'team',
      p_is_auto: isAuto || false,
      p_auto_source: autoSource || null,
      p_auto_source_id: autoSourceId || null,
      p_auto_source_role: autoSourceRole || null,
      p_member_ids: memberIds || [],
    })
    if (error) throw error
    return data
  },

  async update(channelId, { displayName, description }) {
    const { data, error } = await supabase.rpc('update_message_channel', {
      p_channel_id: channelId, p_display_name: displayName ?? null, p_description: description ?? null,
    })
    if (error) throw error
    return data
  },

  async setAvatar(channelId, avatarUrl) {
    const { data, error } = await supabase.rpc('set_channel_avatar', { p_channel_id: channelId, p_avatar_url: avatarUrl })
    if (error) throw error
    return data
  },

  async addMember(channelId, memberId) {
    const { data, error } = await supabase.rpc('add_channel_member', { p_channel_id: channelId, p_member_id: memberId })
    if (error) throw error
    return data
  },

  async removeMember(channelId, memberId) {
    const { data, error } = await supabase.rpc('remove_channel_member', { p_channel_id: channelId, p_member_id: memberId })
    if (error) throw error
    return data
  },

  async updateMemberRole(channelId, memberId, role) {
    const { data, error } = await supabase.rpc('update_channel_member_role', {
      p_channel_id: channelId, p_member_id: memberId, p_role: role,
    })
    if (error) throw error
    return data
  },

  async suspendMember(channelId, memberId, until, reason) {
    const { data, error } = await supabase.rpc('suspend_channel_member', {
      p_channel_id: channelId, p_member_id: memberId, p_until: until, p_reason: reason || null,
    })
    if (error) throw error
    return data
  },

  async unsuspendMember(channelId, memberId) {
    const { data, error } = await supabase.rpc('unsuspend_channel_member', {
      p_channel_id: channelId, p_member_id: memberId,
    })
    if (error) throw error
    return data
  },

  async members(channelId) {
    const { data, error } = await supabase.from('message_channel_members').select('*').eq('channel_id', channelId)
    if (error) throw error
    return data || []
  },

  async messages(channelId, limit = 300) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: true })
      .limit(limit)
    if (error) throw error
    return data || []
  },

  async send(channelId, body, mentions = []) {
    const { data, error } = await supabase.rpc('send_mention_message', {
      p_message_type: 'channel',
      p_context_id: channelId,
      p_body: body,
      p_mention_ids: mentions.length ? mentions : null,
    })
    if (error) throw error
    return data
  },

  async syncAuto(channelId) {
    const { data, error } = await supabase.rpc('sync_auto_channel_members', { p_channel_id: channelId })
    if (error) throw error
    return data
  },

  async ensureOrganizational() {
    const { data, error } = await supabase.rpc('ensure_organizational_channels')
    if (error) throw error
    return data
  },
}

// ------------------------------------------------------------------
// THREADS / REPLIES
// ------------------------------------------------------------------

export const threads = {
  // All replies rooted at a given message (the whole thread tree).
  async list(rootMessageId) {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('root_message_id', rootMessageId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  },

  async reply(parentId, body) {
    const { data, error } = await supabase.rpc('send_mention_message', {
      p_message_type: 'thread',
      p_context_id: parentId,
      p_body: body,
      p_mention_ids: null,
      p_parent_message_id: parentId,
    })
    if (error) throw error
    return data
  },
}

// ------------------------------------------------------------------
// RICH SEND — attachments + priority + mandatory acknowledgment
// ------------------------------------------------------------------

// Upload a file for a chat / group / channel and return the attachment
// metadata the send RPC needs. Files live under the private documents
// bucket (chat/<type>/<context>) and are gated by storage policies.
const SAFE_NAME_RE = /[^\w.\- ]+/g

export function attachmentTypeFor(file) {
  const explicit = file?.attachment_type || file?.attachmentType
  if (explicit) return explicit
  if (String(file?.name || '').toLowerCase().startsWith('voice-note-')) return 'voice_note'
  const type = (file?.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (type === 'application/pdf') return 'pdf'
  if (type.includes('spreadsheet') || type.includes('excel') || type === 'text/csv') return 'spreadsheet'
  if (type.includes('presentation') || type.includes('powerpoint')) return 'presentation'
  if (type.includes('word') || type.includes('document') || type === 'text/plain') return 'document'
  if (type.includes('zip') || type.includes('compressed')) return 'archive'
  return 'file'
}

export async function uploadChatAttachment(contextType, contextId, file) {
  const safeName = (file.name || 'file').replace(SAFE_NAME_RE, '_').slice(0, 120)
  const { data: authData } = await supabase.auth.getUser()
  const userId = authData?.user?.id
  if (!userId) throw new Error('Sign in before uploading an attachment.')
  const randomId = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const filePath = `chat/${contextType}/${contextId || 'direct'}/${userId}/${randomId}-${safeName}`
  const { data, error } = await supabase.storage
    .from('documents')
    .upload(filePath, file, { upsert: false, contentType: file.type || 'application/octet-stream' })
  if (error) throw error
  let checksum = null
  if (globalThis.crypto?.subtle && typeof file.arrayBuffer === 'function') {
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      checksum = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    } catch (_) {
      checksum = null
    }
  }
  return {
    file_name: file.name,
    file_type: file.type || 'application/octet-stream',
    attachment_type: attachmentTypeFor(file),
    file_size: Number(file.size || 0),
    file_path: data?.path || filePath,
    checksum,
    uploaded_by: userId,
  }
}

export async function getAttachmentSignedUrl(filePath, expiresIn = 3600) {
  if (!filePath) return null
  const safePath = String(filePath)
  if (!safePath.startsWith('chat/') || safePath.includes('..') || safePath.includes('://')) return null
  const { data, error } = await supabase.storage.from('documents').createSignedUrl(safePath, expiresIn)
  if (error) return null
  return data?.signedUrl || null
}

export async function listAttachments(messageIds) {
  if (!messageIds?.length) return []
  const { data, error } = await supabase
    .from('message_attachments')
    .select('*')
    .in('message_id', messageIds)
  if (error) throw error
  return data || []
}

// Send a message with rich options: priority (important/urgent), mandatory
// acknowledgment and/or file attachments. Text-only path stays on the
// cheaper send_mention_message(), everything with options goes through here.
export async function sendRichMessage(contextType, contextId, {
  body = '', priority = null, requiresAck = false, files = [], mentionIds = null, parentMessageId = null,
} = {}) {
  const richFiles = (files || []).map((file) => ({
    file_name: file.file_name || file.name || 'attachment',
    file_type: file.file_type || file.type || 'application/octet-stream',
    attachment_type: file.attachment_type || file.attachmentType || attachmentTypeFor(file),
    file_size: Number(file.file_size ?? file.size ?? 0),
    file_path: file.file_path || file.path || null,
    checksum: file.checksum || null,
  }))
  const { data, error } = await supabase.rpc('send_rich_message', {
    p_message_type: contextType,
    p_context_id: contextId,
    p_body: body,
    p_priority: priority || null,
    p_requires_ack: !!requiresAck,
    p_files: richFiles.length ? richFiles : null,
    p_mention_ids: mentionIds?.length ? mentionIds : null,
    p_parent_message_id: parentMessageId || null,
  })
  if (error) throw error
  return data
}

// ------------------------------------------------------------------
// CONVERSATION PINS ("pin a chat" — per-user, appears at the top)
// ------------------------------------------------------------------

export const conversationPins = {
  async listMine() {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) return []
    const { data, error } = await supabase
      .from('pinned_conversations')
      .select('*')
      .eq('user_id', user.user.id)
      .order('pinned_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  isPinned(list, type, id) {
    return (list || []).some((p) => p.conversation_type === type && p.conversation_id === id)
  },

  async pin(type, id) {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) throw new Error('Not signed in')
    const { data, error } = await supabase
      .from('pinned_conversations')
      .insert({ user_id: user.user.id, conversation_type: type, conversation_id: id })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async unpin(type, id) {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) throw new Error('Not signed in')
    const { error } = await supabase
      .from('pinned_conversations')
      .delete()
      .match({ user_id: user.user.id, conversation_type: type, conversation_id: id })
    if (error) throw error
    return { ok: true }
  },
}

// ------------------------------------------------------------------
// MESSAGE ACKNOWLEDGEMENTS (urgent / important)
// ------------------------------------------------------------------

export async function listMessageAcks(messageIds) {
  if (!messageIds?.length) return []
  const { data, error } = await supabase.from('chat_message_acks').select('*').in('message_id', messageIds)
  if (error) throw error
  return data || []
}

// ------------------------------------------------------------------
// MESSAGE ACTIONS
// ------------------------------------------------------------------

export const messageActions = {
  async edit(messageId, body) {
    const { data, error } = await supabase.rpc('edit_my_message', { p_message_id: messageId, p_new_body: body })
    if (error) throw error
    return data
  },

  async softDelete(messageId) {
    const { data, error } = await supabase.rpc('soft_delete_my_message', { p_message_id: messageId })
    if (error) throw error
    return data
  },

  async restrict(messageId, reason) {
    const { data, error } = await supabase.rpc('restrict_message', { p_message_id: messageId, p_reason: reason })
    if (error) throw error
    return data
  },

  async pin(messageId) {
    const { data, error } = await supabase.rpc('pin_message', { p_message_id: messageId })
    if (error) throw error
    return data
  },

  async unpin(messageId) {
    const { data, error } = await supabase.rpc('unpin_message', { p_message_id: messageId })
    if (error) throw error
    return data
  },

  async markOfficial(messageId) {
    const { data, error } = await supabase.rpc('mark_message_official', { p_message_id: messageId })
    if (error) throw error
    return data
  },

  async toggleBookmark(messageId) {
    const { data, error } = await supabase.rpc('toggle_bookmark', { p_message_id: messageId })
    if (error) throw error
    return data
  },

  async addReaction(messageId, emoji) {
    // user_id is required by the RLS with-check (user_id = auth.uid());
    // the client sends its own id only — spoofing is impossible.
    const { data: user } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('message_reactions')
      .insert({ message_id: messageId, user_id: user?.user?.id, emoji })
      .select()
      .single()
    if (error) throw error
    return data
  },

  async removeReaction(messageId, emoji) {
    const { data: user } = await supabase.auth.getUser()
    const { error } = await supabase
      .from('message_reactions')
      .delete()
      .match({ message_id: messageId, user_id: user?.user?.id, emoji })
    if (error) throw error
    return { ok: true }
  },

  async markRead(messageId) {
    const { data, error } = await supabase.rpc('mark_message_read', { p_message_id: messageId })
    if (error) return null
    return data
  },

  async acknowledgeMessage(messageId) {
    const { data, error } = await supabase.rpc('acknowledge_chat_message', {
      p_message_id: messageId,
      p_ip: null,
      p_user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
    })
    if (error) throw error
    return data
  },

  async messageAckStatus(messageId) {
    const { data, error } = await supabase.rpc('get_chat_message_ack_status', { p_message_id: messageId })
    if (error) throw error
    return data
  },

  async report(messageId, reason, details) {
    const { data, error } = await supabase.rpc('report_message', {
      p_message_id: messageId, p_reason: reason, p_details: details || null,
    })
    if (error) throw error
    return data
  },

  async createTask(messageId, { title, description, assignedTo, dueDate, priority }) {
    const { data, error } = await supabase.rpc('create_message_task', {
      p_message_id: messageId,
      p_title: title,
      p_description: description || null,
      p_assigned_to: assignedTo || null,
      p_due_date: dueDate || null,
      p_priority: priority || 'normal',
    })
    if (error) throw error
    return data
  },
}

// ------------------------------------------------------------------
// REACTIONS / BOOKMARKS / MENTIONS LOADERS
// ------------------------------------------------------------------

export async function listReactions(messageIds) {
  if (!messageIds?.length) return []
  const { data, error } = await supabase.from('message_reactions').select('*').in('message_id', messageIds)
  if (error) throw error
  return data || []
}

export async function listMyBookmarks() {
  const { data: user } = await supabase.auth.getUser()
  if (!user?.user?.id) return []
  const { data, error } = await supabase
    .from('message_bookmarks')
    .select('*, message:chat_messages(*)')
    .eq('user_id', user.user.id)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function listMyMentions() {
  const { data: user } = await supabase.auth.getUser()
  if (!user?.user?.id) return []
  const { data, error } = await supabase
    .from('message_mentions')
    .select('*, message:chat_messages(*)')
    .eq('user_id', user.user.id)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data || []
}

export async function listPinned(contextType, contextId) {
  const col = contextType === 'group' ? 'group_id' : 'channel_id'
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq(col, contextId)
    .eq('is_pinned', true)
    .order('pinned_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return data || []
}

export async function listRevisions(messageId) {
  const { error } = await supabase.auth.getUser()
  void error
  const { data } = await supabase.from('message_revisions').select('*').eq('message_id', messageId).order('edited_at', { ascending: true })
  return data || []
}

// ------------------------------------------------------------------
// ANNOUNCEMENTS
// ------------------------------------------------------------------

export const announcements = {
  async list() {
    const { data, error } = await supabase.from('announcements').select('*').order('published_at', { ascending: false })
    if (error) throw error
    return data || []
  },

  async publish({ title, body, priority, targetType, targetValue, requiresAck, effectiveDate, expiryDate }) {
    const { data, error } = await supabase.rpc('publish_announcement', {
      p_title: title,
      p_body: body,
      p_priority: priority || 'normal',
      p_target_type: targetType || 'organization',
      p_target_value: targetValue || null,
      p_requires_ack: requiresAck || false,
      p_effective_date: effectiveDate || null,
      p_expiry_date: expiryDate || null,
    })
    if (error) throw error
    return data
  },

  async message(announcementId) {
    const { data, error } = await supabase
      .from('announcements')
      .select('*, message:chat_messages(*)')
      .eq('id', announcementId)
      .single()
    if (error) throw error
    return data
  },

  async acknowledge(announcementId) {
    const { data, error } = await supabase.rpc('acknowledge_announcement', {
      p_announcement_id: announcementId,
      p_ip: null,
      p_user_agent: navigator.userAgent || null,
    })
    if (error) throw error
    return data
  },

  async ackStatus(announcementId) {
    const { data, error } = await supabase.rpc('get_announcement_ack_status', { p_announcement_id: announcementId })
    if (error) throw error
    return data
  },

  async myAck(announcementId) {
    const { data: user } = await supabase.auth.getUser()
    if (!user?.user?.id) return null
    const { data, error } = await supabase
      .from('message_acknowledgements')
      .select('*')
      .eq('announcement_id', announcementId)
      .eq('user_id', user.user.id)
      .maybeSingle()
    if (error) throw error
    return data || null
  },
}

// ------------------------------------------------------------------
// SEARCH / ADMIN / RETENTION / EXPORTS
// ------------------------------------------------------------------

export async function searchMessages(query, filters = {}) {
  const { data, error } = await supabase.rpc('search_messages', {
    p_query: query || null,
    p_filters: filters || {},
  })
  if (error) throw error
  return data || []
}

export async function getCommunicationStats() {
  const { data, error } = await supabase.rpc('get_communication_stats')
  if (error) throw error
  return data
}

export async function listAuditLog(limit = 200) {
  const { data, error } = await supabase.from('message_audit_log').select('*').order('timestamp', { ascending: false }).limit(limit)
  if (error) throw error
  return data || []
}

export async function listReports() {
  const { data, error } = await supabase.from('message_reports').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function resolveReport(reportId, status, note) {
  const { data, error } = await supabase.rpc('resolve_message_report', { p_report_id: reportId, p_status: status, p_note: note || null })
  if (error) throw error
  return data
}

export async function listHolds() {
  const { data, error } = await supabase.from('message_holds').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function createHold(scope, scopeId, reason, endDate) {
  const { data, error } = await supabase.rpc('create_message_hold', {
    p_scope: scope, p_scope_id: scopeId, p_reason: reason, p_end_date: endDate || null,
  })
  if (error) throw error
  return data
}

export async function releaseHold(holdId, reason) {
  const { data, error } = await supabase.rpc('release_message_hold', { p_hold_id: holdId, p_reason: reason || null })
  if (error) throw error
  return data
}

export async function listRetentionPolicies() {
  const { data, error } = await supabase.from('message_retention_policies').select('*')
  if (error) throw error
  return data || []
}

export async function setRetentionPolicy(key, label, retentionDays, isForever) {
  const { data, error } = await supabase.rpc('set_retention_policy', {
    p_key: key, p_label: label, p_retention_days: retentionDays, p_is_forever: isForever,
  })
  if (error) throw error
  return data
}

export async function listExports() {
  const { data, error } = await supabase.from('message_exports').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function exportRecords({ format, scope, scopeId, reason, query, filters }) {
  const { data, error } = await supabase.rpc('create_message_export', {
    p_format: format,
    p_scope: scope,
    p_scope_id: scopeId || null,
    p_reason: reason || null,
    p_query: query || null,
    p_filters: filters || {},
  })
  if (error) throw error
  return data
}

// Build a client-side export file from the RPC result.
export function buildExportFile(format, { rows, title = 'communication-export' }) {
  const stamp = new Date().toISOString().slice(0, 10)
  if (format === 'json') {
    return downloadBlob(new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' }), `${title}-${stamp}.json`)
  }
  if (format === 'csv') {
    const headers = ['id', 'message_type', 'sender_id', 'title', 'body', 'created_at', 'thread_id', 'group_id', 'channel_id', 'is_official', 'is_pinned', 'priority', 'restricted_status']
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [headers.join(',')]
    for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','))
    return downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `${title}-${stamp}.csv`)
  }
  // pdf: build a printable HTML blob (browser print-to-PDF)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;padding:24px}table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}
  th{background:#f1f5f9}.badge{display:inline-block;background:#dcfce7;color:#166534;border-radius:4px;padding:1px 6px;font-size:11px}</style></head>
  <body><h2>${title}</h2><p>Exported ${new Date().toLocaleString()}</p>
  <table><thead><tr><th>Type</th><th>Sender</th><th>Message</th><th>Date</th><th>Official</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${r.message_type || 'direct'}</td><td>${r.sender_id || ''}</td><td>${(r.title ? `<b>${r.title}</b><br>` : '') + (r.body || '')}</td><td>${r.created_at ? new Date(r.created_at).toLocaleString() : ''}</td><td>${r.is_official ? '<span class="badge">OFFICIAL</span>' : ''}</td></tr>`).join('')}
  </tbody></table></body></html>`
  return downloadBlob(new Blob([html], { type: 'text/html' }), `${title}-${stamp}.html`)
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return { downloaded: fileName }
}

// ------------------------------------------------------------------
// SENSITIVE DATA SCANNER (DLP foundation)
// ------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  { key: 'bvn', label: 'BVN', re: /\b\d{11}\b/ },
  { key: 'nin', label: 'NIN', re: /\b\d{11}\b/ },
  { key: 'password', label: 'Password', re: /\b(password|passwd|pwd)\b/i },
  { key: 'api_key', label: 'API key', re: /\b(api[-_ ]?key|secret|token)\b/i },
  { key: 'card', label: 'Card number', re: /\b\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\b/ },
  { key: 'account', label: 'Account number', re: /\b\d{10}\b/ },
]

// Returns the list of detected categories (used for a warning, not a block).
export function scanSensitiveContent(body) {
  const detected = []
  for (const p of SENSITIVE_PATTERNS) {
    if (p.re.test(body || '')) detected.push(p.label)
  }
  return detected
}

// ------------------------------------------------------------------
// OCR-LESS LINK / HASHTAG HELPERS (client rendering only)
// ------------------------------------------------------------------

export function extractMentions(body, wordMap) {
  const out = []
  const re = /@(\w[\w-]*)/g
  let m
  while ((m = re.exec(body))) {
    const cleaned = m[1].toLowerCase()
    const match = wordMap.get(cleaned)
    if (match) out.push(match)
  }
  return out
}

// ------------------------------------------------------------------
// MEMBER MANAGEMENT / INVITES
// ------------------------------------------------------------------

// Build the shareable invite URL (never exposes a DB uuid — only the token).
export function buildInviteUrl(token) {
  return `${APP_URL}/#/chat?invite=${encodeURIComponent(String(token || ''))}`
}

// A ready-to-send WhatsApp share link for a conversation invite.
export function waShareUrl(inviteUrl, conversationLabel) {
  return `https://wa.me/?text=${encodeURIComponent(`Join "${conversationLabel || 'this conversation'}" on Infinity Core: ${inviteUrl}`)}`
}

export async function createMessageInvite(scope, contextId, { expiresAt = null, maxUses = null } = {}) {
  const { data, error } = await supabase.rpc('create_message_invite', {
    p_scope: scope,
    p_context_id: contextId,
    p_expires_at: expiresAt || null,
    p_max_uses: maxUses == null ? null : Number(maxUses),
  })
  if (error) throw error
  return data
}

export async function revokeMessageInvite(inviteId) {
  const { data, error } = await supabase.rpc('revoke_message_invite', { p_invite_id: inviteId })
  if (error) throw error
  return data
}

export async function listMessageInvites(scope, contextId) {
  const { data, error } = await supabase.rpc('list_message_invites', { p_scope: scope, p_context_id: contextId })
  if (error) throw error
  return Array.isArray(data) ? data : []
}

// Preview what an invite token opens (name, member count, joined already).
export async function getInviteContext(token) {
  const { data, error } = await supabase.rpc('get_message_invite_context', { p_token: token })
  if (error) throw error
  return data
}

// Accept an invite as a plain member.
export async function joinViaInvite(token) {
  const { data, error } = await supabase.rpc('join_via_message_invite', { p_token: token, p_role: 'member' })
  if (error) throw error
  return data
}

export default {
  resolveDirectory,
  displayName,
  directChat,
  groups,
  channels,
  threads,
  messageActions,
  announcements,
  searchMessages,
  getCommunicationStats,
  listAuditLog,
  listReports,
  resolveReport,
  listHolds,
  createHold,
  releaseHold,
  listRetentionPolicies,
  setRetentionPolicy,
  listExports,
  exportRecords,
  buildExportFile,
  listReactions,
  listMyBookmarks,
  listMyMentions,
  listPinned,
  listRevisions,
  scanSensitiveContent,
  extractMentions,
  uploadChatAttachment,
  attachmentTypeFor,
  getAttachmentSignedUrl,
  listAttachments,
  sendRichMessage,
  getUnreadMessageCounts,
  markChatThreadRead,
  unreadMessageTotal,
  conversationPins,
  listMessageAcks,
  createMessageInvite,
  revokeMessageInvite,
  listMessageInvites,
  getInviteContext,
  joinViaInvite,
  buildInviteUrl,
  waShareUrl,
}
