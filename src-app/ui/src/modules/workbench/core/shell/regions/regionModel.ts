// regionModel (Phase 2 · fixed 4-region shell) — the workbench moves from a free-form tiling dock to
// FOUR FIXED REGIONS (VS Code shell): LEFT / CENTER / RIGHT / BOTTOM. Panes no longer go anywhere; each
// pane KIND belongs to a region, shown there as a tab. Left/Right collapse to a border tab-strip;
// Bottom is pop-out-able. This is the "less freedom, more structure" model (owner-requested).

import { Permissions } from '@/api-client/permissions'
import type { PermissionExpr } from '@/core/permissions'
import type { PaneKind } from '@/modules/workbench/core/shell/dock/paneModel'

export type Region = 'left' | 'center' | 'right' | 'bottom'
export const REGIONS: readonly Region[] = ['left', 'center', 'right', 'bottom'] as const

/**
 * Default region for each pane kind (owner-tuned):
 *  - LEFT   — inspect/select rail: visualize controls (annotation / feature columns), datasets.
 *  - CENTER — the canvas hero + review surfaces (artifact, compare, contributed views). Kept clear of the
 *             analysis run/config panes so the canvas stays visible WHILE the user configures a run.
 *  - RIGHT  — the analyses catalog, the analysis RUN / re-run panes, produced artifacts,
 *             reproducibility, and the operational monitors: jobs, run history, lineage.
 *  - BOTTOM — no default panes routed here (empty by default); a pane only lands here when the
 *             user drags one into it.
 */
export const PANE_REGION: Record<PaneKind, Region> = {
  visualize: 'left',
  datasets: 'left',
  launcher: 'right',
  canvas: 'center',
  run: 'right',
  artifact: 'center',
  artifacts: 'right',
  compare: 'center',
  rerun: 'right',
  // A `view` pane's FALLBACK region is `bottom` (never `center` — the center is reserved for the
  // canvas grid, DEC-11/15). In practice `paneReconcile` docks each reconciled `view` pane into the
  // region the contributed view DECLARED (right for control/run, bottom for output, left for inspect
  // — DEC-15) via an explicit `moveToRegion`, so this default only applies to a view pane with no
  // region override.
  view: 'bottom',
  reproducibility: 'right',
  jobs: 'right',
  // The centre canvas's per-plot editing surfaces. RIGHT, beside the plot they edit and NOT
  // inside it: hosted in the grid's own internal panel they occupied grid width, so opening a
  // plot's editor shrank the plot being edited. They are `control`-role surfaces by the
  // ROLE_REGION table below, and `control` is right.
  'edit-plot': 'right',
  'data-table': 'right',
  // The export dialog is the same kind of surface with a wider subject: it may export ONE plot
  // or the WHOLE GRID. Either way it belongs beside the canvas, not inside it — hosted in the
  // grid's internal panel it took ~300px of grid width, which for a whole-grid export means it
  // shrank the very thing being exported while the user set the export up.
  export: 'right',
}

export function regionOfKind(kind: PaneKind): Region {
  return PANE_REGION[kind] ?? 'center'
}

// ── Surface ROLE → region placement contract (declarative-canvas-plots ITEM-15 / DEC-11/15) ──
// Every analysis surface is one of a small, FIXED set of ROLES; the engine maps role → region
// deterministically, so no analysis can pick a free-form `area` and crowd the canvas. This is the
// generalization of ITEM-14: `plot` ALWAYS routes to the CENTER canvas grid (as a cell, never a
// competing center tab); everything else lands beside/below it. `area: center` is REMOVED from the
// contributed-view vocabulary — the center is RESERVED for the ONE canvas `GridWorkspace`.

/** The fixed surface roles an analysis may declare (DEC-11). */
export type SurfaceRole = 'plot' | 'control' | 'run' | 'output' | 'inspect' | 'report'
export const SURFACE_ROLES: readonly SurfaceRole[] = ['plot', 'control', 'run', 'output', 'inspect', 'report'] as const

