import assert from 'node:assert/strict'
import { isValidHttpUrl, isValidMeetingUrl } from '../src/lib/meetingLink.js'

// --- isValidHttpUrl (create-form manual paste) ---
assert.equal(isValidHttpUrl('https://meet.google.com/abc-defg-hij'), true)
assert.equal(isValidHttpUrl('https://zoom.us/j/123456789'), true)
assert.equal(isValidHttpUrl('http://example.com/x'), true)
assert.equal(isValidHttpUrl('not a url'), false)
assert.equal(isValidHttpUrl('ftp://example.com/x'), false)
assert.equal(isValidHttpUrl(''), false)
assert.equal(isValidHttpUrl(null), false)

// --- isValidMeetingUrl (session meeting-panel manual fallback) ---
// Normal meet.google.com style links are accepted.
assert.equal(isValidMeetingUrl('https://meet.google.com/abc-defg-hij'), true)
assert.equal(isValidMeetingUrl('https://meet.google.com/xxx-xxxx-xxx'), true)
assert.equal(isValidMeetingUrl('http://meet.google.com/abc'), true)
// Not a Meet host -> rejected.
assert.equal(isValidMeetingUrl('https://zoom.us/j/123'), false)
assert.equal(isValidMeetingUrl('https://example.com/meet/google'), false)
// Garbage -> rejected.
assert.equal(isValidMeetingUrl('meet.google.com/abc'), false)
assert.equal(isValidMeetingUrl(''), false)
assert.equal(isValidMeetingUrl(null), false)
assert.equal(isValidMeetingUrl('javascript:alert(1)'), false)

// Edge spacing is tolerated.
assert.equal(isValidMeetingUrl('  https://meet.google.com/abc-defg-hij  '), true)

console.log('meetingLink.test.mjs passed')