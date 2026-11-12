// The marker distinguishing a PARSE-TIME (schema-only) chart descriptor from the full,
// render-capable one. Its own module so `registry/registry.ts` and `charts/chartSchemas.ts`
// can both reference it without a cycle.
//
// A schema-only descriptor carries the real `bindingSchema` / `capabilities` / `model` — i.e.
// everything `option/parse.ts` reads — but a PLACEHOLDER `view`, so registering it costs no
// chart View and no deck.gl. `installBuiltins()` later replaces it with the render-capable
// descriptor. That replacement is EXPECTED, so `registerChartType` does not warn about it
// (it still warns for a genuine double-registration, which is the case the warning is for).

/** Set on a descriptor registered by `installBuiltinSchemas()`. */
export const SCHEMA_ONLY_DESCRIPTOR = Symbol.for('@txresbench/viz.schemaOnlyDescriptor')

/** Whether `desc` is a parse-time placeholder awaiting its render-capable upgrade. */
export function isSchemaOnly(desc: object | undefined): boolean {
  return Boolean(desc && (desc as Record<symbol, unknown>)[SCHEMA_ONLY_DESCRIPTOR])
}
