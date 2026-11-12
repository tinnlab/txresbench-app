// types.ts — plain-zustand store type aliases for the visualization module's stores.
//
// This file previously augmented the SDK framework's `RegisteredStores` interface so
// `Stores.Coordination` / `Stores.GridWorkspace` were typed for the `Stores.X` proxy.
// That SDK coupling is removed as part of extracting this module into a standalone,
// SDK-free package: the stores are consumed directly via the exported
// `useCoordinationStore` / `useGridWorkspaceStore` bound zustand hooks (selector reads,
// `.getState()`, `.subscribe(...)`, actions), never through the `Stores.X` proxy — so
// no `RegisteredStores` augmentation is needed.
import type { useCoordinationStore, useGridWorkspaceStore } from '@txresbench/viz'

/** The bound zustand store hook types (state + actions). */
export type CoordinationStore = typeof useCoordinationStore
export type GridWorkspaceStore = typeof useGridWorkspaceStore

/** The resolved store state (state fields + actions) for each store. */
export type CoordinationStoreState = ReturnType<typeof useCoordinationStore.getState>
export type GridWorkspaceStoreState = ReturnType<typeof useGridWorkspaceStore.getState>
