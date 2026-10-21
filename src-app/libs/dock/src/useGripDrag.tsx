// useGripDrag — the content-agnostic pointer-drag lifecycle for a dock grip (extracted from viz's
// CellView). A grip's `pointerdown` starts a drag; the drag then tracks via WINDOW-level
// pointermove/up/cancel (NOT pointer capture) so it follows the cursor across whatever's underneath —
// robust across engines and, crucially, ACROSS WINDOWS: the drag attaches its listeners to EVERY open
// dock window (the main + each popup), so a pane can be dragged from one window and dropped into
// another. On pointerup the pure `resolveDrop` decides, per the window the pointer is in, whether the
// release is a same-container SWAP, a cross-container MOVE (dock into another window), a TEAR-OFF (new
// window), or nothing; the caller's `onResolve` executes it. Escape / pointercancel / a genuine
// app-wide focus loss abort cleanly.
//
// The drag is a MODULE-LEVEL SESSION, not per-component state — deliberately. Only one drag runs at a
// time (the module `dragState` already models that), and the SOURCE component can re-mount mid-drag
// (Arch-A moves a pane by re-mounting it; a portaled popup subtree can also churn on an unrelated
// re-render). Tying the session's listeners/ghost/snapshots to a component's lifecycle would let such a
// re-mount abort the in-flight drag. Module ownership makes the session survive a source re-mount and
// end ONLY on a real terminal event (pointerup / cancel / Escape / app-wide blur).
//
// A module-level REACTIVE drag state (`useGripDragState`) drives cross-pane highlighting (which pane /
// container is the current drop target) so every consumer — in every window (they share one React tree
// via portals) — re-renders on a target change. The caller supplies ONLY: a per-window rect snapshot
// (its own DOM query, run against each window's document) + what a resolved drop DOES.
//
// The floating drag GHOST is one element the session re-homes across documents (appendChild/adoptNode)
// so it follows the cursor into whatever window holds it — the "one JS context, move the node" insight
// the portal pop-out is built on.

import { useCallback, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { resolveDrop, type DragResolution, type DragRect, type RectLike } from './dragGeometry'
import { PRIMARY_CONTAINER } from './containers'
import { getPopupWindowsSnapshot } from './popupWindowRegistry'

// ── module-level reactive drag state (one drag at a time) ───────────────────────────────────────
export interface GripDragState {
  readonly active: boolean
  /** what kind of session is live: a pane DRAG, or an aim-to-place PLACEMENT of a NEW pane. Both drive
   *  the SAME cross-window drop-target highlights (a placement is resolved as a `move` into whatever
   *  container the cursor is over); consumers use `mode` to show placement-only affordances. */
  readonly mode: 'idle' | 'drag' | 'placement'
  readonly sourceId: string | null
  /** the CURRENT resolved target under the cursor (for the drop-target highlight). */
  readonly target: DragResolution
}
const IDLE: GripDragState = { active: false, mode: 'idle', sourceId: null, target: { kind: 'none' } }
let dragState: GripDragState = IDLE
const listeners = new Set<() => void>()

function setDrag(next: GripDragState): void {
  dragState = next
  for (const l of listeners) l()
}
/** Set the reactive module drag state back to IDLE. INTERNAL ONLY — it does NOT tear down a live
 *  `session`/`placement` (that's `endGripDrag`/`endGripPlacement`), so exporting it would be a latch
 *  footgun (a caller could clear the reactive flag while leaving listeners + the ghost attached, then
 *  the one-at-a-time guard blocks every future drag). The end paths call it AFTER their own teardown. */
function clearGripDrag(): void {
  if (dragState === IDLE) return
  setDrag(IDLE)
}
/** Inspection accessor for the module drag active flag (avoids exporting the mutable binding). */
export function isGripDragActive(): boolean {
  return dragState.active
}
/** True when two resolutions denote the same drop target (so a move only re-publishes on a CHANGE). */
function sameResolution(a: DragResolution, b: DragResolution): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'swap' && b.kind === 'swap') return a.paneId === b.paneId
  if (a.kind === 'move' && b.kind === 'move') {
    return a.container === b.container && a.overPaneId === b.overPaneId && a.dir === b.dir && a.before === b.before
  }
  return true
}

