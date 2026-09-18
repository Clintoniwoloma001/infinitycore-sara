import assert from 'node:assert/strict'
import {
  calculateWorkedHours,
  calculateWorkedMinutes,
  formatWorkedHours,
  normalizeWorkingDays,
} from '../src/services/attendanceCalculations.js'

const record = {
  clock_in: '2026-09-18T06:45:00.000Z',
  clock_out: '2026-09-18T16:02:00.000Z',
  work_hours: null,
}

assert.equal(calculateWorkedMinutes(record), 557)
assert.equal(calculateWorkedHours(record), 9.28)
assert.equal(formatWorkedHours(record), '9.3 hours')
assert.equal(calculateWorkedHours({ work_hours: 6.6 }), 6.6)
assert.equal(calculateWorkedHours({ clock_in: record.clock_in }), null)
assert.deepEqual(normalizeWorkingDays(['Monday', 'tue', 'FRIDAY']), ['mon', 'tue', 'fri'])

console.log('attendance calculations: ok')
