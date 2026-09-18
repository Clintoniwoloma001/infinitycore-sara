// ------------------------------------------------------------------
// SARA command parser — deterministic, no external LLM call.
// Turns free text into { intent, filters }. Never returns anything
// that implies an action was already taken; the caller (agentService)
// is responsible for matching, confirming, and executing.
// ------------------------------------------------------------------

const LEAVE_TYPES = ['annual', 'sick', 'maternity', 'paternity', 'personal', 'unpaid']

const CONFIRM_WORDS = /^\s*(yes|yeah|yep|confirm|approve|proceed|go ahead|do it|sure)\b/i
const CANCEL_WORDS = /^\s*(no|nope|cancel|stop|nevermind|never mind|don'?t)\b/i

// Role/permission elevation attempts must never be treated as a normal
// command — SARA must refuse these outright, regardless of phrasing.
const ROLE_ELEVATION = /\b(make|set|give|promote)\b.*\b(me|myself)\b.*\b(admin|super\s?admin|manager|hr|role)\b|\b(change|elevate|upgrade)\b.*\bmy\s+role\b/i

function extractEmployee(text) {
  let m = text.match(/approve\s+([a-z][a-z'\s]*?)'s\s+(?:leave|request)/i)
  if (m) return m[1].trim()
  m = text.match(/approve\s+leave\s+for\s+([a-z][a-z\s]*?)(?:$|[.,!?])/i)
  if (m) return m[1].trim()
  m = text.match(/reject\s+([a-z][a-z'\s]*?)'s\s+(?:leave|request)/i)
  if (m) return m[1].trim()
  return null
}

function extractLeaveType(text) {
  const found = LEAVE_TYPES.find((t) => new RegExp(`\\b${t}\\b`, 'i').test(text))
  return found || null
}

function extractBranch(text) {
  let m = text.match(/from\s+the\s+([a-z][a-z\s]*?)\s+branch/i) || text.match(/from\s+([a-z][a-z\s]*?)\s+branch/i)
  if (m) return m[1].trim()
  m = text.match(/\bin\s+([a-z][a-z\s]*?)\s+branch/i)
  if (m) return m[1].trim()
  // "from Lagos" / "in Lagos" without the word "branch" — take the next word(s)
  // but stop before duration/status qualifiers so we don't swallow them.
  m = text.match(/\bfrom\s+([a-z][a-z\s]*?)(?:\s+that|\s+with|\s+who|\s*,|\s*$|\s+are|\s+is)/i)
  if (m && !/^\d/.test(m[1]) && m[1].trim().length > 1) return m[1].trim()
  return null
}

// ------------------------------------------------------------------
// Strict termination detection. This is the deterministic entry point
// for firing/dismissing an employee. It only EXTRACTS the target and
// intent — the caller (agentService) is still responsible for role
// checking (super_admin / hr_manager ONLY), employee resolution, user
// confirmation, and the audited terminate_employee RPC.
// ------------------------------------------------------------------
const TERMINATION_VERBS = /\b(terminate|fire|dismiss|let go|lay off|discharge|relieve)\b/i

function extractTerminationTarget(text) {
  // "<name>'s employment (is|being) terminated"
  let m = text.match(/([a-zA-Z][a-zA-Z'\s]*?)'s\s+(?:employment\s+)?(?:is|being|be|has been)?\s*terminated/i)
  if (m) return m[1].trim()
  // "end <name>'s employment"
  m = text.match(/\bend\s+([a-zA-Z][a-zA-Z'\s]*?)'s\s+employment/i)
  if (m) return m[1].trim()
  // "terminate/fire/dismiss/... <name> ..." — capture the name, stop at
  // qualifiers like "effective", "for", "because", "due to".
  m = text.match(/\b(?:terminate|fire|dismiss|let go|lay off|discharge|relieve)\s+(?:the\s+)?(?:employment\s+of\s+|contract\s+of\s+)?([a-zA-Z][a-zA-Z'\s]*?)(?:\s+(?:effective|for|because|due|as of|immediately)|\s*,|\s*\.|\s*$)/i)
  if (m) return m[1].trim()
  // "<name>'s employment terminated" without a verb
  m = text.match(/([a-zA-Z][a-zA-Z'\s]*?)'s\s+employment\s+(?:has\s+been\s+)?terminated/i)
  if (m) return m[1].trim()
  return null
}

function isTerminationRequest(text) {
  if (/\bonboarding\b/.test(text)) return false
  if (/\b(?:review|query|about|how do i|how to|what is|who|why)\b/i.test(text) && !TERMINATION_VERBS.test(text)) return false
  // Avoid "show terminated employees" (a read) — terminate must be a
  // direct action on a specific person.
  if (/show|list|display|see|how many|count/i.test(text) && /terminated|termination/i.test(text)) return false
  return TERMINATION_VERBS.test(text) || /termination|terminate/i.test(text)
}

function extractDays(text) {
  let m = text.match(/(\d+)\s*days?\s*or\s*less/i)
  if (m) return { max_days: Number(m[1]) }
  m = text.match(/(\d+)\s*days?\s*or\s*more/i)
  if (m) return { min_days: Number(m[1]) }
  m = text.match(/(?:exactly\s+)?(\d+)\s*days?\b/i)
  if (m) return { exact_days: Number(m[1]) }
  return {}
}

// Maps navigation phrases to route keywords. "open customers" → 'customers'.
function extractNavigateTarget(text) {
  let m = text.match(/(?:open|show me|show|take me to|navigate to|switch to|go to)\s+(?:the\s+)?([a-z0-9][a-z0-9\s'&-]*?)\s*(?:page|section|screen)?\s*$/i)
  if (m) return m[1].trim()
  return null
}

// Extracts a searchable query from "search messages for X" style phrasing.
function extractSearchQuery(text) {
  // Prefer an explicitly quoted phrase.
  let m = text.match(/["']([^"']{2,})["']/)
  if (m) return m[1].trim()
  // "search messages for payroll", "find 'leave policy' in messages"
  m = text.match(/\b(?:search|find|look up|lookup|look for)\b\s+(?:the\s+)?(?:messages?\s+|announcements?\s+|records?\s+)?(?:for\s+|about\s+|matching\s+)?(.{2,}?)(?:\s+in\s+(?:the\s+)?messages?|\s+(?:that|which|about)\b.*|\s*official\b)?\s*$/i)
  if (m) return m[1].trim().replace(/\.$/, '')
  return null
}

function extractTrainingArea(text) {
  const match = text.match(/(?:in|from|did)\s+([a-z][a-z\s&-]*?)\s+area\b/i)
  return match ? `${match[1].trim()} Area` : null
}

// ------------------------------------------------------------------
// Communication (phase 40) intents — read-only and RLS-scoped. They are
// checked before the generic navigation fallback so "show announcements"
// is not swallowed as a navigation attempt.
// ------------------------------------------------------------------
function detectCommunicationIntent(text) {
  // Announcements I still need to acknowledge (mandatory acks outstanding).
  // Keyword can precede or follow "announcement", but never inside a
  // search request ("search announcements about pending payments").
  const pendingWord = /\b(?:unacknowledged|pending|outstanding|missed|missing|miss)\b/i
  const ackPending =
    (pendingWord.test(text) && /announcements?/i.test(text) && !/\b(?:search|find|look up|lookup|look for)\b/i.test(text)) ||
    /announcements?.*(need|needs|require|requires|awaiting|ack|acknowledg)/i.test(text) ||
    /(what|which).*(announcements?|messages?).*(need|must).*(acknowledge|ack)/i.test(text)
  if (ackPending) return { intent: 'COMMS_PENDING_ACK', filters: {} }
  // "show/list/recent announcements" — a read of what reached me.
  if (/announcements?/i.test(text)
      && /\b(show|list|display|see|recent|latest|new|mine|for me|updates|summary|open|go to)\b/i.test(text)
      && !/\b(?:search|find|look up|lookup|look for)\b/i.test(text)) {
    return { intent: 'COMMS_ANNOUNCEMENTS', filters: {} }
  }
  // Full-text search across everything the user can access (RLS-scoped).
  if (/\b(?:search|find|look up|lookup|look for)\b/i.test(text)
      && /(messages?|announcements?|official|records?|communications?)/i.test(text)) {
    const query = extractSearchQuery(text)
    return {
      intent: 'COMMS_SEARCH',
      filters: { query, official: /\bofficial\b/i.test(text) ? 'true' : undefined },
    }
  }
  return null
}

export function parseSaraCommand(raw) {
  const text = (raw || '').trim()
  if (!text) return { intent: 'UNKNOWN', filters: {} }

  if (ROLE_ELEVATION.test(text)) return { intent: 'ROLE_CHANGE_DENIED', filters: {} }
  if (CONFIRM_WORDS.test(text)) return { intent: 'CONFIRM', filters: {} }
  if (CANCEL_WORDS.test(text)) return { intent: 'CANCEL', filters: {} }

  // Communication (phase 40) reads are checked before the leave-approval
  // rules so "show pending announcements" is not mistaken for "show pending
  // leave approvals".
  const comm = detectCommunicationIntent(text)
  if (comm) return comm

  // Training/man-hour questions are read-only and are resolved by the
  // server-side aggregate RPC under the caller's existing organisation scope.
  if (/fewer than\s+(\d+(?:\.\d+)?)\s+training hours|less than\s+(\d+(?:\.\d+)?)\s+training hours/i.test(text)) {
    const match = text.match(/(?:fewer than|less than)\s+(\d+(?:\.\d+)?)\s+training hours/i)
    return { intent: 'TRAINING_LOW_HOURS', filters: { threshold: Number(match?.[1] || 10), area: extractTrainingArea(text) } }
  }
  if (/incomplete mandatory training|mandatory training.*incomplete|branches.*incomplete.*training/i.test(text)) {
    return { intent: 'TRAINING_MANDATORY', filters: { area: extractTrainingArea(text) } }
  }
  if (/monthly training report|training report/i.test(text)) {
    return { intent: 'TRAINING_REPORT', filters: { area: extractTrainingArea(text) } }
  }
  if (/training man[- ]hours|man[- ]hours.*(?:training|kss)|kss.*man[- ]hours/i.test(text)) {
    return { intent: 'TRAINING_MAN_HOURS', filters: { area: extractTrainingArea(text) } }
  }
  if (/training hours|employees completed training|completed training/i.test(text)) {
    return { intent: 'TRAINING_STATS', filters: { area: extractTrainingArea(text) } }
  }

  if (/how many.*(leave|approval|pending)/i.test(text) || /count.*(leave|approval)/i.test(text)) {
    return { intent: 'COUNT_PENDING', filters: {} }
  }

  if (/\b(show|list|display|see)\b.*(pending|leave|approval)/i.test(text) || /^my pending/i.test(text)) {
    return { intent: 'SHOW_PENDING', filters: {} }
  }

  // Onboarding reviews
  if (/onboarding.*review|review.*onboarding|pending.*onboarding|onboarding.*pending/i.test(text)) {
    return { intent: 'PENDING_ONBOARDING', filters: {} }
  }

  // Active employees count
  if (/how many.*(active.*employee|employee)|active.*employee.*count/i.test(text)) {
    return { intent: 'ACTIVE_EMPLOYEES', filters: {} }
  }

  // Interviews today
  if (/interview.*today|today.*interview|scheduled.*today/i.test(text)) {
    return { intent: 'INTERVIEWS_TODAY', filters: {} }
  }

  // Pending users/approvals
  if (/pending.*user|user.*pending|new.*signup|new.*user.*pending/i.test(text)) {
    return { intent: 'PENDING_USERS', filters: {} }
  }

  if (/\b(open|show me|go to|take me to|navigate to|switch to)\b/i.test(text) && text.split(/\s+/).length < 10) {
    const target = extractNavigateTarget(text)
    if (target) return { intent: 'NAVIGATE', filters: { target } }
  }

  if (/\bhelp\b/i.test(text) && text.split(/\s+/).length < 4) {
    return { intent: 'HELP', filters: {} }
  }

  if (isTerminationRequest(text)) {
    const target = extractTerminationTarget(text)
    if (target && target.trim().length > 1) {
      return { intent: 'TERMINATE_EMPLOYEE', filters: { employee: target.trim() } }
    }
  }

  if (/\breject/i.test(text)) {
    return {
      intent: 'REJECT_LEAVE',
      filters: {
        employee: extractEmployee(text),
        leave_type: extractLeaveType(text),
        branch: extractBranch(text),
        ...extractDays(text),
        all: /\ball\b/i.test(text) && !extractEmployee(text),
        status: 'pending',
      },
    }
  }

  if (/\bapprove\b/i.test(text)) {
    return {
      intent: 'APPROVE_LEAVE',
      filters: {
        employee: extractEmployee(text),
        leave_type: extractLeaveType(text),
        branch: extractBranch(text),
        ...extractDays(text),
        all: /\ball\b/i.test(text) && !extractEmployee(text),
        status: 'pending',
      },
    }
  }

  return { intent: 'UNKNOWN', filters: {} }
}
