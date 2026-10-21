// Built-in discovery ordering (ITEM-21, the package-owned pure half). The FE
// host globs `extension.ts` modules (`import.meta.glob`) and hands their
// manifests here to order them by declared `dependencies` before side-effect-
// importing each built-in's registration — the exact `modules/loader.ts` topo-
// sort, extracted so it is unit-testable without the vite glob. Tolerates a
// ZERO-extension set (a fresh tree) and detects dependency cycles.

export interface DiscoverableManifest {
  id: string
  dependencies?: string[]
}

export class DependencyCycleError extends Error {
  readonly cycle: string[]
  constructor(cycle: string[]) {
    super(`extension dependency cycle: ${cycle.join(' → ')}`)
    this.name = 'DependencyCycleError'
    this.cycle = cycle
  }
}

/**
 * Topologically order built-ins so a dependency loads before its dependents.
 * Deterministic (id-sorted at each frontier). Throws `DependencyCycleError` on a
 * cycle. An unknown dependency id is ignored (an external/not-yet-present dep is
 * not fatal for a built-in set — it simply doesn't constrain ordering).
 */
export function topoSortByDependencies<M extends DiscoverableManifest>(manifests: M[]): M[] {
  const byId = new Map<string, M>()
  for (const m of manifests) byId.set(m.id, m)

  const result: M[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (id: string) => {
    const st = state.get(id)
    if (st === 'done') return
    if (st === 'visiting') {
      const from = stack.indexOf(id)
      throw new DependencyCycleError([...stack.slice(from), id])
    }
    const m = byId.get(id)
    if (!m) return // unknown/external dependency — does not constrain ordering
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of [...(m.dependencies ?? [])].sort()) visit(dep)
    stack.pop()
    state.set(id, 'done')
    result.push(m)
  }

  for (const id of [...byId.keys()].sort()) visit(id)
  return result
}
