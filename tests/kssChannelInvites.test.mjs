import assert from 'node:assert/strict'
import fs from 'node:fs'

const kssMigration = fs.readFileSync(new URL('../schema_phase63_kss_channel_training_invites.sql', import.meta.url), 'utf8')
const invitesFn = fs.readFileSync(new URL('../supabase/functions/send-training-invites/index.ts', import.meta.url), 'utf8')

// --- KSS persistent channel ---
assert.match(kssMigration, /'kss-announcements'/)
assert.match(kssMigration, /create or replace function public\.ensure_kss_channel\(\)/)
assert.match(kssMigration, /channel_type\s*[,)]|[']announcement[']/)
assert.match(kssMigration, /is_auto, auto_source, auto_source_role/)
assert.match(kssMigration, /true, 'role', 'all'/)

// Reuses the existing Phase 40 tables — no new tables created, no drops.
assert.doesNotMatch(kssMigration, /create table( if not exists)?\s+public\.message_channels\b/)
assert.doesNotMatch(kssMigration, /drop table/)

// Idempotent single-member add + activation trigger.
assert.match(kssMigration, /create or replace function public\.kss_channel_add_member\(p_user_id uuid\)/)
assert.match(kssMigration, /on conflict \(channel_id, member_id\) do nothing/)
assert.match(kssMigration, /trg_profiles_active_kss_member/)

// Auto-membership sync must work in server/bootstrap contexts (no hard auth.uid()).
assert.match(kssMigration, /create or replace function public\.sync_auto_channel_members\(p_channel_id uuid\)/)
assert.match(kssMigration, /auto_added = true/)
assert.match(kssMigration, /grant execute on function public\.sync_auto_channel_members\(uuid\) to authenticated/)
assert.match(kssMigration, /grant execute on function public\.ensure_kss_channel\(\) to authenticated/)
assert.match(kssMigration, /grant execute on function public\.kss_channel_add_member\(uuid\) to authenticated/)

// Bootstrap at end of migration.
assert.match(kssMigration, /select public\.ensure_kss_channel\(\)/)

// --- KSS training auto-post lives in the existing send-training-invites edge ---
// Only KSS sessions post to the KSS channel (non-KSS must NOT post).
assert.match(invitesFn, /const isKss = session\.training_type === 'kss'/)
assert.match(invitesFn, /ensure_kss_channel/)
assert.match(invitesFn, /send_mention_message/)
assert.match(invitesFn, /if \(isKss\) {/)
assert.match(invitesFn, /channel\.ok \? 'posted' : 'failed'/)

// Emails + in-app notifications use the same edge function; partial failures reported.
assert.match(invitesFn, /RESEND_API_KEY/)
assert.match(invitesFn, /api\.resend\.com\/emails/)
assert.match(invitesFn, /emailFailed/)
assert.match(invitesFn, /notifiedCount/)

console.log('kssChannelInvites.test.mjs passed')