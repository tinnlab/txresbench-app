// Built-in extension discovery (ITEM-21, the FE-host wiring half). Globs each
// built-in's `extension.ts` (the `modules/loader.ts` `import.meta.glob` pattern —
// a RELATIVE literal, not `@/`), topo-sorts them by declared `dependencies` via
// the package's pure `topoSortByDependencies`, and side-effect-registers each
// through the public API. The pure ordering + the contribution types live in
// `@/modules/workbench/core`; this file only binds them to vite's glob + the P2
// datatype registry, and exposes a read-only `window.__workbenchRegistry` seam
// for the e2e (the exact `window.__datatypeRegistry` testability pattern).

import {
  workbenchRegistry,
  Registry,
  buildContributionCatalog,
  WORKBENCH_API_VERSION,
  topoSortByDependencies,
  type ExtensionManifest,
  type DatatypeLattice,
} from '@/modules/workbench/core'
import { datatypeRegistry } from '@/core/datatypes'

interface BuiltinModule {
  manifest: ExtensionManifest
  register: () => void
}

/** Adapt P2's `datatypeRegistry` to the workbench-api `DatatypeLattice` seam. */
const lattice: DatatypeLattice = {
  isA: (sub, sup) => datatypeRegistry.isA(sub, sup),
  matches: (id, sel) => datatypeRegistry.matches(id, sel as Parameters<typeof datatypeRegistry.matches>[1]),
  get: id => datatypeRegistry.get(id) as ReturnType<DatatypeLattice['get']>,
}

// The discovered-guard is pinned to globalThis alongside the (globalThis-shared)
// contribution registry it protects, so an HMR reload / duplicate module instance
// doesn't re-run discovery into an already-populated registry (audit CONC-4).
const G_KEY = '__cyto_workbench_discovered__'
function isDiscovered(): boolean {
  return Boolean((globalThis as unknown as Record<string, boolean | undefined>)[G_KEY])
}
function markDiscovered(): void {
  ;(globalThis as unknown as Record<string, boolean | undefined>)[G_KEY] = true
}

/** Discover + register every built-in extension. Idempotent (globalThis-guarded).
 *  The guard is latched only AFTER a successful pass, and the WHOLE body (incl.
 *  the topo-sort, which can throw `DependencyCycleError`) is guarded — so a bad
 *  built-in set is logged and left un-latched, allowing a later retry/HMR to
 *  re-attempt rather than wedging the guard forever (audit ERR-1 + re-audit). A
 *  single failing `register()` is additionally isolated so it can't abort the rest. */
export function discoverBuiltins(): void {
  if (isDiscovered()) return
  try {
    // ONE glob source: `./extensions/*/extension.ts` — the domain-AGNOSTIC app builtins
    // (the hero canvas etc.); these ship no domain datatype id/widget. The directory was
    // `./builtins/` until the core/extensions layering; the glob matched ZERO modules
    // before the move and matches ZERO after (no builtin ships an `extension.ts` yet), so
    // this is the same behaviour aimed at a directory that exists.
    //
    // ITEM-15 removed the second source (`../../processor-packages/*/extension.ts`, the
    // contributed processor FE-CODE packages) together with its only package. It was the
    // last `import.meta.glob` over processor FRONTEND CODE, and a build-time glob is
    // exactly what INV-7 ("loading a processor's frontend requires no app rebuild")
    // forbids. Processor DATA still arrives two ways: the synchronous seed globs in
    // `core/runtime/loadProcessors.ts` (manifest/ui YAML as `?raw` text) and, for a
    // runtime-dropped package, `loadRuntimeProcessors`, which fetches its assets from
    // the server — the rebuild-free leg.
    const mods = import.meta.glob<BuiltinModule>('./extensions/*/extension.ts', { eager: true })
    const entries = Object.values(mods).filter(m => m && m.manifest && typeof m.register === 'function')

    const ordered = topoSortByDependencies(entries.map(e => e.manifest))
    const byId = new Map(entries.map(e => [e.manifest.id, e]))
    for (const m of ordered) {
      try {
        byId.get(m.id)?.register()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[workbench] built-in "${m.id}" failed to register; skipping`, err)
      }
    }
    markDiscovered() // latch only on a clean pass, so a throwing topo-sort can be retried
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[workbench] built-in discovery failed; will retry on next call', err)
  }
}

/**
 * The availability INPUT a no-argument `available`/`catalog` call answers against: the
 * datatype ids the MOUNTED workbench's PROJECT has produced, published by
 * `WorkbenchProvider` onto the sibling `window.__workbench` shell seam. `[]` when no
 * workbench is mounted — nothing produced, so nothing is available, which is the honest
 * answer to a question asked outside a project.
 *
 * ── WHAT THIS REPLACED, AND WHY IT WAS NEVER A DEFENSIBLE DEFAULT ────────────────────
 *
 * It was `datatypeRegistry.all()` — every datatype the DEPLOYMENT KNOWS. That is the
 * LATTICE, not the project, and the two answer different questions: availability asks
 * "does this project HAVE an input for this analysis", and the lattice always contains
 * the input type of every shipped analysis (that is what it means to ship one). So the
 * default made `available` a constant TRUE for every registered analysis, in every
 * project, including an empty one.
 *
 * It read as correct because it never contradicted a POSITIVE assertion: every spec
 * asking "is X available" after seeding X's input got `true`, for the wrong reason. It
 * only surfaced through a NEGATIVE one — `analysis-launcher.spec.ts`'s guard that at
 * least one analysis must stay GATED, so its list-and-explain assertion is not vacuous.
 * With the lattice as the input that set is empty by construction and the guard could
 * never pass. The launcher itself was right throughout (it gates on
 * `WorkbenchContext.producedTypeIds`, i.e. the project's real artifact datatypes); only
 * the seam disagreed with it.
 */
function mountedProducedTypeIds(): string[] {
  const shell = (window as unknown as {
    __workbench?: { producedTypeIds?: () => string[] | null }
  }).__workbench
  return shell?.producedTypeIds?.() ?? []
}

/** Install the read-only `window.__workbenchRegistry` e2e seam. */
export function installWindowSeam(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __workbenchRegistry?: unknown }).__workbenchRegistry = {
    analyses: () => workbenchRegistry.analyses.all().map(a => a.id),
    views: () => workbenchRegistry.views.all().map(v => v.id),
    /** availability of a contribution given the project's currently-produced datatype ids. */
    available: (id: string, typeIds?: string[]) => {
      const c = workbenchRegistry.analyses.get(id)
      if (!c) return false
      return Registry.availability(c, typeIds ?? mountedProducedTypeIds(), lattice)
    },
    /** the MCP metadata projection P9 consumes. */
    catalog: (typeIds?: string[]) =>
      buildContributionCatalog(
        workbenchRegistry,
        { producedTypeIds: typeIds ?? mountedProducedTypeIds(), version: WORKBENCH_API_VERSION },
        lattice,
      ),
    version: WORKBENCH_API_VERSION,
  }
}
