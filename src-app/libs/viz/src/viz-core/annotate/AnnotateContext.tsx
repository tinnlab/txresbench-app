// AnnotateContext.tsx — the per-image-cell context that scopes ONE `AnnotateStore` instance
// to a cell's toolbar + editing overlay + class panel, so they all read/mutate the SAME
// annotation state (§5). Mirrors `adapter/vizStores.ts`'s `VizStoresContext/Provider` +
// scoped-reactive-hook pattern — but each `<AnnotateProvider>` mounts a FRESH store
// (`createAnnotateStore()`), so two cells side by side are strictly isolated (there is no
// safe-by-default module singleton here: annotation state is inherently per-cell).
//
// Reads are reactive via `useStore(store, selector)` (the same mechanism the viz coordination
// hooks use); imperative callers (the editor hook, an export button) take the raw store from
// `useAnnotateStore()` and call `.getState()` / actions directly.

import React from 'react'
import { useStore } from 'zustand'
import { createAnnotateStore, type AnnotateStore, type AnnotateStoreState } from './Annotate.store'

/** The active per-cell store; `null` outside a provider (a hard error — annotation state has
 *  no meaningful global fallback). */
const AnnotateContext = React.createContext<AnnotateStore | null>(null)

export interface AnnotateProviderProps {
  /** Provide an existing store (e.g. one the host created to also drive a `ProcessorPort`);
   *  omitted ⇒ the provider mints its own fresh instance for its subtree. */
  store?: AnnotateStore
  children?: React.ReactNode
}

/**
 * Scope a fresh (or supplied) `AnnotateStore` to the subtree. The store is minted ONCE per
 * mount (stable across re-renders via a ref), so the cell's tool rail, overlay and panel all
 * resolve the same instance through `useAnnotate` / `useAnnotateStore`.
 */
export function AnnotateProvider({ store, children }: AnnotateProviderProps): React.ReactElement {
  const ref = React.useRef<AnnotateStore | null>(null)
  if (ref.current === null) ref.current = store ?? createAnnotateStore()
  // If a caller swaps in a different explicit store, honor it (stable identity otherwise).
  const active = store ?? ref.current
  return React.createElement(AnnotateContext.Provider, { value: active }, children)
}

/** The raw per-cell store handle from context (imperative use: `.getState()` / actions).
 *  Throws outside an `<AnnotateProvider>`. */
export function useAnnotateStore(): AnnotateStore {
  const store = React.useContext(AnnotateContext)
  if (!store) throw new Error('useAnnotateStore must be used within an <AnnotateProvider>')
  return store
}

/** Reactive read of the active per-cell annotation store via context. Pass a selector to
 *  subscribe to a slice (mirrors `useCoordination` et al.). */
export function useAnnotate<T>(selector: (state: AnnotateStoreState) => T): T {
  return useStore(useAnnotateStore(), selector)
}
