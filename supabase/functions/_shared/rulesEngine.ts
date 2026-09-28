// ============================================================================
// SARA INTERNAL RULES ENGINE  (deterministic-v1)
// ============================================================================
// The internal tier of the provider router. It runs in-process, needs no
// secret, no network and no quota, so the SARA chain can always terminate in
// something that answers. That is what makes a silent failure impossible.
//
// It is NOT a stub. Every SARA feature has a real deterministic responder that
// derives its answer from the data it is handed and shows the arithmetic it
// used, so a degraded reply is correct and auditable rather than a shrug.
//
// The rules engine is deliberately conservative: it never invents a number. If
// the caller did not supply the fields a rule needs, it says so, and the
// caller keeps its own data-driven path. It is the floor of the product, not a
// replacement for a model.

type AnyRecord = Record<string, any>

export interface RulesRequest {
  prompt?: string
  system?: string
  json?: boolean
  /** Structured input for deterministic responders. Remote providers ignore it. */
  rulesData?: AnyRecord
  turns?: Array<{ role: string; parts: Array<AnyRecord> }>
}

export interface RulesAnswer {
  text: string
}

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const pct = (value: number): string => `${(Math.round(value * 10) / 10).toFixed(1)}%`

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const asArray = (value: unknown): AnyRecord[] => (Array.isArray(value) ? (value.filter(Boolean) as AnyRecord[]) : [])

/**
 * Attendance for today is passed either inside `metrics` (the compact summary
 * payload) or at the top level (the dedicated attendance feature), so read both.
 */
const attendanceToday = (data: AnyRecord): AnyRecord | null => {
  const candidate = data?.metrics?.attendance_today ?? data?.attendance_today ?? null
  return candidate && typeof candidate === 'object' ? candidate : null
}

const list = (items: string[], emptyMessage: string): string =>
  (items.length ? items.map((item) => `• ${item}`).join('\n') : emptyMessage)

/** The most recent user/model turn text, used by the conversational features. */
function lastUserText(request: RulesRequest): string {
  const turns = Array.isArray(request.turns) ? request.turns : []
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = (turns[i]?.parts || []).map((p: AnyRecord) => p?.text || '').join(' ').trim()
    if (text) return text
  }
  return String(request.prompt || '').trim()
}

// ===========================================================================
// Operational metrics — shared by chat / summary / analytics features
// ===========================================================================

interface Metric { key: string; label: string; value: number | null; lowerIsBetter?: boolean }

const METRIC_REGISTRY: Array<[string, string, boolean?]> = [
  ['pending_leave_requests', 'Pending leave requests', true],
  ['pending_onboarding_reviews', 'Pending onboarding reviews', true],
  ['active_employees', 'Active employees', false],
  ['pending_user_approvals', 'Pending user approvals', true],
  ['pending_attendance_exceptions', 'Pending attendance exceptions', true],
  ['pending_attendance_issues', 'Pending attendance issues', true],
  ['pending_task_reports', 'Pending task reports', true],
  ['pending_kpi_submissions', 'Pending KPI submissions', true],
  ['pending_loan_applications', 'Pending loan applications', true],
  ['pending_repayments', 'Pending repayments', true],
  ['customers', 'Customers', false],
  ['interviews_today', 'Interviews today', false],
]

function collectMetrics(data: AnyRecord): Metric[] {
  const source = (data?.metrics && typeof data.metrics === 'object') ? data.metrics : (data || {})
  return METRIC_REGISTRY.map(([key, label, lowerIsBetter]) => {
    const raw = source[key]
    return {
      key,
      label,
      value: raw === null || raw === undefined ? null : num(raw, 0),
      lowerIsBetter,
    }
  })
}

/** Anything SARA can actually be useful for, in plain language. */
const CAPABILITIES = [
  'Approve or reject leave requests',
  'Review onboarding submissions and corrections',
  'Summarise attendance, exceptions and issues',
  'Analyse leave patterns and balances',
  'Screen and rank candidates, and generate assessments',
  'Summarise performance reviews and MPR results',
  'Review payroll, BankOne transactions and reconciliations',
  'Answer "how many…", "who is pending…", "show me…" about your own scope',
]

// ===========================================================================
// Chat + summary
// ===========================================================================

function chatAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const message = lastUserText(request)
  const lower = message.toLowerCase()
  const metrics = collectMetrics(data)
  const known = metrics.filter((m) => m.value !== null)

  // A "how many" question: answer the one metric it names, exactly.
  const matched = metrics.filter((m) => {
    const words = m.label.toLowerCase().split(/\s+/)
    return words.some((w) => w.length > 3 && lower.includes(w)) || lower.includes(m.key.replace(/_/g, ' '))
  })
  if (/^(how many|how much|count|number of|total)\b/.test(lower) && matched.length) {
    const target = matched[0]
    return target.value === null
      ? `I do not have a reliable figure for ${target.label.toLowerCase()} in your scope right now.`
      : `**${target.label}: ${target.value}**\n\nThat is the count visible to you right now.`
  }

  if (/help|what can you do|how do i|capabilit/.test(lower)) {
    return ['I can help with:', '', list(CAPABILITIES, '')].join('\n')
  }

  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(lower) || !message) {
    const name = data?.scope?.name ? `, ${data.scope.name}` : ''
    return [
      `Hello${name}. I'm SARA, your operations assistant.`,
      '',
      'Right now in your scope:',
      list(known.slice(0, 6).map((m) => `${m.label}: ${m.value}`), 'No live counts are available to me right now.'),
      '',
      'Ask me about approvals, onboarding, attendance, leave, candidates, performance, payroll or BankOne.',
    ].join('\n')
  }

  const pending = known.filter((m) => m.lowerIsBetter)
  const worst = pending.slice().sort((a, b) => (b.value as number) - (a.value as number)).slice(0, 3)
  const lines = [
    'I could not reach my language model just now, so I am answering from my built-in rules instead. Everything below is computed from your live data, not guessed.',
    '',
  ]
  if (worst.length) {
    lines.push(`Biggest open items right now: ${worst.map((m) => `${m.label} (${m.value})`).join(', ')}.`)
  }
  const attendance = attendanceToday(data)
  if (attendance) {
    const total = num(attendance.total_employees ?? attendance.total)
    const present = num(attendance.present)
    if (total > 0) lines.push(`Attendance today: ${present} of ${total} present (${pct((present / total) * 100)}).`)
  }
  lines.push('')
  lines.push(`You asked: ${message.length > 160 ? `${message.slice(0, 157)}…` : message}`)
  lines.push('')
  lines.push('Here is your live position:')
  lines.push(list(known.slice(0, 8).map((m) => `${m.label}: ${m.value}`), 'No live counts are available to me right now.'))
  lines.push('')
  lines.push('Name any of these — for example "pending leave requests", "attendance today" or "help" — and I will give you the exact figures.')
  return lines.join('\n')
}

function summaryAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const metrics = collectMetrics(data)
  const known = metrics.filter((m) => m.value !== null)
  const bullets: string[] = []
  const value = (key: string) => known.find((m) => m.key === key)?.value

  const pending = known.filter((m) => m.lowerIsBetter)
  const totalPending = pending.reduce((sum, m) => sum + (m.value as number), 0)
  if (totalPending > 0) {
    const top = pending.slice().sort((a, b) => (b.value as number) - (a.value as number)).slice(0, 3)
    bullets.push(`${totalPending} items are waiting on a decision — mainly ${top.map((m) => `${m.label.toLowerCase()} (${m.value})`).join(', ')}.`)
  } else if (known.length) {
    bullets.push('Nothing is waiting on a decision in your scope right now.')
  }

  const attendance = attendanceToday(data)
  if (attendance) {
    const total = num(attendance.total_employees ?? attendance.total)
    const present = num(attendance.present)
    const late = num(attendance.late)
    const absent = num(attendance.absent)
    if (total > 0) {
      bullets.push(`Attendance is ${pct((present / total) * 100)} (${present}/${total} present${late ? `, ${late} late` : ''}${absent ? `, ${absent} absent` : ''}).`)
    }
  }

  const headcount = value('active_employees')
  if (headcount !== null && headcount !== undefined) {
    bullets.push(`${headcount} employees are active, with ${value('customers') ?? 'no recorded'} customers on the platform.`)
  }

  const interviews = value('interviews_today')
  if (interviews !== null && interviews !== undefined) {
    bullets.push(interviews > 0
      ? `${interviews} interview${interviews === 1 ? ' is' : 's are'} scheduled for today.`
      : 'No interviews are scheduled for today.')
  }

  const loans = value('pending_loan_applications')
  if (loans !== null && loans !== undefined && loans > 0) {
    bullets.push(`${loans} loan application${loans === 1 ? '' : 's'} awaiting review.`)
  }

  if (!bullets.length) return 'No operational data is available to me in your scope right now, so I have no summary to give.'
  return bullets.slice(0, 4).join('\n')
}

// ===========================================================================
// Intent classification — mirrors the sara-intent JSON contract exactly
// ===========================================================================

const DEFAULT_INTENTS = [
  'SHOW_PENDING', 'COUNT_PENDING', 'DASHBOARD_SUMMARY', 'PENDING_ATTENTION', 'PENDING_LOANS',
  'APPROVE_LEAVE', 'REJECT_LEAVE', 'TERMINATE_EMPLOYEE', 'HELP', 'UNKNOWN',
]

function intentAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const text = String(data.text ?? lastUserText(request)).toLowerCase()
  const allowed: string[] = Array.isArray(data.allowed) && data.allowed.length ? data.allowed : DEFAULT_INTENTS
  const has = (...needles: string[]) => needles.some((n) => text.includes(n))

  let intent = 'UNKNOWN'
  if (has('help', 'what can you do', 'how do i')) intent = 'HELP'
  else if (has('terminate', 'fire', 'dismiss', 'end employment') && has('employee', 'staff')) intent = 'TERMINATE_EMPLOYEE'
  else if (has('approve') && has('leave')) intent = 'APPROVE_LEAVE'
  else if (has('reject', 'decline', 'deny') && has('leave')) intent = 'REJECT_LEAVE'
  else if (has('loan', 'application')) intent = 'PENDING_LOANS'
  else if (has('dashboard', 'summary', 'overview', 'how are we')) intent = 'DASHBOARD_SUMMARY'
  else if (has('pending', 'awaiting', 'waiting')) intent = has('how many', 'count', 'number') ? 'COUNT_PENDING' : 'SHOW_PENDING'
  else if (has('attention', 'needs me', 'urgent', 'overdue')) intent = 'PENDING_ATTENTION'
  if (!allowed.includes(intent)) intent = allowed.includes('HELP') ? 'HELP' : 'UNKNOWN'

  const entities: AnyRecord = { employee_name: null, leave_type: null, branch: null }
  const nameMatch = text.match(/([a-z]+)\s+([a-z]+)(?:'s)?\s+(?:leave|request)/i)
  if (nameMatch) entities.employee_name = `${nameMatch[1]} ${nameMatch[2]}`.slice(0, 80)
  const typeMatch = text.match(/\b(annual|sick|maternity|paternity|personal|unpaid)\b/)
  if (typeMatch) entities.leave_type = typeMatch[1]
  const branchMatch = text.match(/\b(?:branch|at|in)\s+([a-z\s]{3,40})/)
  if (branchMatch) entities.branch = branchMatch[1].trim().slice(0, 60)

  const criteria: AnyRecord = { max_days: null, min_days: null, exact_days: null }
  const daysMatch = text.match(/\b(\d{1,3})\s*days?\b/)
  if (daysMatch) criteria.exact_days = clamp(Number(daysMatch[1]), 1, 365)
  if (/\bmore than\b|\bat least\b|\bover\b/.test(text) && daysMatch) criteria.min_days = clamp(Number(daysMatch[1]), 0, 365)
  if (/\bunder\b|\bbelow\b|\bless than\b|\bwithin\b/.test(text) && daysMatch) criteria.max_days = clamp(Number(daysMatch[1]), 1, 365)

  return JSON.stringify({
    intent,
    entities,
    criteria,
    all: /\b(all|every|each)\b/.test(text),
    confidence: intent === 'UNKNOWN' ? 0.2 : 0.6,
  })
}

// ===========================================================================
// Recruitment — skills, screening, ranking, assessment generation
// ===========================================================================

const SKILL_HINTS: Array<[RegExp, string]> = [
  [/\b(excel|spreadsheet|pivot)\b/i, 'Excel'],
  [/\b(accounting|book-?keeping|ledger|journal)\b/i, 'Accounting'],
  [/\b(loan|credit|lending|mortgage)\b/i, 'Lending'],
  [/\b(customer service|customer support|front office|reception)\b/i, 'Customer service'],
  [/\b(sales|targets|commission)\b/i, 'Sales'],
  [/\b(microfinance|savings|deposits?|deposit mobilisation)\b/i, 'Microfinance'],
  [/\b(compliance|kyc|aml|regulat)\b/i, 'Compliance'],
  [/\b(audit|internal control|reconcil)\b/i, 'Audit'],
  [/\b(payroll|\bhr\b|human resources|recruit)\b/i, 'HR'],
  [/\b(it support|systems|network|troubleshoot)\b/i, 'IT support'],
  [/\b(marketing|branding|social media)\b/i, 'Marketing'],
  [/\b(python|sql|java|javascript|c#|\.net)\b/i, 'Programming'],
  [/\b(banking|bank)\b/i, 'Banking'],
  [/\b(report|reports|reporting)\b/i, 'Reporting'],
]

function skillSignals(text: string): Set<string> {
  const found = new Set<string>()
  for (const [pattern, label] of SKILL_HINTS) if (pattern.test(text)) found.add(label)
  return found
}

function candidateText(candidate: AnyRecord): string {
  return [
    candidate.skills, candidate.summary, candidate.experience_summary, candidate.cover_letter,
    candidate.education, candidate.position, candidate.job_title, candidate.qualifications,
    Array.isArray(candidate.qualifications) ? candidate.qualifications.join(' ') : '',
    Array.isArray(candidate.experiences) ? candidate.experiences.map((e: AnyRecord) => `${e.position || ''} ${e.description || ''}`).join(' ') : '',
  ].filter(Boolean).join(' ').replace(/[,;|]+/g, ' ')
}

function numericField(record: AnyRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (value === null || value === undefined || value === '') continue
    const parsed = num(value, NaN)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Candidate screening. A transparent weighted score over the fields actually
 * present, showing the reason for every contribution. Weights are fixed and
 * documented here so the score is reproducible and disputable by HR.
 */
function screeningAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const candidate = data.candidate || {}
  const job = data.job || {}
  const criteria = data.criteria || {}
  const text = candidateText(candidate)
  const reasons: string[] = []
  let score = 35

  const explicit = asArray(criteria.required_skills).map((s) => String(s))
  const required = new Set<string>(
    explicit.length ? explicit : [...skillSignals(String(job.requirements || job.description || ''))],
  )
  const candidateSkills = new Set<string>([
    ...skillSignals(text),
    ...String(candidate.skills || '').split(/[,;|]/).map((s) => s.trim()).filter(Boolean),
  ])

  const matched: string[] = []
  const missing: string[] = []
  for (const skill of required) {
    const hit = [...candidateSkills].some((c) => c.toLowerCase() === skill.toLowerCase())
      || text.toLowerCase().includes(skill.toLowerCase())
    ;(hit ? matched : missing).push(String(skill))
  }
  if (required.size) {
    const coverage = matched.length / required.size
    const points = Math.round(coverage * 30)
    score += points
    reasons.push(`Required skill coverage ${Math.round(coverage * 100)}% (${matched.length}/${required.size} matched): +${points}`)
  } else {
    score += 10
    reasons.push('No required skills were supplied for this role, so skill matching could not be scored: +10 baseline')
  }

  const minExperience = numericField(criteria, ['min_experience_years', 'experience_years', 'min_years'])
  const years = numericField(candidate, ['experience_years', 'total_experience_years', 'years_of_experience', 'work_experience_years'])
  if (minExperience !== null && years !== null) {
    const points = years >= minExperience ? 15 : years >= minExperience / 2 ? 8 : 0
    score += points
    reasons.push(`Experience ${years} year(s) against a ${minExperience}-year requirement: +${points}`)
  } else {
    reasons.push('No comparable experience figures were supplied, so experience could not be scored: +0')
  }

  const minEducation = String(criteria.min_education || job.min_education || '').toLowerCase()
  if (minEducation) {
    const haystack = String(candidate.education || candidate.qualifications || text).toLowerCase()
    const order = ['ssce', 'hnd', 'bsc', 'ba', 'b.sc', 'btech', 'msc', 'm.sc', 'phd', 'ssd']
    const requiredIndex = order.findIndex((t) => minEducation.includes(t))
    const achieved = order.findIndex((t) => haystack.includes(t))
    const points = requiredIndex === -1 || achieved >= requiredIndex ? 10 : 0
    score += points
    reasons.push(`Education target "${minEducation}" ${points ? 'met' : 'not evidenced'}: +${points}`)
  } else {
    reasons.push('No minimum education was specified, so education could not be scored: +0')
  }

  const cvName = String(candidate.cv_file_name || candidate.cv_name || candidate.resume_file_name || '')
  if (cvName) {
    score += 5
    reasons.push('A CV is attached and could be read: +5')
  } else {
    reasons.push('No CV is attached, so the application was scored from the form alone: +0')
  }

  if (/\b(excel|python|sql)\b/i.test(text) && !/\b(excel|python|sql)\b/i.test(String(job.requirements || ''))) {
    reasons.push('Noted: the candidate lists technical skills the role description does not require')
  }

  score = clamp(score, 0, 100)
  const recommendation = score >= 75 ? 'shortlist' : score >= 55 ? 'consider' : 'reject'
  return JSON.stringify({
    score,
    recommendation,
    matched_skills: matched,
    missing_skills: missing,
    strengths: reasons.filter((r) => !r.includes('could not be scored') && !r.includes('not evidenced')).slice(0, 4),
    concerns: missing.length ? [`Missing required skills: ${missing.join(', ')}`] : [],
    reasons,
    engine: 'rules',
    notice: 'Scored by the internal rules engine. It uses fixed weights over the fields on the application form only, and is a starting point for HR review rather than a decision.',
  })
}

/** Candidate ranking: the same deterministic score, applied across a batch. */
function rankingAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const candidates = asArray(data.candidates)
  if (!candidates.length) {
    return JSON.stringify({ rankings: [], engine: 'rules', notice: 'No candidates were supplied to rank.' })
  }
  const criteria = data.criteria || {}
  const job = data.job || {}
  const scored = candidates.map((candidate) => {
    const sub = JSON.parse(screeningAnswer({ rulesData: { candidate, job, criteria } })) as AnyRecord
    return {
      candidate_id: candidate.id ?? null,
      candidate_name: candidate.candidate_name ?? candidate.full_name ?? candidate.name ?? null,
      score: sub.score,
      recommendation: sub.recommendation,
      matched_skills: sub.matched_skills,
      missing_skills: sub.missing_skills,
    }
  })
  scored.sort((a, b) => (b.score as number) - (a.score as number))
  return JSON.stringify({
    rankings: scored.map((row, index) => ({ ...row, rank: index + 1 })),
    engine: 'rules',
    notice: `Ranked ${scored.length} candidate(s) by the internal rules engine using the same fixed weights as screening. Ties keep the input order.`,
  })
}

const QUESTION_BANK: Record<string, Array<{ q: string; a: string; distractors: string[] }>> = {
  technical: [
    { q: 'A customer asks for a loan repayment plan they cannot meet. What is your first step?', a: 'Listen fully, then review the account and agree a realistic schedule the customer can sustain.', distractors: ['Offer the maximum loan immediately to close the deal', 'Refuse the request and end the conversation', 'Promise a plan and confirm it later'] },
    { q: 'How would you confirm a customer meets the KYC requirements before a disbursement?', a: 'Verify original identity and address documents against the customer record and log the verification.', distractors: ['Ask a colleague whether they recognise the customer', 'Rely on the branch manager verbal confirmation', 'Proceed if the customer is known personally'] },
    { q: 'Your daily cash reconciliation is short by ₦5,000. What do you do?', a: 'Recount the cash, recheck the till record, then report the variance before close.', distractors: ['Absorb the difference to avoid a late close', 'Adjust the next customer’s transaction to balance it', 'Wait to see whether it resolves by itself'] },
  ],
  behavioral: [
    { q: 'Tell me about a time you had to deliver a difficult message to a colleague.', a: 'Describe a specific instance, what you said, and the outcome you achieved.', distractors: ['I have never had to do that', 'I would rather avoid difficult conversations', 'I usually ask someone else to do it'] },
    { q: 'Describe a time you disagreed with a decision. What did you do?', a: 'Explain the disagreement, how you raised it, and what you did once the decision stood.', distractors: ['I always agree with my supervisor', 'I usually ignore decisions I disagree with', 'I only raise it afterwards'] },
    { q: 'Give an example of meeting a target under pressure.', a: 'Describe the target, the constraint you faced and the specific actions that worked.', distractors: ['I do not set targets for myself', 'Targets are set for me, so this does not apply', 'I would need the exact figures to answer'] },
  ],
  practical: [
    { q: 'A branch is short-staffed on payday. What is your operational plan?', a: 'Prioritise teller and customer-facing duties, stagger non-urgent work, and escalate the staffing gap.', distractors: ['Close the branch until more staff arrive', 'Skip the cash reconciliation to save time', 'Allow unlimited queueing until staff return'] },
    { q: 'Draft a plan to clear a backlog of pending loan applications.', a: 'Triage by completeness and value, assign owners, set daily targets, and report ageing daily.', distractors: ['Clear them in date order without review', 'Wait for the applicants to follow up', 'Approve the oldest applications automatically'] },
    { q: 'A customer wants a statement covering transactions from a closed account. What do you do?', a: 'Explain the retention period, search the archive within it, and escalate to the back office if it is out of range.', distractors: ['Reconstruct the figures from memory', 'Refuse because the account is closed', 'Share the previous customer’s statement as a guide'] },
  ],
  psychometric: [
    { q: 'Numbers are arranged 2, 4, 8, 16, __. Which number comes next?', a: '32 — the series doubles each time.', distractors: ['24 — it adds 8 each time', '18 — it adds 2 each time', '20 — it adds 4 each time'] },
    { q: 'If all Os are Ts, and all Ts are Ps, which statement is true?', a: 'All Os are Ps.', distractors: ['All Ps are Os', 'Some Ps are not Os', 'No Os are Ts'] },
    { q: 'Six people finish a task in 3 days working alone. How long do three people take?', a: '6 days — halving the team doubles the time.', distractors: ['1.5 days', '9 days', '4 days'] },
  ],
}

/** Assessment generation: three questions drawn from the category's bank. */
function assessmentAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const category = String(data.category || 'technical').toLowerCase()
  const bank = QUESTION_BANK[category] || QUESTION_BANK.technical
  const topic = String(data.title || data.job_title || 'the role')
  const questions = bank.slice(0, 3).map((item, index) => {
    const options = [item.a, ...item.distractors]
    // Deterministic rotation so the correct answer is not always option A.
    const shift = index % 4
    const rotated = [...options.slice(shift), ...options.slice(0, shift)]
    return {
      question: item.q,
      options: rotated,
      correct_answer: item.a,
      marks: 1,
      rationale: `${item.a} — assessed against ${topic}.`,
    }
  })
  return JSON.stringify({
    questions,
    engine: 'rules',
    notice: 'Questions were selected from the built-in assessment bank for this category. They are ready to review and edit before assignment.',
  })
}

/** Assessment scoring: arithmetic over the marked responses. */
function assessmentAnalysisAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const responses = asArray(data.responses)
  if (!responses.length) {
    return JSON.stringify({ score: null, engine: 'rules', notice: 'No marked responses were supplied to score.' })
  }
  const graded = responses.map((r) => ({ ...r, awarded: num(r.awarded_marks ?? r.marks_awarded, 0) }))
  const available = graded.reduce((sum, r) => sum + num(r.total_marks ?? r.marks, r.awarded), 0)
  const awarded = graded.reduce((sum, r) => sum + r.awarded, 0)
  const score = available > 0 ? clamp((awarded / available) * 100, 0, 100) : 0
  const correct = graded.filter((r) => r.is_correct === true).length
  const wrong = graded.filter((r) => r.is_correct === false).length
  return JSON.stringify({
    score: Math.round(score * 10) / 10,
    awarded,
    available,
    correct_answers: correct,
    incorrect_answers: wrong,
    questions_answered: graded.length,
    band: score >= 75 ? 'exceeds' : score >= 50 ? 'meets' : 'below',
    strengths: score >= 50 ? [`${correct} of ${graded.length} questions answered correctly`] : [],
    concerns: score < 50 ? [`${wrong} of ${graded.length} questions answered incorrectly`] : [],
    engine: 'rules',
    notice: 'Scored arithmetically from the marked answers. Narrative commentary is only available when a language model is reachable.',
  })
}

