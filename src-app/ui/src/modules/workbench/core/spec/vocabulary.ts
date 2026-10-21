// The declarative `view_spec` VOCABULARY (ITEM-3) — the two CLOSED-BY-CONSTRUCTION
// name sets the parser/validator in this same directory enforces.
//
// These used to live in `core/manifest/viewSpec.ts`, one package away from the
// `parseViewSpec` that is their only enforcement point. A vocabulary and its
// validator in different places is exactly the drift this round closes: the
// contract TYPES stay in `manifest/viewSpec.ts` (pure, dependency-free, shared
// with the backend serde), and the enforced NAME SETS live here, beside
// `./schema.ts`.
//
// DEC-A — kinds OPEN, effects CLOSED. Rendering is not privilege escalation;
// ACTING is:
//   · `WIDGET_KINDS` is the set of FORM-CONTROL kinds the CORE engine ships. It is
//     no longer the whole renderable universe: an extension registers its own kinds
//     through the ordinary `registerWidget` path (`extensions/canvas` owns the plot
//     kinds), so `registeredWidgetKinds()` is a SUPERSET of this list. The schema
//     validator still rejects a `kind` it does not know, which now means "core kind
//     or a registered extension kind".
//   · `EFFECT_OPS` stays EQUALITY-CLOSED. A processor UI can never ship executable
//     code — every verb it can express is an app-reviewed variant of `EffectSpec`.
//     Do not widen this to a registration seam.

/** The FORM-CONTROL widget `kind`s the core engine renders. Plot kinds are OWNED
 *  and registered by the canvas extension (`extensions/canvas/installCanvasWidgets`),
 *  not listed here (ITEM-36). */
export const WIDGET_KINDS = [
  'select',
  'text',
  'multiselect',
  'range_slider',
  'list-editor',
  // A generic TAB/segmented group (mode-switch) + a generic TOKEN/chip input — DOMAIN-FREE
  // core form controls (a tab is a tab, a token is a token; the domain lives in package views).
  'tabs',
  'token-input',
  'table',
  'button',
  'alert',
  'stat',
  'group',
  'dataset-picker',
  // The VISIBLE form of an analysis input (ITEM-7). A core form control, not an extension
  // kind: an input the run consumes has to be part of the vocabulary every declarative
  // view can express, or the only way to supply one is the invisible auto-resolution
  // INV-4 removes.
  'artifact_ref',
] as const
export type WidgetKind = (typeof WIDGET_KINDS)[number]

/** The op keys an `EffectSpec` may carry — a CLOSED vocabulary (the trust
 *  boundary). Exported so the interpreter + the validator guard against drift. */
/**
 * The keys a `require:` block may carry — a CLOSED vocabulary, for the same reason
 * `EFFECT_OPS` is closed and NOT for the reason `WIDGET_KINDS` is open.
 *
 * A constraint is a machine-checked claim about what the RUN will accept, so it sits on
 * the ACTING side of DEC-A's line. Closing it is also the direct answer to the failure
 * this construct replaces: the only gate a form had was one hand-written boolean string
 * per form, and its failures were SILENT — a predicate that reads correctly and never
 * fires. An author who cannot write a free-form predicate can never write one that
 * quietly means nothing.
 *
 * `message` is the one entry that is not a constraint: it is the authored SENTENCE that
 * replaces the engine's default. It lives in the same closed set so an author gets the
 * same "unknown key" refusal for a typo in it.
 *
 * Do not widen this to a registration seam. A sixth constraint is an app change with a
 * real second user.
 */
export const REQUIRE_KEYS = [
  'required',
  'min_items',
  'max_items',
  'number',
  'unique_by',
  'not_in',
  'message',
] as const
export type RequireKey = (typeof REQUIRE_KEYS)[number]

/** The constraints a `require.message` MAP may address — `REQUIRE_KEYS` minus `message`
 *  itself, which is the copy rather than a claim about the value. */
export const REQUIRE_CONSTRAINT_KEYS = REQUIRE_KEYS.filter(k => k !== 'message') as ReadonlyArray<
  Exclude<RequireKey, 'message'>
>

/** The keys a `require.number` block may carry — closed for the same reason. */
export const NUMBER_REQUIRE_KEYS = ['min', 'max', 'integer'] as const
export type NumberRequireKey = (typeof NUMBER_REQUIRE_KEYS)[number]

export const EFFECT_OPS = [
  'set',
  'api',
  'run_processor',
  'wait_for',
  'progress',
  'toast',
  'open_view',
  'close_view',
  'call_action',
  // Dynamic-list mutation (DEC-9).
  'listAppend',
  'listRemove',
] as const
export type EffectOp = (typeof EFFECT_OPS)[number]
