// The widget-renderer REGISTRY (PLAN.md ITEM-7). Mirrors `@txresbench/viz`'s
// `registerChartType`/`installBuiltins`: a `kind` → renderer map the `WidgetHost`
// resolves against.
//
// DEC-A (ITEM-36) — the kind set is OPEN. It used to be CLOSED against core's
// `WIDGET_KINDS`, which meant the plot vocabulary had to live in the transport layer.
// An EXTENSION now registers its own kinds through this same `registerWidget` seam
// (`extensions/canvas` owns scatter/violin/bar/histogram/image), so
// `registeredWidgetKinds()` is a SUPERSET of core's list and the schema validator
// accepts "a core kind OR a registered kind". Rendering is not privilege escalation;
// ACTING is — `EffectSpec`'s op vocabulary stays equality-closed (`core/spec/vocabulary`).
//
// `installWidgets()` still populates a renderer for every CORE kind (complete-by-kind for
// the form controls). An unknown kind is a hard error, never a silent blank.

import type { ReactNode } from 'react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ProducerTarget } from '@/modules/workbench/core/runtime/producerTargets'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import type { BindingOrigin } from '@/modules/workbench/core/runtime/bindingOrigin'
import type { SubmitGate } from '@/modules/workbench/core/form/gate'
import type { RequirementLine } from '@/modules/workbench/core/form/validityContract'

/** What a renderer receives: its resolved binding `scope` (for `$`-ref reads),
 *  the target `viewId`, and a `dispatch` that runs a declared action (short id)
 *  with `view_id` injected — the widget's onChange/onCommit/onClick chokepoint.
 *  `renderChildren` lets a container kind (`group`) render nested widgets
 *  (each with its own `for_each`/`when`) without importing the host directly. */
export interface WidgetRenderContext {
  viewId: string
  scope: Scope
  /** Dispatch a declared action by its LOCAL id (`qc.setEmbedding`); the host
   *  namespaces it + injects `view_id`, then routes through `runAction`.
   *
   *  `opts.origin` says how the value this dispatch carries was CHOSEN, and is stamped onto
   *  every `set` the action performs. A control that omits it is saying "a human did this",
   *  which is the default and the overwhelmingly common case; the ONE thing that must pass
   *  `'auto'` is a pre-selection the control made on the user's behalf. Omitting it where it
   *  was due under-reports an unreviewed binding, which is the defect this argument exists
   *  to close — see `docs/design/binding-origin.md`.
   *
   *  `opts.artifacts` (ITEM-35, DEC-D) is the FUSED MEMBER SET this dispatch carries — the whole
   *  artifact-id list a fused pick spanned, PRIMARY first — stamped onto every `set` the action
   *  performs so the run bound from it records a `used` edge per member. Absent on every unfused
   *  control, which is the common case; the stored value stays the one primary id regardless. */
  dispatch: (
    localActionId: string | undefined,
    args?: Record<string, unknown>,
    opts?: { origin?: BindingOrigin; artifacts?: readonly string[] },
  ) => void
  /** Render a list of child widget specs in `childScope` (used by `group`). */
  renderChildren: (children: WidgetSpec[], childScope: Scope) => ReactNode
  /** Why the action bound to `localActionId` cannot be dispatched RIGHT NOW — a sentence for the
   *  user, or `undefined` when it can. Today the only reason is a byte-identical launch already
   *  in flight; the shape is deliberately a REASON rather than a boolean, because a control that
   *  is disabled with no stated cause reads as broken (DEC-3). Absent in a bare test harness,
   *  where nothing launches. */
  actionBlockedReason?: (localActionId: string | undefined) => string | undefined
  /** The analyses that produce what this view's analysis consumes, and a way to launch one.
   *  Supplied by the host because the derivation needs the registry; absent in a bare harness,
   *  where an actionable alert degrades to its text (which is the zero-producer rendering
   *  anyway, so the degraded case is a real one rather than a broken one). */
  producerTargets?: () => ProducerTarget[]
  launchAnalysis?: (analysisId: string) => void
  /**
   * The live validation message THIS rendered control instance must show, or `undefined`
   * when it has none to show right now.
   *
   * Already carries the display decision (`core/form/validityContract.ts::shouldShow`): a
   * requirement that is unmet but not yet the user's to answer — an empty control they
   * have not touched, or one whose candidate set is empty — arrives here as `undefined`
   * and is stated by the form summary instead. A renderer therefore renders what it is
   * handed and computes nothing; validity is a pre-pass, never a per-renderer derivation.
   */
  error?: string
  /** The same, for one REPEATED PART of a widget (a per-row field of a table), addressed
   *  by `core/form/validityContract.ts::partKey`. */
  partError?: (part: string) => string | undefined
  /**
   * Record that the user has CHANGED this control (optionally one repeated part of it) in
   * this session. Called automatically by `dispatch`; a container that dispatches on
   * behalf of its parts calls it with the part id as well.
   *
   * The touched set is UI state and lives with the pane — it is not part of what the run
   * receives and never enters `store.snapshot()`.
   */
  markTouched?: (part?: string) => void
  /**
   * The form-level submit gate, supplied ONLY to a control that SUBMITS this form (one
   * bound to a declared action that dispatches a run). It is DERIVED from the same
   * verdicts the fields show — never a second predicate that could disagree with them.
   */
  submitGate?: SubmitGate
  /** The unmet requirements to state beside that control, so a disabled primary action
   *  never reads as a broken one. Bounded; `requirementsElided` counts the rest. */
  requirements?: readonly RequirementLine[]
  requirementsElided?: number
}

