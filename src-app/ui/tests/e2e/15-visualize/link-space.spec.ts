// LINK SPACE IS THE COORDINATE ARTIFACT (`docs/design/visualize-pane-feedback.md` #34) —
// driven through the real app, on the owner's own imported shape.
//
// The owner: *"the viz core have options to link zoom and filtering among grid pane … Currently
// it is not working in our visualization … it has todo with the input data series coordinate,
// only same coordinate can be link … if two panes come from the same coordinate set, they should be
// linkable."*
//
// Viz scopes link-zoom (and the shared camera) by `cellSpaceKey`. A pane declares its coordinate
// space to viz through `encode.layout`; this pane declares its coordinates through the app's own
// `coords` / `positionsByArtifact` channel, which `libs/viz` has never heard of. Nothing carried
// the first over to the second, so viz answered out of the catalog — and the canvas source
// declares ONE layout under the fixed id `'metric'` for every base. Measured on this fixture
// before the fix, three panes drawn from THREE DIFFERENT coordinate sets all reported
// `layoutId: 'metric'`: the coordinate the pane was drawn in appeared NOWHERE in the key that
// decides what may share a camera. That is the coordinate-blind-zoom hazard the space scoping was
// written to prevent, and the same `layouts[0]`-shaped guess this work already deleted from
// the DRAWING path — it survived in the LINKING path because nothing joined the two.
//
// Asserted here rather than only in `canvasFeed.test.ts` because the unit test supplies its own
// artifact ids, and the property under test is that the ids the REAL pane captures at emit time
// are the ids that reach viz. The grid is deck.gl/WebGL2 and a headless browser paints no pixel,
// so this reads the app's own read-only pane seam (`window.__canvasPanes`), which now reports
// each pane's resolved `spaceKey` + `layoutId` — viz's OWN answer, read off the resolved grid
// pane, never recomputed from the declaration. The whole of #34 lived in the gap between those two.

