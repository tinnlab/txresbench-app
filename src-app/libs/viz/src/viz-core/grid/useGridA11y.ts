// useGridA11y.ts — SPLIT O (ITEM-31): the grid's ACCESSIBILITY plane.
//
// DEC-26's census row "a11y keyboard / focus / announce" (131), moved verbatim out of
// `GridWorkspace`: the `a11yEnabled` gate, the `:focus-visible` bookkeeping
// (`kbdFocusVisible` + `markKeyboardDriven` / `clearKeyboardFocusVisible`), the live-region handle
// and the `say` announcer, the focused-cell state and its never-dangling `effFocusedId` derivation,
// the three render-state-free mirror refs the listeners read, `announceFocus`, the dedicated
// cell-CYCLING keydown listener, the `useCanvasKeyboard` pan/zoom/activate/clear bindings, and the
// focused-cell outline rect.
//
// It is ONE plane because `effFocusedIdRef` is read by four of the five listener callbacks and
// written by the only two things that set focus — any internal cut strands the ref from its writers.
//
// SHAPE — a value bundle (DEC-27/DEC-28, a seventh time). `focusedCellId` and `kbdFocusVisible` are
// already `useState`, and `focusedRect` is a `useMemo` over `denseRects` — promoting the last one to
// a store would put a subscription on the RECT path, which is the one path TEST-P1 counts per wheel.
//
// Writer-set completeness (HAZARD 1), per moved state — the method, and its limit:
//   `focusedCellId`         two writers (`Home` and the cycle branch), both inside the keydown
//                           listener that moves. Lexical `useState`; `tsc` complete.
//   `kbdFocusVisible`       written only through `markKeyboardDriven` / `clearKeyboardFocusVisible`.
//                           The SECOND is called from the shell's `gridRoot` (the container's
//                           `onBlur`), so it is RETURNED; the first has all six call sites here.
//   `liveRef`               declared here and RETURNED — `<A11yLiveRegion ref>` renders in the
//                           shell's `gridRoot`, so the WRITER is a JSX ref prop. A prop is typed, so
//                           `tsc` sees it, but no `grep` of this module does. Named for that reason.
//   `onGridAnnounceRef`     render-time mirror of the `onA11yAnnounce` PROP; the prop stays a prop
//                           and is passed in, so the mirror travels with its only reader (`say`).
//   `effFocusedIdRef` / `denseCellsA11yRef` / `cellMapA11yRef`
//                           render-time mirrors, written and read only here; `tsc` complete.
//   `containerRef` / `viewStateRef` / `onViewStateChangeRef` / `cellDataRef`
//                           NOT moved. All four are SHELL- or SEAM-owned with other readers; this
//                           plane reads them. Borrowed, not taken.
//   `clearGridSelection`    NOT moved — the SELECTION plane owns it (Split I). Passed in, so the
//                           Escape binding calls the same function the rail does.
//
// NO DEV WINDOW SEAM is installed from this module. Checked, not assumed.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { INITIAL_VIEW_STATE, type CellDataResolved, type GridCell } from './gridModel'
import type { PaneRect } from '../layers/multiView'
import type { GridViewState } from './linkZoom'
import { useCanvasKeyboard } from '../a11y/keyboardControls'
import type { A11yLiveRegionHandle } from '../a11y/A11yLiveRegion'
import { announceViewChange, announceEmpty } from '../a11y/liveRegion'

