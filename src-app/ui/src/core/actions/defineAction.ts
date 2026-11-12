import type { z } from 'zod'
import { createActionContext, type ActionContext } from './ctx'

// AI-controllable actions — the action primitive (slice 1 GLOBAL-only,
// extended by slice 3 / ITEM-4 with the INSTANCE variant).
//
// See `docs/ai-controllable-actions/ARCHITECTURE.md` (Layers 1 + 4) and
// `.lifecycle/ai-actions/{PLAN,DECISIONS}.md` for the authoritative shape. An
// action is declared once via `defineAction` and is drivable by a human
// (button / command palette) AND by the AI agent engine (`./engine.ts`) via
// the SAME `runAction(id, params, ctx)` call — no duplicated orchestration.
//
// `kind: 'global'` (the default, slice-1 back-compat) is invoked directly by
// id. `kind: 'instance'` addresses ONE live, mounted UI instance (a
// `view_id`) — reached at runtime via `ctx.instance(storeKey, view_id)` /
// `ctx.instances(storeKey)`, backed by the instance registry a component
// joins via `./useAction` (`./instanceRegistry.ts`). A `mutating: true,
// stateful: true` instance action additionally requires a valid `expected`
// state-token (ARCHITECTURE.md Layer 6) — the engine enforces this BEFORE
// calling `run` (see `./engine.ts`'s `handleInvoke`), never the action author.

/** Statically-extractable action metadata (what the manifest collector
 *  reads — `scripts/collect-actions.mjs`). */
export interface ActionMeta {
  id: string
  title: string
  /** Permission string required to invoke this action. MANDATORY — every
   *  action must declare one (Layer 5: backend is authoritative for
   *  frontend actions; this is recorded for the manifest + as
   *  defense-in-depth documentation, never the enforcement point). */
  permission: string
  mutating: boolean
  /** `'global'` (default) — invoked directly by id, no runtime target.
   *  `'instance'` — addresses one live, mounted `view_id` (ARCHITECTURE.md
   *  Layer 4); reached via `ctx.instance`/`ctx.instances`, never registered
   *  per-instance (the `defineAction` id stays global + permissioned; only
   *  the TARGET is a runtime param). */
  kind: 'global' | 'instance'
  /** Only meaningful when `kind === 'instance'`. When `true` together with
   *  `mutating`, invoking this action requires a valid `expected` state
   *  token (ARCHITECTURE.md Layer 6 — the read-before-write / stale-state
   *  guard); the engine rejects a missing (`READ_REQUIRED`) or stale
   *  (`STALE_STATE`) token before ever calling `run`. Always `false` for a
   *  `kind: 'global'` action. */
  stateful: boolean
  /** Marks a DESTRUCTIVE / hard-to-undo action (e.g. `project.delete`).
   *  Defaults to `false`. A human-facing surface driving this action (the
   *  command palette) must interpose a confirmation step before actually
   *  invoking it — mirroring the confirm dialog every other destructive
   *  affordance in the app already requires (e.g. `ProjectCard.tsx`'s delete
   *  button). Advisory only for the AI agent path (`./engine.ts`) — the
   *  backend permission model is the real enforcement boundary there; this
   *  flag exists purely to keep the palette's launcher UX from being MORE
   *  permissive than the app's other destructive-action affordances. */
  dangerous: boolean
  /** Which SURFACES may offer this action (PLAN.md ITEM-1). Defaults to
   *  `{palette:true, ai:true}` — an action opts OUT of a surface by setting
   *  its flag `false` (e.g. `surfaces:{palette:false}` keeps it AI-drivable
   *  but hides it from ⌘K; `surfaces:{ai:false}` keeps it in the palette but
   *  excludes it from the AI capability manifest, so the collector drops it —
   *  `scripts/collect-actions.mjs`). Purely additive: every existing action
   *  keeps both surfaces on. */
  surfaces: { palette: boolean; ai: boolean }
  /** The page CONTEXT that must be ACTIVE for this action to be offered
   *  (palette, `CommandPalette.tsx`) / invokable (AI engine, `./engine.ts`'s
   *  `checkContextGuard`). `'global'` (the default) = always available,
   *  everywhere. A non-`'global'` context (e.g. `'workbench'`, `'dataset'`)
   *  is active only while a surface has declared it via `useActiveContext`
   *  (`./activeContext.ts`); composes with `kind:'instance'` (the palette
   *  offers a context-scoped instance action against the active focused
   *  instance). */
  context: string
  // ── Discoverability metadata (richer-actions ITEM-1). All STATIC literals so
  //    the collector (`scripts/collect-actions.mjs`) can extract them into the AI
  //    manifest; every field is independently defaulted (the `surfaces` precedent),
  //    so every pre-existing `defineAction` keeps its meta byte-identical.
  /** Display GROUP for the "<Group> > <Title>" breadcrumb + palette grouping.
   *  `undefined` when omitted — a consumer falls back to its own category
   *  derivation (the global palette's `categoryFor`). Set it explicitly
   *  (`'Datasets'`) to override that fallback. */
  group?: string
  /** ALTERNATIVE names the user might search by ("attach dataset", "import
   *  data") — matched by both palettes + surfaced to the AI. Defaults to `[]`. */
  aliases: string[]
  /** Extra search TOKENS (not shown, only matched). Defaults to `[]`. */
  keywords: string[]
  /** One-line human- + AI-facing description (palette subtitle + manifest hint).
   *  Defaults to `undefined`. */
  description?: string
}

