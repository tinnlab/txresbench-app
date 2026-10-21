// The dataset-preview contribution REGISTRY — a Map-keyed, module-level singleton,
// mirroring `core/datatypes/registry.ts` and `project/core/extensions`.
//
// The app registers NOTHING here. Every entry comes from the package that owns the
// datatype it describes; with no entries the resolver answers `null` for everything
// and the picker renders its count-and-title fallback, which is the permanent
// behaviour for any datatype nobody contributes for — not a placeholder.

import type { DatasetArtifactGroup } from '@/api-client/types'
import type { DatasetPreviewContribution, PreviewLattice, ResolvedPhrase } from './types'

export class DatasetPreviewRegistry {
  private byDatatype = new Map<string, DatasetPreviewContribution>()

  /** Register (or replace) the contribution for a datatype id. */
  register(contribution: DatasetPreviewContribution): void {
    this.byDatatype.set(contribution.datatype, contribution)
  }

  /** Drop every contribution (tests; a package hot-reload). */
  clear(): void {
    this.byDatatype.clear()
  }

  get size(): number {
    return this.byDatatype.size
  }

  /**
   * The MOST SPECIFIC contribution for `datatype`: an exact registration wins, then
   * the nearest registered ancestor. `undefined` when nothing along the chain has one.
   */
  resolve(datatype: string, lattice: PreviewLattice): DatasetPreviewContribution | undefined {
    const exact = this.byDatatype.get(datatype)
    if (exact) return exact
    for (const parent of lattice.ancestors(datatype)) {
      const c = this.byDatatype.get(parent)
      if (c) return c
    }
    return undefined
  }

  /**
   * What the matching contribution says about one group.
   *
   * `title` is the group's own datatype's declared display title, resolved by the
   * caller and handed to the contribution verbatim. It is a parameter rather than
   * something read here so this class stays pure and registry-free, the same reason
   * `lattice` is injected.
   *
   * `null` — nothing along the lattice contributes for this datatype at all.
   * `{order, text: null}` — a contribution matched and DECLINED (the declarations it
   * reads are absent, or it threw). It keeps its declared position; the caller
   * renders the count-and-title fallback there.
   *
   * A display contribution is third-party code running inside a control the user
   * needs, so a throw is contained here — and reported once, to the console, so it is
   * not invisible.
   */
  phraseFor(
    group: DatasetArtifactGroup,
    lattice: PreviewLattice,
    title: string,
  ): ResolvedPhrase | null {
    const c = this.resolve(group.datatype, lattice)
    if (!c) return null
    try {
      return { order: c.order, text: c.phrase(group, title) ?? null }
    } catch (err) {
      console.error(
        `[dataset preview] contribution for "${c.datatype}" threw; showing no phrase`,
        err,
      )
      return { order: c.order, text: null }
    }
  }
}

/** The process-wide registry. */
export const datasetPreviewRegistry = new DatasetPreviewRegistry()

/** Registration entry point for a contributing package. */
export function registerDatasetPreview(contribution: DatasetPreviewContribution): void {
  datasetPreviewRegistry.register(contribution)
}
