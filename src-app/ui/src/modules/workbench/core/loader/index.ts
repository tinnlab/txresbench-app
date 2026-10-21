// The `@/modules/workbench/core/loader` — the package-owned, pure discovery helpers
// the FE host wires to `import.meta.glob` (ITEM-21).
export type { DiscoverableManifest } from './topoSort.ts'
export { topoSortByDependencies, DependencyCycleError } from './topoSort.ts'
