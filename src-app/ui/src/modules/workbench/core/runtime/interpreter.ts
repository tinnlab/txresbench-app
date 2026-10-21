// The action-body INTERPRETER (PLAN.md ITEM-5, research §10). A declared
// `view_spec` action ships its behavior as DATA — an `EffectSpec[]` `body` — not
// a JS closure (the trust boundary: a distributed processor UI can never ship
// arbitrary code). `interpretBody` executes that body over a `ctx`, and
// `registerViewSpecActions` registers each declared action into the LIVE
// `defineAction` registry with `run: (p,ctx) => interpretBody(action.body,p,ctx)`
// — so to the engine (human click AND AI agent) a declared action is
// indistinguishable from a hand-written one: permission-gated, state-token
// guarded (kind:'instance' + stateful), co-drivable through the SAME `runAction`.
//
// The op vocabulary is BOUNDED (research §10 "primitive-effect vocabulary"): a
// new op is an app change here, never shipped by a processor. Ops:
//   set · api · run_processor · wait_for · progress · toast · open_view ·
//   close_view · call_action.

import { z } from 'zod'
import type { ActionContext } from '@/core/actions/ctx'
import {
  defineAction,
  getActionMeta,
  runAction,
} from '@/core/actions/defineAction'
import type {
  ActionSpec,
  EffectSpec,
  InputBindingSpec,
  ViewSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import { publishCapabilities } from '@/core/actions/capabilityReport'
import {
  evalExpr,
  evalWhen,
  expandForEach,
  interpolate,
  interpolateBraces,
  stateRefPaths,
  type Scope,
} from './expr'
import { strongerOrigin, type BindingOrigin } from './bindingOrigin'
import { namespaceActionId } from '@/modules/workbench/core/spec/ids'
import { projectViewSpecCapabilities } from '@/modules/workbench/core/spec/aiCapabilities'
import { synthesizeDescribeAction } from '@/modules/workbench/core/spec/describe'
import { getViewStore } from './viewStores'
import { launchIdentity } from './launchIdentity'

/** The structural subset of a `ViewStore` (ITEM-3) the interpreter reads +
 *  mutates. Kept minimal so a test can hand a mock. */
export interface InterpreterStore {
  readonly state: Record<string, unknown>
  readonly derived: Record<string, unknown>
  /** The RESOLVED `data` slices, exposed to a body as `$data` (optional so a mock store may
   *  omit it). An action that LAUNCHES a run needs the same resolution the FORM read: an
   *  input bound from a second, later query can name a different artifact than the one whose
   *  values the user was looking at, which is the drift INV-4 forbids. */
  readonly data?: Record<string, unknown>
  readonly token: string
  set(field: string, value: unknown, origin?: BindingOrigin, artifacts?: readonly string[]): void
  /** How the value at `field` was chosen — OPTIONAL here, unlike on `ViewStore`.
   *
   *  This interface exists so a test can hand a mock (see the doc-comment above), and
   *  requiring a member would break every mock that already exists for no gain: the one
   *  read below is already a "if we can, ask" — a store that cannot answer reports no
   *  origin, and no origin is not `auto` (INV-4). `ViewStore`, which has exactly one
   *  implementation, requires it, so the real store cannot forget. */
  originOf?(field: string): BindingOrigin | undefined
  /** The FUSED MEMBER SET recorded at `field` (ITEM-35, DEC-D) — OPTIONAL here for the same
   *  reason `originOf` is: a mock store may omit it, and the read below is an "ask if you can".
   *  A store that cannot answer reports no set, and no set means the pick was unfused (one
   *  artifact), which is the honest default. `ViewStore` requires it, so the real store cannot
   *  forget. */
  artifactsOf?(field: string): readonly string[] | undefined
}

/**
 * The `ctx` an action body interprets over. Extends the base `ActionContext`
 * (navigate/progress/log/instance/…) with the effectful capabilities the
 * declarative ops need. Every extra is OPTIONAL: the effect ops that need a
 * capability the host didn't wire throw a clear "not wired" error (a unit test
 * mocks only the subset it exercises; later waves supply the real hooks). The
 * `set`/`describe`/read path needs only `viewStore`, which also falls back to
 * the module `getViewStore` directory, so a bare `runAction` (no ctx) still
 * finds a mounted store.
 */
export interface InterpreterCtx extends ActionContext {
  /** The project the workbench is bound to. Surfaced so a declared action that
   *  creates a project-scoped resource (e.g. a draftable editor's launcher creating
   *  a `drafts` row) can address it without a module global. */
  projectId?: string
  /** Resolve the live declarative store for a `view_id`. Falls back to the
   *  `viewStores` directory when omitted. */
  viewStore?: (viewId: string) => InterpreterStore | undefined
  /** Call a generated `ApiClient` route (`api` op). */
  api?: (call: string, args?: Record<string, unknown>) => Promise<unknown> | unknown
  /** Launch a processor / analysis run (`run_processor` op).
   *
   *  `inputs` is the DECLARED `{ slot → artifact id(s) }` map, kept separate from `params`
   *  (INV-4): the host binds run inputs from it alone, so a plain-value param can never be
   *  mistaken for an artifact id and a declared input can never be dropped.
   *
   *  `inputOrigins` says, PER SLOT, how the binding in `inputs` came to hold its value —
   *  `'auto'` for one the system bound from sole candidacy under a declared
   *  `auto_bind_sole_candidate`, `'user'` for one a human chose, and absent for a slot
   *  whose declaration reads nothing a control writes. It is a separate map rather than a
   *  richer `inputs` value because `inputs` is also the LAUNCH IDENTITY's input (a run is
   *  the same run whoever bound it), and folding origin in would silently stop the
   *  duplicate-launch guard from matching.
   *
   *  `inputArtifacts` says, PER SLOT, the FUSED MEMBER SET the binding stands for (ITEM-35,
   *  DEC-D) — the full artifact-id list a fused pick spanned, PRIMARY first — for the slots
   *  whose declared expression named a state path a fused pick wrote. Absent for an ordinary
   *  (unfused) slot, which is every slot in a single-dataset project. A SEPARATE map for the
   *  same reason `inputOrigins` is: `inputs` is the launch identity's input and stays the one
   *  primary id, while the member set travels here so the host can bind every member as its
   *  own run input and the recorder can write a `used` edge per member. */
  runProcessor?: (
    id: string,
    params?: Record<string, unknown>,
    inputs?: Record<string, unknown>,
    inputOrigins?: Record<string, BindingOrigin>,
    inputArtifacts?: Record<string, readonly string[]>,
  ) => Promise<unknown> | unknown
  /** Await a job/artifact reaching `until` (`wait_for` op). */
  waitFor?: (job: unknown, until?: string) => Promise<unknown> | unknown
  /** Surface a user toast (`toast` op). Falls back to `log`. */
  toast?: (msg: { success?: string; error?: string } | string) => void
  /** Open a nested/sub view (`open_view` op). */
  openView?: (view: string, withParams?: Record<string, unknown>) => void
  /** Close the current (modal/sub) view (`close_view` op). */
  closeView?: () => void
  /** INTERNAL — the `call_action` recursion depth, threaded through nested runs
   *  so an A→B→A cycle trips the depth guard instead of overflowing the stack. */
  __declDepth?: number
  /**
   * INTERNAL — how the GESTURE that is running this body chose its value, stamped onto
   * every `set` the body performs.
   *
   * It rides the ctx rather than the declared `params` bag for one reason: `paramsSchema`
   * accepts a catch-all, so a reserved param NAME would enter the view-spec's declaration
   * vocabulary where a package could collide with it. The ctx is invisible to that
   * surface. This is the same channel, and the same reason, as `__declDepth`.
   *
   * Absent means `'user'` — set by `ViewStore.set`'s own default, not by a fallback here,
   * so there is one place that decides it. It PROPAGATES into a nested `call_action`
   * (`childCtx` spreads the ctx): a chain begun by an auto-bind writes auto throughout,
   * which is the conservative direction — over-reporting an unreviewed binding is a false
   * alarm, under-reporting one is the defect this exists to fix.
   */
  __bindingOrigin?: BindingOrigin
  /**
   * INTERNAL — the FUSED MEMBER SET the gesture that is running this body picked (ITEM-35,
   * DEC-D), stamped onto every `set` the body performs, exactly as `__bindingOrigin` is.
   *
   * It rides the ctx for the same reason origin does: a reserved param NAME would leak into
   * the view-spec's `params` vocabulary where a package could collide with it, and the ctx is
   * invisible to that surface. Absent means the pick was unfused — the common case — in which
   * case `set` records no member set and `resolveInputs` binds the single primary id as today.
   * It PROPAGATES into a nested `call_action` (`childCtx` spreads the ctx), so a chain begun by
   * a fused pick carries its members throughout.
   */
  __bindingArtifacts?: readonly string[]
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Resolve the target store for a body run: an explicit `ctx.viewStore` first,
 *  then the module directory (so a widget's bare `runAction(id,{view_id})` with
 *  no ctx still reaches the mounted store). */
function resolveStore(ctx: InterpreterCtx, viewId: string | undefined): InterpreterStore | undefined {
  if (!viewId) return undefined
  return ctx.viewStore?.(viewId) ?? getViewStore(viewId)
}

/** Deep-evaluate an args/`with`/value node: every string leaf is an `evalExpr`
 *  binding, arrays/objects recurse, scalars pass through. */
function evalDeep(node: unknown, scope: Scope): unknown {
  if (typeof node === 'string') return evalExpr(node, scope)
  if (Array.isArray(node)) return node.map(v => evalDeep(v, scope))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = evalDeep(v, scope)
    return out
  }
  return node
}

/** Path segments that would corrupt an object's prototype chain if used as a
 *  `set` field-path key — rejected wherever they appear (interpolated OR literal),
 *  since `ViewStore.set` writes the path via a dotted-key walk. */
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** Resolve a `set` field path: `{expr}` segments are interpolated against the
 *  scope (e.g. `filteringParams.{$params.ident}.{$params.criterion}`); the rest
 *  is a literal dotted path `ViewStore.set` writes into.
 *
 *  A runtime-interpolated segment (`{$params.x}`) is UNTRUSTED (AI/param-supplied),
 *  so it must not inject prototype keys or extra path structure: each interpolated
 *  segment is rejected if it is a forbidden key or contains a `.` (path-structure
 *  injection). The fully-resolved path is then re-checked so no segment (literal or
 *  interpolated) is `__proto__`/`constructor`/`prototype`. */
function resolveFieldPath(path: string, scope: Scope): string {
  const resolved = path.replace(/\{([^}]+)\}/g, (_m, inner: string) => {
    const e = inner.trim()
    const seg = String(evalExpr(e[0] === '$' ? e : `$${e}`, scope))
    if (seg.includes('.')) {
      throw new Error(`[declarative] interpolated set-path segment must not contain '.': "${seg}"`)
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) {
      throw new Error(`[declarative] illegal interpolated set-path segment "${seg}"`)
    }
    return seg
  })
  for (const seg of resolved.split('.')) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) {
      throw new Error(`[declarative] illegal set-path segment "${seg}"`)
    }
  }
  return resolved
}

