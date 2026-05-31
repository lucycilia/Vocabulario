// Pure spaced-repetition + data-merge logic, extracted from App.jsx so it can be
// unit-tested in isolation (no React, no DOM). App.jsx imports everything here.
//
// FSRS-5 implementation (https://github.com/open-spaced-repetition/fsrs4anki/wiki).
// Grades: 1=Forgot, 2=Hard, 3=Good, 4=Easy.

// Default FSRS-5 weights (the canonical published defaults).
export const FSRS_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
]
export const FSRS_F = 19.0 / 81.0
export const FSRS_C = -0.5
export const DESIRED_RETENTION = 0.9
export const MAX_INTERVAL = 36500

// ─── Date Helpers ───
export const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const today = () => localDateStr()

// practiceDays entries can be either a legacy number (single-device) or an object
// keyed by device ID (multi-device). Always read through totalForDay.
export const totalForDay = (entry) => {
  if (typeof entry === 'number') return entry
  if (entry && typeof entry === 'object') {
    let sum = 0
    for (const v of Object.values(entry)) sum += typeof v === 'number' ? v : 0
    return sum
  }
  return 0
}
// Whether a day counts as "studied" for day-tallies and streaks. A day whose
// per-review count was lost (stored as an empty {}) is still a day you studied —
// the entry only exists because a review or migration recorded it. Use this for
// counting study days; use totalForDay only for review-count math (heatmap
// intensity, averages, tooltips).
export const studiedOnDay = (entry) => {
  if (entry == null) return false
  if (typeof entry === 'number') return entry > 0
  return typeof entry === 'object' // any recorded object, including empty {}
}

export const FSRS = {
  // Forgetting curve: R(t, S) = (1 + F * t/S)^C
  retrievability: (t, s) => {
    if (s <= 0) return 0
    return Math.pow(1.0 + FSRS_F * (t / s), FSRS_C)
  },
  // Interval from desired retention and stability
  interval: (s) => {
    return Math.max(
      1,
      Math.min(
        MAX_INTERVAL,
        Math.round((s / FSRS_F) * (Math.pow(DESIRED_RETENTION, 1.0 / FSRS_C) - 1.0))
      )
    )
  },
  // Initial stability based on first grade
  s0: (grade) => FSRS_W[grade - 1],
  // Initial difficulty based on first grade
  d0: (grade) => {
    return Math.min(10, Math.max(1, FSRS_W[4] - Math.exp(FSRS_W[5] * (grade - 1)) + 1))
  },
  // Update stability on successful recall (grade 2, 3, or 4)
  sSuccess: (d, s, r, grade) => {
    const td = 11.0 - d
    const ts = Math.pow(s, -FSRS_W[9])
    const tr = Math.exp(FSRS_W[10] * (1.0 - r)) - 1.0
    const h = grade === 2 ? FSRS_W[15] : 1.0
    const b = grade === 4 ? FSRS_W[16] : 1.0
    const c = Math.exp(FSRS_W[8])
    const alpha = 1.0 + td * ts * tr * h * b * c
    return s * alpha
  },
  // Update stability on failure (grade 1)
  sFail: (d, s, r) => {
    const df = Math.pow(d, -FSRS_W[12])
    const sf = Math.pow(s + 1, FSRS_W[13]) - 1.0
    const rf = Math.exp(FSRS_W[14] * (1.0 - r))
    const cf = FSRS_W[11]
    return Math.min(df * sf * rf * cf, s)
  },
  // Update stability
  stability: (d, s, r, grade) => {
    if (grade === 1) return FSRS.sFail(d, s, r)
    return FSRS.sSuccess(d, s, r, grade)
  },
  // Update difficulty
  difficulty: (d, grade) => {
    const deltaD = -FSRS_W[6] * (grade - 3)
    const dp = d + deltaD * ((10.0 - d) / 9.0)
    const newD = FSRS_W[7] * FSRS.d0(4) + (1.0 - FSRS_W[7]) * dp
    return Math.min(10, Math.max(1, newD))
  },
  // Create a new card
  defaultCard: (word, translation, phrase, keywordStart, keywordEnd) => ({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    word,
    translation,
    phrase,
    keywordStart,
    keywordEnd,
    // FSRS state
    stability: 0,
    difficulty: 0,
    reps: 0,
    dueDate: localDateStr(),
    lastReview: null,
    firstReviewedAt: null,
    learningStep: 0,
    priority: false,
    suspended: false,
    created: localDateStr(),
    modifiedAt: Date.now(),
  }),
  // Review a card with a grade (1=Forgot, 2=Hard, 3=Good, 4=Easy)
  review: (card, grade) => {
    const reps = card.reps || 0
    const inLearning = reps === 0
    // Learning step: brand-new cards (or cards being relearned at reps=0) get one
    // re-exposure in the same session before they graduate to FSRS scheduling.
    // First click "Good/Easy/Hard" → 10min step. "Forgot" → restart the step.
    // Second click (any non-Forgot) → graduate via the FSRS path below.
    if (inLearning && (grade === 1 || (card.learningStep || 0) === 0)) {
      return {
        ...card,
        dueDate: localDateStr(),
        dueAfter: Date.now() + 10 * 60 * 1000,
        lastReview: localDateStr(),
        firstReviewedAt: card.firstReviewedAt || localDateStr(),
        learningStep: 1,
        priority: false,
        modifiedAt: Date.now(),
      }
    }
    let { stability: s, difficulty: d } = card
    if (reps === 0) {
      // First graduating review: initialize S and D from the grade
      s = FSRS.s0(grade)
      d = FSRS.d0(grade)
    } else {
      // Calculate elapsed days since last review
      const lastReviewDate = card.lastReview ? new Date(card.lastReview + 'T12:00:00') : new Date()
      const now = new Date()
      const elapsed = Math.max(0, (now - lastReviewDate) / 86400000)
      // Calculate retrievability at time of review
      const r = FSRS.retrievability(elapsed, s)
      // Update stability and difficulty
      s = FSRS.stability(d, s, r, grade)
      d = FSRS.difficulty(d, grade)
    }
    // Calculate next interval from new stability, with ±5% fuzz for intervals ≥ 3 days
    let interval = FSRS.interval(s)
    if (interval >= 3) {
      const fuzz = 1 + (Math.random() - 0.5) * 0.1
      interval = Math.max(1, Math.min(MAX_INTERVAL, Math.round(interval * fuzz)))
    }
    const due = new Date()
    due.setDate(due.getDate() + interval)
    // Forgot cards reappear after 10 minutes instead of tomorrow
    const dueAfter = grade === 1 ? Date.now() + 10 * 60 * 1000 : null
    return {
      ...card,
      stability: s,
      difficulty: d,
      reps: reps + 1,
      dueDate: grade === 1 ? localDateStr() : localDateStr(due),
      dueAfter,
      lastReview: localDateStr(),
      // Only mark firstReviewedAt when this is genuinely the card's first review
      // (reps was 0). For already-graduated cards (reps > 0), leave it alone — they
      // were "introduced" long ago, not today, and counting them would shrink the
      // daily new-card slot pool incorrectly.
      firstReviewedAt: card.firstReviewedAt || (reps === 0 ? localDateStr() : null),
      // Clear the "study next" priority flag once the card has been introduced
      priority: false,
      // Reset learning step now that we've graduated
      learningStep: 0,
      modifiedAt: Date.now(),
    }
  },
}

