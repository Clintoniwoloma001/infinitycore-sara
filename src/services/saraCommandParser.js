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

function extractDays(text) {
  let m = text.match(/(\d+)\s*days?\s*or\s*less/i)
  if (m) return { max_days: Number(m[1]) }
  m = text.match(/(\d+)\s*days?\s*or\s*more/i)
  if (m) return { min_days: Number(m[1]) }
  m = text.match(/(?:exactly\s+)?(\d+)\s*days?\b/i)
  if (m) return { exact_days: Number(m[1]) }
  return {}
}

export function parseSaraCommand(raw) {
  const text = (raw || '').trim()
  if (!text) return { intent: 'UNKNOWN', filters: {} }

  if (ROLE_ELEVATION.test(text)) return { intent: 'ROLE_CHANGE_DENIED', filters: {} }
  if (CONFIRM_WORDS.test(text)) return { intent: 'CONFIRM', filters: {} }
  if (CANCEL_WORDS.test(text)) return { intent: 'CANCEL', filters: {} }

  if (/how many.*(leave|approval|pending)/i.test(text) || /count.*(leave|approval)/i.test(text)) {
    return { intent: 'COUNT_PENDING', filters: {} }
  }

  if (/\b(show|list|display|see)\b.*(pending|leave|approval)/i.test(text) || /^my pending/i.test(text)) {
    return { intent: 'SHOW_PENDING', filters: {} }
  }

  if (/\bhelp\b/i.test(text) && text.split(/\s+/).length < 4) {
    return { intent: 'HELP', filters: {} }
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
