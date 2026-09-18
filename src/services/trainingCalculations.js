export const TRAINING_TYPES = [
  { value: 'internal', label: 'Internal training' },
  { value: 'external', label: 'External training' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'induction', label: 'Induction' },
  { value: 'refresher', label: 'Refresher' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'seminar', label: 'Seminar' },
  { value: 'technical', label: 'Technical training' },
  { value: 'management', label: 'Management training' },
  { value: 'kss', label: 'Knowledge Sharing Session (KSS)' },
]

export const formatTrainingType = (value) => {
  const found = TRAINING_TYPES.find((item) => item.value === value)
  return found?.label || String(value || '').replace(/_/g, ' ')
}

export const hours = (minutes) => Number((Number(minutes || 0) / 60).toFixed(2))

export function buildQuestionSets(questions = []) {
  const clean = questions
    .map((question) => ({
      prompt: String(question.prompt || '').trim(),
      question_type: question.question_type || 'multiple_choice',
      options: Array.isArray(question.options) ? question.options.filter(Boolean) : [],
      correct_answer: question.correct_answer,
      marks: Number(question.marks || 1),
    }))
    .filter((question) => question.prompt)

  if (clean.length < 3) throw new Error('Add at least three KSS questions so the three sets are meaningfully different.')

  return [0, 1, 2].map((setIndex) => {
    const rotated = clean.map((_, index) => clean[(index + setIndex) % clean.length])
    return rotated.map((question, questionIndex) => ({
      ...question,
      options: question.options.length > 1
        ? question.options.map((_, optionIndex) => question.options[(optionIndex + setIndex) % question.options.length])
        : question.options,
      display_order: questionIndex,
    }))
  })
}

export function calculateTrainingManHours(durationMinutes, participantCount) {
  return hours(Number(durationMinutes || 0) * Number(participantCount || 0))
}

export function calculateManHourSummary({ scheduledHours = 0, attendanceHours = 0, trainingHours = 0, kssHours = 0, trainingManHours = 0, overtimeHours = 0, absenceHours = 0, lateHours = 0, earlyDepartureHours = 0 } = {}) {
  return {
    scheduledHours: Number(scheduledHours || 0),
    attendanceHours: Number(attendanceHours || 0),
    trainingHours: Number(trainingHours || 0),
    kssHours: Number(kssHours || 0),
    trainingManHours: Number(trainingManHours || 0),
    overtimeHours: Number(overtimeHours || 0),
    absenceHours: Number(absenceHours || 0),
    lateHours: Number(lateHours || 0),
    earlyDepartureHours: Number(earlyDepartureHours || 0),
  }
}

const AGGREGATE_FIELDS = ['scheduledHours', 'attendanceHours', 'trainingHours', 'kssHours', 'trainingManHours', 'overtimeHours', 'absenceHours', 'lateHours', 'earlyDepartureHours']

export function aggregateManHourRows(rows = []) {
  const add = (target, row) => {
    AGGREGATE_FIELDS.forEach((field) => { target[field] = Number((target[field] || 0) + Number(row[field] || 0)) })
    return target
  }
  const business = add({}, {})
  const areaMap = new Map()
  const branchMap = new Map()
  rows.forEach((row) => {
    add(business, row)
    const area = row.area || 'Unassigned'
    const branch = row.branch || 'Unassigned'
    if (!areaMap.has(area)) areaMap.set(area, add({}, {}))
    if (!branchMap.has(branch)) branchMap.set(branch, add({}, {}))
    add(areaMap.get(area), row)
    add(branchMap.get(branch), row)
  })
  return {
    business,
    areas: Object.fromEntries(areaMap),
    branches: Object.fromEntries(branchMap),
    employees: rows,
  }
}