/** The definition passed to `defineAction`. */
export interface ActionDefinition<TParams = unknown, TResult = unknown> {
  id: string
  title: string
  permission: string
  mutating: boolean
  /** Defaults to `'global'` (slice-1 back-compat — every existing
   *  `defineAction` call omits this and keeps working unchanged). */
  kind?: 'global' | 'instance'
  /** Defaults to `false`. Only meaningful for `kind: 'instance'` +
   *  `mutating: true` — see [`ActionMeta.stateful`]. */
  stateful?: boolean
  /** Defaults to `false`. See [`ActionMeta.dangerous`]. */
  dangerous?: boolean
  /** Defaults to `{palette:true, ai:true}` (each flag defaulted
   *  independently, so `surfaces:{palette:false}` still keeps `ai:true`).
   *  See [`ActionMeta.surfaces`]. */
  surfaces?: { palette?: boolean; ai?: boolean }
  /** Defaults to `'global'`. See [`ActionMeta.context`]. */
  context?: string
  /** Defaults to `undefined` (a consumer derives a display group from the id).
   *  See [`ActionMeta.group`]. */
  group?: string
  /** Defaults to `[]`. See [`ActionMeta.aliases`]. */
  aliases?: string[]
  /** Defaults to `[]`. See [`ActionMeta.keywords`]. */
  keywords?: string[]
  /** Defaults to `undefined`. See [`ActionMeta.description`]. */
  description?: string
  /** Zod schema validating `params` at invoke time (also the source the
   *  collector converts to JSON Schema for the manifest). */
  params: z.ZodType<TParams>
  run: (params: TParams, ctx: ActionContext) => Promise<TResult> | TResult
}

interface RegisteredAction {
  meta: ActionMeta
  params: z.ZodType<unknown>
  run: (params: unknown, ctx: ActionContext) => Promise<unknown> | unknown
}

/** Module-level global registry: action id -> {meta, run}. Populated at
 *  module-load time by every `defineAction` call (import the file for its
 *  side effect — see `builtin/appActions.ts` + its import site in
 *  `modules/actions/module.tsx`). */
const registry = new Map<string, RegisteredAction>()

export class ActionAlreadyRegisteredError extends Error {
  constructor(id: string) {
    super(`[actions] duplicate action id: "${id}"`)
    this.name = 'ActionAlreadyRegisteredError'
  }
}

export class ActionNotFoundError extends Error {
  constructor(id: string) {
    super(`[actions] unknown action id: "${id}"`)
    this.name = 'ActionNotFoundError'
  }
}

