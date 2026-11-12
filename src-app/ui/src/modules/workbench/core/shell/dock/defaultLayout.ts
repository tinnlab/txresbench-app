// defaultLayout (ITEM-9) — today's workbench IA expressed as an initial `@txresbench/dock`
// `LayoutNode`, plus a VERSIONED migration of the persisted main-layout blob. The default
// reproduces the P6 shell: a left "Visualize" pane · the center canvas hero · a bottom
// "Analyses" launcher — as MOVABLE panes in one split-tree (no pinned fixtures; `main` may
// become empty). The right "Selection"/"Inspector" pane that used to close the row is
// RETIRED (see `RETIRED_PANE_KINDS`).

import { leafIds, removeLeaf, type LayoutNode } from '@txresbench/dock'
import type { PaneKind, WorkbenchPane } from './paneModel'

/** The default pane ids (stable, named — generated panes are `pane-<n>`). */
export const DEFAULT_PANE_IDS = {
  visualize: 'p-visualize',
  canvas: 'p-canvas',
  launcher: 'p-launcher',
  datasets: 'p-datasets',
} as const

/** The serializable per-project MAIN slice: the split-tree + the pane-content map + the
 *  monotonic id counter (mirrors viz's `GridWorkspaceSlice`, content = `WorkbenchPane`). */
export interface DockMainSlice {
  layout: LayoutNode
  cells: Record<string, WorkbenchPane>
  seq: number
}

/** The persisted main blob version (ITEM-9). Bump on a breaking layout-shape change; the
 *  migration upgrades older blobs preserving pane placement.
 *  v2 (ITEM-25) — the pane-kind VOCABULARY changed: the invented `result` entity was renamed to
 *  `artifact`. The shape is unchanged, so a v1/v0 blob still reads; `migratePaneKind` remaps the
 *  legacy kind on the way in.
 *  v3 — the vocabulary SHRANK: the `selection` ("Inspector") pane is retired outright and is
 *  dropped from a persisted layout by `dropRetiredPanes`. Shape unchanged again, so a v0/v1/v2
 *  blob still reads. */
export const DOCK_MAIN_VERSION = 3

/** Legacy pane kinds → their current name. ITEM-25 renamed the invented `result` entity to
 *  `artifact` (INV-10: one server entity, one UI name). A layout persisted BEFORE the rename
 *  carries `kind: 'result'`, which is no longer in `PaneKind` — `resolvePaneRenderer` would fall
 *  back to the visible "no renderer registered" note and the user's saved pane would effectively
 *  vanish. Remapping on READ keeps an existing layout intact across the upgrade. */
const LEGACY_PANE_KINDS: Readonly<Record<string, PaneKind>> = { result: 'artifact' }

/** Map a persisted pane kind onto the current vocabulary (identity for a current kind). */
export function migratePaneKind(kind: string): string {
  return LEGACY_PANE_KINDS[kind] ?? kind
}

/** Remap every legacy pane kind in a persisted cells map. Returns the SAME object when nothing
 *  needed remapping (so the common path allocates nothing). Shared by the MAIN-blob migration
 *  (localStorage) and the POPUP-slice load (sessionStorage), which persists popped-out panes'
 *  cells verbatim and is therefore the surface a transient `artifact` pane actually survives in. */
export function migratePaneCells(panes: Record<string, WorkbenchPane>): Record<string, WorkbenchPane> {
  let changed = false
  const out: Record<string, WorkbenchPane> = {}
  for (const [id, pane] of Object.entries(panes)) {
    const kind = migratePaneKind(pane.kind)
    if (kind !== pane.kind) {
      changed = true
      out[id] = { ...pane, kind: kind as PaneKind }
    } else {
      out[id] = pane
    }
  }
  return changed ? out : panes
}

function pane(id: string, kind: PaneKind): WorkbenchPane {
  return { id, kind }
}

/** Today's IA as the initial `LayoutNode` + cells:
 *  `[visualize | (canvas over (launcher | datasets))]`. The project detail page is now the
 *  full-bleed workbench (no separate Datasets section), so a Datasets pane is OPEN BY DEFAULT — the entry
 *  point for adding/choosing data — sharing the center-bottom row with the Analyses launcher.
 *
 *  The row used to end in a third leaf, the `selection` "Inspector" pane, at `0.2`. Retiring it
 *  hands that share to the two survivors IN PROPORTION — `0.18/0.8` and `0.62/0.8` — which is
 *  exactly what `@txresbench/dock`'s `removeLeaf` (and therefore `dropRetiredPanes`) computes for an
 *  already-persisted layout. Same rule for a fresh workspace and a migrated one, so the two are
 *  indistinguishable rather than subtly different. */
export function defaultLayout(): LayoutNode {
  const { visualize, canvas, launcher, datasets } = DEFAULT_PANE_IDS
  return {
    kind: 'split',
    dir: 'col',
    sizes: [0.225, 0.775],
    children: [
      { kind: 'leaf', id: visualize },
      {
        kind: 'split',
        dir: 'row',
        sizes: [0.6, 0.4],
        children: [
          { kind: 'leaf', id: canvas },
          {
            kind: 'split',
            dir: 'col',
            sizes: [0.5, 0.5],
            children: [
              { kind: 'leaf', id: launcher },
              { kind: 'leaf', id: datasets },
            ],
          },
        ],
      },
    ],
  }
}

/** A fresh per-project MAIN slice (the default IA). `seq: 0` → generated panes are
 *  `pane-1`, `pane-2`, … (the named default ids never collide). */