/** Interview analysis: structure the notes, do not invent sentiment. */
function interviewAnalysisAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const notes = String(data.notes || data.summary || data.interview_notes || '')
  const rating = numericField(data, ['rating', 'score', 'overall_score'])
  if (!notes && rating === null) {
    return JSON.stringify({ recommendation: 'insufficient_information', engine: 'rules', notice: 'No interview notes or rating were available to analyse.' })
  }
  const strengths: string[] = []
  const concerns: string[] = []
  for (const sentence of notes.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)) {
    if (/\b(strong|excellent|good|solid|clear|confident|knowledgeable|responsive)\b/i.test(sentence)) strengths.push(sentence.slice(0, 160))
    else if (/\b(weak|lack|gap|struggl|unclear|miss|did not|could not)\b/i.test(sentence)) concerns.push(sentence.slice(0, 160))
  }
  return JSON.stringify({
    recommendation: rating === null ? 'insufficient_information' : rating >= 70 ? 'shortlist' : rating >= 50 ? 'consider' : 'reject',
    overall_rating: rating,
    strengths: strengths.slice(0, 5),
    concerns: concerns.slice(0, 5),
    engine: 'rules',
    notice: 'Built by grouping the interviewer’s own wording into strengths and concerns. No rating was invented.',
  })
}

