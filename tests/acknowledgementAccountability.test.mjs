import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ackRequiredByMe,
  isOwnMessage,
  messagePriority,
  messageRequiresAck,
  summarizeAcks,
  ackProgressLabel,
  ACK_COMPLETE_LABEL,
} from '../src/services/ackRules.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260931000003_ack_accountability_and_push_subscriptions.sql')
const directTab = read('src/components/messages/DirectTab.jsx')
const conversations = read('src/components/messages/Conversations.jsx')
const messageBubble = read('src/components/messages/MessageBubble.jsx')
const layout = read('src/components/Layout.jsx')
const banner = read('src/components/chat/AckReminderBanner.jsx')
const sw = read('public/sw.js')
const push = read('src/services/webPushService.js')

const ME = 'me'
const THEM = 'them'
const OTHER = 'other'

const ackRow = (userId, status) => ({ user_id: userId, status })
const important = (senderId) => ({ requires_ack: true, priority: 'high', sender_id: senderId })
const normal = (senderId) => ({ requires_ack: false, priority: 'normal', sender_id: senderId })

// --- Point 12: priority drives the acknowledgement requirement ---
assert.equal(messageRequiresAck(important(ME)), true, 'Important requires acknowledgment')
assert.equal(messageRequiresAck({ requires_ack: true, priority: 'urgent' }), true, 'Urgent requires acknowledgment')
assert.equal(messageRequiresAck(normal(ME)), false, 'Normal never requires acknowledgment')
assert.equal(messageRequiresAck(undefined), false, 'a missing message requires nothing')
assert.equal(messagePriority({ priority: 'urgent' }), 'urgent')
assert.equal(messagePriority({ priority: 'important' }), 'high')
assert.equal(messagePriority({}), 'normal')
assert.equal(messagePriority({ priority: 'critical' }), 'urgent')

// --- Point 1: the sender is never in debt and never blocked ---
assert.equal(isOwnMessage({ sender_id: ME }, ME), true, 'the sender owns their message')
assert.equal(
  ackRequiredByMe(important(ME), [ackRow(ME, 'pending')], ME),
  false,
  'the sender must never be blocked by their own urgent message',
)
assert.equal(
  ackRequiredByMe(important(THEM), [ackRow(ME, 'pending')], ME),
  true,
  'a recipient with a pending row still owes an acknowledgment',
)
// The regression: DirectTab was missing this guard, so an urgent DIRECT message
// gated the sender's own composer until the RECIPIENT acknowledged.
assert.ok(
  /const myAckRequired = \(msg\) => \{[\s\S]*?if \(msg\.sender_id === me\) return false/.test(directTab),
  'DirectTab.myAckRequired must exclude the sender (point 1)',
)
assert.ok(
  /if \(msg\.sender_id === me\) return false/.test(conversations),
  'Conversations.myAckRequired must exclude the sender (point 1)',
)

// --- Point 2: acknowledgment is durable and per user ---
assert.equal(
  ackRequiredByMe(important(THEM), [ackRow(ME, 'acknowledged')], ME),
  false,
  'once acknowledged it stays acknowledged',
)
assert.equal(
  ackRequiredByMe(important(THEM), [ackRow(ME, 'acknowledged'), ackRow(THEM, 'pending')], ME),
  false,
  'my acknowledgment is not affected by who else still owes one',
)
assert.equal(
  ackRequiredByMe(important(THEM), [ackRow(THEM, 'acknowledged')], ME),
  true,
  'somebody else acknowledging does not clear my obligation',
)

// --- Point 4/5: the audience is frozen and the tally counts real acks ---
const freshSummary = summarizeAcks([ackRow(THEM, 'pending'), ackRow(OTHER, 'pending')])
assert.equal(freshSummary.total, 2, 'the denominator is the seeded audience')
assert.equal(freshSummary.done, 0, 'a brand-new broadcast has no acknowledgments')
assert.equal(freshSummary.complete, false, 'a brand-new broadcast is NOT settled')
assert.equal(
  ackProgressLabel(freshSummary),
  '0 of 2 acknowledged · 2 pending',
  'the seeded pending rows must not be counted as acknowledgments',
)

const partial = summarizeAcks([ackRow(THEM, 'acknowledged'), ackRow(OTHER, 'pending')])
assert.equal(partial.done, 1)
assert.equal(partial.pending, 1)
assert.equal(partial.complete, false, 'one of two is not complete')
assert.equal(ackProgressLabel(partial), '1 of 2 acknowledged · 1 pending')

const done = summarizeAcks([ackRow(THEM, 'acknowledged'), ackRow(OTHER, 'acknowledged')])
assert.equal(done.complete, true, 'every recipient acknowledging settles the message')
// The completion label always names the count, so the sender can see the size
// of the audience they reached.
assert.equal(ackProgressLabel(done), 'ALL 2 RECIPIENTS ACKNOWLEDGED')
assert.ok(ackProgressLabel(done).includes('ALL 2 RECIPIENTS ACKNOWLEDGED'))
// A single-recipient ledger has no ambiguity either.
assert.equal(
  ackProgressLabel(summarizeAcks([ackRow(THEM, 'acknowledged')])),
  ACK_COMPLETE_LABEL,
)

// The regression: the UI tallied ROWS, so a new group broadcast read as fully
// acknowledged the instant it was sent.
assert.ok(
  /const \{ done, total, pending, complete \} = summarizeAcks\(acks\)/.test(messageBubble),
  'the bubble tally must use summarizeAcks, not the raw row count',
)
assert.ok(
  messageBubble.includes('ALL ${total} RECIPIENTS ACKNOWLEDGED'),
  'the completed ledger must show ALL RECIPIENTS ACKNOWLEDGED (point 5)',
)

// --- Point 5: acknowledged and pending are rendered separately ---
assert.ok(messageBubble.includes('Still outstanding'), 'the roster needs a PENDING section')
assert.ok(messageBubble.includes('Acknowledged ('), 'the roster needs an ACKNOWLEDGED section')
assert.ok(messageBubble.includes('acknowledged_at'), 'the roster must show the ack timestamp')

// --- Point 3/4: direct vs group audience, frozen at creation ---
assert.ok(
  migration.includes('list_pending_acks_for_me'),
  'the global banner needs a server-side pending list',
)
assert.ok(
  /from public\.chat_message_acks mine[\s\S]*?mine\.status = 'pending'/.test(migration),
  'pending acks must be read from the seeded rows',
)
assert.ok(
  /m\.sender_id is distinct from auth\.uid\(\)/.test(migration),
  'the sender must never appear in their own pending list',
)
// The denominator is the seeded row count, not live membership, so a later join
// or leave cannot move it. BOTH the audience total and the acknowledged count
// must be derived from the seeded rows.
const audienceCounts = migration.match(
  /select count\(\*\)::int\s+from public\.chat_message_acks x\s+where x\.message_id = m\.id( and x\.status = 'acknowledged')?\)/g,
) || []
assert.ok(
  audienceCounts.length >= 2,
  'the audience total and the acknowledged count must both come from the seeded rows',
)

