import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isActiveAccount } from '../src/components/messages/personUtils.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const migration = read('supabase/migrations/20260921000020_messages_identity_directory_left_join.sql')
const service = read('src/services/corporateChatService.js')
const personUtils = read('src/components/messages/personUtils.js')
const directTab = read('src/components/messages/DirectTab.jsx')
const conversations = read('src/components/messages/Conversations.jsx')
const bubble = read('src/components/messages/MessageBubble.jsx')
const layout = read('src/components/Layout.jsx')
const messagesPage = read('src/components/messages/MessagesPage.jsx')
const peoplePicker = read('src/components/messages/PeoplePicker.jsx')

// ------------------------------------------------------------------
// 1. Resolve RPC must NEVER drop an id just because the profiles row is
//    missing — it drives from the requested ids and LEFT JOINs employee
//    records, carrying has_account so the UI can label instead of fake.
// ------------------------------------------------------------------
assert.match(migration, /create or replace function public\.resolve_user_identity\(p_user_ids uuid\[\]\)/)
assert.match(migration, /from unnest\(p_user_ids\) as u\(user_id\)/)
assert.match(migration, /left join public\.profiles p on p\.id = u\.user_id/)
assert.match(migration, /left join lateral \(/)
assert.match(migration, /'has_account', \(p\.id is not null\)/)
assert.match(migration, /grant execute on function public\.resolve_user_identity\(uuid\[\]\) to authenticated/)

// ------------------------------------------------------------------
// 2. Directory must include employee-linked accounts that have NO profile
//    row (auto-synced channel members) — the old INNER JOIN would have
//    hidden them behind "Unknown User".
// ------------------------------------------------------------------
assert.match(migration, /create or replace function public\.get_messaging_directory\(p_search text default null\)/)
assert.match(migration, /from auth\.users u/)
assert.match(migration, /left join public\.profiles p on p\.id = u\.id/)
assert.match(migration, /left join lateral \(/)
// The employee-without-profile exemption is a single parenthesized term and
// the customer exclusion stays independent (WHERE precedence matters — a bare
// `(p.id is null and e.id is not null or coalesce(...) <> 'customer')` would
// wrongly keep every profile-less NON-employee auth user).
assert.match(migration, /where \(\s*\(p\.id is null and e\.id is not null\)\s+or coalesce\(p\.role, 'customer'\) <> 'customer'/)
assert.match(migration, /limit 1000/)

// ------------------------------------------------------------------
// 3. Client indexer must not coerce a person whose name matches their
//    email into "Unknown User" — it surfaces the email (or null) instead
//    and carries hasAccount. (The separate explicit displayName() escape
//    hatch for a genuinely unknown participant stays.)
// ------------------------------------------------------------------
const identityFn = service.slice(service.indexOf('function indexIdentityById'), service.indexOf('export function displayName'))
assert.ok(!identityFn.includes("'Unknown User'"), 'indexIdentityById never coerces to "Unknown User"')
assert.match(service, /name: fullName \|\| r\.email \|\| null/)
assert.match(service, /hasAccount: !!r\.has_account/)
// Direct thread names resolve from identity OR the people directory — never
// a hardcoded "Unknown User" fallback.
assert.ok(!directTab.includes("return 'Unknown User'"), 'DirectTab personName has no "Unknown User" fallback')
assert.match(messagesPage, /has_account: p\.has_account !== undefined \? !!p\.has_account : true/)
assert.match(messagesPage, /hasAccount: p\.has_account !== undefined \? !!p\.has_account : true/)

// ------------------------------------------------------------------
// 4. isActiveAccount: admin/super_admin always active; missing profile row
//    ("No account yet") is inactive; pending/suspended/rejected inactive;
//    active or profile-present-but-status-less active.
// ------------------------------------------------------------------
assert.equal(isActiveAccount(null), false)
assert.equal(isActiveAccount({}), true)
assert.equal(isActiveAccount({ hasAccount: false }), false)
assert.equal(isActiveAccount({ role: 'super_admin', hasAccount: false, profileStatus: '' }), true)
assert.equal(isActiveAccount({ role: 'admin' }), true)
assert.equal(isActiveAccount({ role: 'staff', hasAccount: false }), false)
assert.equal(isActiveAccount({ role: 'staff', hasAccount: true, profileStatus: 'active' }), true)
assert.equal(isActiveAccount({ role: 'staff', hasAccount: true, profileStatus: '' }), true)
assert.equal(isActiveAccount({ role: 'staff', hasAccount: true, profileStatus: 'pending' }), false)
assert.equal(isActiveAccount({ role: 'staff', hasAccount: true, profileStatus: 'suspended' }), false)
assert.equal(isActiveAccount({ role: 'staff', hasAccount: true, profileStatus: 'rejected' }), false)
assert.equal(isActiveAccount({ profile_status: 'active' }), true)

// ------------------------------------------------------------------
// 5. Shared PeoplePicker wiring: ONE component, single mode for direct
//    DMs, multi mode for channel/group member bulk-add.
// ------------------------------------------------------------------
assert.match(directTab, /import PeoplePicker from '\.\/PeoplePicker'/)
assert.match(directTab, /<PeoplePicker\s+title="New Message"/)
assert.match(directTab, /mode="single"/)
assert.match(directTab, /filteredThreads\.map\(\(t\) =>/)
assert.match(directTab, /placeholder="Search direct messages…"/)
assert.match(conversations, /import PeoplePicker from '\.\/PeoplePicker'/)
assert.match(conversations, /<PeoplePicker\s+title=\{isGroup \? 'Add People' : 'Add Channel Member'\}/)
assert.match(conversations, /mode="multi"/)
assert.match(conversations, /placeholder=\{`Search \$\{isGroup \? 'groups' : 'channels'\}…`\}/)
// MemberPanel labels members without an active account instead of faking a name
assert.match(conversations, /No account yet/)
assert.match(conversations, /memberIsActive|isActiveAccount\(/)
assert.match(conversations, /This person does not have an active account yet\./)

// ------------------------------------------------------------------
// 6. MessageBubble takes a person and renders the shared avatar for
//    non-mine messages.
// ------------------------------------------------------------------
assert.match(bubble, /import PersonAvatar from '\.\/PersonAvatar'/)
assert.match(bubble, /person = null,/)
assert.match(bubble, /<PersonAvatar person=\{person\}/)
assert.match(directTab, /person=\{identity\[m\.sender_id\] \|\| people\.find\(\(p\) => p\.id === m\.sender_id\)\}/)
assert.match(conversations, /person=\{ident \|\| people\.find\(\(p\) => p\.id === m\.sender_id\) \|\| null\}/)

// ------------------------------------------------------------------
// 7. Sidebar chip uses the shared avatar fed by the identity resolver.
// ------------------------------------------------------------------
assert.match(layout, /import PersonAvatar from '\.\/messages\/PersonAvatar'/)
assert.match(layout, /import \{ resolveDirectory \} from '\.\.\/services\/corporateChatService'/)
assert.match(layout, /<PersonAvatar person=\{identityMap\?\.\[user\?\.id\] \|\| \{ full_name: name, email \}\}/)

// ------------------------------------------------------------------
// 8. The picker itself reuses the single avatar + personMatches helpers.
// ------------------------------------------------------------------
assert.match(peoplePicker, /const filtered = useMemo\(\(\) =>/)
assert.match(peoplePicker, /personMatches\(p, search\)/)
assert.match(peoplePicker, /<PersonAvatar person=\{p\} sizeClass="w-9 h-9" textClass="text-xs" \/>/)
assert.match(peoplePicker, /z-\[60\]/)

console.log('messages-identity: all assertions passed')