/** Recruitment recommendation: a coverage-first shortlist explanation. */
function recruitmentRecommendationAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const ranking = asArray(data.rankings)
  const capacity = Math.max(0, Math.trunc(num(data.shortlist_capacity, 0)))
  const shortlisted = capacity > 0 ? ranking.slice(0, capacity) : ranking
  return JSON.stringify({
    shortlist: shortlisted,
    capacity,
    basis: 'rank',
    engine: 'rules',
    notice: shortlisted.length === ranking.length && capacity === 0
      ? 'No shortlist capacity was supplied, so every ranked candidate was returned.'
      : `Shortlisted the top ${shortlisted.length} of ${ranking.length} ranked candidate(s) against a capacity of ${capacity}.`,
  })
}

/**
 * Candidate scorecard: a single candidate's assessment result, placed against
 * their template and role averages. The arithmetic is exact; the commentary is
 * only what the supplied numbers and flags support.
 */
function scorecardAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const rows = asArray(data.questions)
  const peer = (data.peer_comparison && typeof data.peer_comparison === 'object') ? data.peer_comparison : {}
  const name = data.candidate?.full_name || data.candidate?.candidate_name || 'The candidate'
  const role = data.candidate?.role || 'the role'

  if (!rows.length && !peer.percentile) {
    return JSON.stringify({
      summary: `No marked answers or peer comparison were available for ${name}, so no scorecard could be produced.`,
      recommended_action: 'manual_review',
      engine: 'rules',
      notice: 'Nothing was supplied to analyse. Narrative commentary is only available when a language model is reachable.',
    })
  }

  const supplied = numericField(data.candidate || {}, ['percentage', 'score'])
  // Prefer the recorded percentage; otherwise derive it from the marked answers
  // so the comparison is still made against real numbers.
  const markedTotal = rows.reduce((sum, r) => sum + num(r.total_marks, num(r.marks, 0)), 0)
  const markedAwarded = rows.reduce((sum, r) => sum + num(r.awarded_marks ?? r.marks_awarded, 0), 0)
  const percentage = supplied !== null
    ? supplied
    : (markedTotal > 0 ? (markedAwarded / markedTotal) * 100 : null)
  const rounded = percentage === null ? null : Math.round(percentage * 10) / 10
  const templateAvg = numericField(peer, ['template_average'])
  const roleAvg = numericField(peer, ['role_average'])
  const percentile = numericField(peer, ['percentile'])
  // The role average is the fairer benchmark (same job, every candidate); the
  // template average is the fallback because it mixes different roles.
  const reference = roleAvg ?? templateAvg
  const referenceLabel = roleAvg !== null ? 'role' : 'template'
  const delta = rounded !== null && reference !== null ? rounded - reference : null
  const flagged = rows.filter((r) => r.flagged === true || num(r.flags_count, 0) > 0)

  const summaryParts = [`${name} scored ${rounded === null ? 'an unscored attempt' : `${rounded}%`} for ${role}.`]
  if (delta !== null) {
    summaryParts.push(delta >= 0
      ? `That is ${Math.abs(Math.round(delta * 10) / 10)} points above the ${referenceLabel} average of ${reference}%.`
      : `That is ${Math.abs(Math.round(delta * 10) / 10)} points below the ${referenceLabel} average of ${reference}%.`)
  }
  if (percentile !== null) summaryParts.push(`The candidate sits in the ${ordinal(percentile)} percentile of comparable attempts.`)
  if (flagged.length) summaryParts.push(`${flagged.length} question(s) were flagged for review.`)

  return JSON.stringify({
    summary: summaryParts.join(' '),
    strengths: rounded !== null && rounded >= 70 ? [`Scored ${rounded}%, at or above the ${reference === null ? 'expected' : 'group average'} level.`] : [],
    concerns: [
      ...(rounded !== null && rounded < 50 ? [`Scored ${rounded}%, below the ${reference === null ? 'expected' : 'group average'} level.`] : []),
      ...(delta !== null && delta <= -10 ? [`${Math.abs(Math.round(delta))} points behind the peer average — worth probing in the review interview.`] : []),
    ],
    flags_review: flagged.slice(0, 5).map((r) => r.question || r.text || 'Flagged question'),
    recommended_action: flagged.length ? 'manual_review' : (rounded === null ? 'manual_review' : rounded >= 70 ? 'shortlist' : rounded >= 50 ? 'consider' : 'reject'),
    peer_comparison: {
      template_average: templateAvg,
      role_average: roleAvg,
      delta_percent: delta === null ? 0 : Math.round(delta * 10) / 10,
    reference_average: reference,
    reference_type: referenceLabel,
      percentile,
    },
    role_fit: reference !== null && rounded !== null && rounded >= reference
      ? { suggested_role: role, confidence: 50, rationale: 'The candidate met the peer average for this role, so the role fit holds on the evidence available.', alternatives: [] }
      : null,
    engine: 'rules',
    notice: 'Built arithmetically from the marked answers and the supplied peer averages. No result was invented and no comment was inferred beyond the numbers.',
  })
}

