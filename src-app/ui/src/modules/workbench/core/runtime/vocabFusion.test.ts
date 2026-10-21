// TEST-33 / TEST-38 / TEST-39 / TEST-40 (dimension-membership ITEM-32, and ITEM-34's read side).
//
// The owner ruled FUSE — but only where the vocabularies reconcile, and never silently otherwise.
// Every case below is about the SECOND half of that ruling: the three-valued check, and the fact
// that BOTH non-reconciled values offer SEPARATELY. A fuse-always implementation passes nothing
// here; a fuse-never implementation passes only the negative arms.
//
// The vocabulary is domain-free: the levels are `L0`/`L1`/…, which is deliberate — a fixture
// spelling a real level name would let an implementation that RECOGNISED the name pass.

import { describe, expect, it } from 'vitest'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { reconcileVocabularies, vocabDeclarationOf, type VocabDeclaration } from './vocabFusion'
import { resolveRowSpaceColumns } from './rowSpaceColumns'

/** The producer's own digest, ported from `cyto_zarr.vocab_declaration` — sorted per-level short
 *  hashes, so the SUBSET arm is exercised against the real shape rather than a stand-in. The
 *  hashes here are synthetic (one byte of level identity, padded), because what this check reads
 *  is the SET of 8-byte tokens and never their provenance. */
function sketchOf(levels: readonly string[]): string {
  const shorts = [...new Set(levels)]
    .map(level => {
      const bytes = new Uint8Array(8)
      for (let i = 0; i < level.length && i < 8; i++) bytes[i] = level.charCodeAt(i)
      return bytes
    })
    .sort((a, b) => {
      for (let i = 0; i < 8; i++) if (a[i] !== b[i]) return a[i] - b[i]
      return 0
    })
  let raw = ''
  for (const short of shorts) for (const b of short) raw += String.fromCharCode(b)
  return btoa(raw)
}

/** A digest that is a pure function of the level SET — order-independent, as the producer's is. */
function digestOf(levels: readonly string[]): string {
  return `d:${[...new Set(levels)].sort().join('|')}`
}

function categorical(levels: readonly string[], over: Partial<VocabDeclaration> = {}): VocabDeclaration {
  return {
    kind: 'categorical',
    digest: digestOf(levels),
    sketch: sketchOf(levels),
    ordered: false,
    nLevels: new Set(levels).size,
    ...over,
  }
}

describe('TEST-38 (ITEM-32/ITEM-34) — the three-valued check over the digest/sketch pair', () => {
  it('EQUAL digests reconcile, whatever order the producers wrote the levels in', () => {
    const a = categorical(['L0', 'L1', 'L2'])
    const b = categorical(['L2', 'L0', 'L1'])
    // This is the case the pre-ITEM-34 answer could not reach: an ORDER-sensitive digest
    // (`levels_digest`) makes these two disagree, and they would have been offered separately
    // forever despite being the same vocabulary.
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'reconciled', evidence: 'digest' })
  })

  it('a sketch-PROVABLE subset reconciles — which a set hash alone cannot answer', () => {
    const whole = categorical(['L0', 'L1', 'L2'])
    const part = categorical(['L0', 'L2'])
    expect(whole.digest).not.toBe(part.digest) // the digests differ; only the sketch decides
    expect(reconcileVocabularies(whole, part)).toMatchObject({ verdict: 'reconciled', evidence: 'sketch' })
    // …and it is symmetric: which side is the subset is not a property of the argument order.
    expect(reconcileVocabularies(part, whole)).toMatchObject({ verdict: 'reconciled', evidence: 'sketch' })
  })

  it('CONFLICTING sets are `mismatched` — and mismatched OFFERS SEPARATELY, never fused', () => {
    const a = categorical(['L0', 'L1'])
    const b = categorical(['L1', 'L2'])
    // Overlapping but neither contained: fusing them would produce one legend carrying three
    // levels, two of which no single dataset declares.
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'mismatched' })
  })

  it('a sketch that cannot be READ is undecidable — never an empty set', () => {
    const a = categorical(['L0', 'L1'])
    const b = { ...categorical(['L9']), sketch: 'not base64 !!!' }
    // An unreadable sketch treated as `{}` is a SUBSET of everything and would fuse every pair
    // it touched — the failure mode is silent and total, so it is refused explicitly.
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'undecidable' })
    // …and a sketch whose length is not a whole number of level hashes: guessing at the
    // remainder invents a level.
    expect(
      reconcileVocabularies(a, { ...categorical(['L9']), sketch: btoa('abc') }),
    ).toMatchObject({ verdict: 'undecidable' })
  })
})

