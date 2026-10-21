// `integration_grid` — the binding plan for the reworked integration slot shape.
//
// ── THE FIXTURE MAKES THREE ORDERS DISAGREE, ON PURPOSE ─────────────────────────────────
//
// The grid has three independent orders and a plan can be accidentally right when they
// coincide:
//
//   1. DATASET INDEX  — the order the user chose the datasets in
//   2. BINDING ORDER  — the order the artifacts happen to sit in the catalog array
//   3. COLUMN ORDER   — the order a dataset's columns happen to sit in the catalog array
//
// So the catalog below is built with all three DELIBERATELY out of step: the rows are shuffled
// relative to each other, the datasets are requested in the reverse of catalog order, and each
// dataset's columns appear in an order that is neither alphabetical nor matched between
// datasets. A plan that reads correctly here cannot be reading position for identity.
//
// This is the hazard that has already cost this entity twice (a mount name read as an
// identity, a mis-ordered id relay), and the assertion that catches it is that the pairings
// hold, not that the counts do.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import { INTEGRATION_GRID_SOURCE, resolveIntegrationGrid } from './integrationGrid'

// DOMAIN-FREE AXIS NAMES, deliberately. This module is `workbench/core` and carries none of
// the domain lattice — nor may its tests, which is what caught the two named constants this
// file used to import. The resolver is axis-AGNOSTIC (it string-matches whatever the view
// declares), so naming the axes `alpha`/`beta` here tests exactly what a real pair would and
// cannot quietly encode one domain's vocabulary as though it were the only possible one.
//
// The counterpart guard — that the SHIPPED VIEW declares an axis some producer actually
// declares — lives below and reads the manifests, so the two sides can genuinely differ.
const ENTITY_AXIS = 'alpha'
const LEVEL_AXIS = 'beta'

const PACKAGES = fileURLToPath(new URL('../../../../../../packages', import.meta.url))

/** A single-column `single-column artifact` artifact on one axis of one dataset. */
function column(id: string, dataset: string, axis: string, name: string): ArtifactRow {
  return {
    id,
    datatype: 'single-column artifact',
    source_dataset_ids: [dataset],
    meta: { name },
    structure: { encoding: 'zarr_v3', kind: 'table', axis, n: 3, columns: [{ path: 'values', name }] },
  } as unknown as ArtifactRow
}

/** A declared row INDEX — the artifact `rows` mounts and `dataset_content_hashes` keys. */
function rowIndex(id: string, dataset: string, hash: string, axis = LEVEL_AXIS): ArtifactRow {
  return {
    id,
    datatype: 'single-column artifact',
    source_dataset_ids: [dataset],
    content_hash: hash,
    meta: { name: 'row_key', is_axis_index: true },
    structure: { encoding: 'zarr_v3', kind: 'table', axis, n: 3, columns: [{ path: 'values', name: 'row_key' }] },
  } as unknown as ArtifactRow
}

/** The dataset anchor itself, so `siblingsOnAxis` can resolve a source-dataset scope. */
/** The chosen artifact. Its OWN id and its owning DATASET id are DELIBERATELY DIFFERENT.
 *
 *  They used to be the same string, and that coincidence hid a critical defect: the resolver
 *  relayed the picker's ARTIFACT ids as `params.dataset_ids`, and every check agreed because
 *  both sides carried the same value. Downstream, the detach guard parses those as UUIDs and
 *  compares against the DATASETS table, so the comparison could never match and ITEM-40's
 *  refusal was inert on every real run.
 *
 *  H10, in the shape this branch keeps paying for: two channels that happen to agree cannot be
 *  told apart. `ds-a` is now the DATASET and `art-a` the artifact. */
function dataset(id: string): ArtifactRow {
  return {
    id: `art-${id}`,
    datatype: 'test/anchor-type',
    source_dataset_ids: [id],
    structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: [LEVEL_AXIS, ENTITY_AXIS], n: 3 },
  } as unknown as ArtifactRow
}

