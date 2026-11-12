// DataZoom.tsx — the core DATAZOOM component (EXTENSIBILITY_STUDY §5.2 / Part 6 STEP 4). This is
// the ECharts "dataZoom component" for `@txresbench/viz`: it OWNS a chart's dataZoom window as core
// state (the `useState` + the reset-on-domain-change effect that USED to live inside each View),
// renders the control surface (`ValueAxisZoom` / `MatrixDataZoom`) for the axes a descriptor
// declares, and feeds the CURRENT window back to the passive View via a render-prop. The View no
// longer owns the slider or the window state — it merely REACTS to the window (re-frame / re-
// densify). "Series is passive; dataZoom owns the window value; the reaction stays in the View."
//
// Two flavors mirror the two window models:
//   • `ValueDataZoom`  — a single value axis (violin / box / bar), over `ValueAxisZoom`.
//   • `MatrixDataZoom` (as `DataZoomMatrix`) — two index axes (heatmap / dotplot), over the
//     matrix control.
//
// PER-INSTANCE ENABLE/DISABLE is preserved verbatim: the `dataZoom` prop flows straight through to
// the underlying control (`false` / an `'off'` axis / no configured axis ⇒ no rail — the control
// renders `children` bare), so the `datazoom-toggle` story's rail-count contract is unchanged. The
// render-prop hands the View the SAME "active window" value the View previously computed inline
// (`zoomWindow ?? fullWindow` / `valueWindow ?? fullValueWindow`), so behavior is byte-identical.
//
// viz-core rule: react + sibling viz-core modules only (no @txresbench/*).

import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ValueAxisZoom } from '../charts/ValueAxisZoom'
import { MatrixDataZoom } from '../charts/MatrixDataZoom'
import type { DataZoomConfig } from '../charts/AxisDataZoom'
import { fullValueWindow, type ValueWindow } from '../charts/valueWindow'
import { fullWindow, type MatrixWindow } from '../charts/matrixWindow'
import { VizEventBusContext } from '../events/EventBusContext'
import { useRafCommit } from '../core/useRafCommit'
import { useStore } from 'zustand'
import { useVizStores } from '../../adapter/vizStores'

// ── SESSION_STATE_PLAN Phase 2: LIFT the dataZoom window into `PlotInteraction.store` ──────────
// The window USED to be pure component-local `useState`, invisible to a session snapshot. It is now
// OPT-IN store-backed: when a component is handed a STABLE per-plot `dataZoomId`, its window LIVES
// in the store keyed by that id (so capture/restore round-trips it); otherwise it keeps local
// `useState` (every current caller passes only a static `testId`, so they are byte-identical AND
// two same-kind plots never collide on a shared key). The store home engages exactly when a unique
// id is threaded (the showcase story; the union-time per-cell wiring). `useDataZoomWindowState`
// mirrors the `useState<T|null>` API so the reset-effect + commit logic below is unchanged.

/** A `[state, setState]` pair whose home is the store (keyed by `id`) when `id` is a non-empty
 *  stable plot id, else a local `useState`. Byte-identical to a bare `useState<T | null>(null)` for
 *  the local branch. The store value is read reactively (a restore that writes the store re-renders
 *  the component); `setState(null)` clears the store entry (⇒ the active-window fallback to full). */
function useDataZoomWindowState<T extends ValueWindow | MatrixWindow>(
  id: string | undefined,
): readonly [T | null, (win: T | null) => void] {
  const storeMode = id != null && id !== ''
  const key = storeMode ? id : ''
  // The active plot-interaction store from context (the module singleton when unprovided), so a
  // per-instance `<Viz>` keeps its dataZoom windows in ITS OWN store (VIZ_ISOLATION W2).
  const plotInteraction = useVizStores().plotInteraction
  // Always call the hook (stable order); in local mode the selector returns undefined and never
  // churns. Cast is safe — a given plot id only ever hosts ITS flavor's window.
  const storeWin = useStore(plotInteraction, s => (storeMode ? s.dataZoomWindows[key] : undefined)) as
    | T
    | undefined
  const [localWin, setLocalWin] = useState<T | null>(null)
  const win = storeMode ? (storeWin ?? null) : localWin
  const setWin = (next: T | null) => {
    if (!storeMode) {
      setLocalWin(next)
      return
    }
    const store = plotInteraction.getState()
    if (next == null) store.clearDataZoomWindow(key)
    else store.setDataZoomWindow(key, next)
  }
  return [win, setWin] as const
}

/**
 * The ACTIVE value window the component feeds to the passive View: the owned state, or the full
 * domain before the reset effect runs (`null` only while the domain is unknown). The Views' former
 * inline `valueWindow ?? fullValueWindow(...)` fallback — extracted PURE so the window-ownership
 * fallback is node-testable independent of React.
 */
