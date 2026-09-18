import assert from 'node:assert/strict'
import {
  buildQuestionSets,
  aggregateManHourRows,
  calculateManHourSummary,
  calculateTrainingManHours,
  hours,
} from '../src/services/trainingCalculations.js'

assert.equal(calculateTrainingManHours(120, 50), 100, '2-hour training x 50 participants = 100 man-hours')
assert.equal(hours(120), 2, '120 minutes = 2 individual training hours')

const summary = calculateManHourSummary({
  scheduledHours: 80,
  attendanceHours: 72,
  trainingHours: 4,
  kssHours: 2,
  trainingManHours: 100,
  overtimeHours: 3,
  absenceHours: 8,
  lateHours: 1.5,
  earlyDepartureHours: 0.5,
})
assert.equal(summary.trainingHours, 4)
assert.equal(summary.attendanceHours, 72)
assert.equal(summary.trainingManHours, 100)
assert.notEqual(summary.trainingHours, summary.trainingManHours)

const hierarchy = aggregateManHourRows([
  { employee: 'Ada', area: 'AREA 1', branch: 'Branch A', scheduledHours: 8, attendanceHours: 7, trainingHours: 2, trainingManHours: 4 },
  { employee: 'Bola', area: 'AREA 1', branch: 'Branch A', scheduledHours: 8, attendanceHours: 8, trainingHours: 1, trainingManHours: 2 },
  { employee: 'Chidi', area: 'AREA 2', branch: 'Branch B', scheduledHours: 8, attendanceHours: 6, trainingHours: 3, trainingManHours: 6 },
])
assert.equal(hierarchy.business.scheduledHours, 24, 'business aggregation')
assert.equal(hierarchy.areas['AREA 1'].trainingHours, 3, 'area aggregation')
assert.equal(hierarchy.branches['Branch A'].attendanceHours, 15, 'branch aggregation')
assert.equal(hierarchy.employees.length, 3, 'employee drilldown rows')

const sets = buildQuestionSets([
  { prompt: 'One', options: ['A', 'B', 'C'], correct_answer: 'A' },
  { prompt: 'Two', options: ['A', 'B', 'C'], correct_answer: 'B' },
  { prompt: 'Three', options: ['A', 'B', 'C'], correct_answer: 'C' },
  { prompt: 'Four', options: ['A', 'B', 'C'], correct_answer: 'A' },
])
assert.equal(sets.length, 3)
assert.equal(new Set(sets.map((set) => set.map((question) => question.prompt).join('|'))).size, 3, 'KSS question ordering differs per set')
assert.equal(sets.every((set) => set.length === 4), true)

console.log('trainingCalculations.test.mjs passed')
