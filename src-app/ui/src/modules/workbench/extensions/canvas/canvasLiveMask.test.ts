// canvasLiveMask.test.ts — the LIVE half of the before/after contract, driven through the REAL
// `VizController` rather than asserted on the resolved option alone.
//
// WHY IT NEEDS THE CONTROLLER. `resolveDeclarativeCanvas` already returns a resolver whose
// `.kept` source carries the current mask, and a test that only calls that resolver passes with
// the mask link completely broken — because the break is not in the resolution, it is in the
// HANDOFF. `VizController.applyOption` resolves a dataset id through `DatasetStore.acquire`, which
// REUSES an entry by id; what makes it ask again is the per-dataset `rev` content token on
// `VizDataset`. That token was documented and implemented nowhere, so a second `setOption`
// carrying a tighter mask re-published the same ids, the store handed back the FIRST source, and
// the "after" pane kept painting the unfiltered rows.
//
// The assertions therefore read the DATASET STORE's resolved catalog — the thing the grid
// actually renders from — not the feed's own resolver.
//
// TWO properties, not one. The mask link is the defect that was reported, and it is asserted
// first. But it was once bought by putting a digest of the content INTO the dataset id, which
// invalidates just as well and mints a new dataset IDENTITY on every edit — and a resolved dataset
// is an identity space, so that silently resets whatever is keyed to it. So the id's STABILITY
// across a content change is asserted too, alongside the reshape: a test of either alone passes on
// an implementation that gets the other exactly backwards.

import { describe, expect, it } from 'vitest'
import { createVizStores, installBuiltinSchemas, VizController, type DatasetResolver } from '@ziee/viz'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { resolveDeclarativeCanvas } from './canvasFeed'

/** A minimal before/after declaration in the shape a filtering surface uses: two logical datasets,
 *  a declared `mask`, and one series per side bound to the same value column. */
const SPEC = {
  id: 'view.mask',
  title: 'Mask',
  canvas: {
    datasets: [{ id: 'frame' }, { id: 'frame.kept' }],
    grid: [],
    mask: '$derived.keptMask',
    series: [
      { id: 's-before', type: 'violin', coordId: 'before', datasetId: 'frame', encode: { valueKey: 'depth' } },
      { id: 's-after', type: 'violin', coordId: 'after', datasetId: 'frame.kept', encode: { valueKey: 'depth' } },
    ],
  },
} as unknown as ViewSpec

const columns = () => ({ depth: [1, 2, 3, 4, 5, 6] })
const frame = columns()

type Feed = NonNullable<ReturnType<typeof resolveDeclarativeCanvas>>

function publish(keptMask: readonly boolean[], slice: Record<string, unknown[]> = frame): Feed {
  const data = { frame: slice }
  const feed = resolveDeclarativeCanvas(SPEC, {
    data,
    scope: { params: {}, state: {}, derived: { keptMask }, const: {}, data },
  })
  expect(feed, 'the declaration resolves to a plottable feed').not.toBeNull()
  return feed!
}

/** The dataset id a resolved series ended up bound to — the identity viz reuses by. */
const boundId = (f: Feed, seriesId: string) => f.option.series.find(s => s.id === seriesId)!.datasetId

/** The `rev` published for the dataset a series binds — the CONTENT token viz re-resolves on. */
const boundRev = (f: Feed, seriesId: string) =>
  f.option.datasets!.find(d => d.id === boundId(f, seriesId))!.rev

/** A stand-in for `CanvasView`: ONE long-lived controller whose resolver ref is refreshed on every
 *  publish and which is re-driven with `{ replace: true }` — the exact live-loop shape. */
