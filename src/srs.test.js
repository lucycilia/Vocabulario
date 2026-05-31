import { describe, it, expect } from 'vitest'
import {
  FSRS,
  FSRS_W,
  mergeCards,
  mergePracticeDays,
  totalForDay,
  studiedOnDay,
  localDateStr,
  today,
} from './srs.js'

const card = (over = {}) => ({
  id: 'c1',
  word: 'w',
  translation: 't',
  phrase: 'p',
  stability: 0,
  difficulty: 0,
  reps: 0,
  dueDate: today(),
  lastReview: null,
  firstReviewedAt: null,
  learningStep: 0,
  priority: false,
  suspended: false,
  modifiedAt: 1000,
  ...over,
})

describe('FSRS.review — learning step (new cards)', () => {
  it('first review of a new card stays in learning (reps 0) with a 10-min step', () => {
    const r = FSRS.review(card(), 3) // Good
    expect(r.reps).toBe(0)
    expect(r.learningStep).toBe(1)
    expect(r.dueDate).toBe(today())
    expect(r.dueAfter).toBeGreaterThan(Date.now())
    expect(r.dueAfter).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 5000)
    expect(r.firstReviewedAt).toBe(today())
  })

  it('Forgot on a brand-new card also keeps it in the learning step', () => {
    const r = FSRS.review(card(), 1) // Forgot
    expect(r.reps).toBe(0)
    expect(r.learningStep).toBe(1)
    expect(r.dueAfter).toBeGreaterThan(Date.now())
  })

  it('second pass (learningStep 1) graduates to FSRS scheduling', () => {
    const r = FSRS.review(card({ learningStep: 1 }), 3) // Good
    expect(r.reps).toBe(1)
    expect(r.stability).toBe(FSRS.s0(3)) // initial stability from grade
    expect(r.difficulty).toBeGreaterThanOrEqual(1)
    expect(r.difficulty).toBeLessThanOrEqual(10)
    expect(r.dueAfter).toBeNull()
    expect(r.learningStep).toBe(0)
  })
})

describe('FSRS.review — graduated cards', () => {
  const graduated = card({
    reps: 3,
    stability: 10,
    difficulty: 5,
    lastReview: '2026-05-20',
    firstReviewedAt: '2026-01-01',
    learningStep: 0,
  })

  it('increments reps by exactly 1', () => {
    expect(FSRS.review(graduated, 3).reps).toBe(4)
  })

  it('Forgot lowers stability (never above prior) and re-dues today + 10 min', () => {
    const r = FSRS.review(graduated, 1)
    expect(r.stability).toBeLessThanOrEqual(graduated.stability)
    expect(r.dueDate).toBe(today())
    expect(r.dueAfter).toBeGreaterThan(Date.now())
    expect(r.reps).toBe(4)
  })

  it('a successful review raises stability and clears the 10-min step', () => {
    const r = FSRS.review(graduated, 3)
    expect(r.stability).toBeGreaterThan(graduated.stability)
    expect(r.dueAfter).toBeNull()
  })

  it('preserves firstReviewedAt on already-graduated cards', () => {
    expect(FSRS.review(graduated, 3).firstReviewedAt).toBe('2026-01-01')
  })
})

describe('FSRS — algorithm invariants', () => {
  it('stability gain is ordered Easy ≥ Good ≥ Hard for the same state', () => {
    const d = 5,
      s = 10,
      r = 0.9
    const sHard = FSRS.sSuccess(d, s, r, 2)
    const sGood = FSRS.sSuccess(d, s, r, 3)
    const sEasy = FSRS.sSuccess(d, s, r, 4)
    expect(sEasy).toBeGreaterThanOrEqual(sGood)
    expect(sGood).toBeGreaterThanOrEqual(sHard)
  })

  it('interval increases monotonically with stability', () => {
    expect(FSRS.interval(20)).toBeGreaterThan(FSRS.interval(5))
    expect(FSRS.interval(100)).toBeGreaterThan(FSRS.interval(20))
  })

  it('difficulty is clamped to [1,10] and Forgot is harder than Easy', () => {
    const dForgot = FSRS.d0(1)
    const dEasy = FSRS.d0(4)
    expect(dForgot).toBeGreaterThan(dEasy)
    for (const g of [1, 2, 3, 4]) {
      expect(FSRS.d0(g)).toBeGreaterThanOrEqual(1)
      expect(FSRS.d0(g)).toBeLessThanOrEqual(10)
    }
  })

  it('retrievability is 1 at t=0 and decreases over time', () => {
    expect(FSRS.retrievability(0, 10)).toBeCloseTo(1, 10)
    expect(FSRS.retrievability(20, 10)).toBeLessThan(FSRS.retrievability(5, 10))
  })

  it('uses the canonical FSRS-5 default weights', () => {
    expect(FSRS_W).toHaveLength(19)
    expect(FSRS_W[0]).toBeCloseTo(0.40255, 5)
  })
})