/** Resolve an `inputs_from` SLOT name: `{expr}` segments are interpolated against the
 *  iteration scope (`"column:{$c.column}"`), the rest is literal.
 *
 *  Deliberately NOT `resolveFieldPath`: that one is a `set` PATH and rejects a `.` in an
 *  interpolated segment because a dot there injects path structure. A slot is an opaque
 *  name, not a path — a metadata column may legitimately be called `a.b` — so the only
 *  rule here is that the result names something. The `{}`-segment FORM is shared so an
 *  author writes one interpolation syntax, not two. The rule itself now lives in `expr.ts`
 *  as `interpolateBraces`, because a SECOND caller appeared (`axis_entry_values`' declared
 *  column names) and a shared form reimplemented per caller is how one syntax comes to mean
 *  two things. */
function resolveSlotName(template: string, scope: Scope): string {
  return interpolateBraces(template, scope)
}

/**
 * Expand the `inputs_from` bindings and MERGE them into the literal `inputs` map.
 *
 * A slot bound twice becomes an ARRAY — the shape `resolveInputs` already expands into one
 * mount per id (a LIST slot). An EXACT duplicate `(slot, artifact)` collapses: two criteria
 * on one column are two criteria, not two mounts of the same artifact.
 *
 * Both failure modes THROW, and that is the point of the construct. A binding whose slot
 * resolves empty, or whose artifact resolves to anything but a non-empty string, is dropped
 * silently by no path here — the run it would produce is the one that keeps every row and
 * reports success. `when` is where an author says an iteration is legitimately not a
 * binding.
 */