function canvasHarness() {
  installBuiltinSchemas()
  const stores = createVizStores()
  let resolver: DatasetResolver | null = null
  const controller = new VizController({
    resolveDataset: (id: string) => {
      if (!resolver) throw new Error('no resolver published yet')
      return resolver(id)
    },
    stores,
  })
  return {
    async drive(feed: Feed): Promise<void> {
      resolver = feed.resolver
      await controller.setOption(feed.option, { replace: true })
    },
    /** How many rows the pane painting `seriesId` actually resolved — read off the DATASET STORE
     *  entry for whatever dataset id that series binds, so the assertion never depends on how the
     *  feed names its datasets. */
    rows(feed: Feed, seriesId: string): number | undefined {
      const series = feed.option.series.find(s => s.id === seriesId)
      expect(series, `the option carries a series "${seriesId}"`).toBeDefined()
      const dsId = series!.datasetId ?? feed.option.datasets?.[0]?.id
      expect(dsId, `series "${seriesId}" binds a dataset`).toBeDefined()
      return stores.datasetStore.getState().getEntry(dsId!)?.catalog?.pointCount
    },
    /** Every id the store currently holds an entry under, sorted — the set a content-addressed
     *  id churns and a stable one does not. */
    entryIds(): string[] {
      return Object.keys(stores.datasetStore.getState().datasets).sort()
    },
  }
}

describe('the AFTER pane follows the live keep-mask', () => {
  it('re-driving the SAME controller with a tighter mask re-resolves the .kept dataset', async () => {
    const canvas = canvasHarness()

    const first = publish([true, true, true, true, true, true])
    await canvas.drive(first)
    expect(canvas.rows(first, 's-after'), 'an all-true mask keeps every row').toBe(6)

    // The user tightens the criterion: the derived mask now keeps 2 of 6.
    const second = publish([true, true, false, false, false, false])
    await canvas.drive(second)
    expect(
      canvas.rows(second, 's-after'),
      'the AFTER pane still reports the pre-edit row count — editing a criterion did not reshape ' +
        'the plot. The resolver carries the new mask; the DatasetStore reused the entry it already ' +
        'held for this id and never asked for it again.',
    ).toBe(2)

    // …and the BEFORE side is untouched by the mask, which is what makes the pair a comparison.
    expect(canvas.rows(second, 's-before'), 'the BEFORE side never masks').toBe(6)
  })

  it('loosening the mask again re-widens the .kept dataset (not a one-way narrowing)', async () => {
    const canvas = canvasHarness()

    const tight = publish([true, false, false, false, false, false])
    await canvas.drive(tight)
    expect(canvas.rows(tight, 's-after')).toBe(1)

    const loose = publish([true, true, true, true, false, false])
    await canvas.drive(loose)
    expect(canvas.rows(loose, 's-after'), 'relaxing a threshold must bring rows BACK').toBe(4)
  })

  it('an UNCHANGED mask keeps the same dataset revision, so viz\'s identity reuse still applies', async () => {
    const canvas = canvasHarness()
    const a = publish([true, true, false, false, false, false])
    await canvas.drive(a)
    // A re-publish carrying an equal-but-not-identical mask array (the derive rebuilds it on every
    // state change) must NOT re-resolve the dataset — the revision is over the mask's CONTENT.
    // A differing revision here would send every keystroke through a full re-resolve.
    const b = publish([true, true, false, false, false, false])
    expect(boundRev(b, 's-after'), 'an unchanged mask re-publishes the same revision').toBe(
      boundRev(a, 's-after'),
    )
    await canvas.drive(b)
    expect(canvas.rows(b, 's-after')).toBe(2)
  })

  // The revision must be a function of the CONTENT, not of when the object holding it was built. A
  // monotonic "this object is new" token invalidates just as correctly and is cheaper, but it makes
  // two structurally identical resolutions disagree — which re-resolves the dataset (and re-runs the
  // per-column filter behind it) every time `$data` is replaced with equal content, and breaks the
  // slice-name parity invariant pinned under `core/spec/`.
  it('a REBUILT slice with equal content resolves to the SAME revisions', () => {
    const mask = [true, true, false, false, false, false]
    const first = publish(mask, columns())
    const second = publish(mask, columns()) // a different object, identical content
    expect(boundRev(second, 's-before')).toBe(boundRev(first, 's-before'))
    expect(boundRev(second, 's-after')).toBe(boundRev(first, 's-after'))
  })

  it('a slice whose VALUES changed gets a NEW revision (the base is content-tracked too)', () => {
    const mask = [true, true, true, true, true, true]
    const first = publish(mask, columns())
    const edited = { ...columns(), depth: [1, 2, 3, 4, 5, 99] }
    expect(boundRev(publish(mask, edited), 's-before')).not.toBe(boundRev(first, 's-before'))
  })
})