import { expect, test, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { coordinateEmits, openVisualize, OWNER_SHAPE, seedOwnerImportedShape } from './_visualize'

const DATASET_NAME = 'Population 1'

/** Each canvas pane's coordinate-space identity, read from the app's own seam. Kept local to this
 *  spec (rather than folded into `_visualize.ts`'s readers) so the file that owns the question
 *  owns the reader. */
async function paneSpaces(
  page: Page,
): Promise<
  Array<{
    id: string
    spaceKey: string | null
    layoutId: string | null
    datasetKey: string | null
    identity: string | null
  }>
> {
  return page.evaluate(() => {
    const read = (window as unknown as { __canvasPanes?: () => Array<Record<string, unknown>> }).__canvasPanes
    return (read ? read() : []).map(p => ({
      id: String(p.id ?? ''),
      spaceKey: (p.spaceKey as string | null) ?? null,
      layoutId: (p.layoutId as string | null) ?? null,
      /** The viz DatasetStore key — the dataset half of the space key, and the identity that was
       *  minted per pane before this change. Read so a failure says WHICH half moved. */
      datasetKey: (p.datasetKey as string | null) ?? null,
      /** The canonical row identity viz pulled for this pane's dataset — the SELECTION half. */
      identity: (p.identity as string | null) ?? null,
    }))
  })
}

/** The measured values, printed on every run: the ledger row is a measurement, and the numbers
 *  behind it should not have to be re-derived by whoever reads this next. */
function reportSpaces(
  label: string,
  panes: Array<{ spaceKey: string | null; datasetKey: string | null; identity: string | null }>,
): void {
  console.log(
    `[#34] ${label}: ${panes.map(p => `${p.datasetKey} ⇒ ${p.spaceKey} [ids ${p.identity}]`).join('  |  ')}`,
  )
}

/** Whether a space key ends in the given coordinate id — the COORDINATE half of a
 *  `${datasetId}:<space-kind>:${layoutId}` key. Asserted by suffix rather than by splitting on
 *  `:`, because the composed dataset id in the leading half carries colons of its own. */
const inCoordinate = (spaceKey: string | null, layoutId: string | null): boolean =>
  !!spaceKey && !!layoutId && spaceKey.endsWith(`:${layoutId}`)

async function openOwnerProject(page: Page, request: import('@playwright/test').APIRequestContext): Promise<void> {
  const projectId = await createProject(request, `link-space ${Date.now()}`)
  await seedOwnerImportedShape(request, projectId, DATASET_NAME)
  await loginAsOwner(page)
  await openVisualize(page, projectId)
}

test.describe('link space follows the coordinate artifact (#34)', () => {
  test('two panes emitted from the SAME coordinate set are in the SAME coordinate space', async ({
    page,
    request,
  }) => {
    await openOwnerProject(page, request)

    const emits = coordinateEmits(page)
    await expect(emits).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })

    // The SAME row pressed twice — two panes drawn from one coordinate set, which is the exact
    // shape of the owner's *"if they come from the same coordinate set"*.
    await emits.first().click()
    await emits.first().click()
    await expect.poll(async () => (await paneSpaces(page)).length, { timeout: 30_000 }).toBe(2)
    // Both halves of the key AND the canonical identity are pulled ASYNCHRONOUSLY by viz (the
    // `DatasetStore` resolves the catalog and the `pointIds` after the pane is placed), so the
    // read waits for the resolution rather than racing it — a first observation of `null` is
    // "not resolved yet", which `__canvasPanes` documents and a poll is the correct reader for.
    await expect
      .poll(async () => (await paneSpaces(page)).every(p => p.layoutId != null && p.identity != null), {
        timeout: 30_000,
      })
      .toBe(true)

    const panes = await paneSpaces(page)
    reportSpaces('SAME coordinate set, two panes', panes)
    // The layout each pane reports is the ARTIFACT it was drawn in — no longer the catalog's
    // fixed `'metric'`, which is what every pane on this fixture used to report.
    expect(panes[0].layoutId).not.toBe('metric')
    expect(panes[0].layoutId).toBe(panes[1].layoutId)
    // …and therefore both space keys end in the SAME coordinate.
    expect(inCoordinate(panes[0].spaceKey, panes[0].layoutId)).toBe(true)
    expect(inCoordinate(panes[1].spaceKey, panes[0].layoutId)).toBe(true)

    // ── THE OTHER HALF, NOW CLOSED (see `canvasFeed.ts::sharedCoordinateBase`) ─────────────
    //
    // `cellSpaceKey` is `${datasetId}:<space-kind>:${layoutId}`. This assertion USED TO BE ITS
    // OPPOSITE — a ratchet pinning that the two keys still differed, because every section minted
    // one dataset id PER EMITTED PANE and a viz dataset is also a selection space, so the panes
    // were read as needing to brush independently. The owner's correction is that they are the
    // same rows twice: a base per pane duplicated the positions and the columns for nothing, and
    // linking is opt-in via the link group regardless, so a shared base makes linking POSSIBLE
    // without making it happen. Panes drawn in one coordinate set therefore share ONE base — one
    // dataset key, one space key — and the ratchet is inverted rather than deleted.
    expect(panes[0].datasetKey).toBe(panes[1].datasetKey)
    expect(panes[0].spaceKey).toBe(panes[1].spaceKey)
    // And the SELECTION half: one base, one set of canonical row ids, so a filter in either pane
    // lands on the same rows in the other. Sharing the base changes which space a pane publishes
    // into, so it is asserted rather than assumed.
    expect(panes[0].identity).not.toBeNull()
    expect(panes[0].identity).toBe(panes[1].identity)
  })

  // THE NEGATIVE CONTROL — the direction that rots silently, because "nothing links" looks
  // identical whether the scoping is right or absent. This fixture is built for it: every
  // coordinate set carries the SAME declared display name (the datatype word), so the sets can
  // only be told apart by identity, which is precisely what the key must carry.
  test('two panes emitted from DIFFERENT coordinate sets are in DIFFERENT coordinate spaces', async ({
    page,
    request,
  }) => {
    await openOwnerProject(page, request)

    const emits = coordinateEmits(page)
    await expect(emits).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })

    await emits.first().click()
    await emits.nth(1).click()
    await expect.poll(async () => (await paneSpaces(page)).length, { timeout: 30_000 }).toBe(2)
    // Both halves of the key AND the canonical identity are pulled ASYNCHRONOUSLY by viz (the
    // `DatasetStore` resolves the catalog and the `pointIds` after the pane is placed), so the
    // read waits for the resolution rather than racing it — a first observation of `null` is
    // "not resolved yet", which `__canvasPanes` documents and a poll is the correct reader for.
    await expect
      .poll(async () => (await paneSpaces(page)).every(p => p.layoutId != null && p.identity != null), {
        timeout: 30_000,
      })
      .toBe(true)

    const panes = await paneSpaces(page)
    reportSpaces('DIFFERENT coordinate sets, two panes', panes)
    // ITEM-10's REAL case, preserved: two panes over different rows keep separate bases, so a
    // brush in one cannot bleed into the other. This is the direction that rots silently, since
    // "nothing links" looks identical whether the scoping is right or absent.
    expect(panes[0].datasetKey).not.toBe(panes[1].datasetKey)
    // …and their canonical ids are DISJOINT ranges, so even in viz's shared canonical selection
    // space a selection made in one cannot resolve to a row of the other. Overlap of even one id
    // would highlight a row in a set of rows it does not belong to.
    const range = (v: string | null) => {
      const m = /^(\d+)\.\.(\d+)\//.exec(v ?? '')
      return m ? [Number(m[1]), Number(m[2])] : null
    }
    const [a, b] = [range(panes[0].identity), range(panes[1].identity)]
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a![1] < b![0] || b![1] < a![0]).toBe(true)
    // Before the fix BOTH of these were `'metric'`: two genuinely different coordinate sets,
    // indistinguishable in the key that decides what shares a camera.
    expect(panes[0].layoutId).not.toBe('metric')
    expect(panes[1].layoutId).not.toBe('metric')
    expect(panes[0].layoutId).not.toBe(panes[1].layoutId)
    // Neither pane's key ends in the OTHER's coordinate — the halves are genuinely distinct,
    // not merely two different dataset identities over one coordinate.
    expect(inCoordinate(panes[0].spaceKey, panes[1].layoutId)).toBe(false)
    expect(inCoordinate(panes[1].spaceKey, panes[0].layoutId)).toBe(false)
    expect(panes[0].spaceKey).not.toBe(panes[1].spaceKey)
  })
})