function applyInputBindings(
  inputs: Record<string, unknown>,
  bindings: InputBindingSpec[] | undefined,
  scope: Scope,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...inputs }
  for (const binding of bindings ?? []) {
    for (const entry of expandForEach(binding, scope)) {
      if (!evalWhen(binding.when, entry.scope)) continue
      const slot = resolveSlotName(String(binding.slot ?? ''), entry.scope).trim()
      if (!slot) {
        throw new Error(
          `[declarative] run_processor inputs_from: binding "${binding.slot}" resolved to an empty slot name`,
        )
      }
      const artifact = evalExpr(binding.artifact, entry.scope)
      if (typeof artifact !== 'string' || artifact === '') {
        throw new Error(
          `[declarative] run_processor inputs_from: slot "${slot}" has no artifact ` +
            `("${binding.artifact}" resolved to ${JSON.stringify(artifact)}). Gate the binding with ` +
            '`when` if this iteration is legitimately not an input.',
        )
      }
      const prior = out[slot]
      if (prior === undefined) out[slot] = artifact
      else if (Array.isArray(prior)) {
        if (!prior.includes(artifact)) out[slot] = [...prior, artifact]
      } else if (prior !== artifact) out[slot] = [prior, artifact]
    }
  }
  return out
}

/**
 * How each DECLARED input slot came to hold its value — `{ slot → origin }`, for the slots
 * that have one.
 *
 * The origin is read off the **declaration**, not the resolved value. A resolved artifact id
 * says nothing about who chose it, and attributing one back to whichever field auto-bound it
 * would be inferring identity from a value — unsound the moment two slots hold the same
 * artifact, which a project with one compatible candidate makes the COMMON case rather than
 * a corner one.
 *
 * So each slot's declared expression is tokenized by the expression language's own reader
 * ({@link stateRefPaths}), and every `$state`/`$scope` path it names is asked of the store.
 * `auto` wins over `user` across them: a slot fed by an unreviewed reference is unreviewed,
 * and the reviewed half does not launder it.
 *
 * Two absences, both deliberate:
 *  · a slot whose expression names no state — an `inputs_from` binding reads `$data`, a
 *    catalog fact no picker writes — gets no entry. Absent is not `auto` (INV-4).
 *  · a store that cannot answer (`originOf` is optional on the mocked subset) yields nothing
 *    rather than a guess.
 *
 * Only `inputs:` is read, never `inputs_from:`. That is not an omission — an `inputs_from`
 * slot NAME is itself computed per iteration, so there is no declared expression to attribute
 * and nothing a control could have written.
 */
