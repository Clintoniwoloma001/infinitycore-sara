// ------------------------------------------------------------------
// Task progress — pure domain helpers (single source of truth).
// No Supabase/React imports; safe to import from node tests.
// Mirrors the SQL engine `public.calculate_task_completion(jsonb, jsonb)`.
// ------------------------------------------------------------------

let _idSeq = 0
export function nextItemId() {
  _idSeq += 1
  return `item_${Date.now().toString(36)}_${_idSeq}`
}

// Build a stable item id for existing (splitted) instructions.
export function itemIdFor(index, taskId) {
  return `item_${taskId || 'legacy'}_${index}`
}

// Normalise a possibly-unstructured instructions string into distinct
// numbered sub-items. Splits on lines that start with a number + `.`/`)`,
// otherwise falls back to the whole text as a single item. Used when a task
// was created with the old single-text format so it can still be itemized.
export function splitInstructions(text, taskId) {
  if (!text || !String(text).trim()) return []
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    // A numbered line: "1." / "1)" / "1. " maybe with a leading "Step"/period.
    .filter((l) => l.length > 0)
  const numbered = []
  for (const line of lines) {
    if (/^\s*\d+[.)]/.test(line)) {
      numbered.push(line.replace(/^\s*\d+[.)]\s*/, '').trim())
    }
  }
  const hasNumbering = numbered.length >= 2
  const rawItems = hasNumbering ? numbered : [String(text).trim()]

  return rawItems
    .filter((t) => t.length > 0)
    .map((text, idx) => ({
      id: itemIdFor(idx, taskId),
      text,
      progress: 0,
    }))
}

// THE completion engine. Overall completion = average of ALL sub-item
// percentages (missing/untouched items count as 0) divided by the TOTAL number
// of sub-items. Worked example from the request: sub-items [100,70,0,0,0] on a
// 5-sub-item task → (100+70+0+0+0)/5 = 34%, never 85%.
export function averageItemCompletion(items, progressById) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return null // no sub-items → caller falls back

  const pct = (id) => {
    const p = progressById?.[id]
    const n = Number(p)
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0
  }

  let sum = 0
  for (const item of list) sum += pct(item.id)
  return Math.round(sum / list.length)
}

// Map from the stored `instruction_progress` array (rows keyed by item_id) to
// a plain `{ [itemId]: progress }` object.
export function progressById(progressRows) {
  const out = {}
  if (!Array.isArray(progressRows)) return out
  for (const row of progressRows) {
    const n = Number(row?.progress)
    if (row?.item_id) out[row.item_id] = Number.isFinite(n) ? n : 0
  }
  return out
}

// Build the `instruction_progress` array back from a map (only touched items).
export function progressRows(items, progressByIdMap) {
  const out = []
  if (!Array.isArray(items)) return out
  for (const item of items) {
    const n = Number(progressByIdMap?.[item.id])
    if (Number.isFinite(n)) out.push({ item_id: item.id, progress: Math.max(0, Math.min(100, n)) })
  }
  return out
}

// The effective completion for a task (auto when sub-items exist, else single).
export function effectiveCompletion(task, progressByIdMap) {
  if (!task) return 0
  const auto = averageItemCompletion(task.instruction_items, progressByIdMap)
  if (auto !== null) return auto
  const manual = Number(task.completion_percentage)
  return Number.isFinite(manual) ? manual : 0
}

// Aggregate KPI/task completion rate for a set of tasks over a date range.
// Rate = average of each task's effective completion. Tasks are included when
// their window overlaps the range: start_date <= range-end AND due_date >=
// range-start (null dates are treated as unbounded).
export function kpiCompletionRate(tasks, { from, to, progressMapByTask } = {}) {
  const s = from ? new Date(String(from).slice(0, 10)) : null
  const e = to ? new Date(String(to).slice(0, 10)) : null
  const cmp = (d, base) => (base ? new Date(String(d).slice(0, 10)) - base : 0)
  const inRange = (t) => {
    if (s && t.start_date && cmp(t.start_date, s) > 0) return false
    if (e && t.due_date && cmp(t.due_date, e) < 0) return false
    return true
  }
  const list = (Array.isArray(tasks) ? tasks : []).filter(inRange)
  if (list.length === 0) return { task_count: 0, completion_rate: 0 }
  let sum = 0
  for (const t of list) {
    const map = progressMapByTask?.[t.id] ?? progressById(t.instruction_progress)
    sum += effectiveCompletion(t, map)
  }
  return {
    task_count: list.length,
    completion_rate: Math.round(sum / list.length),
  }
}