// ── the three-orders-disagree catalog ───────────────────────────────────────────────────
//
// Catalog order interleaves the two datasets and puts B's rows before A's; the columns of each
// dataset are in a different, non-alphabetical order; and the datasets will be REQUESTED as
// [ds-b, ds-a], the reverse of the order their anchors appear here.
const CATALOG: ArtifactRow[] = [
  dataset('ds-a'),
  column('art-b-symbol', 'ds-b', ENTITY_AXIS, 'symbol'),
  rowIndex('idx-b', 'ds-b', 'hash-BBB'),
  column('art-a-ensembl', 'ds-a', ENTITY_AXIS, 'ensembl_id'),
  column('art-b-celltype', 'ds-b', LEVEL_AXIS, 'celltype'),
  dataset('ds-b'),
  column('art-a-symbol', 'ds-a', ENTITY_AXIS, 'symbol'),
  rowIndex('idx-a', 'ds-a', 'hash-AAA'),
  column('art-a-celltype', 'ds-a', LEVEL_AXIS, 'celltype'),
  column('art-b-ensembl', 'ds-b', ENTITY_AXIS, 'ensembl_id'),
]

// The REQUEST order is the reverse of catalog order — order 1 vs order 2 made to disagree.
const REQUESTED = ['art-ds-b', 'art-ds-a']

const AXES = { entity_axis: ENTITY_AXIS, level_axis: LEVEL_AXIS }

const grid = (levels: string[] = []) =>
  resolveIntegrationGrid(CATALOG, AXES, REQUESTED, levels)

describe('the fixture itself exhibits the disagreement it is for', () => {
  // Asserted SEPARATELY from asserting the resolver handles it. A fixture whose orders quietly
  // coincide would make every test below pass for the wrong reason, and nothing would say so.
  it('has request order, catalog order and column order all out of step', () => {
    const anchors = CATALOG.filter(r => r.datatype === 'test/anchor-type').map(r => r.id)
    expect(anchors).toEqual(['art-ds-a', 'art-ds-b'])
    expect(REQUESTED).not.toEqual(anchors)
    // B's row index precedes A's in the catalog, while A is requested last.
    const idxOrder = CATALOG.filter(r => r.id.startsWith('idx-')).map(r => r.id)
    expect(idxOrder).toEqual(['idx-b', 'idx-a'])
    // Each dataset's entity columns appear in a different, non-alphabetical catalog order.
    const entOrder = (ds: string) =>
      CATALOG.filter(r => r.id.startsWith('art-') && (r.source_dataset_ids as string[])[0] === ds)
        .filter(r => (r.structure as { axis: string }).axis === ENTITY_AXIS)
        .map(r => (r.meta as { name: string }).name)
    expect(entOrder('ds-b')).toEqual(['symbol', 'ensembl_id'])
    expect(entOrder('ds-a')).toEqual(['ensembl_id', 'symbol'])
    expect(entOrder('ds-a')).not.toEqual(entOrder('ds-b'))
  })
})