describe('TEST-33 (ITEM-34/ITEM-32) — exactly ONE of {digest, sketch} is undecidable', () => {
  it('a lone digest is NOT used as an equality-only answer', () => {
    const a = { ...categorical(['L0', 'L1']), sketch: undefined }
    const b = categorical(['L0', 'L1'])
    // The plausible shortcut — "a digest alone still answers EQUALITY, so use it" — is exactly
    // what this refuses. `vocab_declaration` emits both or neither and DROPS the digest when the
    // sketch does not fit, so a lone digest means something rewrote one of them, which means
    // neither can be trusted. The write-side invariant is only load-bearing if this refuses.
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'undecidable' })
    expect(reconcileVocabularies(b, a)).toMatchObject({ verdict: 'undecidable' })
  })

  it('a lone SKETCH is refused on the same rule, from the other side', () => {
    const a = { ...categorical(['L0', 'L1']), digest: undefined }
    expect(reconcileVocabularies(a, categorical(['L0', 'L1']))).toMatchObject({ verdict: 'undecidable' })
  })

  it('one side predating ITEM-34 is undecidable — the survivor is not a partial answer', () => {
    const modern = categorical(['L0', 'L1'])
    const legacy: VocabDeclaration = { kind: 'categorical', nLevels: 2, preview: ['L0', 'L1'] }
    expect(reconcileVocabularies(modern, legacy)).toMatchObject({ verdict: 'undecidable' })
  })
})

describe('TEST-39 (ITEM-32/ITEM-34) — `ordered` is undecidable even when the digests are EQUAL', () => {
  it('either side declaring `ordered` refuses, and the digests agreeing does not override it', () => {
    const a = categorical(['L0', 'L1', 'L2'], { ordered: true })
    const b = categorical(['L0', 'L1', 'L2'])
    expect(a.digest).toBe(b.digest) // the sets are identical, and that is not enough
    // An implementation that fuses on set agreement alone passes every other case in this file
    // and produces a legend whose SEQUENCE is one dataset's and whose VALUES are both.
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'undecidable' })
    expect(reconcileVocabularies(b, a)).toMatchObject({ verdict: 'undecidable' })
  })
})

describe('TEST-40 (ITEM-32, Q11) — CONTINUOUS columns fuse on their declared kind', () => {
  it('two continuous columns reconcile, and each side`s declared RANGE is available to state', () => {
    const a: VocabDeclaration = { kind: 'continuous', min: 0, max: 1 }
    const b: VocabDeclaration = { kind: 'continuous', min: 0, max: 1000 }
    // A continuous column has no vocabulary, so there is nothing for the digest check to test.
    // The RANGE is the only tell of divergent meaning available without a body read — so it is
    // SURFACED (the ITEM-10 line carries each dataset's own figure) rather than used to refuse.
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'reconciled', evidence: 'continuous' })
    expect([a.min, a.max, b.min, b.max]).toEqual([0, 1, 0, 1000])
  })

  it('a column declaring NEITHER recognised kind does not fuse', () => {
    const unknown: VocabDeclaration = { kind: 'something-else' }
    expect(reconcileVocabularies(unknown, unknown)).toMatchObject({ verdict: 'undecidable' })
    expect(reconcileVocabularies({}, {})).toMatchObject({ verdict: 'undecidable' })
  })

  it('a continuous column and a categorical one are mismatched, not fused', () => {
    expect(reconcileVocabularies({ kind: 'continuous' }, categorical(['L0']))).toMatchObject({
      verdict: 'mismatched',
    })
  })
})

