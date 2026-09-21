// Shared server-side validator + normalizer for RECRUITMENT assessment
// questions (assessment_templates -> assessment_template_questions).
//
// This is recruitment-scoped and deliberately separate from the Training/KSS
// validator (kssQuestionValidator.js) — the two question banks have different
// schemas and must not be conflated.
//
// Plain ESM so it can be imported by the Deno edge function
// (supabase/functions/sara-candidate-analysis) AND by the node test suite
// (tests/assessmentAnalytics.test.mjs).
//
// The AI/import path must never silently save garbage: these helpers either
// return a fully-valid clean array or null. Strict — never auto-corrects
// wrong values except type-prescribed normalizations (true/false casing,
// whitespace trimming, options forced for true_false).

const QUESTION_TYPES = ['multiple_choice', 'true_false', 'numerical', 'multiple_select', 'ranking']
const DIFFICULTIES = ['easy', 'medium', 'hard']

function trim(value) {
  return String(value == null ? '' : value).trim()
}

function asNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function nonEmptyOptions(options) {
  if (!Array.isArray(options)) return []
  return options.map((o) => String(o == null ? '' : o).trim()).filter((o) => o.length > 0)
}

// Normalize one raw question into a clean, schema-valid row — or null when it
// cannot be trusted. `textOf` is used when the raw input is text/string-based
// (parsed sample files) rather than object-based.
export function sanitizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const questionText = trim(raw.question_text || raw.question || '')
  if (!questionText || questionText.length > 2000) return null

  let type = String(raw.question_type || 'multiple_choice').trim()
  if (!QUESTION_TYPES.includes(type)) type = 'multiple_choice'

  let options = nonEmptyOptions(raw.options)
  let correctAnswer = raw.correct_answer ?? raw.correct ?? raw.answer ?? null

  if (type === 'true_false') {
    options = ['True', 'False']
    const cf = trim(correctAnswer).toLowerCase()
    correctAnswer = cf.startsWith('t') ? 'True' : cf.startsWith('f') ? 'False' : null
    if (!correctAnswer) return null
  } else if (type === 'multiple_select' || type === 'ranking') {
    if (options.length < 2) return null
    let answer = Array.isArray(correctAnswer) ? correctAnswer : []
    if (!Array.isArray(correctAnswer) && correctAnswer != null) {
      answer = String(correctAnswer).split(/[,;|]/).map((s) => s.trim()).filter(Boolean)
    }
    const optionSet = new Set(options)
    answer = answer.filter((a) => optionSet.has(a)).map((a) => String(a).trim())
    if (answer.length === 0) return null
    correctAnswer = answer
  } else if (type === 'multiple_choice') {
    if (options.length < 2) return null
    const cf = trim(correctAnswer)
    if (!cf) return null
    if (!options.includes(cf)) return null
    correctAnswer = cf
  } else if (type === 'numerical') {
    options = []
    if (asNumber(correctAnswer) === null) return null
    correctAnswer = trim(correctAnswer)
  }

  const marks = asNumber(raw.marks ?? raw.marks ?? 1)
  const difficulty = DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : 'medium'
  const competency = trim(raw.competency || '').slice(0, 200) || null

  return {
    question_text: questionText.slice(0, 2000),
    question_type: type,
    options,
    correct_answer: correctAnswer,
    marks: marks !== null && marks > 0 ? marks : 1,
    difficulty,
    competency,
  }
}

// Strict validation of an AI/import-produced array. Returns the clean array
// (all rows valid) or null. The response is rejected wholesale when ANY row is
// invalid or the batch is empty — malformed AI output must never partially save.
export function validateQuestionSet(parsed) {
  if (!parsed || !Array.isArray(parsed.questions)) return null
  if (parsed.questions.length === 0) return null
  const clean = []
  const seen = new Set()
  for (const item of parsed.questions) {
    const q = sanitizeQuestion(item)
    if (!q) return null
    const key = q.question_text.toLowerCase()
    if (seen.has(key)) return null
    seen.add(key)
    clean.push(q)
  }
  return clean.length > 0 ? clean : null
}

// Validator for an already-parsed array of objects (sample files / direct use).
export function validateQuestionRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const clean = []
  const seen = new Set()
  for (const item of rows) {
    const q = sanitizeQuestion(item)
    if (!q) return null
    const key = q.question_text.toLowerCase()
    if (seen.has(key)) return null
    seen.add(key)
    clean.push(q)
  }
  return clean.length > 0 ? clean : null
}

export const ASSESSMENT_QUESTION_VALIDATION_COPY =
  'AI generated questions could not be validated. Please retry or enter the questions manually.'