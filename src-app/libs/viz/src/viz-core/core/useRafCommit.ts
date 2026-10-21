// core/useRafCommit.ts — a shared rAF-coalescing commit hook. Every high-frequency pointer signal
// (dataZoom rail drag, visualMap range drag, chart hover) funnels a value through here so a naive
// setter fired on every `pointermove` (~60×/s) is batched to AT MOST one commit per animation frame
// (intermediate frames dropped) while KEEPING the trailing value — the final position always
// commits (on the next frame). A pending frame is cancelled on unmount. Callers that must commit
// SYNCHRONOUSLY (a dataset-change reset) bypass this and call their setter directly.
//
// Extracted from `datazoom/DataZoom.tsx` (Phase 1) so the Phase-2 hover/filter bridges reuse the
// SAME throttle rather than each inventing its own. Behaviour is byte-identical to the original.
//
// viz-core rule: react only — no @ziee/*, no store, no DOM beyond requestAnimationFrame.

import { useEffect, useRef } from 'react'

/** rAF-coalesce a value setter: returns a `(v) => void` that commits at most once per frame,
 *  always with the latest value. `setState` is read through a ref so an inline closure passed each
 *  render never churns the returned identity. Cancels any pending frame on unmount. */
export function useRafCommit<T>(setState: (v: T) => void): (v: T) => void {
  const setRef = useRef(setState)
  setRef.current = setState
  const pending = useRef<{ v: T } | null>(null)
  const raf = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current)
    },
    [],
  )
  return (v: T) => {
    pending.current = { v }
    if (raf.current == null) {
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        const p = pending.current
        pending.current = null
        if (p) setRef.current(p.v)
      })
    }
  }
}
