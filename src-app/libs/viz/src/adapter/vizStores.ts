// vizStores.ts — the per-instance COORDINATION-STORE SET + React context (VIZ_ISOLATION W1).
//
// The four viz coordination stores (coordination / grid-workspace / color-override /
// plot-interaction) were module-level zustand singletons shared by every consumer, so two
// same-realm `<Viz>` instances clobbered each other's selection / grid / overrides / dataZoom.
// This module introduces the ISOLATION SEAM: a `VizStores` bundle of four independent bound
// stores, a React context that DEFAULTS TO THE MODULE SINGLETONS, and scoped reactive hooks that
// resolve the active set from context.
//
// SAFE-BY-DEFAULT: `VizStoresContext` defaults to `defaultVizStores`, whose members ARE the
// existing module singletons (`useCoordinationStore`, …). So until a `<Viz>` mounts a provider
// with a fresh `createVizStores()` set, a component reading via `useVizStores()` and one importing
// `useCoordinationStore` directly BOTH resolve to the SAME singleton → behavior is byte-identical.
// Isolation only "turns on" under a provider. Consumers are migrated in a LATER wave; this wave
// changes ZERO consumers.

import React from 'react'
import { useStore } from 'zustand'
import {
  createCoordinationStore,
  useCoordinationStore,
  type CoordinationStore,
} from './Coordination.store'
import {
  createGridWorkspaceStore,
  useGridWorkspaceStore,
  type GridWorkspaceStore,
} from './GridWorkspace.store'
import {
  createColorOverrideStore,
  useColorOverrideStore,
  type ColorOverrideStore,
} from './colorOverride.store'
import {
  createPlotInteractionStore,
  usePlotInteractionStore,
  type PlotInteractionStore,
} from './PlotInteraction.store'
import {
  createDatasetStore,
  useDatasetStore,
  type DatasetStore,
} from './DatasetStore'

/** A complete, independent set of the four viz coordination stores — one `<Viz>` instance's
 *  isolated interaction state (selection / grid layout / color overrides / dataZoom+filters). */
export interface VizStores {
  coordination: CoordinationStore
  gridWorkspace: GridWorkspaceStore
  colorOverride: ColorOverrideStore
  plotInteraction: PlotInteractionStore
  /** MULTI-DATASOURCE (ITEM-7): per-dataset owned data (source/catalog/positions/colors/pointIds),
   *  ref-counted by referencing cells. */
  datasetStore: DatasetStore
}

/** Mint a FRESH, fully-independent set of the four stores. A `setState`/action on one set's
 *  member never touches another set's — this is what makes each `<Viz>` isolated. */
export function createVizStores(): VizStores {
  return {
    coordination: createCoordinationStore(),
    gridWorkspace: createGridWorkspaceStore(),
    colorOverride: createColorOverrideStore(),
    plotInteraction: createPlotInteractionStore(),
    datasetStore: createDatasetStore(),
  }
}

/** The DEFAULT set — the pre-existing MODULE SINGLETONS (NOT a fresh set). `VizStoresContext`
 *  defaults to this, so an unprovided subtree resolves to exactly today's singletons and any
 *  consumer reading via the context is byte-identical to importing `useXStore` directly. */
export const defaultVizStores: VizStores = {
  coordination: useCoordinationStore,
  gridWorkspace: useGridWorkspaceStore,
  colorOverride: useColorOverrideStore,
  plotInteraction: usePlotInteractionStore,
  datasetStore: useDatasetStore,
}

/**
 * The RESOLVED per-channel bindings a mounted pane renders from — viz's own answer after a
 * declarative `series.encode` has been overlaid onto the chart's catalog defaults.
 *
 * Exported because a HOST cannot otherwise ask that question without reaching into the grid
 * store's internal shape, and the question is worth asking: the difference between what a
 * declaration REQUESTED and what viz RESOLVED is where a binding bug lives. An unset optional
 * channel resolving to a catalog column instead of `''` (viz's "bind no column") is invisible in
 * the option and decisive on screen.
 *
 * `undefined` when the pane is not mounted or resolved no explicit bindings.
 */
export function resolvedPaneBindings(
  cellId: string,
  stores: VizStores = defaultVizStores,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  return stores.gridWorkspace.getState().cells[cellId]?.bindings
}

/** React context carrying the active `VizStores` set; defaults to the module singletons. */
export const VizStoresContext = React.createContext<VizStores>(defaultVizStores)

/** Provider that scopes a `VizStores` set to its subtree. `<Viz>` mounts a fresh set (a later
 *  wave); everything under the provider resolves that set via `useVizStores()` / the scoped hooks. */
export function VizStoresProvider(props: {
  value: VizStores
  children?: React.ReactNode
}): React.ReactElement {
  return React.createElement(
    VizStoresContext.Provider,
    { value: props.value },
    props.children,
  )
}

/** Read the active `VizStores` set from context (the module singletons when unprovided).
 *  A hook — render-only; imperative/non-React paths take the set explicitly as a param. */
export function useVizStores(): VizStores {
  return React.useContext(VizStoresContext)
}

// Scoped reactive hooks — resolve the active store from context, then subscribe with `useStore`.
// These are the reactive-read entrypoints components migrate to (a later wave). `useStore(store,
// selector)` works directly on the `create()`-bound stores (each exposes `getState`/`subscribe`),
// so no vanilla-store adjustment is needed.

/** Reactive read of the active COORDINATION store via context. */
export function useCoordination<T>(
  selector: (state: ReturnType<CoordinationStore['getState']>) => T,
): T {
  return useStore(useVizStores().coordination, selector)
}

/** Reactive read of the active GRID-WORKSPACE store via context. */
export function useGridWorkspace<T>(
  selector: (state: ReturnType<GridWorkspaceStore['getState']>) => T,
): T {
  return useStore(useVizStores().gridWorkspace, selector)
}

/** Reactive read of the active COLOR-OVERRIDE store via context. */
export function useColorOverride<T>(
  selector: (state: ReturnType<ColorOverrideStore['getState']>) => T,
): T {
  return useStore(useVizStores().colorOverride, selector)
}

/** Reactive read of the active PLOT-INTERACTION store via context. */
export function usePlotInteraction<T>(
  selector: (state: ReturnType<PlotInteractionStore['getState']>) => T,
): T {
  return useStore(useVizStores().plotInteraction, selector)
}
