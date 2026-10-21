// The capability BROKER contract (ITEM-6) — the seam through which one extension
// offers a typed surface and another consumes it, routed BY ID ONLY.
//
// INV-6 — core must not name or type ANY specific capability. Everything in this
// directory is parameterised by an opaque `id` string and a generic payload type;
// the CONTRACT for each id is exported by the extension that PUBLISHES it (the
// VS Code `extension.exports` + ambient-`.d.ts` pattern). Core is the postal
// service, not the correspondent.
//
// Mirrors the existing `registerViewComponent` / `registerChartType` /
// `registerWidget` idiom: an id → implementation map, idempotent, typed.

/** Why a lookup came back ABSENT. Absence is a VALUE, never a throw — a consumer
 *  that can degrade simply degrades. */
export type AbsentReason =
  /** nothing has ever been published under this id. */
  | 'not-published'
  /** something IS published under this id, but outside the requested range. */
  | 'out-of-range'

/** The result of a lookup: a discriminated union so the absent branch is
 *  unavoidable at the type level (no `undefined`-punning, no throw). */
export type CapabilityLookup<T> =
  | { present: true; version: string; value: T }
  | { present: false; reason: AbsentReason; publishedVersion?: string }

/** The broker itself. `publish`/`resolve` are the whole surface; `has`/`ids` are
 *  introspection for diagnostics + tests. */
export interface CapabilityBroker {
  /**
   * Offer `impl` under `id` at `version` (a semver the consumer range-matches).
   * IDEMPOTENT: re-publishing the exact same `(version, impl)` is a silent no-op
   * (module re-evaluation / HMR / a double install); re-publishing anything else
   * under an already-taken id WARNS and keeps the FIRST registration, so a late
   * publisher can never silently swap the surface out from under a consumer.
   */
  publish<T>(id: string, version: string, impl: T): void
  /**
   * Look `id` up, optionally constrained to a semver `range` (the
   * `isApiVersionCompatible` grammar: `^1.2`, `1.x`, `>=1.0 <2.0.0`, exact).
   * A published version outside `range` resolves ABSENT (`out-of-range`).
   */
  resolve<T>(id: string, range?: string): CapabilityLookup<T>
  /** Is anything published under `id` (version-agnostic)? */
  has(id: string): boolean
  /** Every published id, in publish order. */
  ids(): string[]
}

/** A late-bound factory for a builtin's implementation. Registered by the module
 *  that OWNS the id; instantiated once per host bundle by `createWorkbenchApi`.
 *  `TCtx` is the host bundle (opaque here — core does not inspect it). */
export type CapabilityFactory<TCtx = unknown> = (ctx: TCtx) => unknown

/** One registered factory: `{id, version, create}` — the DECLARATION half of a
 *  publish, so core can instantiate builtins without naming any of them. */
export interface CapabilityProvider<TCtx = unknown> {
  id: string
  version: string
  create: CapabilityFactory<TCtx>
}
