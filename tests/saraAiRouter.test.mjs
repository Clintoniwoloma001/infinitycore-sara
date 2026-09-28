// SARA AI provider router — content + deterministic-behaviour tests.
// No live DB and no provider network: the rules tier is pure code, so every
// feature can be asserted for real behaviour rather than only for wiring.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const ROUTER = read('supabase/functions/_shared/aiRouter.ts')
const RULES = read('supabase/functions/_shared/rulesEngine.ts')
const MIGRATION = read('supabase/migrations/20260928000001_sara_ai_provider_router.sql')

const { deterministicAnswer, RESPONDERS, RULES_ENGINE_VERSION } = await import(
  '../supabase/functions/_shared/rulesEngine.ts'
)

let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}

const json = (feature, rulesData) => JSON.parse(deterministicAnswer(feature, { rulesData }).text)

console.log('\nSARA AI provider router\n')

// ---------------------------------------------------------------------------
// 1. Chain + catalog
// ---------------------------------------------------------------------------

test('default chain is gemini > groq > rules > openai > nvidia', () => {
  assert.match(ROUTER, /DEFAULT_CHAIN = \['gemini', 'groq', 'rules', 'openai', 'nvidia'\]/)
  const match = ROUTER.match(/DEFAULT_CHAIN = \[([^\]]+)\]/)
  assert.deepEqual(match[1].split(',').map((s) => s.trim().replace(/'/g, '')), [
    'gemini', 'groq', 'rules', 'openai', 'nvidia',
  ])
})

test('every provider in the default chain is described in the catalog', () => {
  for (const id of ['gemini', 'groq', 'rules', 'openai', 'nvidia']) {
    assert.ok(new RegExp(`\\b${id}: \\{ id: '${id}'`).test(ROUTER), `catalog entry for ${id}`)
  }
})

test('all five providers have adapters or an internal handler', () => {
  assert.match(ROUTER, /async function geminiGenerate/)
  assert.match(ROUTER, /async function geminiTurn/)
  // groq, openai and nvidia all share the OpenAI-compatible adapter.
  assert.match(ROUTER, /openAiCompatibleGenerate/)
  assert.match(ROUTER, /openAiCompatibleTurn/)
  const compat = ROUTER.match(/OPENAI_COMPATIBLE: Record<[^>]*> = \{([\s\S]*?)\n\}/)
  for (const id of ['groq', 'openai', 'nvidia']) {
    assert.ok(compat[1].includes(`${id}: {`), `${id} wired to the OpenAI-compatible adapter`)
  }
})

test('provider secrets are read server-side only, and never returned', () => {
  assert.match(ROUTER, /const SECRET_ENV: Record<string, string\[\]> = \{/)
  for (const env of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY']) {
    assert.ok(ROUTER.includes(env), `secret env ${env} supported`)
  }
  // The secret lookup must not appear in any response shape.
  const secretExports = [...ROUTER.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1])
  assert.ok(secretExports.includes('hasProviderSecret'))
  assert.ok(!ROUTER.includes('api_key: key'))
  assert.ok(!ROUTER.includes('secret: key'))
})

// ---------------------------------------------------------------------------
// 2. Never say "AI unavailable"
// ---------------------------------------------------------------------------

test('the literal outage phrase appears nowhere in the router or rules engine', () => {
  for (const [name, source] of [['aiRouter.ts', ROUTER], ['rulesEngine.ts', RULES]]) {
    assert.ok(
      !/ai_unavailable|AI unavailable|AI is unavailable/i.test(source),
      `${name} must not contain the outage phrase`,
    )
  }
})

test('the router never returns a failure for an exhausted chain, it returns a usable message', () => {
  const tail = ROUTER.slice(ROUTER.indexOf('Unreachable in practice'))
  assert.match(tail, /Your existing commands and reports are unaffected/)
  assert.ok(!/throw new AiRouterExhausted/.test(ROUTER), 'route() resolves rather than throwing')
})

