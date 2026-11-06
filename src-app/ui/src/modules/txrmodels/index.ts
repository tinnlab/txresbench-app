/**
 * txrmodels public surface.
 *
 * The barrel is the module's only public entry for the cross-module seams
 * this node owns: the path builders (PROV-UI-MODELS-1) — screen K
 * (`ui-history`) binds `modelsPath(setId)` for its "Made: N models" set
 * links, the I "Use" handoff and the dialog flows navigate with
 * `pretrainedModelsPath()` / `savedModelsPath()` — never a URL literal.
 * The module's stores, components and pages are internal.
 */
export * from './routes'
