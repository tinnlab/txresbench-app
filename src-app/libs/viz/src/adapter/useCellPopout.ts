// useCellPopout.ts — the per-cell "is this cell popped out?" reactive registry for the grid.
//
// The pop-out MECHANISM is the PORTAL-move engine (`viz-core/popout/windowPortal`): each `CellView`
// owns a `useWindowPortal` that opens a REAL window and MOVES the cell's content into it (one
// instance, state + GL context preserved, no cross-window sync). This module holds ONLY the shared
// cross-cell STATE — "which cells are currently popped out" — that the grid's drag guards +
// placeholders read; the portal marks/clears it on open/close via `markPoppedOut`/`clearPoppedOut`.
//
// It is a small MODULE-LEVEL reactive registry (NOT a field on `GridCell`/the grid store), so the
// grid model stays clean and a pop-out is pure runtime UI state. Every `CellView` subscribes via
// `useSyncExternalStore`, so a pop-out/return re-renders exactly the cells that care.

import { useSyncExternalStore } from 'react'

/**
 * Owns the per-cell "popped out via the portal" set for the grid window. Reactive: publishes a fresh
 * snapshot Set on every change so `useSyncExternalStore` re-renders subscribers.
 */
export class CellPopoutRegistry {
  private readonly poppedOut = new Set<string>()
  /** a NEW Set instance is published on every change (stable between changes). */
  private snapshot: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()

  /** Is this cell currently popped out into its own window? */
  isPoppedOut(cellId: string): boolean {
    return this.poppedOut.has(cellId)
  }

  /** Mark a cell popped out (the portal owns the window; this just publishes the cross-cell state). */
  markPoppedOut(cellId: string): void {
    if (this.poppedOut.has(cellId)) return
    this.poppedOut.add(cellId)
    this.publish()
  }

  /** Clear a cell's popped-out mark (on return / popup close). */
  clearPoppedOut(cellId: string): void {
    if (!this.poppedOut.delete(cellId)) return
    this.publish()
  }

  /** `useSyncExternalStore` subscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** `useSyncExternalStore` snapshot — a stable Set reference between changes. */
  getSnapshot(): ReadonlySet<string> {
    return this.snapshot
  }

  private publish(): void {
    this.snapshot = new Set(this.poppedOut)
    for (const l of this.listeners) l()
  }
}

// ── the default singleton + hook ────────────────────────────────────────────────
// One registry per document: every `CellView` in the grid shares it, so a cell popped out is visible
// to every `CellView`'s `isPoppedOut` read (cross-cell drag guards). Bound once so `useSyncExternalStore`
// gets stable subscribe/getSnapshot references.
const registry = new CellPopoutRegistry()
const subscribe = (l: () => void): (() => void) => registry.subscribe(l)
const getSnapshot = (): ReadonlySet<string> => registry.getSnapshot()

export interface CellPopoutApi {
  isPoppedOut: (cellId: string) => boolean
  /** Mark/clear the cross-cell "is popped out" state read by drag guards + placeholders. The portal
   *  (in `CellView`) calls these from its `onOpen`/`onClose`. */
  markPoppedOut: (cellId: string) => void
  clearPoppedOut: (cellId: string) => void
}

/**
 * Subscribe to per-cell pop-out state. The returned `isPoppedOut` reads the reactive snapshot (so the
 * component re-renders on pop-out/return); `markPoppedOut`/`clearPoppedOut` drive the shared registry.
 * Listener cleanup on unmount is handled by `useSyncExternalStore`.
 */
export function useCellPopout(): CellPopoutApi {
  const popped = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    isPoppedOut: (cellId: string) => popped.has(cellId),
    markPoppedOut: (cellId: string) => registry.markPoppedOut(cellId),
    clearPoppedOut: (cellId: string) => registry.clearPoppedOut(cellId),
  }
}