test('every failure code has user-safe wording and no raw provider body', () => {
  const codes = [...ROUTER.matchAll(/'ai_[a-z_]+'/g)].map((m) => m[0])
  const unique = [...new Set(codes)]
  for (const code of unique) {
    const literal = code.replace(/'/g, '')
    // 'ai_provider_error' is deliberately the documented default branch.
    assert.ok(
      ROUTER.includes(`case '${literal}':`) || literal === 'ai_provider_error',
      `describeFailure has a case for ${literal}`,
    )
  }
  // No adapter may interpolate a provider body into a thrown message.
  assert.ok(!/new AiProviderError\([^)]*body/.test(ROUTER))
  assert.ok(!/new AiProviderError\([^)]*await readErrorDetail/.test(ROUTER))
})

test('errors are scrubbed before they could reach a log', () => {
  assert.match(ROUTER, /\[redacted\]/)
  assert.match(ROUTER, /Bearer\s\[redacted\]/)
})

// ---------------------------------------------------------------------------
// 3. Failover mechanics
// ---------------------------------------------------------------------------

test('a provider without its secret is skipped without spending an attempt on a call', () => {
  assert.match(ROUTER, /if \(!hasProviderSecret\(entry\.id\)\)/)
  assert.match(ROUTER, /code: 'ai_not_configured'/)
})

test('a failure falls through to the next tier instead of returning', () => {
  const catchBlock = ROUTER.slice(ROUTER.indexOf('const code = classifyError(error)'))
  assert.match(catchBlock, /attempts\.push\(\{ provider: entry\.id, outcome: 'failure'/)
  assert.ok(!/return\s*\{[^}]*failedOver: false[^}]*\}\s*\n\s*\}/.test(catchBlock))
})

