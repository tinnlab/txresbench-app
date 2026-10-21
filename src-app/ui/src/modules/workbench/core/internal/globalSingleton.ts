// A process-wide singleton pinned on `globalThis` (audit CONC-2/3/4). The
// contribution registry, the DSL-operator registry, and the view-kind registry
// are ALL cross-module shared state; under Vite HMR or a duplicated package
// instance a plain module-level `const` diverges (one instance's writes are
// invisible to another). Pinning every such singleton to a single `globalThis`
// key gives them ONE identity across instances — consistently, instead of only
// the contribution registry being guarded.

export function globalSingleton<T>(key: string, factory: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>
  const existing = g[key]
  if (existing !== undefined) return existing
  const created = factory()
  g[key] = created
  return created
}
