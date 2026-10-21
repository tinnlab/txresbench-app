// colorOverride.store.ts — the runtime per-group DISPLAY-OVERRIDE store (COLOR_PALETTE_PLAN
// "Per-group DISPLAY OVERRIDES → interactive editing"). The DECLARATIVE override layer
// (`CategoricalOverrides` — by-name `categoryColors`/`categoryLabels`/`palette`, resolved by
// `data/color.ts::resolveEffectivePalette`/`displayCategory`) is the pure math; THIS store is the
// INTERACTIVE, persisted way a user sets those maps (a legend color-picker + editable label write
// here) so the change is live in the plot + legend + axis, and rides into export (export captures
// what's rendered).
//
// STABLE IDENTITY (the color-wave's deferred cross-pane TODO in `coordination/colorScale.ts`):
// overrides are keyed by COLOR-BY COLUMN + category NAME (never by array index / pane), so an edit
// to "T cells" while coloring by `cell_type` applies to that named group across EVERY pane/cell
// coloring by that column — mirroring `resolveSharedDomain`'s continuous-domain coordination, but
// for the categorical axis.
//
// Plain-zustand (no @ziee SDK), matching `Coordination.store.ts`:
// `create()(subscribeWithSelector(immer(...)))` — flat state + immer draft setters, so the app's
// autosave can `store.subscribe(selector, cb)` the overrides and persist them exactly like the
// coordination view state.

import { create } from 'zustand'
import { castDraft } from 'immer'
import { subscribeWithSelector } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import type { CategoricalOverrides, PaletteEntry } from '../viz-core/data/color'
import {
  type CategoryColorScope,
  resolveSharedCategoryColors,
} from '../viz-core/coordination/colorScale'

/** One color-by column's display overrides: by-NAME color + by-NAME display label maps.
 *  A structural subset of `CategoricalOverrides` (colors are `#rrggbb` strings), so it feeds
 *  straight into `resolveEffectivePalette`/`displayCategory` with no adaptation. */
export interface ColumnColorOverride {
  /** raw category NAME → `#rrggbb` swatch color (stable identity per group). */
  categoryColors?: Record<string, string>
  /** raw category NAME → shown display label. */
  categoryLabels?: Record<string, string>
  /** an ORDERED palette (code → `palette[code]`) chosen from a qualitative palette — auto-populates
   *  every group's color. By-name `categoryColors` still win over it (per-group tweaks after a palette). */
  palette?: string[]
}

export interface ColorOverrideState {
  /** Per-color-by-COLUMN overrides, keyed by the column name. A column with no edits has no
   *  entry (⇒ `overridesForColumn` returns `undefined` ⇒ the built-in palette + raw labels,
   *  byte-identical to the no-override path). */
  overrides: Record<string, ColumnColorOverride>
  /** Registered per-panel by-NAME categorical color scopes, keyed by a stable per-registration
   *  id (NOT the color-by column — many panels may color by the same column). Every scope's
   *  `key` names the color-by column; linked panels MERGE the by-name maps of all scopes sharing
   *  a `key` (first-writer-wins per name) so a named group ("T cells") resolves to ONE color
   *  across panes/datasets — the categorical analog of Coordination's `colorScales` continuous-
   *  domain sharing (`sharedCategoryColors` reads it). Runtime panel registrations: additive over
   *  the persisted DISPLAY `overrides` above and NOT part of `serialize`/`hydrate`. */
  categoryColorScopes: Record<string, CategoryColorScope>
}

export interface ColorOverrideActions {
  /** Set one group's swatch color (raw category NAME → `#rrggbb`) for a color-by column. */
  setCategoryColor: (column: string, name: string, color: string) => void
  /** Set one group's DISPLAY label (raw category NAME → shown text) for a color-by column. */
  setCategoryLabel: (column: string, name: string, label: string) => void
  /** Apply a qualitative PALETTE to a column (auto-populate every group's color). Passing `undefined`
   *  clears it. Also clears per-group `categoryColors` so the palette applies cleanly (a fresh populate). */
  setColumnPalette: (column: string, palette: readonly string[] | undefined) => void
  /** Clear ONE group's overrides (both its color AND label) under a column; prunes now-empty
   *  maps + the column entry so it collapses back to the byte-identical no-override path. */
  clearColorOverride: (column: string, name: string) => void
  /** Reset ALL overrides for a color-by column (drop the whole column entry). */
  resetColumn: (column: string) => void
  /** Register (or replace) a panel's by-NAME categorical color scope under `id` (a stable
   *  per-registration key). The categorical analog of Coordination's `setColorScale`. */
  setCategoryColorScope: (id: string, scope: CategoryColorScope) => void
  /** Unregister a panel's categorical color scope (on unmount / color-by change). The categorical
   *  analog of Coordination's `clearColorScale`. */
  clearCategoryColorScope: (id: string) => void
  /** Read the serializable per-column overrides map — the single serialize source for
   *  `sessionState.ts`. Deep-copied so a later edit can't retro-mutate the captured snapshot. */
  serialize: () => Record<string, ColumnColorOverride>
  /** REPLACE the overrides map from a hydrated snapshot (no side effects). */
  hydrate: (overrides: Record<string, ColumnColorOverride>) => void
}

/** Drop a column entry when its color + label maps are both empty (keeps the no-override
 *  path byte-identical: an emptied column resolves to `undefined`, not `{}`). */
