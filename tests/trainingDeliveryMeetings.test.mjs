import assert from 'node:assert/strict'
import fs from 'node:fs'

const migration = fs.readFileSync(new URL('../schema_phase58_training_delivery_meeting_links.sql', import.meta.url), 'utf8')

// Delivery model columns on training_sessions
for (const column of [
  'delivery_type', 'venue_id', 'venue_name', 'venue_address',
  'meeting_platform', 'meeting_url', 'meeting_provider_id', 'meeting_created_at',
]) {
  assert.match(migration, new RegExp(`add column if not exists ${column}\\b`), `${column} added idempotently`)
  assert.match(migration, new RegExp(`add column if not exists ${column}\\b[^;]*`), `${column} declared`)
}

// Required + checked vocabulary
assert.match(migration, /delivery_type text not null default 'physical'\s*check \(delivery_type in \('physical', 'virtual'\)\)/)
assert.match(migration, /meeting_platform text\s*check \(meeting_platform is null or meeting_platform in \('google_meet', 'zoom'\)\)/)
assert.match(migration, /venue_id uuid references public\.branches\(id\) on delete set null/)

// Backfill: legacy virtual_link sessions become virtual; venue from branches
assert.match(migration, /where delivery_type = 'physical'\s*and virtual_link is not null/)
assert.match(migration, /venue_id = b\.id/)
assert.match(migration, /venue_name = coalesce\(nullif\(trim\(s\.venue_name\), ''\), b\.branch_name\)/)

// Security: provider host-control link (zoom start_url) must never be persisted
assert.doesNotMatch(migration, /start_url/)
assert.doesNotMatch(migration, /access_token/)
assert.doesNotMatch(migration, /client_secret/)

// Must remain additive — no new tables, no drops, no data-scrubbing inserts
assert.doesNotMatch(migration, /create table/)
assert.doesNotMatch(migration, /drop table/)
assert.doesNotMatch(migration, /delete from/)

// Index for the delivery filter
assert.match(migration, /create index if not exists idx_training_sessions_delivery/)

console.log('trainingDeliveryMeetings.test.mjs passed')