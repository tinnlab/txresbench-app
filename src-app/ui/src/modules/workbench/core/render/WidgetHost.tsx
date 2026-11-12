// The WIDGET HOST (PLAN.md ITEM-7). Resolves a `WidgetSpec` — honoring its
// `for_each` (data-driven repetition) and `when` (visibility gate) — to the
// registered renderer for its `kind`, and supplies the render `ctx` (binding
// scope + a `dispatch` that namespaces + runs the bound declared action, view_id
// injected). This is the single place `for_each`/`when`/`dispatch` are applied,
// so every renderer stays a pure kind→markup function.

import * as React from 'react'
import { Button } from '@txresbench/kit'
import type { WidgetSpec, WidgetBase } from '@/modules/workbench/core/manifest/viewSpec'
import { runAction, wasSurfaced } from '@/core/actions/defineAction'
import { evalWhen, expandForEach, type Scope } from '@/modules/workbench/core/runtime/expr'
import { launchIdentityForAction, type InterpreterCtx } from '@/modules/workbench/core/runtime/interpreter'
import { isInFlight, subscribeInFlight, inFlightVersion } from '@/modules/workbench/core/runtime/inFlightLaunches'

/** What a Run button says while the identical run it would submit is already in the air.
 *
 *  Phrased as the STATE plus what changes it, because "disabled" alone reads as broken. It does
 *  not say "wait" — the user may change any input and launch immediately; it is the unchanged
 *  resubmission that is refused, and only until that run finishes (DEC-3). */
export const RUN_IN_FLIGHT_REASON = 'This run is already in progress — change an input to launch a different one.'
import { getWidget, type WidgetRenderContext } from './registry'
import type { ProducerTarget } from '@/modules/workbench/core/runtime/producerTargets'
import { namespaceActionId } from '@/modules/workbench/core/spec/ids'
import {
  instanceKey,
  readFormValidity,
  shouldShow,
  type FieldVerdict,
} from '@/modules/workbench/core/form/validity'

export interface WidgetHostProps {
  spec: WidgetSpec
  scope: Scope
  /** The mounted instance the bound actions target. */
  viewId: string
  /** The owning `view_spec` id — used to namespace a widget's local action id. */
  specId: string
  /** The host ctx a dispatched action runs over — wires the effectful ops
   *  (`run_processor`/`wait_for`/`toast`) onto the REAL workbench run/job pipeline
   *  (ITEM-10). Omitted in bare unit tests: a dispatch then falls back to a default
   *  `ActionContext`, so a state-only (`set`/`listAppend`) action still runs. */
  hostCtx?: InterpreterCtx
  /** Forwarded to every widget's render ctx — see `WidgetRenderContext`. */
  producerTargets?: () => ProducerTarget[]
  launchAnalysis?: (analysisId: string) => void
  /** The error-boundary reset signal — see [`WidgetResetKey`]. `DeclarativeRegion` binds it
   *  to the store's `dataRevision`; omitted (bare unit tests) ⇒ the boundary never
   *  auto-resets, which is the safe default (no accidental identity reset). */
  resetKey?: WidgetResetKey
  /**
   * The enclosing repeat indices, outermost first — the address of the instance this
   * widget is being rendered INSIDE.
   *
   * It exists because a control inside a repeated `group` carries the same widget id and
   * the same (zero) own-index in every row, so an address built from the id alone collides
   * across rows and one row's message would land on all of them. Threaded, not derived:
   * only the caller knows where in the repeat tree it is.
   */
  instancePath?: readonly number[]
  /** Which control instances the user has changed this session (DEC-4). UI state, owned by
   *  the pane — never part of the view store, so it never reaches `snapshot()`. */
  touched?: ReadonlySet<string>
  onTouch?: (key: string) => void
}

/** The reset signal a `WidgetErrorBoundary` latches against — a PRIMITIVE (the owning store's
 *  `dataRevision`), never an object.
 *
 *  F7: this used to be the render `scope` OBJECT, and `DeclarativeRegion` rebuilds a fresh
 *  scope literal on EVERY render — so `props.resetKey !== state.lastResetKey` was true every
 *  single time and the boundary never latched at all: it cleared, re-rendered the throwing
 *  child, re-threw and re-logged, forever. Keying on the store's DATA revision (DEC-2 — not
 *  `revision`, which bumps on every slider tick) restores the latch AND keeps the original
 *  intent: "clear when the live loop hands the region corrected DATA". */
export type WidgetResetKey = number | undefined