// ── the dataset IDENTITY survives a content change ──────────────────────────────────────────────
//
// The reshape above was once bought by encoding the content digest into the dataset ID, which
// makes the id a function of the content: every edit published a DIFFERENT identity, viz resolved
// a fresh entry and released the old one, and everything keyed to the retired identity went with
// it. Nothing asserted that, so the cost was invisible from the suite — the reshape tests pass
// either way, which is exactly why these are separate.
describe('a content change re-resolves the dataset WITHOUT re-identifying it', () => {
  it('publishes the same id before and after, while the rows follow the mask', async () => {
    const canvas = canvasHarness()

    const before = publish([true, true, true, true, true, true])
    await canvas.drive(before)
    expect(canvas.rows(before, 's-after')).toBe(6)
    const idBefore = boundId(before, 's-after')
    const entriesBefore = canvas.entryIds()

    const after = publish([true, true, false, false, false, false])
    await canvas.drive(after)

    // 1. the content really did change — otherwise "the id is stable" is vacuous.
    expect(canvas.rows(after, 's-after'), 'the mask must actually have reshaped the pane').toBe(2)
    expect(boundRev(after, 's-after'), 'new content ⇒ a new revision').not.toBe(
      boundRev(before, 's-after'),
    )
    // 2. …and the identity it reshaped under is the one it started with.
    expect(
      boundId(after, 's-after'),
      'the dataset id changed with its content. Encoding the digest in the id invalidates just as ' +
        'well, but it retires the identity — and a resolved dataset is an identity space, so ' +
        'anything keyed to it (a brush/gate above all) is silently discarded on every edit. The ' +
        'digest belongs in `rev`, which viz re-resolves on and which leaves the space standing.',
    ).toBe(idBefore)
    // 3. and the store agrees: re-resolved IN PLACE, not swapped for a differently-keyed entry.
    expect(canvas.entryIds(), 'the store holds the same dataset ids it did before the edit').toEqual(
      entriesBefore,
    )
  })

  it('the id is the one the DECLARATION wrote — no host-minted decoration on the wire', () => {
    // The declaration's vocabulary IS the wire vocabulary; a resolver, a close router and the e2e
    // seam all read these ids back. Decorating them is what forced the reverse map that used to
    // translate them, so this pins the absence of any decoration rather than one spelling of it.
    const feed = publish([true, true, false, false, false, false])
    expect(feed.option.datasets?.map(d => d.id).sort()).toEqual(['frame', 'frame.kept'])
    expect(boundId(feed, 's-before')).toBe('frame')
    expect(boundId(feed, 's-after')).toBe('frame.kept')
  })
})

// ── a mask that keeps NOTHING is an answer, not a schema change ──────────────────────────────────
//
// Tightening a criterion past its last surviving row is an ordinary thing a user does — a threshold sweep
// passes through it on the way to a sensible bound — and the honest render is an EMPTY
// distribution. What happened instead: the `.kept` source classified its columns from the rows
// that survived, so an empty survivor set left every column a zero-length array, `depth` was
// published as CATEGORICAL (an empty array is not numeric, and it is too short to be a per-row
// identifier), and the frame advertised no `value` column at all. A violin needs exactly one, so
// viz refused the option — and `setOption` is per-GRID, so the BEFORE pane froze at the previous
// threshold beside it, with a `[CanvasView] VizController.setOption failed` per render as the
// only trace.
//
// The `switchTo` list is the declaration a contributed row-filter analysis actually ships, and it is what turned the
// under-reported catalog into a hard throw at parse (`resolveSwitchTo` → `schemaSatisfiable`)
// rather than an empty pane. It is here so the test fails the way the surface did.
const EMPTY_SPEC = {
  id: 'view.mask.empty',
  title: 'Mask',
  canvas: {
    datasets: [{ id: 'frame' }, { id: 'frame.kept' }],
    grid: [],
    mask: '$derived.keptMask',
    series: [
      {
        id: 's-before',
        type: 'violin',
        coordId: 'before',
        datasetId: 'frame',
        switchTo: ['violin', 'box', 'histogram'],
        encode: { valueKey: 'depth' },
      },
      {
        id: 's-after',
        type: 'violin',
        coordId: 'after',
        datasetId: 'frame.kept',
        switchTo: ['violin', 'box', 'histogram'],
        encode: { valueKey: 'depth' },
      },
    ],
  },
} as unknown as ViewSpec