// --- Point 14: only the seeded audience can acknowledge ---
assert.ok(
  migration.includes("raise exception 'You are not a recipient of this message'"),
  'a non-audience user must be refused',
)
assert.ok(
  /update public\.chat_message_acks[\s\S]*?and user_id = v_me[\s\S]*?and status <> 'acknowledged'/.test(migration),
  'the acknowledge write must be scoped to the caller and must not insert',
)
const ackFn = (migration.split('create or replace function public.acknowledge_chat_message')[1] || '').split('grant execute')[0]
assert.ok(
  !ackFn.includes('insert into public.chat_message_acks'),
  'acknowledge_chat_message must never INSERT an ack row (point 14)',
)

// --- Point 11: one subscription row per endpoint, multi-device ---
assert.ok(migration.includes('create table if not exists public.push_subscriptions'))
assert.ok(
  migration.includes('constraint push_subscriptions_endpoint_unique unique (endpoint)'),
  'one row per endpoint so several devices coexist',
)
assert.ok(migration.includes('idx_push_subs_user'), 'a user must be able to list all their devices')
assert.ok(migration.includes('record_push_failure'), 'a revoked endpoint must be removable')

// --- Point 7: the banner lives in the application SHELL ---
assert.ok(layout.includes('<AckReminderBanner />'), 'the reminder must be mounted in Layout')
assert.ok(
  layout.includes("from './chat/AckReminderBanner'"),
  'Layout must import the banner',
)

// --- Point 8: dismissal is not acknowledgment, and resurfaces after 5 min ---
assert.ok(
  banner.includes('const RESURFACE_MS = 5 * 60 * 1000'),
  'the banner must resurface after exactly 5 minutes',
)
assert.ok(
  banner.includes('DISMISS_KEY'),
  'a dismissal must be recorded',
)
assert.ok(
  banner.includes('Hide for 5 minutes'),
  'the dismiss control must state that it is not an acknowledgment',
)
assert.ok(
  !/onDismiss[\s\S]{0,400}?acknowledgeMessage/.test(banner),
  'dismissal must never call acknowledge',
)
// The only thing that clears the obligation is a successful server write.
assert.ok(
  /await acknowledgeMessage\(row\.message_id\)[\s\S]{0,200}?await refresh\(\)/.test(banner),
  'only a successful server write may clear the obligation',
)

// --- Points 9/10/18: real push, not an in-app toast ---
assert.ok(sw.includes("self.addEventListener('push'"), 'the service worker must handle push')
assert.ok(sw.includes("self.addEventListener('notificationclick'"), 'a tap must open the message')
assert.ok(sw.includes('event.notification.data?.url'), 'the tap must deep-link to the message')
assert.ok(
  sw.includes('requireInteraction: urgent'),
  'urgent must persist until acknowledged (point 12)',
)
assert.ok(
  push.includes('URGENT MESSAGE') && push.includes('IMPORTANT MESSAGE'),
  'push copy must follow point 10',
)
assert.ok(
  push.includes('Acknowledgement required.'),
  'push copy must state that an acknowledgment is required',
)
assert.ok(
  push.includes('register_push_subscription'),
  'the client must register its subscription with the backend',
)
// No VAPID private key may ever be committed to the client bundle.
assert.ok(
  !/VITE_VAPID_PRIVATE|BEGIN PRIVATE KEY/.test(push),
  'a VAPID private key must never be in the client',
)

console.log('acknowledgement accountability: all assertions passed')
