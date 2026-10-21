// The declarative-CANVAS host SEAM (DOMAIN_AUDIT §4 "Structural", C8).
//
// `DeclarativeRegion` used to import three VALUES out of `extensions/canvas` +
// `extensions/analysis` — `resolveDeclarativeCanvas`, `declarativeCanvas`,
// `buildCanvasDataSource`, `analysesProducing` — while the rest of core is scrupulously
// type-only about extensions ("no runtime core→extensions edge (INV-6)", stated at
// `runtime/viewData.ts`, `runtime/hostCtx.ts`, `shell/WorkbenchContext.tsx`). That live
// edge was the channel canvas assumptions travelled into core through, and they did: core
// knew the canvas's keep-mask was spelled `$derived.keptMask`, knew the positions map was
// keyed `obs`, and knew the artifact catalog had a `layouts` channel.
//
// This module closes the edge the same way capabilities do (`core/capabilities/providers`):
// core declares an INTERFACE and a registry; the canvas extension registers an
// implementation at module-evaluation time from `extensions/index.ts`. Core forwards the
// view's whole `data`/`derived`/`scope` and knows nothing about what the canvas does with
// them. Nothing is registered ⇒ `publish`/`clear` are no-ops and the region still renders.

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import type { InterpreterCtx } from '@/modules/workbench/core/runtime/interpreter'
import type { WorkbenchAPI } from '@/modules/workbench/core'

/** Everything a canvas host needs to (re)publish ONE view's declared canvas. Deliberately
 *  unopinionated: whole slices, whole derived map, whole scope — core names no key. */
export interface DeclarativeCanvasPublish {
  /** the whole view_spec (the host reads its own `canvas` block off it). */
  spec: ViewSpec
  /** the shared per-instance view id — also the feed's ownership key. */
  viewId: string
  /**
   * Where this view's canvas contribution belongs among the others, ASCENDING. Core states a
   * POSITION and nothing about what arranges it: the host that renders a view knows its
   * arrangement (a section stack knows the user's section order), and the canvas host knows
   * only that a smaller number comes first.
   *
   * Omitted ⇒ unpositioned. An unpositioned contribution stacks after every positioned one and
   * keeps its publish order among its peers, so a host that says nothing gets exactly the
   * behaviour it had before this field existed.
   */
  order?: number
  /** the resolved `$data` slices. */
  data: Record<string, unknown>
  /** the reactive scope ($state/$derived/$const/$data/$dataStatus/caps) declared refs
   *  resolve against. */
  scope: Scope
  /** the injected workbench API + bound project, for whatever auxiliary reads the host does. */
  api: WorkbenchAPI
  projectId: string
  /** the interpreter ctx a canvas-routed declared action runs over. */
  hostCtx: InterpreterCtx
  /** the catalog epoch — bumped whenever the project's artifacts changed. A host that caches
   *  a derived read (e.g. plot coordinates) invalidates on a change. Generic: core says
   *  "the data moved", never what moved. */
  catalogEpoch: number
}

export interface DeclarativeCanvasHost {
  /** (Re)publish `spec`'s declared canvas for `viewId`. Called on every data/state change;
   *  a host that declares no canvas must make this a cheap no-op. May resolve auxiliary
   *  data asynchronously and re-publish itself — core does not await it. */
  publish(input: DeclarativeCanvasPublish): void
  /** Tear the feed down for `viewId` (ownership-guarded by the host). */
  clear(viewId: string): void
}

let host: DeclarativeCanvasHost | undefined

/** Register the canvas host (idempotent-by-overwrite; the last registration wins, which is
 *  what a test double needs). */
export function registerDeclarativeCanvasHost(impl: DeclarativeCanvasHost): void {
  host = impl
}

/** The registered host, or `undefined` when no canvas extension is installed (a headless /
 *  node-runner mount). Every call site must tolerate `undefined`. */
export function getDeclarativeCanvasHost(): DeclarativeCanvasHost | undefined {
  return host
}

/** Test-only: drop the registration so a suite can assert the no-host path. */
export function __resetDeclarativeCanvasHostForTests(): void {
  host = undefined
}