function declaredInputOrigins(
  declared: Record<string, unknown> | undefined,
  store: InterpreterStore | undefined,
): Record<string, BindingOrigin> {
  const out: Record<string, BindingOrigin> = {}
  if (!declared || !store?.originOf) return out
  for (const [slot, expr] of Object.entries(declared)) {
    let origin: BindingOrigin | undefined
    for (const path of stateRefPaths(expr)) {
      origin = strongerOrigin(origin, store.originOf(path))
    }
    if (origin) out[slot] = origin
  }
  return out
}

/**
 * The FUSED MEMBER SET behind each DECLARED input slot — `{ slot → [id, …] }`, for the slots
 * whose declared expression names a state path a fused pick wrote (ITEM-35, DEC-D).
 *
 * Read off the DECLARATION, exactly as {@link declaredInputOrigins} is, and for the same
 * reason: a resolved artifact id says nothing about which pick produced it, so each slot's
 * declared expression is tokenized by the expression language's own reader ({@link
 * stateRefPaths}) and every `$state`/`$scope` path it names is asked of the store's
 * `artifactsOf`. Every path that carries a set is UNIONED (deduped, in path order) — a valid
 * `inputs:` expression names exactly one clean `$`-ref (the language refuses `a and b`), so this
 * is single-path in practice; the union is defensive, and it errs toward INCLUDING a member
 * rather than dropping one (the same direction the mixed-multi-select fix took) if a slot ever
 * legitimately combines two fused picker fields.
 *
 * Two absences, both deliberate and both INV-4: a slot whose expression names no fused path
 * gets no entry (absent is not "empty set"), and a store that cannot answer (`artifactsOf`
 * optional on the mocked subset) yields nothing rather than a guess. `inputs_from:` is not read
 * — a data-named slot has no declared expression a picker could have written.
 */