describe('the pre-ITEM-34 fallback — the CAPPED preview, and what it may not answer', () => {
  it('two COMPLETE previews decide, in both directions', () => {
    const a: VocabDeclaration = { kind: 'categorical', nLevels: 2, preview: ['L0', 'L1'] }
    const b: VocabDeclaration = { kind: 'categorical', nLevels: 3, preview: ['L0', 'L1', 'L2'] }
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'reconciled', evidence: 'preview' })
    const c: VocabDeclaration = { kind: 'categorical', nLevels: 2, preview: ['L7', 'L8'] }
    expect(reconcileVocabularies(a, c)).toMatchObject({ verdict: 'mismatched', evidence: 'preview' })
  })

  it('a TRUNCATED preview is undecidable — never a soft yes, even when the visible parts agree', () => {
    // `high_cardinality` is defined as `len(categories) < n_categories`: the preview is not the
    // whole set. Two truncations that happen to agree are a confident merge on an unanswered
    // question, and this is the arm that would make ITEM-32's ruling visibly NOT fire on
    // high-cardinality columns — which is correct under the ruling's own second clause.
    const a: VocabDeclaration = { kind: 'categorical', nLevels: 500, preview: ['L0', 'L1'] }
    const b: VocabDeclaration = { kind: 'categorical', nLevels: 500, preview: ['L0', 'L1'] }
    expect(reconcileVocabularies(a, b)).toMatchObject({ verdict: 'undecidable' })
  })
})

describe('vocabDeclarationOf — the digest is read off the STRUCTURE member, the preview off `meta`', () => {
  const artifact = (over: Partial<ArtifactRow>): ArtifactRow =>
    ({
      id: 'a',
      project_id: 'p',
      datatype: 'demo/column',
      created_at: '2026-01-01T00:00:00Z',
      structure: {},
      ...over,
    }) as ArtifactRow

  it('reads both, from the two places the producer actually writes them', () => {
    // The producer puts `vocab_digest`/`vocab_sketch`/`ordered` on the member entry beside
    // `levels_digest` (`cyto_zarr.Table.categorical`), and `colsummary`'s dict on `meta`.
    // Reading either from the other place finds nothing and silently degrades to undecidable —
    // a fusion that never fires, with no error anywhere.
    const row = artifact({
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        columns: [{ path: 'c', kind: 'categorical', vocab_digest: 'D', vocab_sketch: 'S', ordered: true, n_levels: 3 }],
      },
      meta: { kind: 'categorical', n_categories: 3, categories: ['L0', 'L1', 'L2'] },
    })
    expect(vocabDeclarationOf(row)).toMatchObject({
      kind: 'categorical',
      digest: 'D',
      sketch: 'S',
      ordered: true,
      nLevels: 3,
      preview: ['L0', 'L1', 'L2'],
    })
  })

  it('a MULTI-member table declares no single vocabulary — and none is invented', () => {
    const row = artifact({
      structure: { encoding: 'zarr_v3', kind: 'table', columns: [{ path: 'a' }, { path: 'b' }] },
      meta: { kind: 'categorical' },
    })
    expect(vocabDeclarationOf(row).digest).toBeUndefined()
  })
})

// ── THE OFFER ITSELF (ITEM-32, wired) ─────────────────────────────────────────────────────────
//
// The check above is only half of it. These cases drive `resolveRowSpaceColumns`, where the
// verdict decides whether the reader sees ONE row or TWO — which is the thing the ruling is
// actually about.

