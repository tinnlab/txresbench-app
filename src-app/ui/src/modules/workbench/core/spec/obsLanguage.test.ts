import { describe, it, expect } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from './schema'
import { createViewStore } from '@/modules/workbench/core/runtime/store'
import { resolveDeclarativeCanvas } from '@/modules/workbench/extensions/canvas/canvasFeed'
import { parseLogicalDatasetId } from '@/modules/workbench/extensions/canvas/canvasBinding'

// ── r3canvas — `obs` IS NO LONGER A NAME CORE KNOWS. ─────────────────────────
//
// This file used to pin the OPPOSITE intent (DEC-J: "`obs` is a RETAINED language
// key; renaming it is a versioned language change"). That framing conflated two
// different things wearing one name, and they split cleanly:
//
//   (A) core code SPECIAL-CASING the literal `'obs'` — 13 sites across
//       `extensions/canvas/{canvasBinding,canvasFeed,viz}` plus 7 schema
//       operand-key declarations in `core/manifest/viewSpec.ts` that forced a
//       processor author to spell a generic columnar operand `obs:`. That was a
//       genuine leak, and r3canvas removed it: the canvas default dataset id is
//       now sourced from the DECLARATION (`canvas.datasets[0].id`), the widget
//       frame fallback from the view's own first `$data` slice, and the kernel
//       operand is spelled `frame:` (with `obs:` dual-accepted so no shipping
//       spec needs a migration).
//
//   (B) the DATA key and the dataset ids — `data: { obs: … }`, `$data.obs`,
//       `datasetId: obs`. Those are DATA, not language. `core/spec/schema.ts`
//       contains ZERO `obs`; the parser never validates a data-slice name; and
//       `evalExpr` resolves `$data.<anything>` structurally. Renaming them would
//       be a `WORKBENCH_API_VERSION` MAJOR break for every third-party package —
//       to change a name the language does not privilege once (A) is fixed. So
//       the shipping YAMLs keep calling their slice `obs`, deliberately.
//
// THIS FILE IS THE NEGATIVE CONTROL for (A). Its job is to prove the privilege is
// gone by CONSTRUCTION: the same view_spec, written twice with the slice named
// `obs` and named `frame`, must parse and resolve IDENTICALLY — same series, same
// catalogs, same keep-mask thinning, same image shorthand, same derived values.
// If it fails, the de-privileging is incomplete, which is exactly what it is here
// to tell you. Do NOT "fix" a failure by re-adding an `obs` special case.

// ── the parameterized spec ───────────────────────────────────────────────────
// ONE builder, the slice name as its only parameter. Anything that differs
// between two instantiations other than the literal name is a privilege.

/** The columnar frame both instantiations read (identical bytes, different key). */
const COLUMNS = {
  nCount: [10, 200, 3000, 40],
  ident: ['s1', 's1', 's2', 's2'],
} as const

/** A second, NAMED base — reached through the `<ds>.<default>` suffix form. */
const NAMED_COLUMNS = {
  nCount: [1, 2],
  ident: ['b1', 'b2'],
} as const

/** A minimal `ImageUnderlay`-shaped payload — exercises the default-base image shorthand. */
const IMAGE = {
  data: new Uint8Array([0, 0, 0, 255]),
  width: 1,
  height: 1,
  channels: 4,
  affine: [1, 0, 0, 0, 1, 0],
}

/**
 * The view_spec under test, with `slice` as the ONLY free variable: it names the
 * `data` key, every `$data.<slice>` ref, the canvas default dataset id, the
 * `<default>.kept` variant and the `<ds>.<default>` suffix form.
 */