/** Reactive read of the module drag state so every consumer re-renders (arming / disarming its
 *  drop-target highlight) when a drag starts / ends / changes target. */
export function useGripDragState(): GripDragState {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => dragState,
    () => dragState,
  )
}

// ── window enumeration ────────────────────────────────────────────────────────────────────────
/** A dock window the drag tracks across: its container id + its `Window`. */
interface DockWindow {
  readonly containerId: string
  readonly win: Window
}
/** Every OPEN dock window: the main window (`PRIMARY_CONTAINER`) plus each registered popup. A closed
 *  popup is skipped. This is the set the drag attaches listeners to + snapshots at `pointerdown`. */
function enumerateDockWindows(): DockWindow[] {
  const out: DockWindow[] = []
  if (typeof window !== 'undefined') out.push({ containerId: PRIMARY_CONTAINER, win: window })
  for (const [containerId, win] of getPopupWindowsSnapshot()) {
    try {
      if (win && !win.closed) out.push({ containerId, win })
    } catch {
      /* a window navigated away / cross-origin — skip */
    }
  }
  return out
}

// ── snapshot + options ──────────────────────────────────────────────────────────────────────────
export interface GripSnapshot {
  /** the panes to hit-test against (by id + client rect, in the snapshotted window's coords). */
  readonly panes: DragRect[]
  /** the window's workspace rect (a release outside it → tear-off / no-op). */
  readonly containerRect: RectLike
}

export interface UseGripDragOptions {
  /** this grip's pane id (the drag SOURCE). */
  readonly sourceId: string
  /** which container the source pane lives in (default `PRIMARY_CONTAINER`). A drop in this container
   *  is a swap/tearoff; a drop in ANOTHER container is a cross-window move. */
  readonly sourceContainerId?: string
  /** snapshot ONE window's pane rects + workspace rect (the caller's DOM query against `win`'s
   *  document), in THAT window's client coords. Called for EVERY open dock window at pointerdown.
   *  `null` when the window has no workspace yet (skipped as a drop target). */
  readonly snapshot: (win: Window, containerId: string) => GripSnapshot | null
  /** run the resolved drop — swap within the source container, MOVE to another container, or tear-off.
   *  Called with the resolved target on a real pointerup; NOT called on abort. `kind: 'none'` filtered. */
  readonly onResolve: (target: DragResolution) => void
  /** label rendered on the floating drag ghost. */
  readonly ghostLabel?: string
  readonly ghostTestId?: string
}

export interface GripDragHandle {
  /** attach to the grip element's `onPointerDown`. */
  readonly onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
}

/** Ghost element styling as a cssText string (imperative — the ghost is a re-homed DOM node, not a
 *  React child, so it can cross documents). */
const GHOST_CSS_TEXT =
  'position:fixed;top:0;left:0;z-index:1000;pointer-events:none;padding:2px 8px;' +
  "font:12px system-ui, sans-serif;color:#fff;background:rgba(59,130,246,0.9);" +
  'border:1px solid rgba(255,255,255,0.4);border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
  'white-space:nowrap;will-change:transform;'

// ── the module-level drag session ────────────────────────────────────────────────────────────────
/** Click-vs-drag threshold (px): a press that never moves this far is a CLICK, not a drag — it neither
 *  resolves a drop nor shows drag chrome (its element's `onClick` runs instead). This is what lets a tab
 *  be BOTH click-to-activate AND drag-to-move without the click accidentally firing a swap/replace. */
const DRAG_THRESHOLD_PX = 4

