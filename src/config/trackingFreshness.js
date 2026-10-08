// ============================================================================
// Employee Tracking — freshness + history display thresholds.
//
// THE one config file. Every freshness state, every "is this fix old enough to
// matter" boundary used by the Live positions and Movement history tabs is
// declared here and nowhere else — no component, service or SQL comment may
// hard-code its own number.
//
// Age is always measured against SERVER time: the RPC returns `age_seconds`
// (now() - recorded_at, computed in Postgres) and the UI adds only the elapsed
// wall-clock since that response arrived, so a wrong browser clock can never
// turn a two-day-old fix into a "live" one.
// ============================================================================

/** Freshness states, in freshness order. */
export const FRESHNESS = Object.freeze({
  LIVE: 'live',
  DELAYED: 'delayed',
  STALE: 'stale',
  /** The employee has never produced a fix. Displayed as "No location yet";
   *  counted as STALE in the header counters (see LivePositions). */
  NONE: 'none',
})

/**
 * Boundaries in SECONDS from the fix's recorded_at (device capture time).
 *   age <=  6 min  -> LIVE     (current look, Inside/Outside badge only)
 *   age <= 30 min  -> DELAYED  (badge + amber "delayed" hint)
 *   age >  30 min  -> STALE    (grey chip, "Last known …" wording)
 */
export const FRESHNESS_SECONDS = Object.freeze({
  LIVE: 6 * 60,
  DELAYED: 30 * 60,
})

/** Movement history: uploaded_at - recorded_at beyond this = "uploaded late". */
export const LATE_UPLOAD_MINUTES = 5

/** Movement history: a pause between two fixes beyond this gets a gap row. */
export const TIMELINE_GAP_MINUTES = 10

/** A point whose GPS error exceeds the fence radius cannot prove inside/outside. */
export const LOW_ACCURACY_SUFFIX = '(low GPS accuracy)'

/**
 * Classify an age in seconds (server-computed, plus elapsed since the fetch).
 * Returns one of FRESHNESS.* — never throws, never invents a state.
 */
export function classifyAgeSeconds(ageSeconds) {
  if (ageSeconds == null) return FRESHNESS.NONE
  const seconds = Number(ageSeconds)
  if (!Number.isFinite(seconds)) return FRESHNESS.NONE
  if (seconds <= FRESHNESS_SECONDS.LIVE) return FRESHNESS.LIVE
  if (seconds <= FRESHNESS_SECONDS.DELAYED) return FRESHNESS.DELAYED
  return FRESHNESS.STALE
}

/**
 * The age of a live-position row in seconds, anchored to the server clock.
 *
 * `row.age_seconds` comes straight from Postgres (now() - recorded_at), so the
 * absolute reference is the SERVER. `elapsedMs` is only the wall-clock time that
 * has passed since that response was received — a delta, not a timestamp — so
 * the age keeps advancing between polls without trusting the browser clock.
 */
export function ageSecondsOf(row, elapsedMs = 0) {
  if (!row) return null
  const base = row.age_seconds ?? (row.minutes_ago != null ? Number(row.minutes_ago) * 60 : null)
  if (base == null || !Number.isFinite(Number(base))) return null
  const elapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) / 1000 : 0
  return Number(base) + elapsed
}

/** Freshness of a live-position row, given the milliseconds since it was fetched. */
export function rowFreshness(row, elapsedMs = 0) {
  if (!row) return FRESHNESS.NONE
  // A row with no fix has no age (age_seconds is null), so it lands in NONE.
  const age = ageSecondsOf(row, elapsedMs)
  if (age == null) return FRESHNESS.NONE
  return classifyAgeSeconds(age)
}

/** Header buckets. Rows with no fix land in `stale` (never in `live`). */
export function countFreshness(rows = [], elapsedMs = 0) {
  const counts = { live: 0, delayed: 0, stale: 0, none: 0 }
  for (const row of rows) {
    const state = rowFreshness(row, elapsedMs)
    if (state === FRESHNESS.LIVE) counts.live += 1
    else if (state === FRESHNESS.DELAYED) counts.delayed += 1
    else if (state === FRESHNESS.NONE) counts.none += 1
    // NONE counts as stale: "no location yet" is never presented as current.
    if (state === FRESHNESS.NONE) counts.stale += 1
    else if (state === FRESHNESS.STALE) counts.stale += 1
  }
  return counts
}

/** "1h 20m" / "45m" — used by the history gap rows. */
export function formatDurationMinutes(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}