function sliceSpec(slice: string): ViewSpec {
  const ref = `$data.${slice}`
  return {
    id: `pin/slice-${slice}`,
    title: `slice pin (${slice})`,
    permission: 'jobs::use',
    state: { criteria: { type: 'list', default: [] } },
    data: { [slice]: { source: 'job.result', args: { path: `/${slice}` } } },
    const: { masks: [[true, false, true, false]] },
    derived: {
      keptMask: { keep_mask: { criteria: '$state.criteria', frame: ref } },
      columns: { columns_of: { frame: ref } },
      catColumns: { columns_of: { frame: ref, only: 'categorical' } },
      categories: { categories_by_column: { frame: ref } },
      // the canvas `mask` binding's target — a real kernel, so the spec is self-contained
      myMask: { or_masks: '$const.masks' },
    },
    widgets: [],
    actions: [],
    canvas: {
      datasets: [{ id: slice }, { id: `${slice}.kept` }, { id: `primary.${slice}` }],
      grid: [
        { id: 'c0', region: { row: 0, col: 0 } },
        { id: 'c1', region: { row: 0, col: 1 } },
        { id: 'c2', region: { row: 0, col: 2 } },
      ],
      mask: '$derived.myMask',
      series: [
        { id: 's_base', type: 'violin', coordId: 'c0', datasetId: slice, encode: { valueKey: 'nCount' } },
        { id: 's_kept', type: 'violin', coordId: 'c1', datasetId: `${slice}.kept`, encode: { valueKey: 'nCount' } },
        {
          id: 's_named',
          type: 'violin',
          coordId: 'c2',
          datasetId: `primary.${slice}`,
          encode: { valueKey: 'nCount' },
        },
      ],
    },
  } as unknown as ViewSpec
}

/** The `$data` record the spec resolves against — keyed by the same free variable. */
function sliceData(slice: string): Record<string, unknown> {
  return {
    [slice]: { ...COLUMNS },
    // the NAMED base the `primary.<slice>` id resolves to (suffix stripped ⇒ base `primary`)
    primary: { ...NAMED_COLUMNS },
    // the DEFAULT-base image shorthand (`imageForBase`'s top-level `image` arm)
    image: IMAGE,
  }
}

function sliceScope(slice: string): Record<string, unknown> {
  return {
    state: { criteria: [] },
    derived: { myMask: [true, false, true, false] },
    const: { masks: [[true, false, true, false]] },
    data: sliceData(slice),
  }
}

/** Erase the slice NAME from a resolved value so two instantiations compare structurally. */
function normalize(value: unknown, slice: string): unknown {
  return JSON.parse(JSON.stringify(value).split(`"${slice}`).join('"<S>').split(`.${slice}`).join('.<S>'))
}

/** Everything the canvas resolution observably produces, name-normalized. */
async function canvasFacts(slice: string): Promise<unknown> {
  const feed = resolveDeclarativeCanvas(sliceSpec(slice), {
    data: sliceData(slice),
    positions: { positions: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]), length: 4 },
    scope: sliceScope(slice),
  })
  if (feed == null) return null
  const ids = [slice, `${slice}.kept`, `primary.${slice}`]
  const datasets: unknown[] = []
  for (const id of ids) {
    const source = await feed.resolver(id)
    const catalog = await source.catalog()
    const positions = await source.positions('metric')
    datasets.push({
      catalog: {
        datasetId: catalog.datasetId,
        pointCount: catalog.pointCount,
        valueColumns: [...catalog.valueColumns].sort(),
        categoricalColumns: catalog.categoricalColumns.map(c => c.id).sort(),
        hasImage: catalog.hasImage,
      },
      // the real injected embedding (default base only) vs the metric fabrication
      positions: Array.from(positions.positions),
      length: positions.length,
    })
  }
  return normalize({ option: feed.option, closeActions: feed.closeActions, datasets }, slice)
}

/** Everything the derived kernels observably produce, name-normalized. */
function derivedFacts(slice: string): unknown {
  const store = createViewStore(sliceSpec(slice), `pin-${slice}`, sliceData(slice))
  const out = normalize(store.derived, slice)
  store.dispose()
  return out
}

// ── 1. the negative control ──────────────────────────────────────────────────