export const mergeCards = (localCards, remoteCards, localDeleted, remoteDeleted) => {
  const merged = {}
  const mergedDeleted = {}
  // Combine deletions, keep newer timestamp per ID
  for (const [id, t] of Object.entries(localDeleted || {}))
    mergedDeleted[id] = Math.max(mergedDeleted[id] || 0, t)
  for (const [id, t] of Object.entries(remoteDeleted || {}))
    mergedDeleted[id] = Math.max(mergedDeleted[id] || 0, t)
  // Index all cards by ID, keep newer version
  for (const c of localCards) merged[c.id] = c
  for (const c of remoteCards) {
    const existing = merged[c.id]
    if (!existing) {
      merged[c.id] = c
    } else if ((c.modifiedAt || 0) > (existing.modifiedAt || 0)) {
      // Remote wins — but preserve local-only fields that remote dropped
      // (e.g. keywordSpans, which the Apps Script proxy may not persist as a column).
      // We never want a sync round-trip to erase formatting the user added locally.
      const preserved = {}
      if (
        Array.isArray(existing.keywordSpans) &&
        existing.keywordSpans.length > 0 &&
        (!Array.isArray(c.keywordSpans) || c.keywordSpans.length === 0)
      ) {
        preserved.keywordSpans = existing.keywordSpans
      }
      if (existing.firstReviewedAt && !c.firstReviewedAt)
        preserved.firstReviewedAt = existing.firstReviewedAt
      if (existing.firstReview && !c.firstReview) preserved.firstReview = existing.firstReview
      merged[c.id] = { ...c, ...preserved }
    }
  }
  // Apply deletions: delete if tombstone is newer than card
  for (const [id, delTime] of Object.entries(mergedDeleted)) {
    if (merged[id] && (merged[id].modifiedAt || 0) <= delTime) {
      delete merged[id]
    } else if (merged[id]) {
      // Card modified after deletion — keep card, remove tombstone
      delete mergedDeleted[id]
    }
  }
  // Tombstones are kept forever (one numeric per delete, negligible size; guarantees
  // delete propagation even on devices offline for months).
  return { cards: Object.values(merged), deleted: mergedDeleted }
}

export const mergePracticeDays = (local, remote) => {
  const merged = {}
  const allDays = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])
  for (const day of allDays) {
    const l = (local || {})[day]
    const r = (remote || {})[day]
    // Two legacy numbers — keep the max (best guess at the truth).
    if (typeof l === 'number' && typeof r === 'number') {
      merged[day] = Math.max(l, r)
      continue
    }
    // One side is per-device object, the other is legacy — promote to per-device.
    const lObj = typeof l === 'object' && l ? l : typeof l === 'number' ? { __legacy__: l } : {}
    const rObj = typeof r === 'object' && r ? r : typeof r === 'number' ? { __legacy__: r } : {}
    const combined = { ...lObj }
    for (const [device, count] of Object.entries(rObj)) {
      combined[device] = Math.max(combined[device] || 0, count || 0)
    }
    merged[day] = combined
  }
  return merged
}