interface DragSession {
  readonly sourceId: string
  readonly sourceContainerId: string
  /** the pointer that started the drag — later move/up/cancel from a DIFFERENT pointer (multitouch) are
   *  ignored, so a second finger can't hijack or abort the drag. */
  readonly pointerId: number
  readonly onResolve: (target: DragResolution) => void
  /** per-window snapshots captured at pointerdown (containerId → its rects, in its window's coords). */
  readonly snapMap: Map<string, GripSnapshot>
  ghost: HTMLDivElement | null
  /** press origin (client coords) + whether the pointer has crossed the drag threshold yet. */
  readonly startX: number
  readonly startY: number
  moved: boolean
  /** the source window + ghost labels, held so the ghost + drag chrome can be created LAZILY on the
   *  first real move (not on pointerdown — a click must show nothing). */
  readonly sourceWin: Window
  readonly ghostLabel?: string
  readonly ghostTestId?: string
  /** removes every window's listeners. */
  cleanup: () => void
}
let session: DragSession | null = null

/** Re-home + reposition a ghost element into the window the pointer is now in (one JS context — move
 *  the node). Shared by the drag session + the placement session. */
function moveGhostEl(el: HTMLDivElement | null, win: Window, x: number, y: number): void {
  if (!el) return
  try {
    if (el.ownerDocument !== win.document) {
      win.document.body.appendChild(win.document.adoptNode(el))
    }
    el.style.transform = `translate(${x + 12}px, ${y + 12}px)`
  } catch {
    /* window went away mid-drag — the end path removes the ghost */
  }
}

function moveGhostTo(win: Window, x: number, y: number): void {
  moveGhostEl(session?.ghost ?? null, win, x, y)
}

/** Resolve the drop for a pointer at `(x, y)` in `containerId`'s window (its snapshot + local coords). */
function resolveInWindow(containerId: string, x: number, y: number): DragResolution {
  const s = session
  const snap = s?.snapMap.get(containerId)
  if (!s || !snap) return { kind: 'none' }
  return resolveDrop(
    x,
    y,
    { containerId, containerRect: snap.containerRect, panes: snap.panes },
    s.sourceId,
    s.sourceContainerId,
  )
}

/** The single end path: tear down listeners + ghost, clear the session + module state — and, when a
 *  real resolution is passed (pointerup), run it. Abort paths pass `null`. */
function endGripDrag(resolution: DragResolution | null): void {
  const s = session
  if (!s) return
  s.cleanup()
  const g = s.ghost
  s.ghost = null
  // Clear the module session + reactive state BEFORE touching the ghost DOM: if the ghost was re-homed
  // into a popup that has since closed, `removeChild` on a torn-down cross-window node can throw — and
  // a throw here previously left `session` non-null / `dragState.active` true, permanently latching the
  // drag (every future grip press hits the `if (session || isGripDragActive()) return` guard). State
  // first, then remove the ghost defensively.
  session = null
  clearGripDrag()
  try {
    g?.parentNode?.removeChild(g)
  } catch {
    /* ghost's window went away mid-drag — nothing more to clean up */
  }
  if (resolution && resolution.kind !== 'none') s.onResolve(resolution)
}

