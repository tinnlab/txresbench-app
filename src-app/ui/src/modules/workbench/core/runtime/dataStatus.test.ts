import { describe, it, expect } from 'vitest'
import { aggregateDataStatus, type DataStatus, type SliceResolution } from './dataStatus'

// TEST-1 (incremental-landing #29, ITEM-1) — `partial` is a first-class DataStatus with an
// explicit arm at every consumer, never a silent fallthrough. Here we pin the PURE consumer
// (`aggregateDataStatus`) and the type-level admission; the RENDER consumers are pinned by TEST-9
// (`dataStatusGate.test.tsx`, RegionStatus/DeclarativeRegion) and the landing consumer by TEST-8
// (`viewData.test.ts`). Each drives `partial` and asserts a DELIBERATE outcome — the negative
// control is that a consumer with no arm falls through to a default and returns a plausible-but-
// wrong value, so every assertion below names the SPECIFIC outcome rather than "not a crash".

describe('TEST-1 — partial as a first-class DataStatus', () => {
  it('SliceResolution.status admits partial (type + runtime)', () => {
    const r: SliceResolution = { status: 'partial' }
    expect(r.status).toBe('partial')
    // The type accepts it: this line would not compile if `partial` were absent from SliceStatus.
    const s: DataStatus = 'partial'
    expect(s).toBe('partial')
  })

  it('aggregateDataStatus ranks partial ABOVE ready and empty (still arriving beats "done"/"nothing")', () => {
    // A frame that is ready on one slice and still arriving on another is STILL ARRIVING.
    expect(aggregateDataStatus([{ status: 'ready' }, { status: 'partial' }]).status).toBe('partial')
    expect(aggregateDataStatus([{ status: 'partial' }, { status: 'empty' }]).status).toBe('partial')
    // A lone partial folds to partial (deliberate — not a fallthrough to ready/empty).
    expect(aggregateDataStatus([{ status: 'partial' }]).status).toBe('partial')
  })

  it('aggregateDataStatus keeps every FAULT above partial — a still-arriving slice never masks one', () => {
    expect(aggregateDataStatus([{ status: 'partial' }, { status: 'error', error: 'x' }]).status).toBe(
      'error',
    )
    expect(aggregateDataStatus([{ status: 'partial' }, { status: 'unreadable' }]).status).toBe(
      'unreadable',
    )
    expect(aggregateDataStatus([{ status: 'partial' }, { status: 'unsupported' }]).status).toBe(
      'unsupported',
    )
  })

  it('a pure-ready or pure-empty fold is unchanged by the new arm (no regression)', () => {
    expect(aggregateDataStatus([{ status: 'ready' }, { status: 'empty' }]).status).toBe('ready')
    expect(aggregateDataStatus([{ status: 'empty' }]).status).toBe('empty')
  })
})
