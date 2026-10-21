// builtinViews (ITEM-55/56) — register the built-in shell SURFACES as
// `ViewContribution`s so `placeViews(area)` is the single content source for every dock
// area (center / left / right), not a hardcoded region→component map. ONE shell view
// remains:
//   · `workbench.canvas` — area `center` → the viz `GridWorkspace` hero (ITEM-56).
//
// The other two are gone, and per DEC-H nothing was invented to replace either — the
// LEFT and RIGHT dock AREAS stay open to any extension. The LEFT area still has a pane
// rendering `placeViews('left')`, which shows the honest "Nothing here yet" empty state
// until an extension contributes into it. The RIGHT area no longer has one: its
// `p-selection` "Inspector" host was DELETED, because right-area views already reconcile
// into `view` panes in the right region, so the extra host only ever double-rendered them.
//   · `workbench.selection` (ITEM-9)  — went with the workbench selection feature.
//   · `workbench.visualize` (ITEM-33) — was the `fieldProviders` "color/select by" rail;
//     `fieldProviders` had ZERO contributors after the single-cell processor package was
//     deleted, so the rail rendered its own empty state and nothing else.
//
// Descriptor-only + framework-free (a `render:{component:'<named>'}` ref, no heavy
// import) so calling this at APP BOOT does NOT pull deck.gl. The named components are
// registered LAZILY at shell mount (`dock/panes.tsx` → `registerViewComponent`), keeping
// the deck bundle out of the app-boot path. A host-owned boot registration, distinct
// from the glob-discovered extensions.

import { workbenchRegistry, WORKBENCH_API_VERSION, type ViewContribution } from '@/modules/workbench/core'
import { SHELL_EXTENSION_ID } from '../host/createHost'

/** The named-component ids the shell surfaces resolve through (registered in panes.tsx). */
export const SHELL_VIEW_COMPONENTS = {
  canvas: 'ui/WorkbenchCanvas',
} as const

/** The shell view ids that already have a DEDICATED default region pane (the `canvas`/
 *  `visualize` pane KINDS in `defaultMainSlice`). `paneReconcile` must NOT re-mount these as
 *  generic `view` panes when it reconciles the left/right areas — they'd DUPLICATE the default
 *  pane (the "double title / un-closable canvas" symptom the VIEW_AREAS comment records).
 *  Analysis-contributed views (declarative processor surfaces) have no default pane, so they
 *  DO reconcile.
 *
 *  This set SHRANK twice: ITEM-9 dropped `workbench.selection` with the selection feature,
 *  ITEM-33 dropped `workbench.visualize` with the field-provider rail. Nothing was added
 *  back either time: the set is read as a pure FILTER, so a smaller set simply means fewer
 *  exclusions — the `visualize` pane keeps rendering `placeViews('left')` (empty today), and
 *  no consumer assumes a fixed cardinality. */
export const SHELL_DEFAULT_PANE_VIEW_IDS: ReadonlySet<string> = new Set(['workbench.canvas'])

let done = false

/** Register the built-in center shell view (idempotent). Called at app boot
 *  (module.tsx) + when the gallery mounts a shell in isolation. */
export function registerBuiltinShellViews(): void {
  if (done) return
  done = true
  const views: ViewContribution[] = [
    {
      id: 'workbench.canvas',
      extensionId: SHELL_EXTENSION_ID,
      apiVersion: WORKBENCH_API_VERSION,
      title: 'Canvas',
      area: 'center',
      render: { component: SHELL_VIEW_COMPONENTS.canvas },
    },
  ]
  for (const v of views) {
    if (!workbenchRegistry.views.get(v.id)) workbenchRegistry.views.register(v)
  }
}
