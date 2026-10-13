// ============================================================================
// SARA's local command routing — the wrong-answer bug
// ============================================================================
// Reported conversation (web, before the fix):
//
//   HOW MANY LEAVE DO I HAVE LEFT ?
//   -> "You have no pending leave approvals."          <-- WRONG QUESTION ANSWERED
//   WHAT IS MY LEAVE BALANCE ?
//   -> "Your leave balances: Annual Leave: 10 of 10."  <-- correct
//   WHAT IS AWELE"S LEAVE BALANCE ?
//   -> "SARA could not answer that just now."          <-- real reason hidden
//
// TWO BUGS, both in the local intent parser (not the AI):
//
//   1. `COUNT_PENDING` matched the bare word "leave", so any "how many <leave>
//      ..." question was routed to the pending-approvals counter. Asking about
//      your own ENTITLEMENT therefore got a count of somebody else's queue.
//
//   2. The balance matcher accepted only "my" and "how much" as the opener, so
//      even with bug 1 fixed, "how many ..." could never reach it.
//
// Both fixed, and pinned here.
// ============================================================================
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const parserMod = await import(
  `data:text/javascript,${encodeURIComponent(
    readFileSync(join(root, 'src/services/saraCommandParser.js'), 'utf8')
      .replace(/import[\s\S]*?from '[^']*'\s*/g, ''),
  )}`,
)
const { parseSaraCommand } = parserMod

let failed = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok  ${label}`)
  } catch (e) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${e.message}`)
  }
}

console.log('\n1. Asking about MY OWN leave entitlement is a BALANCE question')

check('"how many leave do I have left"', () => {
  assert.equal(parseSaraCommand('HOW MANY LEAVE DO I HAVE LEFT ?').intent, 'MY_LEAVE_BALANCE')
  assert.equal(parseSaraCommand('how many leave do i have left').intent, 'MY_LEAVE_BALANCE')
  assert.equal(parseSaraCommand('how many leave days do i have').intent, 'MY_LEAVE_BALANCE')
})

check('the phrasings that already worked keep working', () => {
  assert.equal(parseSaraCommand('what is my leave balance').intent, 'MY_LEAVE_BALANCE')
  assert.equal(parseSaraCommand('how much leave do i have').intent, 'MY_LEAVE_BALANCE')
  assert.equal(parseSaraCommand('my annual leave').intent, 'MY_LEAVE_BALANCE')
})

check('asking about a DIFFERENT person stays a permission question', () => {
  // Not mine. It must NOT be answered from my own balance, and it must NOT be
  // routed to the pending-approvals counter either. It goes to the server,
  // which either answers from the caller's grants or refuses properly.
  const r = parseSaraCommand('what is awele leave balance')
  assert.notEqual(r.intent, 'MY_LEAVE_BALANCE')
  assert.notEqual(r.intent, 'COUNT_PENDING')
  assert.notEqual(r.intent, 'SHOW_PENDING')
})

console.log('\n2. The pending-approvals counter still counts pending approvals')

check('a genuine pending question still routes to COUNT_PENDING', () => {
  assert.equal(parseSaraCommand('how many pending leave approvals do i have').intent, 'COUNT_PENDING')
  assert.equal(parseSaraCommand('how many approvals are awaiting me').intent, 'COUNT_PENDING')
  assert.equal(parseSaraCommand('count my approvals').intent, 'COUNT_PENDING')
})

check('and SHOW_PENDING still lists them', () => {
  assert.equal(parseSaraCommand('show my pending leave requests').intent, 'SHOW_PENDING')
})

console.log('\n3. The generic failure copy is only the last resort')

const svc = readFileSync(join(root, 'src/services/saraChatService.js'), 'utf8')

check('every cause gets its own honest message', () => {
  for (const code of [
    'forbidden', 'unauthorized', 'rate_limited', 'timeout', 'ai_empty',
    'ai_not_configured', 'ai_invalid_key', 'ai_billing', 'ai_network',
    'ai_timeout', 'ai_provider_error',
  ]) {
    assert.match(svc, new RegExp(`\\b${code}:`), `no message for "${code}"`)
  }
})

check('a permission refusal says so, not "could not answer"', () => {
  assert.match(svc, /forbidden: 'You do not have access to that information/)
  assert.match(svc, /unauthorized: 'Please sign in again/)
})

check('the vague sentence is no longer shared by many causes', () => {
  // The old map pointed four codes at one shared NO_ANSWER string. GENERIC_FAILURE
  // is now the last resort only, and nothing may point at it by name.
  const vague = svc.match(/const GENERIC_FAILURE =\s*\n?\s*'([^']+)'/)[1]
  const shared = [...svc.matchAll(/^\s+(ai_\w+|rate_limited|timeout|ai_empty): '(.*)',$/gm)]
    .filter((m) => m[2] === vague)
  assert.equal(shared.length, 0, 'no cause should still share the generic text')
  // And it must not be the text an unknown code falls through to by name.
  assert.match(svc, /ERROR_MESSAGES\[code\] \|\| UNKNOWN|ERROR_MESSAGES\[code\] \|\| GENERIC_FAILURE/)
})

check('the router\'s own degradation notice is surfaced, not dropped', () => {
  assert.match(svc, /export function degradedNotice/)
  assert.match(svc, /response\.degraded/)
  assert.match(svc, /response\.notice/)
})

console.log('\n4. Mobile reports the same reasons as web')

const dart = readFileSync(join(root, '../infinitycore-mobile/lib/features/sara/sara_chat_service.dart'), 'utf8')

check('mobile maps the same codes', () => {
  for (const code of [
    'forbidden', 'unauthorized', 'rate_limited', 'timeout', 'ai_empty',
    'ai_invalid_key', 'ai_billing', 'ai_network', 'ai_provider_error',
  ]) {
    assert.match(dart, new RegExp(`'${code}':`), `no mobile message for "${code}"`)
  }
})

check('mobile no longer rewrites every code to ai_unavailable', () => {
  // The old _errorCode() whitelisted four codes and flattened the rest.
  assert.ok(!/const known = \{[\s\S]*?'ai_unavailable',[\s\S]*?\};/.test(dart))
  assert.match(dart, /final code = explicit\?\.toString\(\)\.trim\(\)/)
})

check('mobile surfaces the degraded notice too', () => {
  assert.match(dart, /degraded/)
  assert.match(dart, /notice/)
})

console.log('\n5. The command list the copy promises actually exists')

check('SARA_COMMANDS is exported and non-empty', () => {
  assert.match(svc, /export const SARA_COMMANDS = \[/)
  assert.match(svc, /label:/)
})

check('the panel renders those commands', () => {
  const sara = readFileSync(join(root, 'src/components/sara/Sara.jsx'), 'utf8')
  assert.match(sara, /SARA_COMMANDS\.map\(/)
  assert.match(sara, /handleCommand\(c\.example, 'text'\)/)
})

console.log('')
if (failed > 0) {
  console.log(`${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('All SARA honest-error and intent-routing checks passed.')
