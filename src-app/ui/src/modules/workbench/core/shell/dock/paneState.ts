// paneState (ITEM-19, Arch A) — per-pane CONTENT state keyed by PANE ID (never by slot or
// container), so a pane keeps its live internal state (scroll, an in-progress config value, a
// run subscription id) across a `movePane` / pop-out / return — the pane id is stable through
// every container move, so its state entry stays attached to it. The ENTITY a pane is bound to
// for the self-close lifecycle is NOT stored here: it is DERIVED from the pane's `ref`
// (`paneModel.resolvePaneEntity`) and reconciled against the live catalog by
// `entityLifecycle.ts` — see the note on {@link PaneEntity} for why a registry was the wrong
// shape.
//
// Module-level (one map per document) + reactive via `useSyncExternalStore`, mirroring the
// `@ziee/dock` popup registry.

import { useSyncExternalStore } from 'react'

/** Opaque per-pane content state (the pane's renderer owns the shape). */
export type PaneContentState = Record<string, unknown>

const stateById = new Map<string, PaneContentState>()
const listeners = new Set<() => void>()
/**
 * CLOSE listeners — notified with the pane id when {@link clearPaneState} runs.
 *
 * `clearPaneState` is already the one signal every close path converges on (the region
 * shell, the reconciler, the entity lifecycle), and a pane's state is not the only thing
 * that has to end when the pane does. A LIVE PROGRESS STREAM does too: the run lifecycle
 * (`extensions/analysis/runSession.ts`) deliberately outlives an unmount — a region
 * renders only its active tab, so unmount means "you looked away", not "you are done" —
 * and CLOSE is the event that genuinely ends it. The listener exists rather than an
 * import from here into that module because the dependency runs the other way: pane state
 * is core, the run session is an extension.
 */
const closeListeners = new Set<(paneId: string) => void>()
let epoch = 0

function publish(): void {
  epoch += 1
  for (const l of listeners) l()
}

/** Read a pane's content state (undefined if none set). */
export function getPaneState<T extends PaneContentState = PaneContentState>(paneId: string): T | undefined {
  return stateById.get(paneId) as T | undefined
}

/** Merge a patch into a pane's content state (keyed by PANE ID — survives container moves). */
export function setPaneState(paneId: string, patch: PaneContentState): void {
  stateById.set(paneId, { ...(stateById.get(paneId) ?? {}), ...patch })
  publish()
}

/** Drop a pane's content state (call when the pane is CLOSED — not when it merely moves). */
export function clearPaneState(paneId: string): void {
  const had = stateById.delete(paneId)
  // Fired unconditionally: a pane can own a live resource (a run's progress stream)
  // without ever having written a state entry, so gating this on `had` would leak exactly
  // the case that matters — a pane opened, Run pressed, pane closed.
  for (const l of closeListeners) l(paneId)
  if (had) publish()
}

/** Subscribe to pane CLOSE. Returns an unsubscribe. */
export function onPaneClosed(cb: (paneId: string) => void): () => void {
  closeListeners.add(cb)
  return () => {
    closeListeners.delete(cb)
  }
}

/** Reactive hook: a pane's content state + a setter (re-renders on any pane-state change). */
export function usePaneState<T extends PaneContentState = PaneContentState>(
  paneId: string,
): [T | undefined, (patch: PaneContentState) => void] {
  const value = useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => stateById.get(paneId) as T | undefined,
    () => stateById.get(paneId) as T | undefined,
  )
  return [value, patch => setPaneState(paneId, patch)]
}

/**
 * ONE field of a pane's content state, with `useState`'s shape.
 *
 * This exists because the migration it serves has to be reviewable at a glance. A region renders
 * only its ACTIVE tab, so every `useState` inside a pane is destroyed the moment the user looks at
 * a sibling tab — their typed search, their opened disclosure, the re-run they just finished. The
 * remedy is always the same edit, and the less it changes at the call site the less room there is
 * to get it wrong: `useState(x)` becomes `usePaneStateValue(pane.id, 'key', x)` and nothing else
 * about the component moves.
 *
 * It is deliberately NOT a general store hook: the value is keyed by PANE ID (stable across a
 * move / pop-out / return) and lives exactly as long as the pane does — `clearPaneState` on close
 * ends it, so "survives a tab switch" never becomes "leaks for the life of the page".
 */
export function usePaneStateValue<T>(
  paneId: string,
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const value = useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => stateById.get(paneId)?.[key] as T | undefined,
    () => stateById.get(paneId)?.[key] as T | undefined,
  )
  const current = value === undefined ? initial : value
  return [
    current,
    next => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(current) : next
      setPaneState(paneId, { [key]: resolved })
    },
  ]
}

/** Monotonic epoch — a test/consumer can observe that a mutation happened. */
export function paneStateEpoch(): number {
  return epoch
}

// ── entity-lifecycle binding (self-close a pane whose entity is gone) ─────────────────────────

/**
 * An entity a pane is bound to (its artifact/run/view target).
 *
 * There is no registry here any more, and that absence is the point. A pane's entity used to be
 * REGISTERED into a map by the pane's own component on mount and dropped on unmount — which made
 * the binding last exactly as long as the RENDER, while a region renders only its active tab. It
 * is now DERIVED from the pane's `ref` by the resolver its kind declared
 * (`paneModel.resolvePaneEntity`), so the dock store is the single source of truth for which
 * panes are bound and a background tab is bound like any other. The type stays here because it is
 * pane state's vocabulary; `entityLifecycle.ts` is the one consumer.
 */
export interface PaneEntity {
  /** the sync entity name (e.g. `'artifact'`, `'job'`, `'project'`). */
  readonly entity: string
  /** the entity id. */
  readonly id: string
}

/** Test-only reset. */
export function __resetPaneState(): void {
  stateById.clear()
  epoch = 0
  publish()
}
