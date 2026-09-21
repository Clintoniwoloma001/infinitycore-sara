import assert from 'node:assert/strict'
import fs from 'node:fs'
import { validateGeneratedQuestions, formatQuestionLines } from '../supabase/functions/_shared/kssQuestionValidator.js'

const edgeFn = fs.readFileSync(new URL('../supabase/functions/generate-training-questions/index.ts', import.meta.url), 'utf8')
const trainingPage = fs.readFileSync(new URL('../src/pages/Training.jsx', import.meta.url), 'utf8')

// ---- Shared validator unit tests ----

const valid = [
  { question: 'What is the cash limit?', correct_answer: '500k', options: ['500k', '1m', '2m'] },
  { question: 'Who owns customer data?', correct_answer: 'The bank', options: ['Agents', 'The bank', 'Everyone'] },
  { question: 'When must alerts be logged?', correct_answer: 'Immediately', options: ['Immediately', 'Within a week', 'Never'] },
]

// Valid response -> exactly 3 clean questions, pipe format preserved.
const clean = validateGeneratedQuestions({ questions: valid })
assert.ok(clean, 'valid response accepted')
assert.equal(clean.length, 3)
const lines = formatQuestionLines(clean)
assert.equal(lines.length, 3)
assert.match(lines[0], /What is the cash limit\? \| 500k \| 500k, 1m, 2m/)

// Fewer / more than 3 questions.
assert.equal(validateGeneratedQuestions({ questions: valid.slice(0, 2) }), null)
assert.equal(validateGeneratedQuestions({ questions: [...valid, valid[0]] }), null)

// Missing question / answer / options.
assert.equal(validateGeneratedQuestions({ questions: [{ ...valid[0], question: '  ' }] }), null)
assert.equal(validateGeneratedQuestions({ questions: [valid[0], { ...valid[0], correct_answer: '' }, valid[1]] }), null)
assert.equal(validateGeneratedQuestions({ questions: [valid[0], { ...valid[0], options: ['a'] }, valid[1]] }), null)

// Correct answer not among the options.
assert.equal(validateGeneratedQuestions({ questions: [valid[0], { ...valid[0], options: ['a', 'b', 'c'] }, valid[1]] }), null)

// Empty options.
assert.equal(validateGeneratedQuestions({ questions: [valid[0], { ...valid[0], options: ['a', ' ', 'c'] }, valid[1]] }), null)

// Duplicate questions.
assert.equal(validateGeneratedQuestions({ questions: [valid[0], valid[0], valid[1]] }), null)

// Malformed delimiter structure / non-array.
assert.equal(validateGeneratedQuestions({ questions: 'nope' }), null)
assert.equal(validateGeneratedQuestions(null), null)
assert.equal(validateGeneratedQuestions({}), null)

// ---- Edge function surface ----
assert.match(edgeFn, /OPENAI_ENDPOINT/)
assert.match(edgeFn, /gpt-4o-mini/)
assert.match(edgeFn, /npm:unpdf@1\.8\.1/)
assert.match(edgeFn, /npm:mammoth@1\.12\.3/)
assert.match(edgeFn, /text-based PDF\/DOCX\/TXT file/)
assert.match(edgeFn, /consume_sara_ai_usage/)
assert.match(edgeFn, /AI_QUESTION_GENERATION/)
assert.match(edgeFn, /KSS_QUESTION_VALIDATION_COPY/)
assert.match(edgeFn, /_shared\/kssQuestionValidator\.js/)
assert.doesNotMatch(edgeFn, /\.from\('training_questions'\)/)

// ---- Training page UI surface ----
assert.match(trainingPage, /Generate Questions from Document/)
assert.match(trainingPage, /accept="\.txt,\.pdf,\.docx"/)
assert.match(trainingPage, /txt|pdf|docx/)
assert.match(trainingPage, /Review and edit them below/)
assert.match(trainingPage, /textarea/)

// The user-friendly validation copy is delivered via the shared module.
assert.match(
  fs.readFileSync(new URL('../supabase/functions/_shared/kssQuestionValidator.js', import.meta.url), 'utf8'),
  /AI generated questions could not be validated\. Please retry or enter questions manually\./
)

console.log('trainingQuestionGeneration.test.mjs passed')