/** Start a drag session for `opts` at pointer event `e`. No-op if a drag is already active. */
function beginGripDrag(opts: UseGripDragOptions, e: ReactPointerEvent<HTMLElement>): void {
  if (session || placement || isGripDragActive()) return // one drag/placement at a time, globally
  if (typeof window === 'undefined') return
  const sourceContainerId = opts.sourceContainerId ?? PRIMARY_CONTAINER

  // Snapshot EVERY open dock window (its rects, in ITS OWN client coords) so a drop in any window
  // hit-tests against that window's panes. Windows are stable during a drag (a new popup needs a fresh
  // gesture), so a start-of-drag snapshot is sufficient.
  const dockWindows = enumerateDockWindows()
  const snapMap = new Map<string, GripSnapshot>()
  for (const { containerId, win } of dockWindows) {
    const snap = opts.snapshot(win, containerId)
    if (snap) snapMap.set(containerId, snap)
  }
  // The source's own window MUST be snapshotted (else there is nothing to drag against).
  if (!snapMap.has(sourceContainerId)) return
  // Do NOT preventDefault here — a plain CLICK on the grip/tab must still fire the element's `onClick`
  // (a tab click activates it). We only stopPropagation (don't bubble the press). The drag is COMMITTED
  // lazily on the first move past `DRAG_THRESHOLD_PX` (in `onMove`): only then do we preventDefault,
  // arm the reactive drag state, and create the ghost — so a click resolves nothing.
  e.stopPropagation()
  const sourceWin = (e.currentTarget.ownerDocument?.defaultView ?? window) as Window

  const removers: Array<() => void> = []
  const activeSession: DragSession = {
    sourceId: opts.sourceId,
    sourceContainerId,
    pointerId: e.pointerId,
    onResolve: opts.onResolve,
    snapMap,
    ghost: null,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    sourceWin,
    ghostLabel: opts.ghostLabel,
    ghostTestId: opts.ghostTestId,
    cleanup: () => {
      for (const r of removers) r()
    },
  }
  session = activeSession

  // Attach the drag listeners to EVERY dock window. Each handler is tagged with its window's
  // containerId, so a pointermove/up in window W resolves against W's snapshot + local coords.
  for (const { containerId, win } of dockWindows) {
    if (!snapMap.has(containerId)) continue
    const onMove = (ev: PointerEvent) => {
      if (!session || ev.pointerId !== session.pointerId) return // ignore a 2nd finger (multitouch)
      // Termination backstop for a release the per-window `pointerup` listeners can't see: a button-up
      // over the DESKTOP (no dock window under the cursor) delivers `pointerup` to no dock document, and
      // if focus never left the source window the `blur` backstop below never fires either — the drag
      // would latch. The FIRST `pointermove` back over any dock window carries `buttons === 0` (button
      // no longer held) → abort (we can't know where it was released, so we never fake a drop).
      if (ev.buttons === 0) {
        endGripDrag(null)
        return
      }
      // Click-vs-drag threshold: until the pointer moves past it, this is still a CLICK — don't resolve,
      // don't show drag chrome. On crossing it, COMMIT to the drag (preventDefault + reactive state +
      // lazily create the ghost).
      if (!session.moved) {
        if (
          Math.abs(ev.clientX - session.startX) <= DRAG_THRESHOLD_PX &&
          Math.abs(ev.clientY - session.startY) <= DRAG_THRESHOLD_PX
        ) {
          return
        }
        session.moved = true
        ev.preventDefault()
        setDrag({ active: true, mode: 'drag', sourceId: session.sourceId, target: { kind: 'none' } })
        try {
          const g = session.sourceWin.document.createElement('div')
          g.style.cssText = GHOST_CSS_TEXT
          if (session.ghostTestId) g.setAttribute('data-testid', session.ghostTestId)
          g.textContent = session.ghostLabel ?? ''
          session.sourceWin.document.body.appendChild(g)
          session.ghost = g
        } catch {
          /* no ghost (headless / detached) — the drag still works */
        }
      }
      const res = resolveInWindow(containerId, ev.clientX, ev.clientY)
      if (!sameResolution(dragState.target, res)) {
        setDrag({ active: true, mode: 'drag', sourceId: session.sourceId, target: res })
      }
      moveGhostTo(win, ev.clientX, ev.clientY)
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== activeSession.pointerId) return // ignore a 2nd finger's lift
      // A press that never crossed the threshold is a CLICK, not a drop → resolve nothing (the element's
      // own onClick handles it, e.g. a tab click activates the tab).
      endGripDrag(activeSession.moved ? resolveInWindow(containerId, ev.clientX, ev.clientY) : null)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== activeSession.pointerId) return
      endGripDrag(null)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endGripDrag(null)
    }
    // Backstop: a window blur mid-drag. Dragging INTO another dock window ALSO blurs this one, so do
    // NOT abort on that — defer a tick (let the newly-focused window settle) and abort only when NO
    // dock window has focus (the pointer left the app entirely, so no pointerup will arrive). Bail if
    // the drag that armed this timer has already ended (a stale timer must not abort a LATER drag).
    const onBlur = () => {
      win.setTimeout(() => {
        if (session !== activeSession || !isGripDragActive()) return
        const stillInApp = enumerateDockWindows().some(w => {
          try {
            return w.win.document.hasFocus()
          } catch {
            return false
          }
        })
        if (!stillInApp) endGripDrag(null)
      }, 0)
    }
    try {
      win.document.addEventListener('pointermove', onMove)
      win.document.addEventListener('pointerup', onUp)
      win.document.addEventListener('pointercancel', onCancel)
      win.document.addEventListener('keydown', onKey, true)
      win.addEventListener('blur', onBlur)
      removers.push(() => {
        try {
          win.document.removeEventListener('pointermove', onMove)
          win.document.removeEventListener('pointerup', onUp)
          win.document.removeEventListener('pointercancel', onCancel)
          win.document.removeEventListener('keydown', onKey, true)
          win.removeEventListener('blur', onBlur)
        } catch {
          /* window gone — its listeners died with it */
        }
      })
    } catch {
      /* couldn't attach to this window (cross-origin / closed) — skip it */
    }
  }
}