describe('C3 — datasetIds carries DATASET ids, never the picker’s ARTIFACT ids', () => {
  // The assertion that would have caught the critical defect. It is only capable of failing
  // because the fixture makes the two ids DIFFER; while `art-x` and `x` were one string this
  // whole class was invisible.
  it('relays the owning dataset id, not the chosen artifact id', () => {
    const g = grid()
    expect(g.datasetIds).toEqual(['ds-b', 'ds-a'])
    for (const id of g.datasetIds) {
      expect(id, 'an ARTIFACT id reached params.dataset_ids').not.toMatch(/^art-/)
    }
    // …and the keyed hashes are keyed by the SAME vocabulary, or the compute's cross-check
    // would compare two different kinds of id and always disagree.
    expect(Object.keys(g.contentHashes).sort()).toEqual(g.datasetIds.slice().sort())
  })

  it('REFUSES a dataset integrated with itself (two artifacts, one dataset)', () => {
    // Deduping by ARTIFACT id let two modalities of one dataset through: `ready: true`, both
    // cross-checks agreeing, and the producer joining a dataset against itself at 100% match.
    const twoModalities = [
      ...CATALOG,
      { id: 'art-ds-a-rna', datatype: 'test/anchor-type', source_dataset_ids: ['ds-a'],
        structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: [LEVEL_AXIS, ENTITY_AXIS], n: 3 } } as unknown as ArtifactRow,
    ]
    const g = resolveIntegrationGrid(twoModalities, AXES, ['art-ds-a', 'art-ds-a-rna'], [])
    expect(g.datasetIds).toEqual(['ds-a'])
    expect(g.blocked.map(b => b.reason).join(' ')).toMatch(/integrated with itself/i)
    expect(g.ready, 'a dataset was integrated with itself').toBe(false)
  })

  it('REFUSES an artifact whose owning dataset is ambiguous or absent', () => {
    const odd = [
      ...CATALOG,
      { id: 'art-multi', datatype: 'test/anchor-type', source_dataset_ids: ['ds-a', 'ds-b'],
        structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: [LEVEL_AXIS, ENTITY_AXIS], n: 3 } } as unknown as ArtifactRow,
    ]
    const g = resolveIntegrationGrid(odd, AXES, ['art-multi', 'art-ds-b'], [])
    expect(g.blocked.map(b => b.reason).join(' ')).toMatch(/several datasets/i)
    expect(g.ready).toBe(false)
  })
})

describe('resolveIntegrationGrid — the dataset dimension', () => {
  it('indexes datasets in the REQUESTED order, not the catalog order', () => {
    const g = grid()
    expect(g.datasetIds).toEqual(['ds-b', 'ds-a'])
    expect(g.ready).toBe(true)
    expect(g.blocked).toEqual([])
  })

  it('pairs each rows[] entry with its own dataset, across the disagreement', () => {
    const g = grid()
    // rows is POSITIONAL and must line up with datasetIds — the relay the compute cross-checks.
    expect(g.rows).toEqual(['idx-b', 'idx-a'])
    // …and the pairing is asserted per dataset, not as a list shape, so a both-reversed result
    // (which has the right shape and the wrong meaning) fails here.
    g.datasetIds.forEach((id, i) => {
      expect(g.rows[i], `rows[${i}] is not ${id}'s index`).toBe(id === 'ds-b' ? 'idx-b' : 'idx-a')
    })
  })

  it('keys dataset_content_hashes BY DATASET, never positionally', () => {
    const g = grid()
    expect(g.contentHashes).toEqual({ 'ds-a': 'hash-AAA', 'ds-b': 'hash-BBB' })
    // The property that makes the compute's cross-check have force: reversing the id relay must
    // NOT leave the map still agreeing. A parallel-list version passed exactly that, measured,
    // in the producer — so it is asserted here rather than trusted.
    const reversed = resolveIntegrationGrid(CATALOG, AXES, ['art-ds-a', 'art-ds-b'], [])
    expect(reversed.rows).toEqual(['idx-a', 'idx-b'])
    expect(reversed.contentHashes).toEqual(g.contentHashes)
    reversed.datasetIds.forEach((id, i) => {
      expect(reversed.contentHashes[id]).toBe(
        (CATALOG.find(r => r.id === reversed.rows[i]) as ArtifactRow).content_hash,
      )
    })
  })
})