/** Publish `EMPTY_SPEC` under `keptMask` over a frame carrying one numeric + one categorical column. */
function publishEmptySpec(keptMask: readonly boolean[]): Feed {
  const slice = { depth: [1, 2, 3, 4, 5, 6], phase: ['g1', 's', 'g2', 'g1', 's', 'g2'] }
  const data = { frame: slice }
  const feed = resolveDeclarativeCanvas(EMPTY_SPEC, {
    data,
    scope: { params: {}, state: {}, derived: { keptMask }, const: {}, data },
  })
  expect(feed, 'the declaration resolves to a plottable feed').not.toBeNull()
  return feed!
}

const NONE_KEPT = [false, false, false, false, false, false]
const ALL_KEPT = [true, true, true, true, true, true]

describe('a keep-mask that empties the frame keeps the frame’s SCHEMA', () => {
  it('the .kept catalog reports the same column kinds as its base', async () => {
    const feed = publishEmptySpec(NONE_KEPT)
    const catalogOf = async (id: string) => (await feed.resolver(id)).catalog()
    const base = await catalogOf('frame')
    const kept = await catalogOf('frame.kept')

    // The rows really are gone — otherwise everything below is vacuous.
    expect(base.pointCount, 'the base is unmasked').toBe(6)
    expect(kept.pointCount, 'the mask kept nothing').toBe(0)

    // …and the SCHEMA is unchanged by that, because a `.kept` dataset is a row-subset VIEW.
    expect(kept.valueColumns, 'a numeric column is still a value column with no rows in it').toEqual(
      base.valueColumns,
    )
    expect(kept.continuousColumns.map(c => c.id)).toEqual(base.continuousColumns.map(c => c.id))
    expect(kept.categoricalColumns.map(c => c.id)).toEqual(base.categoricalColumns.map(c => c.id))

    // The negative control on the misclassification specifically: `depth` must not have MOVED
    // channels. Asserting only "no value columns is wrong" would pass on a catalog that dropped it
    // from every channel; it was in fact published as a category axis.
    expect(
      kept.categoricalColumns.map(c => c.id),
      'the numeric metric was advertised as a CATEGORY axis once its rows were gone',
    ).not.toContain('depth')
    expect(kept.valueColumns).toContain('depth')
  })

  it('driving the real controller with an empty .kept renders both panes instead of refusing the option', async () => {
    const canvas = canvasHarness()

    // A sane threshold first, so the "after" pane has a previous state to freeze at.
    const some = publishEmptySpec([true, true, false, false, false, false])
    await canvas.drive(some)
    expect(canvas.rows(some, 's-after')).toBe(2)

    // The user tightens past the last surviving row. This is where `setOption` used to REJECT.
    const none = publishEmptySpec(NONE_KEPT)
    await canvas.drive(none)

    expect(canvas.rows(none, 's-after'), 'the after pane paints its own empty distribution').toBe(0)
    // The cost of a rejected option was never confined to the pane that caused it: `setOption` is
    // per-grid, so the BEFORE side stopped following the data too.
    expect(canvas.rows(none, 's-before'), 'the unmasked side keeps every row throughout').toBe(6)

    // …and it comes back. An empty selection must not be a terminal state for the canvas.
    const again = publishEmptySpec(ALL_KEPT)
    await canvas.drive(again)
    expect(canvas.rows(again, 's-after'), 'relaxing the threshold repopulates the after pane').toBe(6)
  })
})