// ── the per-grip hook ─────────────────────────────────────────────────────────────────────────
export function useGripDrag(opts: UseGripDragOptions): GripDragHandle {
  // Latest options in a ref — the drag session captures them AT pointerdown; the hook never keeps
  // session state, so a source re-mount can't disturb an in-flight drag (the session is module-owned).
  const optsRef = useRef(opts)
  optsRef.current = opts

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return // left button only
    beginGripDrag(optsRef.current, e)
  }, [])

  return { onPointerDown }
}

// ── the module-level PLACEMENT session (aim-to-place a NEW pane, docking P5) ──────────────────────
// Aim-to-place is a drag that is already "picked up": a NEW pane looking for where to land. It reuses
// the SAME cross-window machinery — per-window listeners, `resolveDrop`, the re-homed ghost, and the
// reactive `dragState` that drives the drop-target highlights — but is started programmatically (no
// grip pointerdown) and RESOLVED BY A CLICK (there's no held button), or DISCARDED by Escape. Because
// its sentinel "source container" matches no real container, every container the cursor enters resolves
// as a `move` (split beside a pane / append into the body), so the P4 highlights light up unchanged.

/** Sentinel source id/container for a placement — never a real pane or container id, so `resolveDrop`
 *  treats every container as foreign (a `move`) and the sentinel never hit-tests as a pane. */
const PLACEMENT_SOURCE = '__dock_placement_sentinel__'

/** The resolved insertion for a placed new pane (the `move` shape). */
export type PlacementTarget = Extract<DragResolution, { kind: 'move' }>

export interface PlacementOptions {
  /** snapshot ONE window's pane rects + workspace rect (same query the drag uses). */
  readonly snapshot: (win: Window, containerId: string) => GripSnapshot | null
  /** the user CLICKED a valid spot — create the new pane in `target.container` at its drop target. */
  readonly onPlace: (target: PlacementTarget) => void
  /** the user pressed Escape (or placement was otherwise aborted) — DISCARD the pending new pane. */
  readonly onDiscard: () => void
  readonly ghostLabel?: string
  readonly ghostTestId?: string
}

interface PlacementSession {
  readonly onPlace: (target: PlacementTarget) => void
  readonly onDiscard: () => void
  readonly snapMap: Map<string, GripSnapshot>
  ghost: HTMLDivElement | null
  cleanup: () => void
}
let placement: PlacementSession | null = null

/** True while an aim-to-place placement is live (mutually exclusive with a drag). */
export function isPlacementActive(): boolean {
  return placement != null
}

/** Abort an in-flight placement (e.g. the host workspace unmounts mid-aim) — tears down its listeners +
 *  ghost and runs the session's `onDiscard`. No-op when no placement is active. */
export function abortGripPlacement(): void {
  endGripPlacement(null)
}

/** Resolve the placement target for a pointer at `(x, y)` in `containerId`'s window. */
function resolvePlacementIn(containerId: string, x: number, y: number): DragResolution {
  const snap = placement?.snapMap.get(containerId)
  if (!placement || !snap) return { kind: 'none' }
  return resolveDrop(
    x,
    y,
    { containerId, containerRect: snap.containerRect, panes: snap.panes },
    PLACEMENT_SOURCE,
    PLACEMENT_SOURCE,
  )
}

/** End a placement: tear down listeners + ghost, clear the session + reactive state, then run the
 *  outcome — `onPlace` for a resolved `move`, else `onDiscard`. */