describe('resolveIntegrationGrid — the ragged column grid', () => {
  it('emits one entity binding per (dataset, column) with the RIGHT artifact', () => {
    const g = grid()
    expect(g.entityBindings).toEqual([
      { index: 0, column: 'ensembl_id', artifact: 'art-b-ensembl' },
      { index: 0, column: 'symbol', artifact: 'art-b-symbol' },
      { index: 1, column: 'ensembl_id', artifact: 'art-a-ensembl' },
      { index: 1, column: 'symbol', artifact: 'art-a-symbol' },
    ])
    // Stated as the property, so a future reordering cannot make it accidentally pass: every
    // binding's artifact must belong to the dataset its index names.
    for (const binding of g.entityBindings) {
      const owner = (CATALOG.find(r => r.id === binding.artifact) as ArtifactRow).source_dataset_ids as string[]
      expect(owner[0], `${binding.artifact} is not ${g.datasetIds[binding.index]}'s`).toBe(g.datasetIds[binding.index])
    }
  })

  it('binds ONLY the level columns the user declared (INV-1)', () => {
    // The catalog bounds the offer; it never selects. With nothing declared there are no
    // `level:` bindings at all, even though both datasets carry `celltype`.
    expect(grid().levelBindings).toEqual([])
    expect(grid(['celltype']).levelBindings).toEqual([
      { index: 0, column: 'celltype', artifact: 'art-b-celltype' },
      { index: 1, column: 'celltype', artifact: 'art-a-celltype' },
    ])
    // A name nothing carries binds nothing rather than throwing — the user's declaration can
    // outlive a change of datasets, and the launch is where that is refused.
    expect(grid(['not_a_column']).levelBindings).toEqual([])
  })

  it('is RAGGED — a dataset contributing more columns does not shift another', () => {
    const extra = [...CATALOG, column('art-a-alias', 'ds-a', ENTITY_AXIS, 'alias')]
    const g = resolveIntegrationGrid(extra, AXES, REQUESTED, [])
    expect(g.entityBindings.filter(c => c.index === 0)).toHaveLength(2)
    expect(g.entityBindings.filter(c => c.index === 1)).toHaveLength(3)
    // ds-b's rows are untouched by ds-a growing one — the whole reason these are a family
    // rather than a relayed partition.
    expect(g.entityBindings.filter(c => c.index === 0)).toEqual(grid().entityBindings.filter(c => c.index === 0))
  })
})