export function activeValueWindow(
  win: ValueWindow | null,
  domain: readonly [number, number] | null,
): ValueWindow | null {
  if (!domain) return null
  return win ?? fullValueWindow(domain[0], domain[1])
}

/**
 * The ACTIVE matrix window the component feeds to the passive View: the owned state, or the full
 * matrix before the reset effect runs (`null` only while the dims are unknown). The Views' former
 * inline `zoomWindow ?? (nRows>0 && nCols>0 ? fullWindow(...) : null)` fallback — extracted PURE.
 */
export function activeMatrixWindow(
  win: MatrixWindow | null,
  nRows: number,
  nCols: number,
): MatrixWindow | null {
  return win ?? (nRows > 0 && nCols > 0 ? fullWindow(nRows, nCols) : null)
}

// `useRafCommit` (the rAF-coalesced window commit, H2) now lives in `../core/useRafCommit` so the
// Phase-2 hover/filter bridges reuse the SAME throttle. Behaviour is unchanged: every window source
// (rail drag, wheel, drag-pan) funnels through it, batching ~60Hz `setWin`s to one per frame while
// keeping the trailing value; the reset-to-full effects bypass it (calling `setWin` directly).

export interface ValueDataZoomProps {
  /**
   * The full value domain the window spans (`[lo, hi]`). MUST be a stable/memoized reference:
   * the window resets to the full domain whenever THIS reference changes (matching the Views'
   * former `useEffect(..., [valueRange])`). `null` before the data's domain is known.
   */
  readonly domain: readonly [number, number] | null
  /** Per-instance dataZoom config, threaded straight to `ValueAxisZoom` (`false` ⇒ no rail). */
  readonly dataZoom?: false | DataZoomConfig
  /** Enable value-axis drag-pan (off while a producing gesture owns the pointer). Default true. */
  readonly enablePan?: boolean
  readonly testId?: string
  /** The plot id carried on the emitted `dataZoom` event (EVENT_API_PLAN). Defaults to `testId`. */
  readonly dataZoomId?: string
  /** The passive View: receives the CURRENT window (or `null` before the domain is known). */
  readonly children: (window: ValueWindow | null) => ReactNode
}

/**
 * The value-axis dataZoom component (violin / box / bar): owns the `ValueWindow` state + the
 * reset-to-full-on-domain-change effect (hoisted out of each View), renders `ValueAxisZoom`, and
 * feeds the active window to the passive View. The View reacts (re-frame the y bounds / re-densify
 * the KDE) but no longer owns the state or the slider.
 */
export function ValueDataZoom({
  domain,
  dataZoom,
  enablePan,
  testId,
  dataZoomId,
  children,
}: ValueDataZoomProps) {
  // The window state's home is `PlotInteraction.store` when a stable `dataZoomId` is threaded
  // (SESSION_STATE_PLAN Phase 2), else local `useState` (byte-identical). Keyed ONLY on
  // `dataZoomId` (NEVER the shared static `testId`) so two same-kind plots can't collide.
  const [win, setWin] = useDataZoomWindowState<ValueWindow>(dataZoomId)
  const bus = useContext(VizEventBusContext)
  // Commit the owned window AND — when a `<Viz>` bus is present — fan a typed `dataZoom` event.
  // The value axis maps to `y`. Routed through `useRafCommit` so the emit is rAF-coalesced
  // identically to the state commit (no 60Hz event storm during a drag). The reset-to-full effect
  // below calls `setWin` DIRECTLY (bypassing this), so a dataset change emits no dataZoom event.
  const commitWin = useRafCommit((w: ValueWindow) => {
    setWin(w)
    bus?.emit({ type: 'dataZoom', id: dataZoomId ?? testId ?? '', axis: 'y', window: { y: [w.lo, w.hi] } })
  })
  // Reset to the full domain whenever the domain VALUES change (a new dataset / group set). Keyed on
  // the primitive `lo`/`hi` (not the `domain` array identity) so a caller passing a non-memoized
  // `[lo, hi]` literal that re-creates the SAME range every render does NOT clobber the user's zoom
  // (LOW-2). The matrix twin already keys on primitive nRows/nCols, so it was safe.
  const lo = domain?.[0]
  const hi = domain?.[1]
  useEffect(() => {
    setWin(lo != null && hi != null ? fullValueWindow(lo, hi) : null)
  }, [lo, hi])
  // The active window: the state, or the full domain before the reset effect runs (the Views'
  // former `valueWindow ?? fullValueWindow(...)`). `null` only while the domain is unknown.
  //
  // MEMOIZED ON THE DOMAIN *VALUES* (not just called inline) — load-bearing, not a micro-opt. When
  // `win` is null the fallback MINTS a fresh `{lo,hi}` object; calling it inline handed the passive
  // View a NEW `window` identity on EVERY render, which cascades: `ViolinBody.bounds` → its `layers`
  // memo → `ChartCanvas.allLayers` → a shared-deck `ChartLayerSink.publish` whose equality gate
  // compares `layers` BY REFERENCE (`chartLayerSink.ts`) ⇒ it notifies, `GridWorkspace` re-renders,
  // the chart re-renders, a new fallback object is minted … an unbounded publish↔re-render loop
  // (React "Maximum update depth exceeded"). A null `win` is NOT transient: `VizController.setOption`
  // hydrates `dataZoomWindows` from the option, so an option with no `dataZoom` block CLEARS the
  // store entry, while the reset effect above only re-seeds when the domain VALUES change — so a
  // surface that re-issues `setOption` over unchanged data (the declarative canvas, once per form
  // edit) leaves `win` permanently null. Keying the memo on `[win, lo, hi]` makes the fallback's
  // identity a pure function of the domain, so an unchanged domain settles after one frame.
  const active = useMemo(
    () => (lo != null && hi != null ? activeValueWindow(win, [lo, hi]) : null),
    [win, lo, hi],
  )
  if (!domain || !active) return <>{children(null)}</>
  return (
    <ValueAxisZoom
      domainLo={domain[0]}
      domainHi={domain[1]}
      value={active}
      onChange={commitWin}
      enablePan={enablePan}
      dataZoom={dataZoom}
      testId={testId}
    >
      {children(active)}
    </ValueAxisZoom>
  )
}

