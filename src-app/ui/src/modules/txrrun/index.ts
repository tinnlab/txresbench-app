/**
 * txrrun public surface.
 *
 * The barrel is the module's only public entry for the cross-module seams
 * this node owns: the path builders (PROV-UI-RUN-1) — screen K
 * (`ui-history`) binds `runningPath` to reopen a running run, and the
 * intake flow navigates to `chooseMethodsPath()`; neither spells a URL
 * literal. The module's stores, components and pages are internal.
 */
export * from './routes'