export class ActionParamsError extends Error {
  constructor(id: string, detail: string) {
    super(`[actions] invalid params for "${id}": ${detail}`)
    this.name = 'ActionParamsError'
  }
}

/**
 * Register a global action. Throws on a duplicate id (fail fast at module
 * load rather than silently letting the second definition win).
 */
export function defineAction<TParams, TResult>(
  def: ActionDefinition<TParams, TResult>,
): ActionDefinition<TParams, TResult> {
  if (registry.has(def.id)) {
    throw new ActionAlreadyRegisteredError(def.id)
  }
  registry.set(def.id, {
    meta: {
      id: def.id,
      title: def.title,
      permission: def.permission,
      mutating: def.mutating,
      kind: def.kind ?? 'global',
      stateful: def.stateful ?? false,
      dangerous: def.dangerous ?? false,
      // Per-field defaulting (NOT `def.surfaces ?? {…}`): a partial
      // `surfaces:{palette:false}` must still default `ai` to `true`, so each
      // flag is defaulted independently — the object analog of the
      // `stateful`/`dangerous` single-field `?? false` above.
      surfaces: {
        palette: def.surfaces?.palette ?? true,
        ai: def.surfaces?.ai ?? true,
      },
      context: def.context ?? 'global',
      group: def.group,
      // Per-field defaulting (arrays independently defaulted, mirroring `surfaces`).
      aliases: def.aliases ?? [],
      keywords: def.keywords ?? [],
      description: def.description,
    },
    params: def.params as z.ZodType<unknown>,
    run: def.run as (params: unknown, ctx: ActionContext) => Promise<unknown> | unknown,
  })
  return def
}

/**
 * Validate `params` against the registered action's zod schema and invoke
 * its `run`. This is the SINGLE call site both the agent engine
 * (`./engine.ts`) and any future human affordance (command palette / button)
 * go through — one implementation, every caller.
 *
 * `ctx` is optional so a caller with no orchestration needs (e.g. a simple
 * human button click that only wants `ctx.navigate`) can omit it; a default
 * context is created via `createActionContext()` (see `./ctx.ts`).
 */
export async function runAction(
  id: string,
  params: unknown,
  ctx?: ActionContext,
): Promise<unknown> {
  const entry = registry.get(id)
  if (!entry) {
    throw new ActionNotFoundError(id)
  }
  const parsed = entry.params.safeParse(params)
  if (!parsed.success) {
    throw new ActionParamsError(id, parsed.error.message)
  }
  return entry.run(parsed.data, ctx ?? createActionContext())
}

/** Read-only view of the registry, for the engine (and any future
 *  introspection / manifest collector). */
export function getActionRegistry(): ReadonlyMap<string, RegisteredAction> {
  return registry
}

/** Look up a single action's metadata (undefined if unregistered). */
export function getActionMeta(id: string): ActionMeta | undefined {
  return registry.get(id)?.meta
}

// ── "already surfaced to the user" marker ────────────────────────────────────
//
// An action that fails MUST both (a) tell the user and (b) reject, so a declared
// body's trailing `toast: {success}` never renders. Generic dispatch sites (e.g.
// the declarative `WidgetHost`) also toast a rejection they receive, precisely so
// a failure is never silent. Both together produced TWO identical error toasts
// for one failure. An action that has already shown the user its own, better
// worded message marks the error; a dispatcher that sees the mark still rejects
// and still logs, it just does not toast a duplicate.
const SURFACED = '__txresbench_action_surfaced__'

/** Mark an error as already reported to the user by the action itself. */
export function markSurfaced<E>(err: E): E {
  if (err && typeof err === 'object') {
    try {
      Object.defineProperty(err, SURFACED, { value: true, enumerable: false })
    } catch {
      // A frozen error object simply keeps the (harmless) duplicate toast.
    }
  }
  return err
}

/** True when the action already showed this failure to the user. */
export function wasSurfaced(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<string, unknown>)[SURFACED] === true
}