describe('mergeCards', () => {
  it('the newer modifiedAt wins', () => {
    const local = [{ id: 'a', reps: 1, modifiedAt: 100 }]
    const remote = [{ id: 'a', reps: 5, modifiedAt: 200 }]
    const { cards } = mergeCards(local, remote, {}, {})
    expect(cards.find((c) => c.id === 'a').reps).toBe(5)
  })

  it('keeps local when local is newer', () => {
    const local = [{ id: 'a', reps: 9, modifiedAt: 300 }]
    const remote = [{ id: 'a', reps: 1, modifiedAt: 100 }]
    const { cards } = mergeCards(local, remote, {}, {})
    expect(cards.find((c) => c.id === 'a').reps).toBe(9)
  })

  it('preserves local keywordSpans when a newer remote dropped them', () => {
    const local = [{ id: 'a', modifiedAt: 100, keywordSpans: [[0, 3]] }]
    const remote = [{ id: 'a', modifiedAt: 200 }]
    const { cards } = mergeCards(local, remote, {}, {})
    expect(cards.find((c) => c.id === 'a').keywordSpans).toEqual([[0, 3]])
  })

  it('a tombstone newer than the card deletes it', () => {
    const local = [{ id: 'a', modifiedAt: 100 }]
    const { cards } = mergeCards(local, [], { a: 200 }, {})
    expect(cards.find((c) => c.id === 'a')).toBeUndefined()
  })

  it('a card edited after its tombstone survives (edit beats delete)', () => {
    const local = [{ id: 'a', modifiedAt: 300 }]
    const { cards } = mergeCards(local, [], { a: 200 }, {})
    expect(cards.find((c) => c.id === 'a')).toBeDefined()
  })

  it('preserves local firstReviewedAt when a newer remote dropped it', () => {
    const local = [{ id: 'a', modifiedAt: 100, firstReviewedAt: '2026-01-01' }]
    const remote = [{ id: 'a', modifiedAt: 200 }]
    const { cards } = mergeCards(local, remote, {}, {})
    expect(cards.find((c) => c.id === 'a').firstReviewedAt).toBe('2026-01-01')
  })

  it('adds a remote-only card not present locally', () => {
    const { cards } = mergeCards(
      [{ id: 'a', modifiedAt: 100 }],
      [{ id: 'b', modifiedAt: 50 }],
      {},
      {}
    )
    expect(cards.map((c) => c.id).sort()).toEqual(['a', 'b'])
  })
})

describe('mergePracticeDays', () => {
  it('takes the max of two legacy numbers per day', () => {
    expect(mergePracticeDays({ '2026-01-01': 3 }, { '2026-01-01': 7 })['2026-01-01']).toBe(7)
  })

  it('promotes a legacy number against a per-device object and keeps both', () => {
    const m = mergePracticeDays({ d1: 0, '2026-01-01': { devA: 5 } }, { '2026-01-01': 3 })
    expect(m['2026-01-01']).toEqual({ devA: 5, __legacy__: 3 })
  })

  it('takes per-device max across devices', () => {
    const m = mergePracticeDays(
      { '2026-01-01': { devA: 5, devB: 2 } },
      { '2026-01-01': { devB: 9 } }
    )
    expect(m['2026-01-01']).toEqual({ devA: 5, devB: 9 })
  })
})

describe('totalForDay / studiedOnDay', () => {
  it('totalForDay sums numbers, objects, and treats empties as 0', () => {
    expect(totalForDay(4)).toBe(4)
    expect(totalForDay({ a: 2, b: 3 })).toBe(5)
    expect(totalForDay({})).toBe(0)
    expect(totalForDay(null)).toBe(0)
    expect(totalForDay(undefined)).toBe(0)
  })

  it('studiedOnDay counts any recorded entry (incl. empty {}) but not 0/absent', () => {
    expect(studiedOnDay({})).toBe(true) // count lost, but the day happened
    expect(studiedOnDay({ devA: 2 })).toBe(true)
    expect(studiedOnDay(5)).toBe(true)
    expect(studiedOnDay(0)).toBe(false)
    expect(studiedOnDay(null)).toBe(false)
    expect(studiedOnDay(undefined)).toBe(false)
  })
})
