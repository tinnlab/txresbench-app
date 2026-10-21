// The `@/modules/workbench/core/form` — the params/artifact-ref/host-widget-slot
// schema TYPES only (A3: the SchemaForm renderer is P6's host panel).
export type {
  ParamsSchema,
  ParamField,
  ScalarField,
  NumberField,
  EnumField,
  BooleanField,
  StringField,
  ArrayField,
  ArtifactRefField,
  WidgetField,
  GatingContext,
  OptionsResolver,
  AcceptsResolver,
} from './schema-types.ts'
export {
  isArtifactRefField,
  isWidgetField,
  isScalarField,
  artifactRefFields,
  isFieldVisible,
  visibleFields,
  isFieldFilled,
  pruneHiddenParams,
} from './schema-types.ts'
// ITEM-52 — the widget-value submit-gate contract (a widget embeds its own verdict).
export type { SubmitGate, WidgetGateValue } from './gate.ts'
export { readWidgetGate } from './gate.ts'
// declarative-form-validation — the form-validity CONTRACT (the verdict shapes, the
// address vocabulary, the display rule, the channel). A widget renderer lives in the
// extensions layer and may reach core only through the public barrel, and it needs the
// ADDRESS vocabulary: a per-row control looks its own verdict up under the key the engine
// filed it under, and a second spelling of that key is a message that lands nowhere.
//
// `./validity.ts` — the WALKER that produces one — is deliberately NOT here. It resolves an
// `artifact_ref`'s candidate set to answer "is this requirement satisfiable at all", which
// reaches a subtree the `node --test --experimental-strip-types` runner that pins this
// barrel cannot parse. Same structural un-barrel-ability the `artifact_ref` RENDERER has,
// answered the same way: its consumers (core's own render layer) import it by path.
export type { FieldVerdict, FormValidity, RequirementLine, ViolationKind } from './validityContract.ts'
// `FORM_VALIDITY_SCOPE_KEY` is deliberately NOT here, on the rule `core/index.ts` already
// states for its two siblings: `CATALOG_SCOPE_KEY` and `VALUE_PREVIEW_SCOPE_KEY` are withheld
// because a render-scope CHANNEL has "no consumer outside core, and exporting it here would add
// public surface nothing asks for." This key meets that description exactly — every consumer,
// production and test, is inside core — and it is redundant with `readFormValidity` below, which
// is the sanctioned accessor. Exporting both would let a consumer bypass the type guard and
// index the scope directly, which is the thing the accessor exists to prevent.
export {
  SUMMARY_LEAD,
  SUMMARY_LIMIT,
  instanceKey,
  partKey,
  readFormValidity,
  shouldShow,
} from './validityContract.ts'
// ITEM-64 — data-driven defaults + the MAD helper (additive; FE-runtime resolvers).
export type { ColumnStats, DataSummary, DataDrivenDefaultResolver } from './defaults.ts'
export {
  statsOf,
  columnStats,
  buildDataSummary,
  madThreshold,
  madResolver,
  resolveDataDrivenDefault,
} from './defaults.ts'