/** Human name for a failed widget, for the placeholder (F8/ITEM-8): its declared label, else
 *  its id, else its kind. A `$`-ref label is NOT used verbatim (it would print the binding,
 *  not a name) — the id/kind fallback takes over. Exported so the fallback order is pinned
 *  by a test rather than re-derived by a reader. */
export function widgetDisplayName(
  spec: { label?: unknown; id?: string; kind?: string } | undefined,
): string {
  if (!spec) return 'widget'
  const label = spec.label
  if (typeof label === 'string' && label.trim() !== '' && !label.trim().startsWith('$')) {
    return label.trim()
  }
  if (spec.id) return spec.id
  if (spec.kind) return spec.kind
  return 'widget'
}

/** Isolates ONE widget's render: a throwing renderer / binding degrades to a compact inline
 *  placeholder instead of crashing the whole fanned region (the sibling widgets keep
 *  rendering). Must be a class — error boundaries have no hook equivalent. */
class WidgetErrorBoundary extends React.Component<
  {
    widgetId?: string
    /** What the placeholder NAMES (F8) — the widget's label / id / kind. */
    widgetName?: string
    /** The widget's declared kind, shown alongside the name. */
    widgetKind?: string
    resetKey?: WidgetResetKey
    children: React.ReactNode
  },
  { error: Error | null; lastResetKey: WidgetResetKey; retryNonce: number }
