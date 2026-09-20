import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('schema_phase60_messaging_member_management.sql')
const reset = read('schema_phase44_platform_reset.sql')
const chatService = read('src/services/corporateChatService.js')
const conversations = read('src/components/messages/Conversations.jsx')
const messagesPage = read('src/components/messages/MessagesPage.jsx')

// --- Phase 60 migration: invitations ------------------------------------
for (const required of [
  'create table if not exists public.message_invites',
  'token_hash text not null unique',
  'create_message_invite',
  'revoke_message_invite',
  'get_message_invite_context',
  'join_via_message_invite',
  'list_message_invites',
  'can_manage_conversation_members',
  'msg_invites read_owner_admin',
]) {
  assert.ok(migration.includes(required), `migration is missing ${required}`)
}
// The raw token is returned exactly once; the table stores only the SHA-256 hex.
assert.match(migration, /encode\(digest\(v_token, 'sha256'\), 'hex'\)/)
assert.match(migration, /'ok', true, 'id', v_invite_id, 'token', v_token/)

// --- Phase 60 migration: automatic channel provisioning ------------------
for (const required of [
  'normalized_org_label',
  'employee_matches_department_channel',
  'sync_auto_channel_members',
  'reconcile_auto_channel_membership_for_employee',
  'backfill_auto_channel_memberships',
  'trg_employee_auto_channel_sync',
  'trg_profile_auto_channel_sync',
  'handle_new_user',
]) {
  assert.ok(migration.includes(required), `migration is missing ${required}`)
}
// Department channels now match the departments master, not raw free text.
assert.match(migration, /normalized_org_label\(v_dept\) = public\.normalized_org_label\(d\.name\)/)
assert.match(migration, /normalized_org_label\(v_dept\) = public\.normalized_org_label\(d\.code\)/)
// Re-sync never touches manual/owner memberships (auto_added provenance only).
assert.match(migration, /delete from public\.message_channel_members cm\s+where cm\.channel_id = p_channel_id\s+and cm\.auto_added = true\s+and cm\.member_id <> all\(v_qualifying\)/)
// Employee auto-eligibility ignores archived and departed staff.
assert.match(migration, /coalesce\(e\.is_archived, false\) = false/)
// Preserve the Phase 10 signup contract (customer role, pending) behind the link.
assert.match(migration, /'customer', 'pending'/)
assert.match(migration, /on conflict \(id\) do nothing/)

// --- Phase 60 migration: member-management overrides + comm-admin -------
for (const required of [
  'add_channel_member',
  'remove_channel_member',
  'update_channel_member_role',
  'add_group_member',
  'remove_group_member',
  'update_group_member_role',
  'suspend_channel_member',
  'unsuspend_channel_member',
  'suspend_group_member',
  'unsuspend_group_member',
]) {
  assert.ok(migration.includes(required), `migration is missing ${required}`)
}
// Owner protection survives the override.
assert.match(migration, /'owner'/i)
// Role-set calls still go through one shared audit helper.
assert.match(migration, /write_communication_audit/)

// --- Phase 44 reset wipes invites ---------------------------------------
assert.ok(reset.includes('message_invites'), 'platform reset does not wipe message_invites')

// --- Frontend service helpers -------------------------------------------
for (const required of [
  'createMessageInvite',
  'revokeMessageInvite',
  'listMessageInvites',
  'getInviteContext',
  'joinViaInvite',
  'buildInviteUrl',
  'waShareUrl',
]) {
  assert.ok(chatService.includes(required), `corporateChatService is missing ${required}`)
}
assert.match(chatService, /\/#\/chat\?invite=/)
assert.match(chatService, /https:\/\/wa\.me\/\?text=/)
assert.ok(conversations.includes('createMessageInvite'), 'Conversations does not import createMessageInvite')

// --- Conversations MemberPanel ------------------------------------------
for (const required of [
  'Create invite link',
  'Invite via link',
  'Re-sync from org chart',
  'COMM_ADMIN_ROLES',
  'Search members…',
  'displayPersonName',
]) {
  assert.ok(conversations.includes(required), `Conversations is missing ${required}`)
}
// Comm-admin can manage members even without an owner/admin role in the room.
assert.match(conversations, /canManage = \['owner', 'admin'\]\.includes\(myRole\) \|\| isCommAdmin/)
// Invite joins land as plain members, never as owner/admin.
assert.match(conversations, /Auto ·|Automatic ·/)

// --- MessagesPage invite deep-link --------------------------------------
for (const required of ['getInviteContext', 'joinViaInvite', "qs.get('invite')", 'inviteCtx']) {
  assert.ok(messagesPage.includes(required), `MessagesPage is missing ${required}`)
}
assert.match(messagesPage, /Join \{inviteCtx\.scope\}/)
assert.match(messagesPage, /Open \{inviteCtx\.scope\}/)

console.log('Member management contract checks passed.')