describe('resolveIntegrationGrid — what it refuses', () => {
  it('blocks a dataset with no row index, and is NOT ready', () => {
    const g = resolveIntegrationGrid(
      CATALOG.filter(r => r.id !== 'idx-a'),
      AXES,
      REQUESTED,
      [],
    )
    expect(g.blocked.map(b => b.dataset)).toEqual(['ds-a'])
    expect(g.blocked[0].reason).toMatch(/row index/i)
    // A PARTIAL plan must never launch: the entity axis is an intersection, so dropping a
    // source makes the result larger and every count would describe a join nobody requested.
    expect(g.ready).toBe(false)
    expect(g.datasetIds).toEqual(['ds-b'])
  })

  // ── THE CASE A MUTATION FOUND MISSING ─────────────────────────────────────────────────
  //
  // The test above asserts `ready === false` with one dataset blocked — and it passed even
  // when `ready` was mutated to ignore `blocked` entirely, because only ONE dataset survived
  // and the `>= 2` floor caught it anyway. It was passing for the wrong reason.
  //
  // The hazard is a selection where a dataset is dropped and ENOUGH REMAIN: the plan then
  // looks complete and launches an integration over a subset the user did not ask for. The
  // entity axis is an INTERSECTION, so a dropped source makes the result LARGER — every count
  // agrees and describes a join nobody requested. That needs three datasets to reach.
  it('is NOT ready when a dataset is blocked but two others remain', () => {
    const withC = [
      ...CATALOG,
      dataset('ds-c'),
      column('art-c-ensembl', 'ds-c', ENTITY_AXIS, 'ensembl_id'),
      // …and NO row index for ds-c, so it is blocked while ds-a and ds-b are both fine.
    ]
    const g = resolveIntegrationGrid(withC, AXES, ['art-ds-b', 'art-ds-a', 'art-ds-c'], [])
    expect(g.blocked.map(b => b.dataset)).toEqual(['ds-c'])
    // The floor is satisfied — this is exactly the state that must still refuse.
    expect(g.datasetIds).toEqual(['ds-b', 'ds-a'])
    expect(g.datasetIds.length).toBeGreaterThanOrEqual(2)
    expect(g.ready, 'a plan with a dropped source must never launch').toBe(false)
    // The count the view gates on must agree with the list it renders — they are two
    // channels for one fact and a form that showed "1 excluded" over an empty table, or an
    // empty sentence over a populated one, would be worse than either alone.
    expect(g.blockedCount).toBe(g.blocked.length)
    expect(g.blockedCount).toBe(1)
  })

  it('blocks a row index carrying no content hash, rather than mounting an empty key', () => {
    const noHash = CATALOG.map(r => (r.id === 'idx-a' ? rowIndex('idx-a', 'ds-a', '') : r))
    const g = resolveIntegrationGrid(noHash, AXES, REQUESTED, [])
    expect(g.blocked.map(b => b.dataset)).toEqual(['ds-a'])
    expect(g.contentHashes).not.toHaveProperty('ds-a')
    expect(g.ready).toBe(false)
  })

  it('refuses an AMBIGUOUS row index rather than picking the first', () => {
    const two = [...CATALOG, rowIndex('idx-a2', 'ds-a', 'hash-AAA2')]
    const g = resolveIntegrationGrid(two, AXES, REQUESTED, [])
    expect(g.blocked.map(b => b.dataset)).toEqual(['ds-a'])
    expect(g.rows).not.toContain('idx-a')
    expect(g.rows).not.toContain('idx-a2')
  })

  it('drops a name one dataset carries TWICE rather than coin-flipping the artifact', () => {
    const dup = [...CATALOG, column('art-a-symbol-2', 'ds-a', ENTITY_AXIS, 'symbol')]
    const g = resolveIntegrationGrid(dup, AXES, REQUESTED, [])
    const aSymbols = g.entityBindings.filter(c => c.index === 1 && c.column === 'symbol')
    expect(aSymbols).toEqual([])
    // ds-b's `symbol` is unaffected — the ambiguity is one dataset's, not the name's.
    expect(g.entityBindings.filter(c => c.index === 0 && c.column === 'symbol')).toHaveLength(1)
  })

  it('REFUSES an undeclared axis rather than defaulting to one', () => {
    // The constants this module used to hold were a copy of two entries of a domain lattice
    // that lives in a package manifest, sitting in `workbench/core`. Removing them is only
    // safe if the absence REFUSES: a guessed axis matches no artifact at all
    // (`declaredAxes(...).includes(axis)`), so it renders as "these datasets share nothing" —
    // the blank surface this entity already shipped once and had to measure to find.
    for (const args of [{}, { entity_axis: ENTITY_AXIS }, { level_axis: LEVEL_AXIS }, { entity_axis: '', level_axis: '' }]) {
      const g = resolveIntegrationGrid(CATALOG, args, REQUESTED, [])
      expect(g.anchored, `args ${JSON.stringify(args)} produced a plan`).toBe(false)
      expect(g.ready).toBe(false)
      expect(g.rows).toEqual([])
    }
    // …and the positive control: the SAME catalog and ids DO produce a plan once both axes
    // are declared, so the refusals above are about the arguments and not about the fixture.
    expect(resolveIntegrationGrid(CATALOG, AXES, REQUESTED, []).ready).toBe(true)
  })

  it('is not ready below two datasets, and distinguishes that from nothing chosen', () => {
    const one = resolveIntegrationGrid(CATALOG, AXES, ['art-ds-a'], [])
    expect(one.anchored).toBe(true)
    expect(one.datasets).toBe(1)
    expect(one.ready).toBe(false)
    const none = resolveIntegrationGrid(CATALOG, AXES, [], [])
    expect(none.anchored).toBe(false)
    expect(none.ready).toBe(false)
  })

  it('never mounts the row index as an identifier column', () => {
    // Offering the index as something to join on would offer the row identifiers themselves,
    // which are one distinct value per row.
    const g = grid(['row_key'])
    expect(g.entityBindings.map(c => c.artifact)).not.toContain('idx-a')
    expect(g.levelBindings.map(c => c.artifact)).not.toContain('idx-a')
  })
})