/**
 * The region a surface ROLE places into (the ITEM-15 contract):
 *  - `plot`    → CENTER (the canvas grid, as a cell — via the `VizOption` path, never a view tab)
 *  - `control` → RIGHT  (inputs that drive a plot, next to Run)
 *  - `run`     → RIGHT  (the params form + Run + live progress)
 *  - `output`  → BOTTOM (tabular metrics / logs / text summary / save-export)
 *  - `report`  → BOTTOM (a rendered HTML/PDF artifact, distinct from `output`)
 *  - `inspect` → LEFT   (data structure / selection detail read rail)
 */
export const ROLE_REGION: Record<SurfaceRole, Region> = {
  plot: 'center',
  control: 'right',
  run: 'right',
  output: 'bottom',
  report: 'bottom',
  inspect: 'left',
}

export function regionForRole(role: SurfaceRole): Region {
  return ROLE_REGION[role]
}

/**
 * Assert a CONTRIBUTED view's `area` is placeable (ITEM-14/15). `center` is REJECTED LOUD: the
 * center region is reserved for the canvas `GridWorkspace`, so a contributed view (an analysis's
 * plot) must route to the canvas via the `VizOption` path, never claim a center tab beside it.
 * Throws on `center`; returns the area unchanged for `left`/`right`/`bottom`. Pure — the region
 * model test drives it directly, and `placeViews` calls it for any NON-canvas `center` contribution
 * (the canvas GridWorkspace `workbench.canvas` is the sole whitelisted center view) so a smuggled
 * `center` fails loud at the placement seam.
 */
export function assertContributableArea(area: string): Region {
  if (area === 'center') {
    throw new Error(
      `[workbench] a contributed view may not declare area "center" — the center region is reserved ` +
        `for the canvas GridWorkspace; contribute a plot via the canvas VizOption block (ITEM-14/15).`,
    )
  }
  if (area === 'left' || area === 'right' || area === 'bottom') return area
  throw new Error(`[workbench] contributed view has out-of-vocabulary area "${area}" (ITEM-15).`)
}

/** The pane kinds a user can add MANUALLY from the region "+" menu. Excludes the
 *  action-/transient-created kinds (`run`/`artifact`/`rerun`/`compare`/`view`) that
 *  only appear as a side effect of launching an analysis or a contributed view. */
export const ADDABLE_PANE_KINDS: readonly PaneKind[] = [
  'datasets',
  'launcher',
  'artifacts',
  // 'reproducibility' renders the consolidated PROVENANCE pane (graph + readiness +
  // export) — the former separate History / Lineage panes were folded into it.
  'reproducibility',
  'jobs',
  'visualize',
  'canvas',
]

/**
 * The permission a pane KIND requires, for the kinds whose content is permission-gated
 * (R4C-05). Unlisted kinds are ungated.
 *
 * Why this exists: `reproducibility` used to be a project-detail SECTION contributed
 * through the project-extension registry, so both its nav entry and its panel were
 * permission-filtered for free (`useProjectNavEntries` / `useProjectDetailPanels` →
 * `evaluatePermission`). Retiring the section nav in favour of a workbench pane
 * (commit 6d231748) moved it to a directly-registered pane renderer, which inherits no
 * filtering — the "+" menu offered it to every user, and a user without
 * `provenance::read` who opened it was shown the pane's "No provenance yet" empty state,
 * a FALSE claim (the backend gate holds and answers 403; the project may well have
 * provenance the user simply may not see).
 *
 * This map restores the MENU half of that gate. It is not the gate on its own — a pane is
 * also reachable via a restored layout, `revealPane`, and the `window.__workbenchPanes`
 * seam — so each gated pane asserts its own permission in its renderer too (see
 * `ProvenancePane`). Kept here, in the import-light region model, so `RegionShell` can
 * consult it without pulling in the heavy pane-content graph (`panes.tsx`).
 */
export const PANE_KIND_PERMISSION: Partial<Record<PaneKind, PermissionExpr>> = {
  reproducibility: Permissions.ProvenanceRead,
}