export type WidgetRenderer = (spec: WidgetSpec, ctx: WidgetRenderContext) => ReactNode

const registry = new Map<string, WidgetRenderer>()

/** Register (or replace) the renderer for `kind`. Replace-on-dup is intentional
 *  (idempotent installers, and an app can override a builtin). */
export function registerWidget(kind: string, renderer: WidgetRenderer): void {
  registry.set(kind, renderer)
}

/** Resolve the renderer for `kind`. THROWS on an unregistered kind — a missing
 *  renderer is a bug (the validator already rejects unknown kinds), never a
 *  silent empty render. */
export function getWidget(kind: string): WidgetRenderer {
  const renderer = registry.get(kind)
  if (!renderer) throw new Error(`[declarative] no widget renderer registered for kind "${kind}"`)
  return renderer
}

/** Whether a renderer is registered for `kind` (non-throwing probe). */
export function hasWidget(kind: string): boolean {
  return registry.has(kind)
}

/** Every registered kind (introspection / test). */
export function registeredWidgetKinds(): string[] {
  return Array.from(registry.keys())
}

/** Test-only reset. */
export function __clearWidgetsForTests(): void {
  registry.clear()
}

// ── core's OWN renderers, published for the installer (ITEM-7/ITEM-21) ────────
//
// `artifact_ref` is the one form control core owns: it reads the catalog CHANNEL core
// publishes on the render scope (`core/artifacts/catalog.ts`) and drives core's own pure
// candidate resolver (`core/runtime/axisSource.ts`), so its renderer sits in `core/render/`
// beside them rather than an extension owning the engine's input primitive.
//
// It is published from HERE — the module whose job is exactly renderer registration, and
// the one core/render module the widget installer already imports — instead of from
// `core/index.ts`, because the public barrel cannot carry it. `core/index.test.ts` pins
// that the barrel loads under `node --test --experimental-strip-types`, and that runner
// can neither parse `.tsx` (`ERR_UNKNOWN_FILE_EXTENSION`) nor the parameter-property
// syntax in `@/core/workstore`, which the resolver reaches for its display formatter.
// So this renderer and everything behind it are structurally un-barrel-able, and the
// registry is the seam that publishes them.
export { ArtifactRefRenderer } from './ArtifactRefWidget'