describe('resolveRowSpaceColumns (ITEM-32) — a reconciled pair is ONE offer naming both datasets', () => {
  const DIGEST = 'digest-rows'
  const HASH = 'h'.repeat(64)

  const keyArtifact: ArtifactRow = {
    id: 'k-rows',
    project_id: 'p',
    datatype: 'demo/key',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-1',
    content_hash: HASH,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'rows',
      key: 'values',
      columns: [{ name: 'values', kind: 'string' }],
      key_sequence_digest: DIGEST,
    },
  } as ArtifactRow

  const column = (id: string, dataset: string, levels: readonly string[], over: Record<string, unknown> = {}): ArtifactRow =>
    ({
      id,
      project_id: 'p',
      datatype: 'demo/column',
      created_at: '2026-01-01T00:00:00Z',
      source_dataset_id: dataset,
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        aligned_to: DIGEST,
        columns: [
          {
            path: 'c',
            kind: 'categorical',
            ordered: false,
            n_levels: new Set(levels).size,
            vocab_digest: digestOf(levels),
            vocab_sketch: sketchOf(levels),
            ...over,
          },
        ],
      },
      meta: { name: 'shared', kind: 'categorical', n_categories: new Set(levels).size },
    }) as ArtifactRow

  const resolve = (rows: readonly ArtifactRow[]) => resolveRowSpaceColumns(rows, {}, [HASH])

  it('fuses two datasets` same-named columns when the vocabularies reconcile', () => {
    const res = resolve([keyArtifact, column('c-a', 'ds-1', ['L0', 'L1']), column('c-b', 'ds-2', ['L1', 'L0'])])
    expect(res.columns).toHaveLength(1)
    const only = res.columns.reduce(first => first)
    // ONE offer — and it carries BOTH artifacts, because a record or export of this pick must
    // contribute both (ITEM-35). The stored value stays the single primary id.
    expect(only.artifact).toBe('c-a')
    expect(only.artifacts).toEqual(['c-a', 'c-b'])
    // …and it SAYS which datasets it spans. A fusion nobody can see is the thing the ruling's
    // second clause forbids.
    expect(only.datasets).toEqual(['ds-1', 'ds-2'])
  })

  it('offers a MISMATCHED pair SEPARATELY — two rows, no warning, nothing merged', () => {
    const res = resolve([keyArtifact, column('c-a', 'ds-1', ['L0', 'L1']), column('c-b', 'ds-2', ['L7', 'L8'])])
    // Two rows the reader can pick individually, rather than one merged row with prose they
    // would have to translate back into an action they cannot take.
    expect(res.columns.map(c => c.artifact).sort()).toEqual(['c-a', 'c-b'])
    expect(res.columns.every(c => c.artifacts === undefined)).toBe(true)
  })

  it('offers an UNDECIDABLE pair separately too — undecidable is not a soft yes', () => {
    const ordered = { ordered: true }
    const res = resolve([keyArtifact, column('c-a', 'ds-1', ['L0', 'L1'], ordered), column('c-b', 'ds-2', ['L0', 'L1'])])
    expect(res.columns.map(c => c.artifact).sort()).toEqual(['c-a', 'c-b'])
  })

  it('never fuses two same-named columns of ONE dataset', () => {
    // The natural key excludes the name precisely so this is legal, and merging them would
    // delete an offer inside a single project — which is not what the ruling asked for.
    const res = resolve([keyArtifact, column('c-a', 'ds-1', ['L0', 'L1']), column('c-b', 'ds-1', ['L0', 'L1'])])
    expect(res.columns.map(c => c.artifact).sort()).toEqual(['c-a', 'c-b'])
  })

  it('ALL PAIRS must reconcile — a three-way group with one conflict offers all THREE separately', () => {
    // A≡B and A≡C but B≢C. A representative-based check fuses all three and hides the conflict;
    // the verdict must not depend on which member was picked to compare against.
    const res = resolve([
      keyArtifact,
      column('c-a', 'ds-1', ['L0', 'L1', 'L2']),
      column('c-b', 'ds-2', ['L0', 'L1']),
      column('c-c', 'ds-3', ['L2']),
    ])
    expect(res.columns.map(c => c.artifact).sort()).toEqual(['c-a', 'c-b', 'c-c'])
  })
})