function ordinal(value: number): string {
  const rounded = Math.round(value)
  const suffix = ['th', 'st', 'nd', 'rd'][((rounded % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][rounded % 100] || 'th'
  return `${rounded}${suffix}`
}

// ===========================================================================
// HR analytics — attendance, leave, performance, MPR, BankOne
// ===========================================================================

function attendanceAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const records = asArray(data.records).length ? asArray(data.records) : asArray(data.attendees)
  if (!records.length) {
    return 'No attendance records were supplied for the period, so there is nothing to summarise.'
  }
  const present = records.filter((r) => ['present', 'on_time', 'late', 'present_late'].includes(String(r.status).toLowerCase())).length
  const late = records.filter((r) => String(r.status).toLowerCase() === 'late').length
  const absent = records.filter((r) => String(r.status).toLowerCase() === 'absent').length
  const remote = records.filter((r) => r.is_remote === true || r.remote === true).length
  const rate = (present / records.length) * 100
  const flagged = records.filter((r) => r.flagged === true || num(r.exception_count, 0) > 0)
  return [
    `**Attendance summary**`,
    `${present} of ${records.length} staff attended (${pct(rate)}).`,
    late ? `${late} arrived after the late threshold.` : 'No late arrivals were recorded.',
    absent ? `${absent} were absent.` : 'No absences were recorded.',
    remote ? `${remote} attended remotely.` : '',
    flagged.length
      ? `${flagged.length} staff have an open attendance exception: ${flagged.slice(0, 8).map((r) => r.employee_name || r.full_name || 'staff').join(', ')}.`
      : 'No attendance exceptions are open.',
    '',
    rate < 90 ? 'Attendance is below the 90% expectation — review the exception queue.' : 'Attendance is at or above the 90% expectation.',
  ].filter(Boolean).join('\n')
}

function leaveAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const records = asArray(data.records)
  const balances = asArray(data.balances)
  if (!records.length && !balances.length) {
    return 'No leave records or balances were supplied, so there is nothing to analyse.'
  }
  const byType = new Map<string, number>()
  for (const r of records) {
    const type = String(r.leave_type || 'other').toLowerCase()
    byType.set(type, (byType.get(type) || 0) + num(r.days, num(r.total_days, 0)))
  }
  const totals = [...byType.entries()].sort((a, b) => b[1] - a[1])
  const pending = records.filter((r) => String(r.status).toLowerCase() === 'pending')
  const lines = [
    '**Leave analysis**',
    records.length ? `${records.length} leave request(s) in scope, ${pending.length} still pending.` : '',
    totals.length ? `Days taken by type: ${totals.map(([type, days]) => `${type} ${days}d`).join(', ')}.` : '',
  ]
  if (balances.length) {
    const atRisk = balances.filter((b) => {
      const remaining = num(b.remaining ?? num(b.effective_entitlement, 0) - num(b.used_days ?? b.used, 0), 0)
      const entitlement = num(b.effective_entitlement ?? b.entitled_days, 0)
      return entitlement > 0 && remaining / entitlement <= 0.2
    })
    lines.push(atRisk.length
      ? `${atRisk.length} employee(s) have used 80% or more of their entitlement: ${atRisk.slice(0, 8).map((b) => b.employee_name || b.full_name || 'staff').join(', ')}.`
      : 'No employee is close to exhausting their leave entitlement.')
  }
  if (pending.length) {
    const oldest = pending.slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0]
    lines.push(`Oldest pending request: ${oldest.employee_name || 'staff'}, ${oldest.days ?? '—'} day(s).`)
  }
  return lines.filter(Boolean).join('\n')
}

function performanceAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const rows = asArray(data.reviews).length ? asArray(data.reviews) : asArray(data.employees)
  if (!rows.length) {
    return 'No performance reviews were supplied, so there is nothing to summarise.'
  }
  const scored = rows.map((r) => ({ row: r, score: numericField(r, ['score', 'total_score', 'mpr_score', 'final_score']) }))
  const known = scored.filter((s) => s.score !== null)
  const average = known.length ? known.reduce((sum, s) => sum + (s.score as number), 0) / known.length : null
  const bands = [
    { label: 'Exceeds', min: 75 }, { label: 'Meets', min: 50 }, { label: 'Below', min: 0 },
  ]
  const distribution = bands.map((band) => ({
    label: band.label,
    count: known.filter((s) => (s.score as number) >= band.min && (band.label === 'Below' || (s.score as number) < (bands[bands.indexOf(band) - 1]?.min ?? Infinity))).length,
  }))
  const top = known.slice().sort((a, b) => (b.score as number) - (a.score as number)).slice(0, 3)
  const bottom = known.slice().sort((a, b) => (a.score as number) - (b.score as number)).slice(0, 3)
  const name = (r: AnyRecord) => r.employee_name || r.full_name || r.name || 'staff'
  return [
    '**Performance review**',
    average === null
      ? 'No numeric scores were present in the reviews supplied, so no average could be computed.'
      : `${known.length} of ${rows.length} reviews carry a score. Average ${Math.round(average * 10) / 10}.`,
    distribution.some((d) => d.count) ? `Distribution: ${distribution.map((d) => `${d.label} ${d.count}`).join(', ')}.` : '',
    top.length ? `Highest: ${top.map((s) => `${name(s.row)} (${s.score})`).join(', ')}.` : '',
    bottom.length ? `Lowest: ${bottom.map((s) => `${name(s.row)} (${s.score})`).join(', ')}.` : '',
    '',
    'Narrative comments are only added when a language model is reachable.',
  ].filter(Boolean).join('\n')
}

function mprAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const components = asArray(data.components)
  const employee = data.employee || {}
  const period = data.period_label || data.period || 'the review period'
  if (!components.length) {
    return `No MPR components were supplied for ${period}, so no score could be computed.`
  }
  const weighted = components.map((c) => {
    const weight = num(c.weight, 0)
    const score = num(c.score, 0)
    return { label: String(c.name || c.label || 'Component'), weight, score, weighted: (score * weight) / 100 }
  })
  const totalWeight = weighted.reduce((sum, c) => sum + c.weight, 0)
  const total = totalWeight > 0 ? weighted.reduce((sum, c) => sum + c.weighted, 0) : 0
  const strongest = weighted.slice().sort((a, b) => (b.weight ? b.score / b.weight : 0) - (a.weight ? a.score / a.weight : 0))[0]
  const weakest = weighted.slice().sort((a, b) => (a.weight ? a.score / a.weight : 0) - (b.weight ? b.score / b.weight : 0))[0]
  const name = employee.full_name || employee.employee_name || 'The employee'
  return [
    `**MPR summary — ${name} (${period})**`,
    `Overall score: ${(Math.round(total * 10) / 10).toFixed(1)} out of 100 (weights total ${totalWeight}).`,
    list(weighted.map((c) => `${c.label}: ${c.score} at ${c.weight}% weight → ${(Math.round(c.weighted * 10) / 10).toFixed(1)} points`), ''),
    strongest ? `Strongest area: ${strongest.label}.` : '',
    weakest ? `Area needing attention: ${weakest.label}.` : '',
  ].filter(Boolean).join('\n')
}

function bankoneAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const transactions = asArray(data.transactions)
  const loans = asArray(data.loans)
  if (!transactions.length && !loans.length) {
    return 'No BankOne transactions or loans were supplied, so there is nothing to analyse.'
  }
  let credits = 0
  let debits = 0
  for (const t of transactions) {
    const amount = num(t.amount, 0)
    const direction = String(t.type || t.direction || t.transaction_type || '').toLowerCase()
    if (/credit|inflow|cashin|repayment/.test(direction)) credits += amount
    else debits += amount
  }
  const outstanding = loans.reduce((sum, l) => sum + num(l.outstanding_principal ?? l.outstanding ?? l.balance, 0), 0)
  const portfolio = loans.length ? (loans.reduce((sum, l) => sum + num(l.principal ?? l.loan_amount, 0), 0) || 1) : 1
  const overdue = loans.filter((l) => num(l.days_past_due, 0) > 0)
  return [
    '**BankOne analytics**',
    transactions.length
      ? `${transactions.length} transaction(s) in scope — ${formatMoney(credits)} credited, ${formatMoney(debits)} debited, net ${formatMoney(credits - debits)}.`
      : '',
    loans.length
      ? `${loans.length} loan(s) with ${formatMoney(outstanding)} outstanding (${pct((outstanding / portfolio) * 100)} of principal).`
      : '',
    overdue.length
      ? `${overdue.length} loan(s) are past due, totalling ${formatMoney(overdue.reduce((s, l) => s + num(l.outstanding_principal ?? l.outstanding ?? l.balance, 0), 0))}.`
      : 'No loans are past due.',
  ].filter(Boolean).join('\n')
}

function formatMoney(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `₦${rounded.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ===========================================================================
// Training question generation
// ===========================================================================

function trainingQuestionAnswer(request: RulesRequest): string {
  const data = request.rulesData || {}
  const title = String(data.title || 'this training')
  const description = String(data.description || '')
  // The KSS bank contract is strict and shared with the validator: EXACTLY
  // three questions with EXACTLY three options each, and the correct answer
  // present verbatim among them. Keep that shape here or the drafts get
  // rejected as unvalidated AI output.
  const base = JSON.parse(assessmentAnswer({ rulesData: { category: 'behavioral', title } })) as AnyRecord
  const questions = (base.questions as AnyRecord[]).slice(0, 3).map((q, index) => {
    const correct = String(q.correct_answer)
    const distractors = (q.options as string[])
      .map((option) => String(option))
      .filter((option) => option !== correct)
      .slice(0, 2)
    // Deterministic rotation, so the answer is not always the first option.
    const rotated = [correct, distractors[0], distractors[1]]
    const shift = index % rotated.length
    return {
      question: String(q.question),
      options: rotated.slice(shift).concat(rotated.slice(0, shift)),
      correct_answer: correct,
    }
  })
  const extra = description
    ? ` Applying this to ${title}: ${description.slice(0, 120)}`
    : ''
  return JSON.stringify({
    questions,
    engine: 'rules',
    notice: `Three draft questions were built from the internal question bank for "${title}".${extra} Review and edit them before publishing.`,
  })
}

// ===========================================================================
// Dispatch
// ===========================================================================

const RESPONDERS: Record<string, (request: RulesRequest) => string> = {
  chat: chatAnswer,
  summary: summaryAnswer,
  intent: intentAnswer,
  candidate_screening: screeningAnswer,
  candidate_ranking: rankingAnswer,
  candidate_scorecard: scorecardAnswer,
  assessment_generation: assessmentAnswer,
  assessment_analysis: assessmentAnalysisAnswer,
  interview_analysis: interviewAnalysisAnswer,
  recruitment_recommendation: recruitmentRecommendationAnswer,
  attendance_summary: attendanceAnswer,
  leave_analysis: leaveAnswer,
  performance_review: performanceAnswer,
  mpr_summary: mprAnswer,
  bankone_analytics: bankoneAnswer,
  training_questions: trainingQuestionAnswer,
}

/**
 * Produce the deterministic answer for a SARA feature.
 * Unknown features get a grounded, non-inventing chat reply rather than nothing.
 */
export function deterministicAnswer(feature: string, request: RulesRequest): RulesAnswer {
  const responder = RESPONDERS[feature]
  try {
    if (responder) return { text: responder(request) }
    return { text: chatAnswer(request) }
  } catch {
    // The rules tier must not be the thing that throws.
    return { text: 'I could not complete that calculation from the data available to me. No result has been recorded — please try again or use the underlying report.' }
  }
}

export const RULES_ENGINE_VERSION = 'deterministic-v1'
export { RESPONDERS, QUESTION_BANK, CAPABILITIES }