test('unparseable JSON fails over rather than surfacing a parse error', () => {
  assert.match(ROUTER, /parseLooseJson\(result\.text\)\n\s*if \(parsed === undefined\) throw new AiProviderError\('ai_invalid_json'/)
})

test('cooling providers are demoted but retained', () => {
  assert.match(ROUTER, /Number\(a\.cooling_down\) - Number\(b\.cooling_down\)/)
})

test('failover can be switched off to primary-only', () => {
  assert.match(ROUTER, /if \(!config\.failover_enabled\) return chain\.slice\(0, 1\)/)
})

test('latency is measured per attempt, not cumulatively from the request start', () => {
  assert.ok(!/const ms = Date\.now\(\) - started\n\s*if \(options\.mode === 'json'\)/.test(ROUTER))
  const perAttempt = (ROUTER.match(/const ms = Date\.now\(\) - attemptStarted/g) || []).length
  assert.ok(perAttempt >= 3, `every serving path times its own attempt (found ${perAttempt})`)
})

test('every serving path records both the attempt and the completed call', () => {
  const logSuccess = (ROUTER.match(/await logSuccess\(/g) || []).length
  assert.equal(logSuccess, 4, 'internal turn/generate + remote turn + remote json + remote generate')
  assert.match(ROUTER, /recordOutcome\(admin, entry\.id, \{ model, outcome: 'success'/)
  assert.match(ROUTER, /recordCall\(admin, attempts, entry\.id/)
})

test('the internal tier is a guaranteed terminal provider, appended when absent', () => {
  assert.match(ROUTER, /PROVIDER_CATALOG\[id\]\.kind === 'internal'/)
  assert.match(ROUTER, /chain\.push\(\{[\s\S]*?kind: 'internal'/)
})

// ---------------------------------------------------------------------------
// 4. Deterministic rules engine — real behaviour per feature
// ---------------------------------------------------------------------------

test('every feature advertised by the router has a rules responder', () => {
  const features = [...ROUTER.matchAll(/\{ id: '([a-z_]+)', label:/g)].map((m) => m[1])
  assert.equal(features.length, 16, `feature catalog complete (${features.length})`)
  for (const feature of features) {
    assert.ok(RESPONDERS[feature], `rules responder for ${feature}`)
  }
})

test('an unknown feature still answers instead of returning nothing', () => {
  const answer = deterministicAnswer('not_a_real_feature', { prompt: 'how many pending leave requests?' })
  assert.ok(answer.text.trim().length > 20, 'grounded reply produced')
  assert.equal(answer.text.trim().endsWith('undefined'), false)
})

test('the rules engine never throws for hostile or empty input', () => {
  for (const feature of Object.keys(RESPONDERS)) {
    for (const rulesData of [undefined, null, {}, { candidate: null }, { candidates: 'nope' }, { responses: [null] }]) {
      const answer = deterministicAnswer(feature, { rulesData })
      assert.equal(typeof answer.text, 'string')
      assert.ok(answer.text.length > 0, `${feature} produced text`)
    }
  }
})

test('intent classification mirrors the sara-intent JSON contract', () => {
  const parsed = json('intent', { text: 'approve annual leave for Ada Obi' })
  assert.equal(parsed.intent, 'APPROVE_LEAVE')
  assert.equal(parsed.entities.leave_type, 'annual')
  assert.ok('entities' in parsed && 'criteria' in parsed && 'confidence' in parsed)
  assert.equal(typeof parsed.all, 'boolean')
})

test('intent classification respects the allowed-intent allow-list', () => {
  const parsed = json('intent', { text: 'terminate this employee', allowed: ['APPROVE_LEAVE', 'UNKNOWN'] })
  assert.equal(parsed.intent, 'UNKNOWN')
})

test('intent extraction pulls days into criteria', () => {
  assert.equal(json('intent', { text: 'show leave requests more than 14 days' }).criteria.min_days, 14)
  assert.equal(json('intent', { text: 'show leave within 5 days' }).criteria.max_days, 5)
  assert.equal(json('intent', { text: 'pending leave requests' }).intent, 'SHOW_PENDING')
  assert.equal(json('intent', { text: 'how many are pending' }).intent, 'COUNT_PENDING')
  assert.equal(json('intent', { text: 'bananas' }).intent, 'UNKNOWN')
})

test('chat answers a "how many" question with the exact figure', () => {
  const answer = deterministicAnswer('chat', {
    prompt: 'how many pending leave requests are there?',
    rulesData: { metrics: { pending_leave_requests: 7 } },
  })
  assert.match(answer.text, /7/)
  assert.ok(!/undefined/.test(answer.text))
})

test('chat greets and lists capabilities without inventing numbers', () => {
  const greeting = deterministicAnswer('chat', { prompt: 'hello' })
  assert.match(greeting.text, /SARA/)
  const help = deterministicAnswer('chat', { prompt: 'what can you do?' })
  assert.match(help.text, /Approve or reject leave requests/)
  const empty = deterministicAnswer('chat', { prompt: 'explain the loan book' })
  assert.ok(!/NaN/.test(empty.text))
})

test('summary reports the real open items and attendance rate', () => {
  const text = deterministicAnswer('summary', {
    rulesData: {
      metrics: {
        pending_leave_requests: 4,
        pending_user_approvals: 3,
        active_employees: 210,
        attendance_today: { total_employees: 210, present: 180, late: 6, absent: 30 },
      },
    },
  }).text
  assert.match(text, /7 items are waiting/)
  assert.match(text, /85\.7% \(180\/210 present, 6 late, 30 absent\)/)
  assert.match(text, /210 employees are active/)
})

test('summary admits when it has no data rather than inventing a position', () => {
  const text = deterministicAnswer('summary', { rulesData: {} }).text
  assert.match(text, /No operational data is available/)
  assert.ok(!/\d+ employees/.test(text))
})

test('candidate screening is a transparent weighted score with reasons', () => {
  const parsed = json('candidate_screening', {
    job: { requirements: 'Excel, accounting and loan experience' },
    criteria: { required_skills: ['Excel', 'Accounting', 'Lending'], min_experience_years: 3, min_education: 'HND' },
    candidate: { skills: 'Excel, customer service', experience_years: 4, education: 'HND Accounting', cv_file_name: 'cv.pdf' },
  })
  assert.ok(parsed.score > 0 && parsed.score <= 100)
  assert.deepEqual(parsed.matched_skills, ['Excel', 'Accounting'])
  assert.deepEqual(parsed.missing_skills, ['Lending'])
  assert.equal(parsed.engine, 'rules')
  assert.ok(parsed.reasons.length >= 4, 'every scored component is explained')
  assert.ok(parsed.reasons.some((r) => /4 year\(s\) against a 3-year requirement/.test(r)))
})

test('candidate screening refuses to score what it was not given', () => {
  const parsed = json('candidate_screening', { candidate: { skills: 'Excel' } })
  assert.match(JSON.stringify(parsed.reasons), /No comparable experience figures were supplied/)
  assert.match(parsed.notice, /starting point for HR review rather than a decision/)
})

test('candidate ranking is deterministic and total-ordered', () => {
  const batch = { candidates: [
    { id: 1, candidate_name: 'Weak', skills: '', experience_years: 0 },
    { id: 2, candidate_name: 'Strong', skills: 'Excel, Accounting, Lending, Compliance', experience_years: 8, education: 'MSc', cv_file_name: 'cv.pdf' },
  ], criteria: { required_skills: ['Excel', 'Accounting', 'Lending'], min_experience_years: 3 } }
  const first = json('candidate_ranking', batch)
  const second = json('candidate_ranking', batch)
  assert.deepEqual(first, second, 'same input, same output')
  assert.deepEqual(first.rankings.map((r) => r.rank), [1, 2])
  assert.equal(first.rankings[0].candidate_id, 2)
  assert.equal(first.rankings[0].candidate_name, 'Strong')
  assert.ok(first.rankings[0].score > first.rankings[1].score)
})

test('ranking an empty batch returns an empty list, not a throw', () => {
  assert.deepEqual(json('candidate_ranking', {}).rankings, [])
})

test('assessment generation returns exactly three well-formed questions', () => {
  for (const category of ['technical', 'behavioral', 'practical', 'psychometric', 'unknown-category']) {
    const { questions, engine } = json('assessment_generation', { category, title: 'Relationship Officer' })
    assert.equal(engine, 'rules')
    assert.equal(questions.length, 3, `${category} yields three questions`)
    for (const q of questions) {
      assert.ok(q.question.length > 10)
      assert.equal(q.options.length, 4)
      assert.ok(q.options.includes(q.correct_answer), 'correct answer is among the options')
      assert.equal(new Set(q.options).size, 4, 'options are distinct')
    }
  }
})

test('the correct answer is not always the first option', () => {
  const { questions } = json('assessment_generation', { category: 'technical' })
  const positions = questions.map((q) => q.options.indexOf(q.correct_answer))
  assert.ok(new Set(positions).size > 1, `answer positions rotate (${positions.join(',')})`)
})

test('assessment scoring is arithmetic over the marked answers', () => {
  const parsed = json('assessment_analysis', { responses: [
    { awarded_marks: 1, total_marks: 1, is_correct: true },
    { awarded_marks: 0, total_marks: 1, is_correct: false },
    { awarded_marks: 1, total_marks: 2, is_correct: true },
  ] })
  assert.equal(parsed.awarded, 2)
  assert.equal(parsed.available, 4)
  assert.equal(parsed.score, 50)
  assert.equal(parsed.band, 'meets')
  assert.equal(parsed.correct_answers, 2)
  assert.equal(parsed.incorrect_answers, 1)
})

test('assessment scoring returns null rather than a fake zero when nothing was marked', () => {
  assert.equal(json('assessment_analysis', { responses: [] }).score, null)
})

test('interview analysis groups the interviewer wording and never invents a rating', () => {
  const withRating = json('interview_analysis', {
    rating: 82,
    notes: 'Strong grasp of reconciliations. Could not explain the escalation path clearly.',
  })
  assert.equal(withRating.recommendation, 'shortlist')
  assert.equal(withRating.overall_rating, 82)
  assert.equal(withRating.strengths.length, 1)
  assert.equal(withRating.concerns.length, 1)
  const withoutRating = json('interview_analysis', { notes: 'Average session.' })
  assert.equal(withoutRating.recommendation, 'insufficient_information')
  assert.equal(json('interview_analysis', {}).recommendation, 'insufficient_information')
})

test('recruitment shortlist respects the capacity it is given', () => {
  const rankings = [{ candidate_id: 1, score: 90 }, { candidate_id: 2, score: 70 }, { candidate_id: 3, score: 50 }]
  assert.equal(json('recruitment_recommendation', { rankings, shortlist_capacity: 2 }).shortlist.length, 2)
  assert.equal(json('recruitment_recommendation', { rankings, shortlist_capacity: 0 }).shortlist.length, 3)
  assert.match(json('recruitment_recommendation', { rankings, shortlist_capacity: 2 }).notice, /capacity of 2/)
})

test('attendance summary computes the rate and flags the exception queue', () => {
  const text = deterministicAnswer('attendance_summary', { rulesData: { records: [
    { status: 'present', employee_name: 'Ada' },
    { status: 'present', employee_name: 'Bode' },
    { status: 'late', employee_name: 'Chidi' },
    { status: 'absent', employee_name: 'Dami' },
    { status: 'present', employee_name: 'Efe', exception_count: 1 },
  ] } }).text
  assert.match(text, /4 of 5 staff attended \(80\.0%\)/, 'a late arrival still counts as attended')
  assert.match(text, /1 arrived after the late threshold/)
  assert.match(text, /1 were absent/)
  assert.match(text, /below the 90% expectation/)
  assert.match(deterministicAnswer('attendance_summary', { rulesData: { records: [] } }).text, /nothing to summarise/)
})

test('leave analysis breaks days down by type and finds entitlement risk', () => {
  const text = deterministicAnswer('leave_analysis', { rulesData: {
    records: [
      { leave_type: 'Annual', days: 5, status: 'approved' },
      { leave_type: 'Annual', days: 3, status: 'pending', created_at: '2026-01-01', employee_name: 'Ada' },
      { leave_type: 'Sick', days: 2, status: 'approved' },
    ],
    balances: [
      { employee_name: 'Ada', effective_entitlement: 10, used_days: 9 },
      { employee_name: 'Bode', effective_entitlement: 20, used_days: 2 },
    ],
  } }).text
  assert.match(text, /annual 8d, sick 2d/)
  assert.match(text, /1 employee\(s\) have used 80% or more/)
  assert.match(text, /Ada/)
  assert.match(text, /Oldest pending request: Ada, 3 day\(s\)/)
})

test('performance review reports the average and the extremes', () => {
  const text = deterministicAnswer('performance_review', { rulesData: { reviews: [
    { employee_name: 'Ada', score: 88 }, { employee_name: 'Bode', score: 62 }, { employee_name: 'Chidi', score: 40 },
  ] } }).text
  assert.match(text, /3 of 3 reviews carry a score\. Average 63\.3/)
  assert.match(text, /Highest: Ada \(88\)/)
  assert.match(text, /Lowest: Chidi \(40\)/)
  assert.match(deterministicAnswer('performance_review', { rulesData: { reviews: [{ employee_name: 'Ada' }] } }).text, /no average could be computed/)
})

test('MPR summary applies the component weights', () => {
  const text = deterministicAnswer('mpr_summary', { rulesData: {
    employee: { full_name: 'Ada Obi' },
    period_label: 'Q3 2026',
    components: [
      { name: 'Productivity', score: 80, weight: 60 },
      { name: 'Conduct', score: 100, weight: 40 },
    ],
  } }).text
  assert.match(text, /Overall score: 88\.0 out of 100 \(weights total 100\)/)
  assert.match(text, /Productivity: 80 at 60% weight → 48\.0 points/)
  assert.match(text, /Conduct: 100 at 40% weight → 40\.0 points/)
  assert.match(deterministicAnswer('mpr_summary', { rulesData: { components: [] } }).text, /no score could be computed/)
})

test('MPR weights that do not total 100 do not silently inflate the score', () => {
  const text = deterministicAnswer('mpr_summary', { rulesData: { components: [{ name: 'Only', score: 50, weight: 50 }] } }).text
  assert.match(text, /weights total 50/)
})

test('BankOne analytics separates credits from debits and sizes the overdue book', () => {
  const text = deterministicAnswer('bankone_analytics', { rulesData: {
    transactions: [
      { type: 'credit', amount: 500000 }, { type: 'debit', amount: 200000 }, { type: 'repayment', amount: 100000 },
    ],
    loans: [
      { principal: 1000000, outstanding_principal: 400000, days_past_due: 0 },
      { principal: 500000, outstanding_principal: 100000, days_past_due: 30 },
    ],
  } }).text
  assert.match(text, /₦600,000\.00 credited, ₦200,000\.00 debited, net ₦400,000\.00/)
  assert.match(text, /2 loan\(s\) with ₦500,000\.00 outstanding \(33\.3% of principal\)/)
  assert.match(text, /1 loan\(s\) are past due, totalling ₦100,000\.00/)
  assert.match(deterministicAnswer('bankone_analytics', { rulesData: {} }).text, /nothing to analyse/)
})

test('training question generation produces three drafts framed for the topic', () => {
  const { questions, notice } = json('training_questions', { title: 'KYC Fundamentals', description: 'for relationship officers' })
  assert.equal(questions.length, 3)
  assert.match(notice, /KYC Fundamentals/)
  assert.match(notice, /Review and edit them before publishing/)
})

test('KSS drafts match the strict question-bank contract', () => {
  // Mirrors validateGeneratedQuestions() in _shared/kssQuestionValidator.js, which
  // the edge function runs on whatever the router returns.
  const { questions } = json('training_questions', { title: 'KYC Fundamentals' })
  assert.equal(questions.length, 3, 'exactly three questions')
  const texts = new Set()
  for (const q of questions) {
    assert.ok(q.question.trim().length > 0)
    assert.equal(q.options.length, 3, 'exactly three options')
    assert.ok(q.options.every((o) => o.trim().length > 0), 'no empty option')
    assert.ok(q.options.includes(q.correct_answer), 'correct answer present verbatim')
    assert.equal(new Set(q.options).size, 3, 'no duplicate options')
    texts.add(q.question.toLowerCase())
  }
  assert.equal(texts.size, 3, 'no duplicate questions')
})

test('the candidate scorecard places the result against the peer averages', () => {
  const parsed = json('candidate_scorecard', {
    candidate: { full_name: 'Ada Obi', role: 'Relationship Officer', percentage: 65 },
    questions: [
      { question: 'Q1', awarded_marks: 2, total_marks: 2, is_correct: true, flagged: false },
      { question: 'Q2', awarded_marks: 0, total_marks: 2, is_correct: false, flagged: true },
    ],
    peer_comparison: { template_average: 55, role_average: 60, percentile: 72 },
  })
  assert.equal(parsed.peer_comparison.percentile, 72)
  assert.equal(parsed.peer_comparison.delta_percent, 5, '65% against the 60% role average')
  assert.match(parsed.summary, /Ada Obi scored 65% for Relationship Officer/)
  assert.match(parsed.summary, /5 points above the role average of 60%/)
  assert.match(parsed.summary, /72nd percentile/)
  assert.deepEqual(parsed.flags_review, ['Q2'])
  assert.equal(parsed.recommended_action, 'manual_review', 'a flagged answer forces review')
})

test('the scorecard sends a candidate to review when they are well behind', () => {
  const parsed = json('candidate_scorecard', {
    candidate: { full_name: 'Bode', role: 'Loan Officer', percentage: 25 },
    questions: [{ question: 'Q1', awarded_marks: 1, total_marks: 4, is_correct: false, flagged: false }],
    peer_comparison: { template_average: 80, role_average: 78, percentile: 8 },
  })
  assert.equal(parsed.peer_comparison.delta_percent, -53)
  assert.match(parsed.summary, /53 points below the role average of 78%/)
  assert.ok(parsed.concerns.length >= 1, 'the gap is raised as a concern')
})

test('the scorecard derives the percentage from the marked answers when none is recorded', () => {
  const parsed = json('candidate_scorecard', {
    candidate: { full_name: 'Ada Obi', role: 'Relationship Officer' },
    questions: [
      { question: 'Q1', awarded_marks: 2, total_marks: 2, is_correct: true, flagged: false },
      { question: 'Q2', awarded_marks: 0, total_marks: 2, is_correct: false, flagged: false },
    ],
    peer_comparison: { template_average: 55, role_average: 60, percentile: 72 },
  })
  assert.match(parsed.summary, /Ada Obi scored 50% for Relationship Officer/)
  assert.equal(parsed.peer_comparison.delta_percent, -10, '50% is 10 points under the 60% role average')
  assert.equal(parsed.peer_comparison.reference_type, 'role', 'the role average is the benchmark')
})

test('the scorecard admits when it was given nothing to work with', () => {
  const parsed = json('candidate_scorecard', {})
  assert.equal(parsed.recommended_action, 'manual_review')
  assert.match(parsed.summary, /no scorecard could be produced/)
  assert.match(parsed.notice, /only available when a language model is reachable/)
})

// ---------------------------------------------------------------------------
// 6. Edge function wiring
// ---------------------------------------------------------------------------

const CHAT = read('supabase/functions/sara-chat/index.ts')
const INTENT = read('supabase/functions/sara-intent/index.ts')
const CANDIDATE = read('supabase/functions/sara-candidate-analysis/index.ts')
const TRAINING_Q = read('supabase/functions/generate-training-questions/index.ts')

test('every SARA edge function routes through the shared router', () => {
  for (const [name, source] of [['sara-chat', CHAT], ['sara-intent', INTENT], ['sara-candidate-analysis', CANDIDATE], ['generate-training-questions', TRAINING_Q]]) {
    assert.match(source, /from '\.\.\/_shared\/aiRouter\.ts'/, `${name} imports the router`)
  }
})

test('no edge function imports the single-provider Gemini client any more', () => {
  for (const [name, source] of [['sara-chat', CHAT], ['sara-intent', INTENT]]) {
    assert.ok(!/from '\.\.\/_shared\/gemini\.ts'/.test(source), `${name} no longer pins one provider`)
  }
})

test('no edge function surfaces the outage phrase to a caller', () => {
  for (const [name, source] of [['sara-chat', CHAT], ['sara-intent', INTENT], ['sara-candidate-analysis', CANDIDATE], ['generate-training-questions', TRAINING_Q]]) {
    assert.ok(!/ai_unavailable|AI is temporarily unavailable/i.test(source), `${name} is clean`)
  }
})

test('chat and summary report degradation instead of failing', () => {
  assert.match(CHAT, /degraded: routed\.degraded/)
  assert.match(CHAT, /remote_providers_ready/)
  assert.ok(!/try \{ geminiApiKey\(\) \} catch \{ return json\(\{ ok: false, error: 'ai_not_configured' \}\) \}/.test(CHAT))
})

test('sara-chat passes the live snapshot to the rules tier and the tools', () => {
  assert.match(CHAT, /rulesData: snapshot/)
  assert.match(CHAT, /const data = await snapshot\(\)/)
  // The snapshot is memoised so it is never fetched twice for one request.
  assert.match(CHAT, /snapshotPromise \|\|= operationalSummary\(db, context\)/)
})

test('the internal summary tier is folded into the bullet contract the client renders', () => {
  assert.match(CHAT, /\.split\('\\n'\)\.map\(\(line\) => line\.trim\(\)\)/)
})

test('intent classification keeps its server-side allow-list in the rules tier', () => {
  assert.match(INTENT, /rulesData: \{ text, allowed \}/)
  assert.match(INTENT, /feature: 'intent'/)
  assert.ok(!/if \(!aiReady\) return json\(\{ intent: 'UNKNOWN'/.test(INTENT), 'no secret gate rejects the request')
})

test('candidate analysis routes every action, keeping the CV file path as a pre-step', () => {
  for (const feature of ['candidate_screening', 'assessment_generation', 'assessment_analysis', 'interview_analysis', 'candidate_scorecard']) {
    assert.ok(CANDIDATE.includes(`feature: '${feature}'`), `${feature} routed`)
  }
  assert.match(CANDIDATE, /if \(cv && hasProviderSecret\('openai'\)\)/)
  assert.match(CANDIDATE, /try \{ parsed = await runOpenAIWithCV/)
  assert.match(CANDIDATE, /if \(!parsed\) \{/)
  assert.ok(!/runOpenAI\(\[/i.test(CANDIDATE), 'no direct chat/completions call remains')
})

test('candidate analysis reports the provider that actually answered', () => {
  assert.match(CANDIDATE, /provider: lastRouteMeta\.provider, model: lastRouteMeta\.model, degraded: lastRouteMeta\.degraded/)
})

test('training questions keep the strict validator as the only rejection path', () => {
  assert.match(TRAINING_Q, /validateGeneratedQuestions\(routed\.value\)/)
  assert.match(TRAINING_Q, /KSS_QUESTION_VALIDATION_COPY/)
  assert.ok(!/api\.openai\.com/.test(TRAINING_Q), 'no hard-coded provider endpoint')
  assert.ok(!/Deno\.env\.get\('OPENAI_API_KEY'\)/.test(TRAINING_Q), 'no single-provider key check')
})

// ---------------------------------------------------------------------------
// 7. Migration agreement
// ---------------------------------------------------------------------------

test('deterministic answers are stable across repeated runs', () => {
  const input = { rulesData: { records: [{ status: 'present' }, { status: 'absent' }] } }
  const runs = new Set([1, 2, 3].map(() => deterministicAnswer('attendance_summary', input).text))
  assert.equal(runs.size, 1, 'the rules tier is deterministic')
})

test('the engine version is pinned and matches the provider default model', () => {
  assert.equal(RULES_ENGINE_VERSION, 'deterministic-v1')
  assert.match(ROUTER, /rules: \{ id: 'rules'.*defaultModel: 'deterministic-v1' \}/)
})

test('the migration seeds the same five providers in the same order', () => {
  const seed = MIGRATION.match(/insert into public\.ai_providers[\s\S]*?on conflict/)[0]
  for (const id of ['gemini', 'groq', 'rules', 'openai', 'nvidia']) {
    assert.ok(seed.includes(`'${id}'`), `${id} seeded`)
  }
  const order = [...seed.matchAll(/'(gemini|groq|rules|openai|nvidia)'\s*,\s*'/g)].map((m) => m[1])
  assert.deepEqual(order.slice(0, 5), ['gemini', 'groq', 'rules', 'openai', 'nvidia'])
})

test('the migration exposes the four telemetry surfaces the router writes to', () => {
  for (const table of ['ai_providers', 'provider_health', 'provider_latency', 'provider_usage_logs']) {
    assert.match(MIGRATION, new RegExp(`create table if not exists public\\.${table}`), `${table} created`)
  }
  for (const fn of ['get_ai_provider_config', 'record_ai_provider_outcome', 'record_ai_provider_call', 'ai_provider_chain', 'ai_features']) {
    assert.ok(MIGRATION.includes(fn), `${fn} defined`)
  }
})

test('the migration lists every feature the router advertises', () => {
  const migrationFeatures = [...MIGRATION.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  for (const feature of ['chat', 'summary', 'intent', 'candidate_screening', 'candidate_ranking', 'candidate_scorecard', 'assessment_generation', 'assessment_analysis', 'interview_analysis', 'recruitment_recommendation', 'attendance_summary', 'leave_analysis', 'performance_review', 'mpr_summary', 'bankone_analytics', 'training_questions']) {
    assert.ok(migrationFeatures.includes(feature), `feature ${feature} registered in the DB`)
  }
})

test('the migration never writes a provider key', () => {
  assert.ok(!/insert into public\.(ai_providers|provider_health|provider_usage_logs)[\s\S]{0,400}api_key/i.test(MIGRATION))
})

console.log(`\n${passed} passed\n`)