describe('r3canvas — core privileges NO slice name (`frame` resolves exactly like `obs`)', () => {
  it('every spelling PARSES', () => {
    for (const slice of ['obs', 'frame', 'rows']) {
      const parsed = parseViewSpec(sliceSpec(slice))
      expect(parsed.ok, `slice "${slice}" must parse: ${JSON.stringify(parsed)}`).toBe(true)
    }
  })

  it('the canvas resolves IDENTICALLY for a slice named `frame` and one named `obs`', async () => {
    const asObs = await canvasFacts('obs')
    const asFrame = await canvasFacts('frame')
    // A non-null feed is the positive control: if resolution collapsed to null for BOTH,
    // "identical" would be vacuously true.
    expect(asObs, 'the canvas must actually resolve (else the parity below is vacuous)').not.toBeNull()
    expect(asFrame).toEqual(asObs)
  })

  it('a THIRD, unrelated slice name resolves identically too (not an obs/frame special pair)', async () => {
    expect(await canvasFacts('rows')).toEqual(await canvasFacts('obs'))
  })

  it('the `.kept` variant thins by the DECLARED mask under either name', async () => {
    for (const slice of ['obs', 'frame']) {
      const feed = resolveDeclarativeCanvas(sliceSpec(slice), {
        data: sliceData(slice),
        scope: sliceScope(slice),
      })!
      const base = await (await feed.resolver(slice)).catalog()
      const kept = await (await feed.resolver(`${slice}.kept`)).catalog()
      expect(base.pointCount, `base rows (${slice})`).toBe(4)
      // myMask = [true,false,true,false] ⇒ 2 survivors, under EITHER name.
      expect(kept.pointCount, `kept rows (${slice})`).toBe(2)
    }
  })

  it('the DEFAULT-base image shorthand fires under either name', async () => {
    for (const slice of ['obs', 'frame']) {
      const feed = resolveDeclarativeCanvas(sliceSpec(slice), {
        data: sliceData(slice),
        scope: sliceScope(slice),
      })!
      expect((await (await feed.resolver(slice)).catalog()).hasImage, `default base (${slice})`).toBe(true)
      // a NON-default base has no image of its own — the shorthand is default-base-only
      expect((await (await feed.resolver(`primary.${slice}`)).catalog()).hasImage).toBe(false)
    }
  })

  it('the `<ds>.<default>` suffix form strips whatever the declaration named its default', () => {
    expect(parseLogicalDatasetId('primary.obs', 'obs')).toEqual({ base: 'primary', kept: false })
    expect(parseLogicalDatasetId('primary.frame', 'frame')).toEqual({ base: 'primary', kept: false })
    // `.obs` is NOT stripped when the declaration's default is `frame` — the suffix is the
    // DECLARED name, not a name core knows.
    expect(parseLogicalDatasetId('primary.obs', 'frame')).toEqual({ base: 'primary.obs', kept: false })
    // `.kept` is generic (it is language, not a data-slice name) and needs no default.
    expect(parseLogicalDatasetId('frame.kept')).toEqual({ base: 'frame', kept: true })
    expect(parseLogicalDatasetId('anything.kept')).toEqual({ base: 'anything', kept: true })
    // With NO default supplied, a dotted id is its own base — core invents nothing.
    expect(parseLogicalDatasetId('primary.obs')).toEqual({ base: 'primary.obs', kept: false })
  })

  it('the derived kernels resolve IDENTICALLY under either slice name', () => {
    expect(derivedFacts('frame')).toEqual(derivedFacts('obs'))
    expect(derivedFacts('rows')).toEqual(derivedFacts('obs'))
    // positive control — the kernels actually computed something
    const d = derivedFacts('frame') as Record<string, unknown>
    expect(d.keptMask).toEqual([true, true, true, true])
    expect(JSON.stringify(d.columns)).toMatch(/nCount/)
    expect((d.categories as Record<string, string[]>).ident).toEqual(['s1', 's2'])
  })
})

// ── 2. the operand-key rename is DUAL-ACCEPTED ───────────────────────────────
//
// `frame:` is the domain-neutral spelling of the three frame kernels' columnar
// operand; `obs:` is the pre-r3canvas spelling and stays honored, so the two
// shipping YAMLs (`packages/{cell-filter,qc}/ui/*.yaml`) keep working with no
// migration and no `WORKBENCH_API_VERSION` bump. Remove the alias at the next
// MAJOR (`core/version.ts`, gate in `core/manifest/validate.ts`).

