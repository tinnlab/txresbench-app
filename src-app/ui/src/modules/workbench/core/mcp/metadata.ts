// The per-contribution MCP metadata surface + the `ContributionCatalog`
// projection (A4 / ITEM-18). **P9 OWNS the registry→MCP tools/resources
// GENERATOR** (the safety→annotation mapping, the denylist, the per-project MCP
// server + JWT/approval wiring). P5's job here is to (a) DECLARE the LLM-facing
// metadata (already on `Contribution`, §0.4.2) and (b) expose a stable,
// backend-readable PROJECTION P9's generator ingests — the `ContributionCatalog`
// (analogous to `txresbench-control-mcp`'s `Operation` catalog, but sourced from the
// contribution registry instead of OpenAPI). P9's future `init_from_registry`
// consumes THIS shape (it does not exist yet — verified — so P5 defines it forward).

import type { Contributions } from '../contributions/workbenchRegistry.ts'
import type { Contribution, Safety } from '../contributions/types.ts'
import { defaultSafety } from '../contributions/types.ts'
import type { DatatypeLattice } from '../datatypes/lattice.ts'
import type { WhenContext } from '../datatypes/when.ts'
import { computeAvailability } from '../contributions/availability.ts'

/** The projected MCP metadata for one contribution — the generator's input row. */
export interface ContributionCatalogEntry {
  /** the contribution id → the MCP tool/resource id. */
  id: string
  /** the projected surface kind (the generator maps these → tools vs resources). */
  kind: 'analysis'
  title: string
  description: string
  whenHint?: string
  examples: string[]
  safety: Safety
  /** false ⇒ the author opted this contribution OUT of the LLM surface. */
  ai: boolean
  category?: string
  /** The INPUT SLOTS + their type constraints — what an agent needs to CALL this
   *  analysis. Replaces the old `params` form-schema projection (a form is a UI concern
   *  the manifest no longer carries) and the separate `accepts` list. Each entry with a
   *  `slot` is an input the caller binds to an artifact id of the matching type. */
  appliesTo: unknown[]
  /** produced datatype ids. */
  produces: string[]
  /** availability against the current project catalog (so the AI's tool set == what's valid now). */
  available: boolean
}

/** The full backend-readable projection P9's generator ingests. */
export interface ContributionCatalog {
  version: string
  entries: ContributionCatalogEntry[]
}

/** The registry keys projected to the LLM tool surface. Views + status-bar items are
 *  internal (§0.4.2), so they are deliberately NOT here — this is the single list a new
 *  AI-facing kind is added to (no more copy-pasted loops). ITEM-9 removed the
 *  `selectionActions` entry with the kind; ITEM-35 removed `commands` with the commands
 *  registry (zero contributors), leaving `analyses` as the ONE projected kind. */
const PROJECTED: ReadonlyArray<{ key: keyof Contributions; kind: ContributionCatalogEntry['kind'] }> = [
  { key: 'analyses', kind: 'analysis' },
]

/** Project one contribution → a catalog entry (single projector; no per-kind loop). */
function projectEntry(
  c: Contribution & { appliesTo?: unknown[]; produces?: string[] },
  kind: ContributionCatalogEntry['kind'],
  ctx: WhenContext,
  lattice: DatatypeLattice,
): ContributionCatalogEntry {
  const appliesTo = c.appliesTo ?? []
  return {
    id: c.id,
    kind,
    title: c.title,
    description: c.description ?? c.title,
    whenHint: c.whenHint,
    examples: c.examples ?? [],
    safety: c.safety ?? defaultSafety(kind),
    ai: c.ai ?? true,
    category: c.category,
    // `params` is gone from the manifest (it was a FORM SCHEMA). What an agent needs to
    // CALL an analysis is its input slots + their type constraints, which `appliesTo`
    // carries directly — no projection, no stripped resolver functions, no flattening of
    // a stepped form. Non-input params are the view's state and are sent by the caller.
    appliesTo,
    produces: c.produces ?? [],
    available: computeAvailability({ appliesTo: appliesTo as never }, ctx, lattice),
  }
}

/**
 * Walk the contribution registries → a serializable `ContributionCatalog`. Pure.
 * Only the AI-facing kinds in `PROJECTED` are emitted (views/status-bar items
 * are internal). `available` is computed through the SHARED `computeAvailability`
 * (SoT with `Registry.availability`) against the injected lattice + the project's
 * produced type ids, so the generated tool set reflects what is valid to run now (§0.4).
 */
export function buildContributionCatalog(
  registry: Contributions,
  ctx: { producedTypeIds: string[]; version: string },
  lattice: DatatypeLattice,
): ContributionCatalog {
  const whenCtx: WhenContext = { producedTypeIds: ctx.producedTypeIds }
  const entries: ContributionCatalogEntry[] = []
  for (const { key, kind } of PROJECTED) {
    for (const c of registry[key].all()) {
      entries.push(projectEntry(c as never, kind, whenCtx, lattice))
    }
  }

  return { version: ctx.version, entries }
}