function pruneColumn(overrides: Record<string, ColumnColorOverride>, column: string): void {
  const entry = overrides[column]
  if (!entry) return
  const noColors = !entry.categoryColors || Object.keys(entry.categoryColors).length === 0
  const noLabels = !entry.categoryLabels || Object.keys(entry.categoryLabels).length === 0
  const noPalette = !entry.palette || entry.palette.length === 0
  if (noColors && noLabels && noPalette) delete overrides[column]
}

// PER-INSTANCE ISOLATION (VIZ_ISOLATION W1): the store DEFINITION is extracted into the
// `createColorOverrideStore()` factory (a fresh, independent bound store per call);
// `useColorOverrideStore` is the DEFAULT module singleton (factory invoked once) with a
// byte-identical public API. No existing consumer changes.
export function createColorOverrideStore() {
  return create<ColorOverrideState & ColorOverrideActions>()(
    subscribeWithSelector(
      immer((set, get) => ({
      // state
      overrides: {},
      categoryColorScopes: {},
      // actions
      setCategoryColor: (column, name, color) =>
        set(s => {
          const entry = (s.overrides[column] ??= {})
          ;(entry.categoryColors ??= {})[name] = color
        }),
      setCategoryLabel: (column, name, label) =>
        set(s => {
          const entry = (s.overrides[column] ??= {})
          ;(entry.categoryLabels ??= {})[name] = label
        }),
      setColumnPalette: (column, palette) =>
        set(s => {
          if (!palette || palette.length === 0) {
            const entry = s.overrides[column]
            if (entry) {
              delete entry.palette
              pruneColumn(s.overrides, column)
            }
            return
          }
          const entry = (s.overrides[column] ??= {})
          entry.palette = [...palette]
          // A palette is a FRESH auto-populate — drop any per-group color overrides so it applies cleanly.
          delete entry.categoryColors
        }),
      clearColorOverride: (column, name) =>
        set(s => {
          const entry = s.overrides[column]
          if (!entry) return
          if (entry.categoryColors) {
            delete entry.categoryColors[name]
            if (Object.keys(entry.categoryColors).length === 0) delete entry.categoryColors
          }
          if (entry.categoryLabels) {
            delete entry.categoryLabels[name]
            if (Object.keys(entry.categoryLabels).length === 0) delete entry.categoryLabels
          }
          pruneColumn(s.overrides, column)
        }),
      resetColumn: column =>
        set(s => {
          delete s.overrides[column]
        }),
      setCategoryColorScope: (id, scope) =>
        set(s => {
          // castDraft: `scope.categoryColors` holds readonly RGB tuples; immer's draft slot is mutable.
          s.categoryColorScopes[id] = castDraft(scope)
        }),
      clearCategoryColorScope: id =>
        set(s => {
          delete s.categoryColorScopes[id]
        }),
      serialize: () => JSON.parse(JSON.stringify(get().overrides)) as Record<string, ColumnColorOverride>,
      hydrate: overrides =>
        set(s => {
          s.overrides = JSON.parse(JSON.stringify(overrides ?? {})) as Record<string, ColumnColorOverride>
        }),
      })),
    ),
  )
}

/** A bound ColorOverride store instance (the factory's return type). */
export type ColorOverrideStore = ReturnType<typeof createColorOverrideStore>

/** The DEFAULT module-singleton ColorOverride store — byte-identical to the pre-factory
 *  export. Existing consumers importing `useColorOverrideStore` are unaffected. */
export const useColorOverrideStore: ColorOverrideStore = createColorOverrideStore()

/**
 * The `CategoricalOverrides` bundle for one color-by column, or `undefined` when the column has
 * no edits (⇒ the built-in palette + raw labels, byte-identical to the no-override render). Feed
 * the result straight into `computeColoring({ ...colorBy, ...overrides })` AND the `Legend`
 * `overrides` prop so the plot + legend + categorical axis all resolve through the SAME maps.
 *
 * Pure (takes the overrides map as an arg) so it works both as a non-reactive snapshot
 * (`overridesForColumn(useColorOverrideStore.getState().overrides, col)`) and inside a reactive
 * component selector (`useColorOverrideStore(s => overridesForColumn(s.overrides, col))`).
 */
export function overridesForColumn(
  overrides: Record<string, ColumnColorOverride>,
  column: string,
): CategoricalOverrides | undefined {
  const entry = overrides[column]
  if (!entry) return undefined
  const hasColors = entry.categoryColors && Object.keys(entry.categoryColors).length > 0
  const hasLabels = entry.categoryLabels && Object.keys(entry.categoryLabels).length > 0
  const hasPalette = entry.palette && entry.palette.length > 0
  if (!hasColors && !hasLabels && !hasPalette) return undefined
  return {
    ...(hasColors ? { categoryColors: entry.categoryColors } : {}),
    ...(hasLabels ? { categoryLabels: entry.categoryLabels } : {}),
    ...(hasPalette ? { palette: entry.palette } : {}),
  }
}

/** The SHARED (merged) by-name category→color map across every registered scope coloring by
 *  `key`, or `null` when none does — the categorical analog of Coordination's
 *  `sharedColorDomain`. Non-reactive snapshot read (mirrors `sharedColorDomain`); the merge rule
 *  (first-writer-wins per name) lives in the pure `resolveSharedCategoryColors`. Feed the result
 *  as `categoryColors` into a `CategoricalOverrides` bundle so a named group resolves to one color
 *  across linked panes/datasets. */
export function sharedCategoryColors(key: string): Record<string, PaletteEntry> | null {
  const { categoryColorScopes } = useColorOverrideStore.getState()
  return resolveSharedCategoryColors(Object.values(categoryColorScopes), key)
}