export interface DataZoomMatrixProps {
  readonly nRows: number
  readonly nCols: number
  /** Per-instance dataZoom config, threaded straight to `MatrixDataZoom` (`false` ⇒ no rails). */
  readonly dataZoom?: false | DataZoomConfig
  readonly testId?: string
  /** The plot id carried on the emitted `dataZoom` event (EVENT_API_PLAN). Defaults to `testId`. */
  readonly dataZoomId?: string
  /** The passive View: receives the CURRENT matrix window (or `null` before dims are known). */
  readonly children: (window: MatrixWindow | null) => ReactNode
}

/**
 * The matrix (2-axis, index-unit) dataZoom component (heatmap / dotplot): owns the `MatrixWindow`
 * state + the reset-to-full-on-dims-change effect (hoisted out of each View), renders the matrix
 * control, and feeds the active window to the passive View, which re-frames to it.
 */
export function DataZoomMatrix({
  nRows,
  nCols,
  dataZoom,
  testId,
  dataZoomId,
  children,
}: DataZoomMatrixProps) {
  // Store-backed when a stable `dataZoomId` is threaded (SESSION_STATE_PLAN Phase 2), else local
  // `useState` (byte-identical). Keyed ONLY on `dataZoomId`, never the shared static `testId`.
  const [win, setWin] = useDataZoomWindowState<MatrixWindow>(dataZoomId)
  const bus = useContext(VizEventBusContext)
  // Commit the owned matrix window AND — when a `<Viz>` bus is present — fan a typed `dataZoom`
  // event. A matrix moves BOTH index axes (cols→x, rows→y) in one commit → `axis: 'xy'`. rAF-
  // coalesced identically to the state commit; the reset-to-full effect below bypasses this.
  const commitWin = useRafCommit((w: MatrixWindow) => {
    setWin(w)
    bus?.emit({
      type: 'dataZoom',
      id: dataZoomId ?? testId ?? '',
      axis: 'xy',
      window: { x: [w.col0, w.col1], y: [w.row0, w.row1] },
    })
  })
  // Reset to the full matrix whenever the DIMENSIONS change (a new dataset). Clustering only
  // reorders the same dims, so the window persists across cluster/z-score toggles — exactly the
  // Views' former `useEffect(() => { if (nRows>0 && nCols>0) setZoomWindow(fullWindow(...)) }, [nRows,nCols])`.
  useEffect(() => {
    if (nRows > 0 && nCols > 0) setWin(fullWindow(nRows, nCols))
  }, [nRows, nCols])
  // The active window: the state, or the full matrix before the reset effect runs (the Views'
  // former `zoomWindow ?? (nRows>0 && nCols>0 ? fullWindow(...) : null)`). MEMOIZED for the same
  // identity reason as the value twin above — a fresh fallback object per render churns the passive
  // View's layers memo, which the shared-deck sink's by-reference equality gate cannot absorb.
  const active = useMemo(() => activeMatrixWindow(win, nRows, nCols), [win, nRows, nCols])
  if (!active) return <>{children(null)}</>
  return (
    <MatrixDataZoom
      nRows={nRows}
      nCols={nCols}
      value={active}
      onChange={commitWin}
      dataZoom={dataZoom}
      testId={testId}
    >
      {children(active)}
    </MatrixDataZoom>
  )
}