function endGripPlacement(resolution: DragResolution | null): void {
  const p = placement
  if (!p) return
  p.cleanup()
  const g = p.ghost
  p.ghost = null
  // State first, then the (possibly cross-window) ghost DOM defensively (mirrors `endGripDrag`).
  placement = null
  clearGripDrag()
  try {
    g?.parentNode?.removeChild(g)
  } catch {
    /* ghost's window went away — nothing more to clean up */
  }
  if (resolution && resolution.kind === 'move') p.onPlace(resolution)
  else p.onDiscard()
}

/**
 * Start an aim-to-place placement for a new pane. Snapshots every open dock window, arms per-window
 * pointermove (preview) + click (place) + Escape (discard) listeners, and shows a ghost that follows
 * the cursor across windows. Returns `false` (a no-op) when a drag/placement is already active or there
 * is no window to place into. The caller (e.g. a viz `requestAddCell`) supplies the DOM snapshot + what
 * a resolved placement DOES.
 */
export function startGripPlacement(opts: PlacementOptions): boolean {
  if (session || placement || isGripDragActive()) return false // one drag/placement at a time
  if (typeof window === 'undefined') return false
  const dockWindows = enumerateDockWindows()
  const snapMap = new Map<string, GripSnapshot>()
  for (const { containerId, win } of dockWindows) {
    const snap = opts.snapshot(win, containerId)
    if (snap) snapMap.set(containerId, snap)
  }
  if (snapMap.size === 0) return false // nowhere to place

  const removers: Array<() => void> = []
  placement = {
    onPlace: opts.onPlace,
    onDiscard: opts.onDiscard,
    snapMap,
    ghost: null,
    cleanup: () => {
      for (const r of removers) r()
    },
  }
  setDrag({ active: true, mode: 'placement', sourceId: PLACEMENT_SOURCE, target: { kind: 'none' } })

  // Ghost created in the MAIN window, HIDDEN until the first pointermove gives it a position (placement
  // starts with no pointer). It re-homes across windows on move, exactly like the drag ghost.
  try {
    const g = window.document.createElement('div')
    g.style.cssText = GHOST_CSS_TEXT
    g.style.opacity = '0'
    if (opts.ghostTestId) g.setAttribute('data-testid', opts.ghostTestId)
    g.textContent = opts.ghostLabel ?? ''
    window.document.body.appendChild(g)
    placement.ghost = g
  } catch {
    /* no ghost (headless) — placement still works */
  }

  for (const { containerId, win } of dockWindows) {
    if (!snapMap.has(containerId)) continue
    const onMove = (ev: PointerEvent) => {
      if (!placement) return
      const res = resolvePlacementIn(containerId, ev.clientX, ev.clientY)
      if (!sameResolution(dragState.target, res)) {
        setDrag({ active: true, mode: 'placement', sourceId: PLACEMENT_SOURCE, target: res })
      }
      if (placement.ghost) placement.ghost.style.opacity = '1'
      moveGhostEl(placement.ghost, win, ev.clientX, ev.clientY)
    }
    // Capture-phase click so a placement click PLACES rather than falling through to a cell/chrome. A
    // click resolving to `none` (outside any workspace) is ignored — the user keeps aiming; Escape
    // discards.
    const onClick = (ev: MouseEvent) => {
      if (!placement) return
      const res = resolvePlacementIn(containerId, ev.clientX, ev.clientY)
      if (res.kind === 'move') {
        ev.preventDefault()
        ev.stopPropagation()
        endGripPlacement(res)
      }
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endGripPlacement(null)
    }
    try {
      win.document.addEventListener('pointermove', onMove)
      win.document.addEventListener('click', onClick, true)
      win.document.addEventListener('keydown', onKey, true)
      removers.push(() => {
        try {
          win.document.removeEventListener('pointermove', onMove)
          win.document.removeEventListener('click', onClick, true)
          win.document.removeEventListener('keydown', onKey, true)
        } catch {
          /* window gone */
        }
      })
    } catch {
      /* couldn't attach to this window — skip it */
    }
  }
  return true
}