describe('r3canvas — the `frame:` operand key dual-accepts the legacy `obs:`', () => {
  function kernelSpec(key: 'frame' | 'obs'): ViewSpec {
    return {
      id: `pin/operand-${key}`,
      title: 'operand pin',
      permission: 'jobs::use',
      state: { criteria: { type: 'list', default: [] } },
      data: { slice: { source: 'job.result', args: { path: '/slice' } } },
      const: {},
      derived: {
        keptMask: { keep_mask: { criteria: '$state.criteria', [key]: '$data.slice' } },
        columns: { columns_of: { [key]: '$data.slice' } },
        catColumns: { columns_of: { [key]: '$data.slice', only: 'categorical' } },
        categories: { categories_by_column: { [key]: '$data.slice' } },
      },
      widgets: [],
      actions: [],
    } as unknown as ViewSpec
  }

  function derivedFor(key: 'frame' | 'obs'): Record<string, unknown> {
    const store = createViewStore(kernelSpec(key), `operand-${key}`, { slice: { ...COLUMNS } })
    const out = JSON.parse(JSON.stringify(store.derived)) as Record<string, unknown>
    store.dispose()
    return out
  }

  it('both spellings parse', () => {
    expect(parseViewSpec(kernelSpec('frame')).ok).toBe(true)
    expect(parseViewSpec(kernelSpec('obs')).ok).toBe(true)
  })

  it('`frame:` and the legacy `obs:` produce identical derived values', () => {
    const viaFrame = derivedFor('frame')
    expect(derivedFor('obs')).toEqual(viaFrame)
    // positive control — not two empty maps
    expect(viaFrame.keptMask).toEqual([true, true, true, true])
    expect((viaFrame.categories as Record<string, string[]>).ident).toEqual(['s1', 's2'])
  })

  it('`frame:` WINS when a spec (mid-migration) carries both', () => {
    const both = {
      id: 'pin/operand-both',
      title: 'operand pin',
      permission: 'jobs::use',
      state: {},
      data: { a: { source: 'job.result' }, b: { source: 'job.result' } },
      const: {},
      derived: { columns: { columns_of: { frame: '$data.a', obs: '$data.b' } } },
      widgets: [],
      actions: [],
    } as unknown as ViewSpec
    const store = createViewStore(both, 'operand-both', { a: { fromA: [1, 2] }, b: { fromB: ['x'] } })
    expect(JSON.stringify(store.derived.columns)).toMatch(/fromA/)
    expect(JSON.stringify(store.derived.columns)).not.toMatch(/fromB/)
    store.dispose()
  })
})

// ── 3. the un-gameable check: no `'obs'` literal survives in core ─────────────
//
// The parity tests above prove BEHAVIOUR. This one proves the CODE: a future edit
// that re-introduces `if (id === 'obs')` or `evalExpr('$data.obs', …)` fails here
// even if it happens to be behaviour-compatible with the fixtures above. Comments
// are stripped first — prose may discuss the history freely; only a CODE literal
// is a privilege.

const CORE_FILES: Record<string, () => Promise<{ default: string }>> = {
  'extensions/canvas/canvasBinding.ts': () =>
    import('@/modules/workbench/extensions/canvas/canvasBinding.ts?raw') as never,
  'extensions/canvas/canvasFeed.ts': () =>
    import('@/modules/workbench/extensions/canvas/canvasFeed.ts?raw') as never,
  'extensions/canvas/viz.tsx': () => import('@/modules/workbench/extensions/canvas/viz.tsx?raw') as never,
  'core/runtime/store.ts': () => import('@/modules/workbench/core/runtime/store.ts?raw') as never,
  'core/spec/schema.ts': () => import('@/modules/workbench/core/spec/schema.ts?raw') as never,
}

/** Strip block comments and `//` line comments (prose is exempt — see above). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('r3canvas — no `obs` string literal survives in the de-privileged core files', () => {
  for (const [label, load] of Object.entries(CORE_FILES)) {
    it(`${label} carries no quoted 'obs' / "obs" literal`, async () => {
      const src = stripComments((await load()).default)
      const hits = src.match(/(['"])obs\1/g) ?? []
      expect(hits, `${label} re-introduced a hardcoded slice name: ${hits.join(', ')}`).toEqual([])
    })
  }

  it('the comment-stripper is sound (negative control — it does not blank everything)', async () => {
    const src = stripComments((await CORE_FILES['core/runtime/store.ts']!()).default)
    // a real code token still present after stripping
    expect(src).toMatch(/createViewStore/)
    // and a literal INSIDE code is still visible to the matcher
    expect(/(['"])obs\1/.test(`const x = 'obs'`)).toBe(true)
  })
})
