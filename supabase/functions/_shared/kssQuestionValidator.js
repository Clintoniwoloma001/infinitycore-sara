// Shared server-side validator for AI-generated KSS questions.
//
// Plain ESM so it can be imported by the Deno edge function
// (supabase/functions/generate-training-questions) AND by the node test suite
// (tests/trainingQuestionGeneration.test.mjs). Mirrors the task rules:
// reject unless exactly three valid questions with the correct answer present
// among exactly three non-empty options and no duplicate questions.

function normalize(value) {
  return String(value || '').trim()
}

function validOptions(options) {
  return Array.isArray(options) && options.length === 3 && options.every((option) => normalize(option).length > 0)
}

// Returns an array of `{ question, correct_answer, options }` when the parsed
// AI response is valid, otherwise null. Never auto-corrects AI mistakes — the
// correct answer MUST already be one of the supplied options.
export function validateGeneratedQuestions(parsed) {
  if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length !== 3) return null
  const clean = []
  const seen = new Set()
  for (const item of parsed.questions) {
    const question = normalize(item?.question)
    const correctAnswer = normalize(item?.correct_answer)
    if (!question || !correctAnswer) return null
    if (!validOptions(item?.options)) return null
    const options = item.options.map((option) => normalize(option))
    if (!options.includes(correctAnswer)) return null
    const key = question.toLowerCase()
    if (seen.has(key)) return null
    seen.add(key)
    clean.push({ question, correct_answer: correctAnswer, options })
  }
  return clean.length === 3 ? clean : null
}

// Compose the EXISTING KSS question-bank line format:
//   Question | Correct answer | Option 1, Option 2, Option 3
export function formatQuestionLines(questions) {
  return questions.map((q) => `${q.question} | ${q.correct_answer} | ${q.options.join(', ')}`)
}

export const KSS_QUESTION_VALIDATION_COPY = 'AI generated questions could not be validated. Please retry or enter questions manually.'