export interface GridA11yInputs {
  /** The opt-in gate: a11y is OFF unless the host supplies a label (and WebGL is up). */
  readonly accessibleLabel: string | undefined
  readonly glOk: boolean
  readonly onA11yAnnounce: ((message: string) => void) | undefined
  readonly denseIds: ReadonlySet<string>
  readonly denseCells: readonly GridCell[]
  readonly cellMap: Record<string, GridCell>
  readonly denseRects: readonly PaneRect[]
  readonly nPoints: number
  /** Shell-owned: the workspace root, which is the keyboard TARGET for both listeners. */
  readonly containerRef: RefObject<HTMLDivElement | null>
  /** SEAM refs the deck layer fills (SPLIT A) — the camera keys read and write through them. */
  readonly viewStateRef: RefObject<Record<string, GridViewState>>
  readonly onViewStateChangeRef: RefObject<(e: { viewId: string; viewState: GridViewState }) => void>
  readonly cellDataRef: RefObject<(cell: GridCell) => CellDataResolved>
  /** Owned by the SELECTION plane (Split I) — Escape must clear the same selection the rail does. */
  readonly clearGridSelection: () => void
}

export function useGridA11y({
  accessibleLabel,
  glOk,
  onA11yAnnounce,
  denseIds,
  denseCells,
  cellMap,
  denseRects,
  nPoints,
  containerRef,
  viewStateRef,
  onViewStateChangeRef,
  cellDataRef,
  clearGridSelection,
}: GridA11yInputs) {
  // ── Accessibility (opt-in via `accessibleLabel`) ─────────────────────────────────────────
  // The shared deck is N views over N dense cells, so keyboard camera control drives ONE FOCUSED
  // dense cell at a time: `[`/`]` (and `,`/`.`) cycle focus, `Home` = first; arrows pan the focused
  // cell (Shift = larger step), +/- zoom it, Enter/Space announce it, Esc clear the selection — each
  // spoken through an off-screen ARIA live region. Pan/zoom flow through the SAME `onViewStateChange`
  // the mouse uses, so link-zoom fan-out + zoom clamping are inherited for free. The camera is
  // CONTROLLED here, so a keyboard move just re-renders with the new state — no remount (unlike the
  // uncontrolled single-canvas views). `guardTarget` + the cycle-listener's own `e.target === el`
  // check keep every chrome button/select's native keys (a focused child is never hijacked).
  const a11yEnabled = accessibleLabel != null && glOk
  // `:focus-visible` semantics for the focused-cell ring. The ring exists so a SIGHTED KEYBOARD user
  // can see which dense cell the `[`/`]`/arrow/zoom keys drive — it is meaningless chrome for a mouse
  // user, who already points at the cell they mean. So it is armed only by an actual grid-driving
  // keypress and disarmed by the next pointer press anywhere in the workspace (capture phase, so an
  // overlay that stops propagation still disarms it). Guarded setters => no re-render when unchanged.
  const [kbdFocusVisible, setKbdFocusVisible] = useState(false)
  const markKeyboardDriven = useCallback(() => setKbdFocusVisible(v => (v ? v : true)), [])
  const clearKeyboardFocusVisible = useCallback(() => setKbdFocusVisible(v => (v ? false : v)), [])
  const liveRef = useRef<A11yLiveRegionHandle | null>(null)
  const onGridAnnounceRef = useRef(onA11yAnnounce)
  onGridAnnounceRef.current = onA11yAnnounce
  const say = useCallback((m: string) => {
    liveRef.current?.announce(m)
    onGridAnnounceRef.current?.(m)
  }, [])
  const [focusedCellId, setFocusedCellId] = useState<string | null>(null)
  // The EFFECTIVE focused dense cell: the tracked id when it's still a dense cell, else the first
  // dense cell (focus never dangles after a remove / kind-switch). Null when there are no dense cells.
  const effFocusedId = useMemo(() => {
    if (focusedCellId && denseIds.has(focusedCellId)) return focusedCellId
    return denseCells[0]?.id ?? null
  }, [focusedCellId, denseIds, denseCells])
  // Refs the (inline) keyboard handlers read at key time (no stale closure).
  const effFocusedIdRef = useRef(effFocusedId)
  effFocusedIdRef.current = effFocusedId
  const denseCellsA11yRef = useRef(denseCells)
  denseCellsA11yRef.current = denseCells
  const cellMapA11yRef = useRef(cellMap)
  cellMapA11yRef.current = cellMap

  // Announce the focused cell ("scatter cell 2 of 3 focused"). Reads refs (render-state-free).
  const announceFocus = useCallback(
    (id: string | null) => {
      const list = denseCellsA11yRef.current
      if (!id) {
        say('No cell to focus')
        return
      }
      const idx = list.findIndex(c => c.id === id)
      const kind = cellMapA11yRef.current[id]?.kind ?? 'cell'
      say(`${kind} cell ${idx + 1} of ${list.length} focused`)
    },
    [say],
  )

  // Cycle the focused dense cell with `[`/`]` (and `,`/`.`) + `Home`. A DEDICATED listener (cell-
  // cycling is grid-specific, NOT a `keyToAction` intent), target-guarded like the camera keys.
  useEffect(() => {
    if (!a11yEnabled) return
    const el = containerRef.current
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      if (e.target !== el) return
      const list = denseCellsA11yRef.current
      if (list.length === 0) return
      if (e.key === 'Home') {
        e.preventDefault()
        markKeyboardDriven()
        setFocusedCellId(list[0].id)
        announceFocus(list[0].id)
        return
      }
      let dir = 0
      if (e.key === ']' || e.key === '.') dir = 1
      else if (e.key === '[' || e.key === ',') dir = -1
      else return
      e.preventDefault()
      markKeyboardDriven()
      const cur = effFocusedIdRef.current
      const i = Math.max(0, list.findIndex(c => c.id === cur))
      const next = list[(i + dir + list.length) % list.length].id
      setFocusedCellId(next)
      announceFocus(next)
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [a11yEnabled, announceFocus, markKeyboardDriven])

  useCanvasKeyboard({
    ref: containerRef,
    enabled: a11yEnabled,
    guardTarget: true,
    onPan: ({ dx, dy }) => {
      markKeyboardDriven()
      const id = effFocusedIdRef.current
      if (!id) return
      const vs = viewStateRef.current[id]
      if (!vs) return
      // world units per key so a keypress moves a roughly-constant SCREEN distance across zooms.
      const step = 24 / 2 ** (vs.zoom ?? INITIAL_VIEW_STATE.zoom)
      onViewStateChangeRef.current({
        viewId: id,
        viewState: { target: [vs.target[0] + dx * step, vs.target[1] + dy * step, 0], zoom: vs.zoom },
      })
    },
    onZoom: ({ dir }) => {
      markKeyboardDriven()
      const id = effFocusedIdRef.current
      if (!id) return
      const vs = viewStateRef.current[id]
      if (!vs) return
      onViewStateChangeRef.current({
        viewId: id,
        viewState: { target: [vs.target[0], vs.target[1], 0], zoom: vs.zoom + (dir === 'in' ? 1 : -1) },
      })
      say(announceViewChange(dir === 'in' ? 1 : -1))
    },
    onActivate: () => {
      markKeyboardDriven()
      const id = effFocusedIdRef.current
      const cell = id ? cellMapA11yRef.current[id] : undefined
      const kind = cell?.kind ?? 'cell'
      // Announce the FOCUSED cell's OWN dataset point count (a multi-dataset cell has a different N
      // than the default `nPoints`); cellData resolves it per-cell.
      const n = cell ? cellDataRef.current(cell).nPoints : nPoints
      say(`${kind} cell, ${n.toLocaleString()} points`)
    },
    onClearSelection: () => {
      clearGridSelection()
      say(announceEmpty())
    },
  })

  // The focused dense cell's measured rect, for the visible keyboard-focus outline (sighted keyboard
  // users need to see WHICH cell the arrows drive).
  const focusedRect = useMemo(
    () =>
      a11yEnabled && kbdFocusVisible && effFocusedId
        ? denseRects.find(r => r.id === effFocusedId) ?? null
        : null,
    [a11yEnabled, kbdFocusVisible, effFocusedId, denseRects],
  )

  return {
    a11yEnabled,
    kbdFocusVisible,
    clearKeyboardFocusVisible,
    liveRef,
    effFocusedId,
    focusedRect,
  }
}