> {
  state: { error: Error | null; lastResetKey: WidgetResetKey; retryNonce: number } = {
    error: null,
    lastResetKey: this.props.resetKey,
    retryNonce: 0,
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  /** Clear a latched error when the render INPUTS change (a new `resetKey` — the live loop hands the
   *  region corrected data). Without this a transient bad slice in the real-time loop would pin the
   *  placeholder until unmount, even after the store re-renders the region with valid data.
   *  The key is a PRIMITIVE (see `WidgetResetKey`), so an unrelated re-render no longer resets. */
  static getDerivedStateFromProps(
    props: { resetKey?: WidgetResetKey },
    state: { error: Error | null; lastResetKey: WidgetResetKey; retryNonce: number },
  ): { error: Error | null; lastResetKey: WidgetResetKey } | null {
    if (props.resetKey !== state.lastResetKey) {
      return { error: null, lastResetKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error: unknown): void {
    console.error('[declarative] widget render failed', this.props.widgetId, error)
  }

  /** F8 — the user-driven half of the latch (DEC-5): a RENDER failure is not fixed by
   *  re-fetching, so this clears the latched error and re-renders the child. The nonce
   *  re-keys the subtree so React remounts it rather than reusing the failed tree. */
  private retry = (): void => {
    this.setState(s => ({ error: null, retryNonce: s.retryNonce + 1 }))
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const name = this.props.widgetName ?? this.props.widgetId ?? 'widget'
      const kind = this.props.widgetKind
      return (
        <div
          role="alert"
          data-testid={`widget-error-${this.props.widgetId ?? 'unknown'}`}
          className="flex w-full flex-col items-start gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          <span>{`"${name}"${kind ? ` (${kind})` : ''} failed to render`}</span>
          <Button
            variant="outline"
            data-testid={`widget-error-retry-${this.props.widgetId ?? 'unknown'}`}
            // A `for_each` row set can fail N times in one region, so a bare "Retry" would
            // expose N indistinguishable controls to a screen-reader / voice user.
            aria-label={`Retry ${name}`}
            onClick={this.retry}
          >
            Retry
          </Button>
        </div>
      )
    }
    return <React.Fragment key={this.state.retryNonce}>{this.props.children}</React.Fragment>
  }
}

/** Invokes a widget renderer INSIDE a component so a synchronous throw happens in this
 *  child's render phase — where the wrapping `WidgetErrorBoundary` can catch it (a throw in
 *  `WidgetHost`'s own render would escape the boundary). Resolving the renderer for `kind`
 *  is done here too, so an unknown-kind throw is isolated as well. */
function RenderedWidget({
  wspec,
  rctx,
}: {
  wspec: WidgetSpec & WidgetBase
  rctx: WidgetRenderContext
}): React.ReactElement {
  const renderer = getWidget(wspec.kind)
  return <>{renderer(wspec, rctx)}</>
}

/** The message a verdict shows RIGHT NOW, or `undefined`. One place, so the DEC-4
 *  absent-vs-present rule is applied identically to a widget and to a repeated part of
 *  one, and no renderer ever re-derives it. */
function shownMessage(
  verdict: FieldVerdict | undefined,
  key: string,
  touched: ReadonlySet<string> | undefined,
): string | undefined {
  return shouldShow(verdict, touched?.has(key) === true) ? verdict?.message : undefined
}

/** Render one widget spec (expanded over its `for_each`, gated by its `when`). */
export function WidgetHost({
  spec,
  scope,
  viewId,
  specId,
  hostCtx,
  resetKey,
  producerTargets,
  launchAnalysis,
  instancePath,
  touched,
  onTouch,
}: WidgetHostProps): React.ReactElement {
  // Re-render when a launch starts or finishes: a Run button's disabled state is derived from
  // module-level in-flight state, which React cannot observe on its own. Without this the guard
  // would engage on the next unrelated render and, worse, RELEASE on one — leaving the button
  // disabled after its run finished until something else happened to re-render.
  React.useSyncExternalStore(subscribeInFlight, inFlightVersion, inFlightVersion)
  const entries = expandForEach(spec, scope)
  const basePath = instancePath ?? []
  // The verdict map this render's fields, summary and gate ALL read from — computed once
  // per render by the pane, never here (non-negotiable 1: a requirement is declared once
  // and consumed everywhere, and a form may not compute its validity twice).
  const validity = readFormValidity(scope)
  return (
    <>
      {entries.map((entry, i) => {
        const wspec = entry.spec as WidgetSpec & WidgetBase
        if (!evalWhen(wspec.when, entry.scope)) return null
        const path = [...basePath, i]
        const widgetId = wspec.id ?? String((wspec as { kind?: string }).kind ?? 'widget')
        const key = instanceKey(widgetId, path)
        const markTouched = (part?: string): void =>
          onTouch?.(part === undefined ? key : instanceKey(widgetId, path, part))
        const submits =
          wspec.kind === 'button' &&
          typeof (wspec as { onClick?: string }).onClick === 'string' &&
          validity?.submitActions.has((wspec as { onClick: string }).onClick) === true
        const rctx: WidgetRenderContext = {
          viewId,
          scope: entry.scope,
          producerTargets,
          launchAnalysis,
          error: shownMessage(validity?.verdicts.get(key), key, touched),
          partError: part => {
            const partId = instanceKey(widgetId, path, part)
            return shownMessage(validity?.verdicts.get(partId), partId, touched)
          },
          markTouched,
          // A gate + a summary are handed ONLY to the control that submits. Gating every
          // affordance on form validity would disable the very "Add" and "Remove" buttons
          // an incomplete form needs in order to become complete.
          submitGate: submits ? validity?.gate : undefined,
          requirements: submits ? validity?.summary : undefined,
          requirementsElided: submits ? validity?.elided : undefined,
          actionBlockedReason: localId => {
            if (!localId) return undefined
            const identity = launchIdentityForAction(namespaceActionId(specId, localId), entry.scope)
            return identity && isInFlight(identity) ? RUN_IN_FLIGHT_REASON : undefined
          },
          dispatch: (localId, args, opts) => {
            if (!localId) return
            // Every control change funnels through here, which is what makes "has the user
            // engaged with this control yet" answerable without each renderer remembering
            // to say so.
            markTouched()
            // Pass the host ctx (3rd arg) so `run_processor`/`wait_for`/`toast` reach the real
            // run/job pipeline; a bare test with no ctx falls back to the default ActionContext.
            // `origin` rides the CTX, not the params bag. `paramsSchema` accepts a
            // catch-all, so a reserved param name would enter the declaration vocabulary
            // where a package could collide with it; the ctx is invisible to that surface.
            // Spread onto whatever host ctx exists (possibly none, in a bare harness) so a
            // control that says nothing about origin sends nothing, and `ViewStore.set`'s
            // own `'user'` default is the ONE place the fallback is decided.
            // `artifacts` (ITEM-35, DEC-D) rides the SAME ctx channel as origin, for the same
            // vocabulary-collision reason: a fused pick carries its whole member set here so the
            // `set` it triggers records it in the store sidecar. Absent on every unfused control.
            const ctxWithOrigin: InterpreterCtx | undefined =
              opts?.origin || (opts?.artifacts && opts.artifacts.length > 0)
                ? ({
                    ...(hostCtx ?? {}),
                    ...(opts.origin ? { __bindingOrigin: opts.origin } : {}),
                    ...(opts.artifacts && opts.artifacts.length > 0 ? { __bindingArtifacts: opts.artifacts } : {}),
                  } as InterpreterCtx)
                : hostCtx
            void runAction(
              namespaceActionId(specId, localId),
              { view_id: viewId, ...(args ?? {}) },
              ctxWithOrigin,
            ).catch((err: unknown) => {
              // A declared action that REJECTS aborts `interpretBody` before its
              // remaining effects — including any trailing `toast: {success}`. If
              // the rejection is only console-logged, the button appears to do
              // NOTHING (a zod `ActionParamsError`, an unknown action id, or a
              // mid-body failure after real work already happened). A silent
              // failure is a defect, so the rejection is surfaced to the user
              // here; the console line is kept for diagnosis.
              console.error('[declarative] action dispatch failed', localId, err)
              // …unless the action ALREADY told the user (in its own, better-worded
              // sentence). Re-toasting a marked error showed the same message twice.
              if (!wasSurfaced(err)) {
                const message = err instanceof Error ? err.message : String(err)
                hostCtx?.toast?.({ error: message })
              }
            })
          },
          // Forward the reset signal into nested children (a `group`'s widgets) — without
          // this a throw inside a group would latch forever with no way to clear it.
          renderChildren: (children, childScope) => (
            <WidgetList
              specs={children}
              scope={childScope}
              viewId={viewId}
              specId={specId}
              hostCtx={hostCtx}
              resetKey={resetKey}
              producerTargets={producerTargets}
              launchAnalysis={launchAnalysis}
              // The children are rendered INSIDE this instance, so they inherit its
              // address — without which every row of a repeated container would hand its
              // children the same one.
              instancePath={path}
              touched={touched}
              onTouch={onTouch}
            />
          ),
        }
        return (
          // The key MUST include the iteration index: a `for_each` expansion yields N entries
          // that all carry the SAME declared widget `id` (`criterionRow` × 50), so keying on
          // the id alone gave React duplicate keys for every repeated widget — a real defect
          // the Slice-3 gallery fixtures surfaced immediately (it had been invisible because
          // no declarative surface was ever rendered under the runtime-health pass). Rows are
          // positional (a criteria list indexed by position), so the index is the right key.
          <WidgetErrorBoundary
            key={`${wspec.id ?? 'widget'}-${i}`}
            widgetId={wspec.id}
            widgetName={widgetDisplayName(wspec)}
            widgetKind={wspec.kind}
            resetKey={resetKey}
          >
            <RenderedWidget wspec={wspec} rctx={rctx} />
          </WidgetErrorBoundary>
        )
      })}
    </>
  )
}

export interface WidgetListProps {
  specs: WidgetSpec[]
  scope: Scope
  viewId: string
  specId: string
  /** Threaded to each widget's dispatch — see [`WidgetHostProps.hostCtx`]. */
  hostCtx?: InterpreterCtx
  /** The error-boundary reset signal — see [`WidgetResetKey`]. */
  resetKey?: WidgetResetKey
  /** Forwarded to each widget's render ctx — see `WidgetRenderContext`. */
  producerTargets?: () => ProducerTarget[]
  launchAnalysis?: (analysisId: string) => void
  /** See [`WidgetHostProps.instancePath`]. */
  instancePath?: readonly number[]
  /** See [`WidgetHostProps.touched`]. */
  touched?: ReadonlySet<string>
  onTouch?: (key: string) => void
}

/** Render an ordered list of widget specs (a region body / a group's children). Each
 *  top-level widget is wrapped in a `WidgetErrorBoundary` so a throw in its `for_each` /
 *  `when` expansion (not just its renderer) degrades to a placeholder, not a dead region. */
export function WidgetList({
  specs,
  scope,
  viewId,
  specId,
  hostCtx,
  resetKey,
  producerTargets,
  launchAnalysis,
  instancePath,
  touched,
  onTouch,
}: WidgetListProps): React.ReactElement {
  return (
    <>
      {specs.map((spec, i) => {
        const id = (spec as WidgetBase).id
        return (
          <WidgetErrorBoundary
            key={id ?? i}
            widgetId={id}
            widgetName={widgetDisplayName(spec as { label?: unknown; id?: string; kind?: string })}
            widgetKind={(spec as { kind?: string }).kind}
            resetKey={resetKey}
          >
            <WidgetHost
              spec={spec}
              scope={scope}
              viewId={viewId}
              specId={specId}
              hostCtx={hostCtx}
              resetKey={resetKey}
              instancePath={instancePath}
              touched={touched}
              onTouch={onTouch}
            />
          </WidgetErrorBoundary>
        )
      })}
    </>
  )
}