export function defaultMainSlice(): DockMainSlice {
  const { visualize, canvas, launcher, datasets } = DEFAULT_PANE_IDS
  return {
    layout: defaultLayout(),
    cells: {
      [visualize]: pane(visualize, 'visualize'),
      [canvas]: pane(canvas, 'canvas'),
      [launcher]: pane(launcher, 'launcher'),
      [datasets]: pane(datasets, 'datasets'),
    },
    seq: 0,
  }
}

/**
 * Pane kinds RETIRED from the vocabulary — a persisted layout naming one is DROPPED on read
 * (its entry in the pane map AND its leaf), never rendered.
 *
 * Distinct from `LEGACY_PANE_KINDS`, which REMAPS a renamed kind onto its current name: a
 * retired kind has no successor, because the surface itself is gone. Dropping is the only
 * honest outcome. Leaving the pane in place would resolve `FallbackPane` and give the user a
 * permanent tab reading "No renderer registered for pane kind …" — permanent because the main
 * layout lives in `localStorage` and nothing else ever rewrites it.
 *
 * `selection` (the "Inspector" pane) is the first entry. It was never contributed — four
 * hardcoded sites created it — and its entire renderer was `<PlacedArea area="right"/>`, i.e. a
 * SECOND window onto the right dock AREA, so every analysis that docks right rendered twice:
 * once as its own right-region tab and again inside the Inspector. The AREA survives untouched;
 * only the duplicate host is gone.
 *
 * This set is also the answer to "may a later surface reuse the id?". It is the permanent,
 * behaviour-free record that a persisted `selection` pane means the DELETED inspector — the
 * benefit of "reserving" the id, without keeping it alive in `PaneKind`. Keeping it alive is
 * precisely what shipped the duplicate: ITEM-9 emptied the pane but "retained the kind id so
 * persisted layouts keep resolving", and that obligated a title, an icon, a default region, a
 * "+"-menu entry and a live renderer for a surface nobody could meaningfully open.
 */
export const RETIRED_PANE_KINDS: ReadonlySet<string> = new Set(['selection'])

/** Whether a persisted pane kind has been retired (its pane must be dropped, not rendered). */
export function isRetiredPaneKind(kind: string): boolean {
  return RETIRED_PANE_KINDS.has(kind)
}

/**
 * Drop every retired-kind pane from a persisted MAIN slice — its entry AND its leaf, so the
 * split-tree reflows and the freed space goes to the surviving siblings in proportion
 * (`@txresbench/dock`'s `removeLeaf` renormalizes the `sizes` vector). Returns the SAME slice when
 * nothing needed dropping, so the common path allocates nothing.
 *
 * If the drop would leave the project with no panes at all, the DEFAULT IA is returned instead:
 * the workspace is never left paneless (same guarantee `pruneTransient` makes).
 */
export function dropRetiredPanes(slice: DockMainSlice): DockMainSlice {
  const kept: Record<string, WorkbenchPane> = {}
  let layout: LayoutNode | null = slice.layout
  let dropped = 0
  for (const [id, pane] of Object.entries(slice.cells)) {
    if (!isRetiredPaneKind(pane.kind)) {
      kept[id] = pane
      continue
    }
    dropped += 1
    // Guard the leaf lookup: `removeLeaf` rebuilds the tree even when it removes nothing, and a
    // retired pane can legitimately have no leaf (an orphan left by a popped-out pane).
    if (layout && leafIds(layout).includes(id)) layout = removeLeaf(layout, id)
  }
  if (dropped === 0) return slice
  if (!layout || Object.keys(kept).length === 0) return defaultMainSlice()
  return { layout, cells: kept, seq: slice.seq }
}

/** The persisted main blob (localStorage) — a version tag + the per-project slices. */
export interface DockMainBlob {
  v: number
  byProject: Record<string, DockMainSlice>
}

/** Structural check that a value is a usable per-project slice (defends a hand-edited /
 *  partially-written blob). */
function isSlice(v: unknown): v is DockMainSlice {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<DockMainSlice>
  return !!s.layout && typeof s.layout === 'object' && !!s.cells && typeof s.cells === 'object'
}

/**
 * Migrate a persisted main blob to the current version, PRESERVING pane placement:
 *  - the CURRENT version → its `byProject` (validated slice-by-slice; a corrupt slice is
 *    dropped so one bad project can't take the rest down).
 *  - a v0 blob (no `v` tag, but a `byProject` map) → upgraded in place (the slices are
 *    already shape-compatible; this is the "preserve placement" path).
 *  - ANY accepted slice additionally has its pane KINDS remapped through `migratePaneKind`
 *    (v1→v2: `result` → `artifact`, ITEM-25) so a pre-rename layout keeps rendering, and then
 *    its RETIRED panes dropped through `dropRetiredPanes` (v2→v3: `selection`) so a deleted
 *    surface does not come back as a fallback-note tab.
 *  - an UNKNOWN / future version, or an unrecognizable value → an EMPTY map (the store
 *    falls back to the default IA per project) WITHOUT throwing. The workspace is never
 *    left paneless — `ensureProject` seeds the default 4-pane layout.
 */
export function migrateDockMain(raw: unknown): Record<string, DockMainSlice> {
  if (!raw || typeof raw !== 'object') return {}
  const blob = raw as Partial<DockMainBlob>
  // Unknown / future version → fall back to default (never throw, never mis-read).
  if (typeof blob.v === 'number' && blob.v > DOCK_MAIN_VERSION) return {}
  // v0 (no version tag) OR the current version: both carry a shape-compatible `byProject`.
  const byProject = blob.byProject
  if (!byProject || typeof byProject !== 'object') return {}
  const out: Record<string, DockMainSlice> = {}
  for (const [pid, slice] of Object.entries(byProject)) {
    if (isSlice(slice)) out[pid] = dropRetiredPanes({ ...slice, cells: migratePaneCells(slice.cells) })
  }
  return out
}