function declaredInputArtifacts(
  declared: Record<string, unknown> | undefined,
  store: InterpreterStore | undefined,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  if (!declared || !store?.artifactsOf) return out
  for (const [slot, expr] of Object.entries(declared)) {
    const seen = new Set<string>()
    const merged: string[] = []
    for (const path of stateRefPaths(expr)) {
      for (const id of store.artifactsOf(path) ?? []) {
        if (!seen.has(id)) {
          seen.add(id)
          merged.push(id)
        }
      }
    }
    if (merged.length > 0) out[slot] = merged
  }
  return out
}

/** Read a (dotted) field path off a live state object, refusing to walk the prototype chain
 *  (mirrors `expr.step`'s `BLOCKED_KEYS`). Used by `listAppend`/`listRemove` to read the CURRENT
 *  list before mutating it. A missing intermediate → `undefined`. */
function readStatePath(state: Record<string, unknown>, path: string): unknown {
  let cur: unknown = state
  for (const seg of path.split('.')) {
    if (cur == null) return undefined
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** True iff `el` is an object matching EVERY key/value of `wanted` (`===`). The `listRemove`
 *  `match` drops the first (all) element(s) satisfying this — "remove by id" is `match:{id:…}`. */
function matchesAll(el: unknown, wanted: Record<string, unknown>): boolean {
  if (el == null || typeof el !== 'object') return false
  const rec = el as Record<string, unknown>
  return Object.entries(wanted).every(([k, v]) => rec[k] === v)
}

/**
 * Does a `set` VALUE name any of the fused member ids? (ITEM-35, DEC-D.)
 *
 * The member set is VALUE-specific — it describes the fused pick — whereas `origin` is
 * gesture-wide. So it must attach ONLY to the field that received the pick, never to a sibling
 * the same gesture also wrote (a fused-pick onChange that also resets a dependent list would
 * otherwise stamp the members onto the reset field, and a run declaring that field would bind
 * artifacts the value there never named). A value NAMES a member when it IS a member id (single
 * select) or CONTAINS one (multi select); a reset to `[]`/`null`/an unrelated id names none.
 */
function valueNamesArtifact(value: unknown, members: readonly string[]): boolean {
  const set = new Set(members)
  if (typeof value === 'string') return set.has(value)
  if (Array.isArray(value)) return value.some(v => typeof v === 'string' && set.has(v))
  return false
}

/** Interpret ONE effect. `bag` accumulates `into:` results as top-level scope
 *  vars (so a later effect can reference `$saveJob`). */
async function interpretEffect(
  effect: EffectSpec,
  scope: Scope,
  ctx: InterpreterCtx,
  store: InterpreterStore | undefined,
  bag: Record<string, unknown>,
  origin: BindingOrigin | undefined,
  artifacts: readonly string[] | undefined,
): Promise<void> {
  if ('set' in effect) {
    if (!store) throw new Error('[declarative] `set` effect has no live view store to write to')
    for (const [rawPath, rawValue] of Object.entries(effect.set)) {
      // `origin` is the BODY's, not this effect's: it says how the gesture that ran this
      // action chose its value, and one gesture writes one origin however many fields it
      // touches. `undefined` reaches `set` as its `'user'` default (INV-5) — the only way
      // to record `auto` is for the dispatching control to have said so.
      const val = evalDeep(rawValue, scope)
      // `artifacts` (ITEM-35, DEC-D) rides the SAME gesture channel but, UNLIKE origin, is
      // VALUE-specific: it attaches only to the field whose value actually names a member (the
      // fused pick), never to a sibling the gesture also wrote (a dependent reset). `undefined`
      // on every unfused gesture — the common case — so the store records no set and binds the
      // single value.
      const carries =
        !!artifacts && artifacts.length > 0 && valueNamesArtifact(val, artifacts) ? artifacts : undefined
      store.set(resolveFieldPath(rawPath, scope), val, origin, carries)
    }
    return
  }
  if ('api' in effect) {
    if (!ctx.api) throw new Error('[declarative] `api` effect used but ctx.api is not wired')
    const { call, args, into } = effect.api
    const res = await ctx.api(call, asRecord(evalDeep(args ?? {}, scope)))
    if (into) bag[into] = res
    return
  }
  if ('run_processor' in effect) {
    if (!ctx.runProcessor)
      throw new Error('[declarative] `run_processor` effect used but ctx.runProcessor is not wired')
    const { id, inputs, inputs_from, params, into } = effect.run_processor
    // `inputs` travels as its OWN argument. It was being dropped here — destructuring took
    // only `{ id, params, into }` — so both shipped views' explicit `inputs:` blocks reached
    // nothing, and the host was left inferring run inputs from the params bag.
    //
    // `inputs_from` merges into that SAME map before it leaves: the host binds one channel,
    // and a data-named slot is indistinguishable downstream from a literal one (it is a
    // slot; where its name came from is this layer's business, not the launcher's).
    const res = await ctx.runProcessor(
      id,
      asRecord(evalDeep(params ?? {}, scope)),
      applyInputBindings(asRecord(evalDeep(inputs ?? {}, scope)), inputs_from, scope),
      // Derived from the DECLARATION, beside the evaluation that reads the same block, so
      // the two cannot come to disagree about which slot read which state.
      declaredInputOrigins(inputs as Record<string, unknown> | undefined, store),
      // The member sets, from the SAME declaration + store (ITEM-35, DEC-D). A slot bound to a
      // fused pick carries its full set here; every other slot carries nothing and binds as before.
      declaredInputArtifacts(inputs as Record<string, unknown> | undefined, store),
    )
    if (into) bag[into] = res
    return
  }
  if ('wait_for' in effect) {
    if (!ctx.waitFor)
      throw new Error('[declarative] `wait_for` effect used but ctx.waitFor is not wired')
    await ctx.waitFor(evalExpr(effect.wait_for.job, scope), effect.wait_for.until)
    return
  }
  if ('progress' in effect) {
    ctx.progress(String(evalExpr(effect.progress, scope)))
    return
  }
  if ('toast' in effect) {
    const msg =
      typeof effect.toast === 'string'
        ? // Prose that MAY mention `$state`/`$derived` (schema.ts treats a string toast as a
          // message, not a bare ref) — interpolate the refs in place instead of evalExpr-ing the
          // whole string (which would reject the mixed text+`$` as arbitrary code).
          interpolate(effect.toast, scope)
        : (evalDeep(effect.toast, scope) as { success?: string; error?: string })
    if (ctx.toast) ctx.toast(msg)
    else ctx.log('[toast]', msg)
    return
  }
  if ('open_view' in effect) {
    if (!ctx.openView)
      throw new Error('[declarative] `open_view` effect used but ctx.openView is not wired')
    ctx.openView(effect.open_view.view, asRecord(evalDeep(effect.open_view.with ?? {}, scope)))
    return
  }
  if ('close_view' in effect) {
    if (!ctx.closeView)
      throw new Error('[declarative] `close_view` effect used but ctx.closeView is not wired')
    ctx.closeView()
    return
  }
  if ('call_action' in effect) {
    await runAction(effect.call_action.id, asRecord(evalDeep(effect.call_action.params ?? {}, scope)), ctx)
    return
  }
  if ('listAppend' in effect) {
    if (!store) throw new Error('[declarative] `listAppend` effect has no live view store to write to')
    const path = resolveFieldPath(effect.listAppend.path, scope)
    const cur = readStatePath(store.state, path)
    const list = Array.isArray(cur) ? cur.slice() : []
    list.push(evalDeep(effect.listAppend.value, scope))
    store.set(path, list)
    return
  }
  if ('listRemove' in effect) {
    if (!store) throw new Error('[declarative] `listRemove` effect has no live view store to write to')
    const { path: rawPath, index, match } = effect.listRemove
    const path = resolveFieldPath(rawPath, scope)
    const cur = readStatePath(store.state, path)
    if (!Array.isArray(cur)) return // nothing to remove from (no-op, not an error)
    let next: unknown[] = cur
    if (index !== undefined) {
      const idx = Number(evalExpr(index, scope))
      next = cur.filter((_, i) => i !== idx)
    } else if (match && Object.keys(match).length > 0) {
      const wanted = asRecord(evalDeep(match, scope))
      next = cur.filter(el => !matchesAll(el, wanted))
    }
    store.set(path, next)
    return
  }
  // Exhaustive over `EFFECT_OPS`; an unknown op is a spec/validator bug.
  throw new Error(`[declarative] unknown effect op: ${JSON.stringify(Object.keys(effect))}`)
}

/**
 * Interpret a declared action `body` over `ctx`. `params` carry `view_id` (the
 * target instance) plus the action's declared params. The scope exposes
 * `$params` and — via the resolved store — `$state`/`$derived`, plus any `into:`
 * results as top-level `$<name>` vars. Effects run in order (async-aware so
 * `api`/`run_processor`/`wait_for` sequence correctly).
 */
/** Max `call_action` nesting before we assume a cycle (A→B→A) and bail instead
 *  of overflowing the stack. */
const MAX_CALL_ACTION_DEPTH = 24

export async function interpretBody(
  body: EffectSpec[],
  params: Record<string, unknown> | undefined,
  ctx: InterpreterCtx,
): Promise<Record<string, unknown>> {
  const depth = typeof ctx.__declDepth === 'number' ? ctx.__declDepth : 0
  if (depth > MAX_CALL_ACTION_DEPTH) {
    throw new Error(
      `[declarative] call_action recursion too deep (>${MAX_CALL_ACTION_DEPTH}); possible A→B→A cycle`,
    )
  }
  // Threaded through nested `call_action` runs so the guard above trips on a cycle.
  const childCtx: InterpreterCtx = { ...ctx, __declDepth: depth + 1 }
  const p = params ?? {}
  const viewId = typeof p.view_id === 'string' ? p.view_id : undefined
  const store = resolveStore(ctx, viewId)
  const bag: Record<string, unknown> = {}
  for (const effect of body ?? []) {
    // Rebuild the scope EACH step so a `set`-then-read observes the LIVE store
    // (`store.state`/`store.derived` are getters over the current value): a later
    // effect in the same body sees the mutation an earlier `set` made, not a stale
    // pre-set snapshot. `into:` results live at the scope root (`$saveJob`).
    // `$data` is in scope for the SAME reason `$state`/`$derived` are: a body that launches
    // a run has to be able to name what the form resolved. It was absent, which is why the
    // only inputs a view could pass were ones it had first copied into `state` — fine for a
    // control's value, impossible for a catalog fact the user never picks (which artifact a
    // column lives in). Additive: no shipped body referenced `$data` before, so nothing
    // resolves differently.
    const scope: Scope = {
      params: p,
      state: store?.state ?? {},
      derived: store?.derived ?? {},
      data: store?.data ?? {},
      ...bag,
    }
    await interpretEffect(effect, scope, childCtx, store, bag, ctx.__bindingOrigin, ctx.__bindingArtifacts)
  }
  return bag
}

/** Build a permissive zod schema for a declared action's params. `view_id` is
 *  always required (the instance target, ARCHITECTURE.md Layer 4); the declared
 *  keys are accepted loosely (the view_spec `params` vocabulary is informal —
 *  the app validates SHAPE, not exhaustively) plus a catch-all for extras. */
function paramsSchema(declared: Record<string, unknown> | undefined): z.ZodType {
  const shape: Record<string, z.ZodType> = { view_id: z.string() }
  for (const key of Object.keys(declared ?? {})) {
    if (key === 'view_id') continue
    shape[key] = z.unknown().optional()
  }
  return z.object(shape).catchall(z.unknown())
}

/** Guard so a re-mount of the same view doesn't attempt to re-register (the
 *  live `defineAction` registry dup-THROWS — DEC-6 idempotency). */
const registeredSpecs = new Set<string>()

/**
 * Register every action a `view_spec` declares (plus its synthesized
 * `<view>.describe`, ITEM-11) into the live `defineAction` registry. Ids are
 * namespaced by the view id (`${spec.id}::${action.id}`, `ids.ts`). IDEMPOTENT:
 * a second call for the same spec id is a no-op, and any individual id already
 * present is skipped — so a component re-mount never triggers the registry's
 * duplicate-id throw.
 */

// ── the LAUNCH descriptor of an action (the duplicate-run guard's input) ─────────────
//
// A Run button knows the id of the action it dispatches and nothing else — not that the action
// launches anything, and certainly not with what. The guard needs both, at RENDER time, so the
// control can be disabled BEFORE the second click rather than refusing after it.
//
// So registration records what each action would launch. The alternative — re-parsing the view
// spec in the render layer — puts a second reader on the same declaration, which is the shape
// this repo keeps paying for.
interface LaunchDescriptor {
  analysisId: string
  inputs?: Record<string, unknown>
  inputs_from?: InputBindingSpec[]
  params?: Record<string, unknown>
}

const launchByAction = new Map<string, LaunchDescriptor>()

/** The first `run_processor` an action body performs, if any. First rather than all: the
 *  identity is about the run a click SUBMITS, and a body that launches twice is not a shape any
 *  shipped view has — if one appears, it needs a decision, not a silent pick of the last. */
function launchDescriptorOf(body: EffectSpec[] | undefined): LaunchDescriptor | undefined {
  for (const effect of body ?? []) {
    if ('run_processor' in effect) {
      const rp = effect.run_processor
      return {
        analysisId: rp.id,
        inputs: rp.inputs as Record<string, unknown> | undefined,
        inputs_from: rp.inputs_from,
        params: rp.params as Record<string, unknown> | undefined,
      }
    }
  }
  return undefined
}

/**
 * The identity the action would submit RIGHT NOW, given the form's current scope — or
 * `undefined` when the action launches nothing, OR when the form is in a state that could not
 * be submitted at all.
 *
 * It evaluates the same declarations through the same helpers the launch itself uses, so the
 * guard cannot disagree with what would actually be sent. A separately-derived "what we think
 * this would submit" is how a guard starts firing on the wrong thing.
 *
 * TOTAL, and that is not a softening of the launch's own rules. Those helpers THROW on an
 * unsubmittable form — an `inputs_from` binding that passes its `when` and resolves to no
 * artifact is exactly the silent keep-everything run they exist to refuse — and this function
 * is called from RENDER (`WidgetHost`'s `actionBlockedReason`, on every repaint), where a throw
 * escapes into the widget error boundary and replaces the Run control with "failed to render".
 * That is a real, reachable state: a criterion whose column the currently selected dataset does
 * not carry makes its binding unresolvable, and it costs the user the very control that would
 * have told them so.
 *
 * `undefined` is the honest answer rather than a swallow: this identity has ONE consumer, the
 * "an identical launch is already in the air" guard, and a submission that cannot be built
 * matches nothing in flight. The refusal itself stays where it belongs — on the launch path,
 * loud, at the moment a run would otherwise start.
 */
export function launchIdentityForAction(namespacedActionId: string, scope: Scope): string | undefined {
  const d = launchByAction.get(namespacedActionId)
  if (!d) return undefined
  try {
    const inputs = applyInputBindings(asRecord(evalDeep(d.inputs ?? {}, scope)), d.inputs_from, scope)
    return launchIdentity(d.analysisId, inputs, asRecord(evalDeep(d.params ?? {}, scope)))
  } catch {
    return undefined
  }
}

/** Test-only: the registry is module-level and survives between cases. */
export function __resetLaunchDescriptorsForTests(): void {
  launchByAction.clear()
}

export function registerViewSpecActions(spec: ViewSpec): void {
  if (registeredSpecs.has(spec.id)) return
  for (const action of spec.actions ?? []) {
    const id = namespaceActionId(spec.id, action.id)
    if (getActionMeta(id)) continue
    defineAction({
      id,
      title: action.title,
      permission: action.permission,
      mutating: action.mutating ?? false,
      kind: 'instance',
      stateful: action.stateful ?? false,
      surfaces: action.surfaces,
      params: paramsSchema(action.params),
      run: (p, ctx) => interpretBody((action as ActionSpec).body, p as Record<string, unknown>, ctx as InterpreterCtx),
    })
    // Recorded even when the action launches nothing (the lookup simply misses), so a view that
    // gains a `run_processor` later needs no second edit here.
    const launch = launchDescriptorOf((action as ActionSpec).body)
    if (launch) launchByAction.set(id, launch)
  }
  const describe = synthesizeDescribeAction(spec)
  if (!getActionMeta(describe.id)) defineAction(describe)
  registeredSpecs.add(spec.id)
  // Tell the backend what this session can now be asked to do. THIS is the
  // moment the real set is known, which is why the projection lives on this
  // side (see `capabilityReport.ts`); the server stores what it is given rather
  // than re-parsing the spec with a second, partial schema of its own.
  //
  // Reported only for ids the registry ACTUALLY holds: `runAction` resolving
  // the id is exactly the invokability predicate the catalog is claiming, so a
  // projected entry whose registration was skipped (a foreign spec already owns
  // that id) must not be advertised.
  publishCapabilities(
    projectViewSpecCapabilities(spec).filter(capability => getActionMeta(capability.id)),
  )
}

/** Test-only reset of the per-spec idempotency guard (the underlying
 *  `defineAction` registry has no reset, so tests use unique spec ids; this
 *  only clears the "already processed this spec" bookkeeping). */
export function __resetRegisteredSpecsForTests(): void {
  registeredSpecs.clear()
}
