// @vitest-environment jsdom
//
// CanvasCoverage.test.tsx — ITEM-19, the unit half of TEST-24.
//
// ── WHAT THIS DOES WHEN THE DEFECT IS PRESENT ─────────────────────────────────────────────────
//
// The defect ITEM-19 is most at risk of shipping is not "no indicator" — it is an indicator that
// LIES: one that flashes a full bar at the live 3,460-row layout, which arrives as a single
// 8,192-row inner chunk and cannot fill progressively at all. A test that only asserted "the indicator
// appears and reaches 100%" would pass with that defect fully intact, so the single-chunk leg here
// asserts ABSENCE THROUGHOUT — not absence at the end — by inspecting after every event.
//
// The events are the REAL `StreamProgress` shape the source emits (`workbenchStreamingSource.ts`),
// fed through a stand-in with the same `onProgress` contract, so this measures the component's
// rule and the multi-chunk source test measures the producer.

import { cleanup, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasCoverage } from './CanvasCoverage'
import type { StreamProgress, WorkbenchStreamingSource } from '../data'

/** A stand-in exposing only `onProgress` — the whole surface the indicator consumes. */
function progressSource() {
  const observers = new Set<(p: StreamProgress) => void>()
  return {
    source: {
      onProgress(o: (p: StreamProgress) => void) {
        observers.add(o)
        return () => observers.delete(o)
      },
    } as unknown as WorkbenchStreamingSource,
    emit(p: Partial<StreamProgress>) {
      const full: StreamProgress = {
        key: 'positions\nlayout-1',
        kind: 'positions',
        chunks: 1,
        bytesSeen: 0,
        rowsSeen: 0,
        totalRows: 100000,
        done: false,
        ...p,
      }
      act(() => {
        for (const o of observers) o(full)
      })
    },
    observers,
  }
}

const indicator = () => screen.queryByTestId('workbench-canvas-coverage')

afterEach(cleanup)

describe('CanvasCoverage — ITEM-19', () => {
  it('a MULTI-chunk read: appears, advances past 0, and DISAPPEARS on completion', async () => {
    const p = progressSource()
    render(<CanvasCoverage source={p.source} />)
    // Non-vacuity: the component really subscribed.
    expect(p.observers.size).toBe(1)

    // Chunk 1 — still nothing: one chunk is not evidence of progressive arrival.
    p.emit({ chunks: 1, rowsSeen: 8192 })
    expect(indicator()).toBeNull()

    // Chunk 2 — now it is real progress, so it shows, and it shows a REAL fraction.
    p.emit({ chunks: 2, rowsSeen: 16384 })
    const el = indicator()
    expect(el).not.toBeNull()
    expect(Number(el!.getAttribute('data-coverage-pct'))).toBeGreaterThan(0)
    expect(el!.textContent).toContain('16,384 of 100,000 rows')

    // It advances.
    p.emit({ chunks: 8, rowsSeen: 65536 })
    expect(Number(indicator()!.getAttribute('data-coverage-pct'))).toBe(65)

    // Completion removes it — never a bar left sitting at 100%.
    p.emit({ chunks: 13, rowsSeen: 100000, done: true })
    expect(indicator()).toBeNull()
  })

  it('a SINGLE-chunk read (the live 3,460-row shape): ABSENT throughout, never a flashed bar', () => {
    const p = progressSource()
    render(<CanvasCoverage source={p.source} />)
    const seen: (Element | null)[] = []

    // The exact event sequence the live 3,460-row layout produces: one inner chunk, then done.
    p.emit({ chunks: 1, rowsSeen: 3460, totalRows: 3460 })
    seen.push(indicator())
    p.emit({ chunks: 1, rowsSeen: 3460, totalRows: 3460, done: true })
    seen.push(indicator())

    // ABSENT AFTER EVERY EVENT — not merely absent at the end. A "hidden once complete"
    // implementation passes an end-state check while still flashing a full bar mid-load.
    expect(seen).toEqual([null, null])
  })

  it('reports nothing without a denominator, rather than guessing one', () => {
    const p = progressSource()
    render(<CanvasCoverage source={p.source} />)
    p.emit({ chunks: 4, rowsSeen: 32768, totalRows: null })
    expect(indicator()).toBeNull()
  })

  it('ignores non-positions channels — a colour column is not canvas load progress', () => {
    const p = progressSource()
    render(<CanvasCoverage source={p.source} />)
    p.emit({ key: 'continuous\nartifact/col', kind: 'continuous', chunks: 6, rowsSeen: 40000 })
    expect(indicator()).toBeNull()
    // Positive control: the same numbers on the positions channel DO show, so the previous
    // assertion is about the channel filter and not about the numbers being unusable.
    p.emit({ chunks: 6, rowsSeen: 40000 })
    expect(indicator()).not.toBeNull()
  })

  it('renders nothing at all when there is no streaming source to observe', () => {
    render(<CanvasCoverage source={null} />)
    expect(indicator()).toBeNull()
  })
})