// ── THE AXIS VOCABULARY, ASSERTED AGAINST THE SHIPPED MANIFESTS ─────────────────────────
//
// This is the assertion whose ABSENCE let `axis: rows` ship. The three suites covering the
// offer filter all built fixtures declaring `structure.axis = 'rows'`, so they agreed with the
// view while both disagreed with every producer in the tree — the guard and the guarded
// sharing one invented string. Pinning the defaults to the MANIFESTS is what makes the two
// sides able to differ.
describe('the axis names are the ones the producers actually declare', () => {
  const declaredAxisNames = (): Set<string> => {
    const out = new Set<string>()
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const file = `${PACKAGES}/${pkg.name}/manifest.yaml`
      if (!existsSync(file)) continue
      const m = parseYaml(readFileSync(file, 'utf8')) as {
        contributes?: { datatypes?: Array<{ axes?: Array<{ name?: string }> }> }
      }
      for (const d of m.contributes?.datatypes ?? []) {
        for (const a of d.axes ?? []) if (typeof a?.name === 'string') out.add(a.name)
      }
    }
    return out
  }

  // The test that used to sit here pinned this module's two DEFAULT axis constants to a name
  // some shipped datatype declares. It is gone because the constants are gone: a core module
  // may not hold the domain lattice, so there is no default left to pin. The guard below —
  // over every shipped VIEW's declared axis — is the half that was always doing the work,
  // since a view is where a domain vocabulary legitimately lives.

  // ── THE GENERAL GUARD, not a fix for one line ─────────────────────────────────────────
  //
  // The defect was one view spelling an axis nobody declares. Fixing that view alone would
  // leave the NEXT one free to do the same, silently, with the same blank result — so the
  // check is over EVERY shipped view's literal `axis:` argument.
  //
  // Literal spellings only. A `$`-ref (`axis: "$scope.axis"`) is resolved at render time from
  // a value this cannot see, so asserting anything about it would be asserting about the text
  // rather than the axis — and a check whose predicate is adjacent to its sentence fires on
  // the wrong rows and is believed.
  //
  // ── IT PARSES THE YAML, AND THE FIRST DRAFT DID NOT ───────────────────────────────────
  //
  // A regex over the file text harvested `axis: "rows"` out of a COMMENT explaining the very
  // defect being fixed, and reported the fixed tree as still broken. That is the same
  // prose-becomes-vocabulary failure the view↔compute gate documents at its own `slot_paths`
  // reader — reproduced here within an hour of reading it. Ask the PARSER, not the file: a
  // comment is not a declaration and the YAML reader is what knows the difference.
  //
  // ── EVERY KEY THAT NAMES AN AXIS, NOT JUST THE ONE SPELLED `axis` ─────────────────────
  //
  // `integration_grid` takes its two axes as `entity_axis` / `level_axis`. Reading only the
  // key `axis` left both of them unread, so a view could name an axis no producer declares
  // through either and this guard would report the tree clean.
  const AXIS_KEYS = new Set(['axis', 'entity_axis', 'level_axis'])

  /** Every shipped view yaml, parsed. Parsed — never regex'd over the text: a first draft of
   *  the guard below harvested an axis name out of a COMMENT explaining the defect it was
   *  fixing, and reported the fixed tree as broken. */
  const shippedViews = (): Array<{ file: string; doc: unknown }> => {
    const out: Array<{ file: string; doc: unknown }> = []
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const uiDir = `${PACKAGES}/${pkg.name}/ui`
      if (!existsSync(uiDir)) continue
      for (const f of readdirSync(uiDir)) {
        if (!f.endsWith('.yaml')) continue
        out.push({ file: `${pkg.name}/ui/${f}`, doc: parseYaml(readFileSync(`${uiDir}/${f}`, 'utf8')) })
      }
    }
    return out
  }

  it('every shipped view names a DECLARED axis, or a $-ref', () => {
    const names = declaredAxisNames()
    const found: Array<{ file: string; key: string; axis: string }> = []
    const walk = (node: unknown, file: string): void => {
      if (Array.isArray(node)) {
        for (const n of node) walk(n, file)
        return
      }
      if (node == null || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // A `$`-ref is resolved at render time from a value this cannot see.
        if (AXIS_KEYS.has(k) && typeof v === 'string' && v !== '' && !v.startsWith('$')) {
          found.push({ file, key: k, axis: v })
        }
        walk(v, file)
      }
    }
    for (const { file, doc } of shippedViews()) walk(doc, file)
    // A matcher that matches nothing reports success while checking nothing — this is the
    // "filter matching nothing" failure, so the corpus is asserted non-empty first.
    expect(found.length, 'no literal axis argument found in any shipped view').toBeGreaterThan(0)
    // …and non-empty PER KEY, so widening the key set cannot go quietly back to reading one:
    // every key in `AXIS_KEYS` must be exercised by some shipped view, or the widening is a
    // filter that matches nothing dressed as a stronger check.
    for (const key of AXIS_KEYS) {
      expect(
        found.filter(f => f.key === key).length,
        `no shipped view declares a literal "${key}" — this guard reads it but nothing exercises it`,
      ).toBeGreaterThan(0)
    }
    const bad = found.filter(f => !names.has(f.axis))
    expect(
      bad,
      `view(s) name an axis no datatype declares: ${bad.map(b => `${b.file} → ${b.key}: "${b.axis}"`).join(', ')}`,
    ).toEqual([])
  })

  // ── THE ABSENCE HALF, which no spelling check can make ────────────────────────────────
  //
  // The guard above reads the axis a view DECLARES. It is structurally blind to a view that
  // declares NEITHER — and that is exactly how the shipped integration form left both axes
  // off its `integration_grid` slice, at which point the resolver's refuse-rather-than-guess
  // contract turned every real launch into the empty plan: `ready` false forever,
  // `rows`/`datasetIds` `[]`, and the view's run action launching with no mounts at all.
  //
  // So the presence of both keys is asserted directly, on every slice that selects this
  // resolver, wherever a view happens to declare one.
  it('every shipped `integration_grid` slice declares BOTH axes', () => {
    const slices: Array<{ file: string; key: string; args: Record<string, unknown> }> = []
    for (const { file, doc } of shippedViews()) {
      const data = (doc as { data?: Record<string, { source?: unknown; args?: unknown }> } | undefined)?.data ?? {}
      for (const [key, decl] of Object.entries(data)) {
        if (decl?.source !== INTEGRATION_GRID_SOURCE) continue
        slices.push({ file, key, args: (decl.args ?? {}) as Record<string, unknown> })
      }
    }
    // Non-vacuity first: with no slice found this test would pass while checking nothing,
    // which is the failure mode it exists to close.
    expect(slices.length, `no shipped view declares a "${INTEGRATION_GRID_SOURCE}" slice`).toBeGreaterThan(0)
    const missing = slices.flatMap(s =>
      (['entity_axis', 'level_axis'] as const)
        .filter(k => typeof s.args[k] !== 'string' || s.args[k] === '')
        .map(k => `${s.file} → data.${s.key} is missing "${k}"`),
    )
    expect(
      missing,
      'the resolver carries no default for either axis and answers the EMPTY plan without ' +
        `them, so an omission is a form that can never launch:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })
})
