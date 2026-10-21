// singletonResidue.ts — the Showcase's CROSS-STORY CONTAMINATION probe (dev-only).
//
// WHY THIS EXISTS. The four viz coordination stores (+ the dataset store) exist BOTH as
// per-instance sets (`createVizStores()`, what `<Viz>` mounts) and as MODULE SINGLETONS
// (`defaultVizStores`, the fallback an unprovided subtree resolves to). A Showcase story that
// drives a `VizController` — or calls `useXStore.getState().mutate(...)` — WITHOUT its own
// `<VizStoresProvider>` writes the SINGLETON. That write is process-global: it survives the story
// switch and is inherited by every story mounted later in the SAME page load.
//
// That is not hypothetical. `00-capabilities.story.tsx` is registered first, so the Showcase mounts
// it at LANDING on every page load; its `setOption({replace:true})` hydrated `gridLinked` (auto-
// derived TRUE for two scatter series over one layout) into the singleton, so the grid story then
// mounted ALREADY LINKED and `linked-panels` TEST-17's permissive "click it if it isn't on" seed
// silently did nothing — the spec failed for a reason unrelated to the product.
//
// The failure is INVISIBLE in a single-story run: open that one story and it behaves. It only
// appears in a FULL-SUITE page load, where story N inherits stories 1..N-1's residue. So a
// per-story assertion cannot catch it; the assertion has to be over the SEQUENCE. This probe is
// what makes that assertion possible from an e2e: it snapshots the module singletons and diffs
// them against a FRESHLY-MINTED store set.
//
// PRISTINE IS MEASURED, NOT GUESSED. The baseline is `createVizStores()` snapshotted through the
// SAME reducer, so "clean" means "byte-identical to a store nobody has touched" — a definition
// that cannot drift when a store gains a field, and that no hand-written literal could keep up
// with. (`tests/viz-e2e/story-isolation.spec.ts` is the consumer.)

import { createVizStores, defaultVizStores, type VizStores } from '../adapter/vizStores'

/** One store-set's contaminable state, flattened to primitives an e2e can diff + print. */
export type ResidueSnapshot = Record<string, string | number | boolean | null>

/** Flatten a store set to the fields a story can dirty. Counts/flags only — never row data, so a
 *  diff prints readably and a large fixture cannot blow up the payload. */
export function snapshotStores(s: VizStores): ResidueSnapshot {
  const c = s.coordination.getState()
  const g = s.gridWorkspace.getState()
  const p = s.plotInteraction.getState()
  const o = s.colorOverride.getState()
  const d = s.datasetStore.getState()
  const leafCount = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0
    const n = node as { type?: string; children?: unknown[] }
    if (n.type === 'leaf') return 1
    return (n.children ?? []).reduce<number>((acc, ch) => acc + leafCount(ch), 0)
  }
  return {
    'coordination.pointSelection': c.pointSelection?.length ?? 0,
    'coordination.selectionOrigin': c.selectionOrigin,
    'coordination.viewStates': Object.keys(c.viewStates).length,
    'coordination.selectionBySpace': Object.keys(c.selectionBySpace).length,
    'coordination.selectionByOrigin': Object.keys(c.selectionByOrigin).length,
    'coordination.exclusiveSelectionEpoch': c.exclusiveSelectionEpoch,
    'coordination.exclusiveSelectionOrigin': c.exclusiveSelectionOrigin,
    'coordination.selectionProvenance': c.selectionProvenance != null,
    'coordination.highlight': c.highlight,
    'coordination.gridLinked': c.gridLinked,
    'coordination.colorBySelection': c.colorBySelection,
    'coordination.colorScales': Object.keys(c.colorScales).length,
    'gridWorkspace.cells': Object.keys(g.cells).length,
    'gridWorkspace.layoutLeaves': leafCount(g.layout),
    'gridWorkspace.seq': g.seq,
    'gridWorkspace.containerLayouts': Object.keys(g.containerLayouts).length,
    'gridWorkspace.paneContainer': Object.keys(g.paneContainer).length,
    'gridWorkspace.pendingClose': g.pendingClose.length,
    'gridWorkspace.returnAnchors': Object.keys(g.returnAnchors).length,
    'gridWorkspace.pendingRestore': g.pendingRestore.length,
    'gridWorkspace.pendingPlacement': g.pendingPlacement != null,
    'gridWorkspace.linkGroups': Object.keys(g.linkGroups).length,
    'gridWorkspace.linkPicking': g.linkPicking != null,
    'plotInteraction.dataZoomWindows': Object.keys(p.dataZoomWindows).length,
    'plotInteraction.filters': Object.keys(p.filters).length,
    'colorOverride.overrides': Object.keys(o.overrides).length,
    'colorOverride.categoryColorScopes': Object.keys(o.categoryColorScopes).length,
    'datasetStore.datasets': Object.keys(d.datasets).length,
    'datasetStore.resolver': d.resolver != null,
  }
}

/** Keys whose singleton value differs from a never-touched store set, with both values. */
export function residueDiff(): { key: string; pristine: unknown; actual: unknown }[] {
  const actual = snapshotStores(defaultVizStores)
  const pristine = snapshotStores(createVizStores())
  const out: { key: string; pristine: unknown; actual: unknown }[] = []
  for (const k of Object.keys(pristine)) {
    if (actual[k] !== pristine[k]) out.push({ key: k, pristine: pristine[k], actual: actual[k] })
  }
  return out
}

declare global {
  interface Window {
    /** Keys where the MODULE SINGLETON stores differ from a freshly-minted set. `[]` ⇒ clean. */
    __VIZ_SINGLETON_RESIDUE__?: () => { key: string; pristine: unknown; actual: unknown }[]
    /** The full singleton snapshot (for a readable failure message). */
    __VIZ_SINGLETON_SNAPSHOT__?: () => ResidueSnapshot
  }
}

/** Install the probe on `window` (called from the Showcase entry; dev-only surface). */
export function installSingletonResidueProbe(): void {
  window.__VIZ_SINGLETON_RESIDUE__ = residueDiff
  window.__VIZ_SINGLETON_SNAPSHOT__ = () => snapshotStores(defaultVizStores)
}
