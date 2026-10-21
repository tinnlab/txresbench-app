// volcanoBinding.test.ts — TEST-13 (ITEM-10): `volcanoInputFromTable` must not name a column the
// table did not.
//
// ── The defect this exists to keep dead ──────────────────────────────────────────────────────
//
// The two columns were read as `table.columns[opts.effectColumn ?? 'effect']` and `?? 'signif'`.
// Those `??`s look like fallbacks and are not: they are hardcoded column LITERALS — the in-package
// fixtures' vocabulary asserted over a host's stat table. Per
// `docs/design/binding-resolution-refusal.md`, "a hardcoded column literal in a resolver is a claim
// about the data that no contributor made".
//
// A host DE table is `log2FoldChange` / `padj` / `pvalue` / `baseMean`, not `effect` / `signif`, so
// the literals bound nothing and the plot rendered silently empty with no statement of why. (Note
// what is NOT the defect: a table that really does publish `effect` binding it. An exact match on a
// name the DATA published is evidence, and that step survives untouched — it is the invention of the
// name when the data never said it that is gone.)
//
// The property under test is the CLASS, not the instance: with no declaration and no name match,
// several candidates must resolve to NOTHING rather than to whichever column the literal names or
// the table happens to list first. The two controls (an explicit override binds; a genuine
// `effect`/`signif` table still binds) are what stop the fix degenerating into "never plot".

import { describe, it, expect } from 'vitest'
import { volcanoInputFromTable } from './VolcanoView'
import type { DataTable } from '../data/wire'

function table(columns: Record<string, number[]>, rowLabels = ['g1', 'g2', 'g3']): DataTable {
  return {
    rowLabels,
    columns: Object.fromEntries(
      Object.entries(columns).map(([k, v]) => [k, Float32Array.from(v)]),
    ),
  }
}

const FC = [-2, 0.1, 3]
const P = [4, 0.2, 5]

describe('volcanoInputFromTable — the columns are bound, not guessed', () => {
  it('two plausible numeric columns and no override resolves to NOTHING, not to a literal', () => {
    // The ordinary host shape. Nothing here is called `effect` or `signif`, and nothing chooses
    // between the four candidates — so the honest answer is no points, and the view's existing
    // empty state says so.
    const t = table({ log2FoldChange: FC, padj: P, pvalue: P, baseMean: [10, 20, 30] })
    expect(volcanoInputFromTable(t)).toEqual([])
  })

  it('an ambiguous significance side refuses even when the effect side bound cleanly', () => {
    // Per-channel resolution, and BOTH channels have to resolve. `effect` binds here by exact name
    // match (a name the DATA published is evidence, not a guess — that is the one step of the old
    // chain that was always sound), but three columns qualify for significance and nothing chooses
    // between them, so the plot refuses rather than pairing the fold change with a plausible
    // stranger.
    const t = table({ effect: FC, log2FoldChange: FC, padj: P, pvalue: P })
    expect(volcanoInputFromTable(t)).toEqual([])
  })

  it('an EXPLICIT override binds — a declaration is evidence', () => {
    const t = table({ log2FoldChange: FC, padj: P, pvalue: P, baseMean: [10, 20, 30] })
    const pts = volcanoInputFromTable(t, { effectColumn: 'log2FoldChange', significanceColumn: 'padj' })
    expect(pts).toHaveLength(3)
    expect(pts.map(p => p.label)).toEqual(['g1', 'g2', 'g3'])
    expect(pts.map(p => p.x)).toEqual([-2, expect.closeTo(0.1, 5), 3])
  })

  it('an override naming a column the table lacks resolves to nothing (it does not fall back)', () => {
    const t = table({ log2FoldChange: FC, padj: P })
    expect(volcanoInputFromTable(t, { effectColumn: 'notThere' })).toEqual([])
  })

  it('a table that GENUINELY has `effect`/`signif` still binds them (the control)', () => {
    // Byte-identical behaviour for every existing caller and fixture: the conventional name is still
    // honoured — it is just required to be a name the DATA published, not one the resolver invented.
    const t = table({ effect: FC, signif: P })
    const pts = volcanoInputFromTable(t)
    expect(pts).toHaveLength(3)
    expect(pts.map(p => p.x)).toEqual([-2, expect.closeTo(0.1, 5), 3])
  })

  it('`effect`/`signif` still win over other columns present alongside them', () => {
    const t = table({ baseMean: [1, 2, 3], effect: FC, signif: P, pvalue: [9, 9, 9] })
    const pts = volcanoInputFromTable(t)
    expect(pts).toHaveLength(3)
    expect(pts.map(p => p.x)).toEqual([-2, expect.closeTo(0.1, 5), 3])
  })

  it('a SOLE remaining candidate binds — one choice is no choice at all', () => {
    // `effect` binds by name; `padj` is then the ONLY column left, so binding it asserts nothing.
    // That is the whole difference from the `[0]` this file exists to forbid: `length === 1` claims
    // no ordering, while position 0 of a longer list claims one the data never stated.
    const t = table({ effect: FC, padj: P })
    const pts = volcanoInputFromTable(t)
    expect(pts).toHaveLength(3)
  })

  it('an empty table resolves to nothing rather than throwing', () => {
    expect(volcanoInputFromTable(table({}))).toEqual([])
  })
})
