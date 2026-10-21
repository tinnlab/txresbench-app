// spatial-coordinate-binding.spec.ts — #228 TEST-6 and TEST-17.
//
// The BINDING, end to end: a real emitted raster and a real set of spot coordinates, in one
// project, in one declared `coordinate_space`, read by the real production data source through
// the real byte plane, in a real browser with software GL. Nothing is mocked — `page.route()` is
// not used, per this suite's standing rule.
//
// ── THE CONTROL, AND WHY IT IS A SECOND PROJECT RATHER THAN A SECOND ASSERTION ───────────────
//
// "The overlay rendered" is not observable from a screenshot of one project: a pane with a
// picture and no points looks exactly like a pane whose overlay never mounted. So this seeds TWO
// projects that differ in EXACTLY ONE STRING — the `coordinate_space` the coordinates artifact
// declares — and compares what is painted. Same raster bytes, same 160 positions, same camera,
// same viewport.
//
// That shape also removes a question the spec would otherwise have to answer: WHICH layout the
// pane happens to bind. If the pane bound some other layout, neither arm would draw an overlay,
// the two pictures would be identical, and the test FAILS. A vacuous pass is not reachable.
//
// ── AND WHAT A PICTURE CANNOT SHOW ──────────────────────────────────────────────────────────
//
// INV-6: *"a browser can read a slice of a multi-GB artifact without materializing it."* An
// overlay that forced the raster to be read whole would paint an identical image. So the bytes
// are counted too, in the same SHAPE `spatial-image-render.spec.ts` uses for the raster alone —
// the artifact's own stored tile and level lengths rather than a share of its size — and the
// figure is recorded against the TILED layout #227 made the writer emit and #259 refreshed this
// corpus to (512x512 at every pyramid level).

import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, openWorkbench, trackErrors } from '../14-workbench/_dock'
import { postSeedPlan, seededId } from '../14-declarative-qc/_seed'
import { ENTITY_AXIS, POSITIONS_MEMBER, zarrArrayMembers } from '../14-declarative-qc/_fixtures'

// Software WebGL, for THIS FILE ONLY — the same arguments `playwright.viz.config.ts` passes, and
// declared here rather than in the shared config so no other suite's browser changes.
test.use({
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  },
})

const VIZ_FIXTURES = path.resolve(process.cwd(), '../libs/viz/src/viz-core/spatial/fixtures')
const RASTER = path.join(VIZ_FIXTURES, 'spatial-image-hires.ome.tif')

const MANIFEST = JSON.parse(
  readFileSync(path.join(VIZ_FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; datatype: string; structure: unknown; meta: Record<string, unknown> }[]
const ENTRY = MANIFEST.find(e => e.id === 'spatial-image-hires')!

/** The artifact-derived byte quantities the #259 bounds below are stated against — the stored
 *  length of one level-0 tile and of the whole coarsest level, read out of the committed file's
 *  own `TileByteCounts` by `make-emitted-image-fixtures.py --oracle`. Stated against the artifact
 *  rather than as a share of its size, so the bound keeps its meaning at any artifact size. */
const ORACLE = JSON.parse(
  readFileSync(path.join(VIZ_FIXTURES, 'pixel-oracle.json'), 'utf8'),
) as Record<string, number | string | number[]>
/** The producer's own space id — not typed here, read from the emitted manifest entry. */
const SPACE = ENTRY.meta.coordinate_space as string
/** A DIFFERENT section's frame. One string apart, and it is the whole control. */
const OTHER_SPACE = `${SPACE}__sectionB`

/** The vendor's own 160 spot positions, in full-resolution pixels — which IS this space. */
const VENDOR = JSON.parse(
  readFileSync(path.join(VIZ_FIXTURES, 'vendor-spot-positions.json'), 'utf8'),
) as { datatype: string; spots: { x: number; y: number }[] }
const N_SPOTS = VENDOR.spots.length
/**
 * The datatype the coordinates artifact is seeded as, READ FROM THE FIXTURE rather than typed —
 * the same trick `spatial-image-render.spec.ts` uses for the raster's id, and for the same reason:
 * the app tier carries zero of the domain lattice.
 *
 * It matters WHICH type, and the first cut of this spec got it wrong by seeding an ordinary
 * COMPUTED-LAYOUT type. A coordinate frame is harvested only from an artifact whose datatype
 * declares the `spatial-coordinates` capability (INV-1: *"Tables CAN NOT have a coordinate
 * system"*), so a computed-layout artifact carrying a `coordinate_space` in its `meta` is
 * correctly ignored — and BOTH arms of the comparison below then drew no overlay and painted the
 * same picture. The test said exactly that ("if the picture is the same, the overlay never
 * rendered in either") and it was right.
 *
 * (The word this paragraph does NOT use for that type is itself the point: `ui/tests` is a scanned
 * root for `lint-no-domain-in-builtin`, and the first draft of this very comment — about the app
 * carrying zero of the domain lattice — spelled a domain noun twice and reddened the lint.)
 */
const COORDS_DATATYPE = VENDOR.datatype

/** Seed a project holding the real raster and the real spots, in `layoutSpace`. */
async function seedBoundProject(
  request: import('@playwright/test').APIRequestContext,
  layoutSpace: string,
) {
  const bytes = readFileSync(RASTER)
  const token = await ownerToken(request)
  const project = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `binding ${layoutSpace} ${Date.now()}`, description: '' },
    })
  ).json()

  const values: number[] = []
  for (const s of VENDOR.spots) values.push(s.x, s.y)

  // The COORDINATES artifact: the same positions-shaped zarr store the shipped writer emits
  // (which is exactly what §6.2 says `spatial/coordinates` is), carrying the vendor's own
  // numbers and the producer's coordinate-space declaration in `meta`.
  await postSeedPlan(request, project.id, {
    artifacts: [
      {
        output_id: 'spots',
        datatype: COORDS_DATATYPE,
        structure: {
          encoding: 'zarr_v3',
          kind: 'table',
          axis: ENTITY_AXIS,
          n: N_SPOTS,
          columns: [],
          arrays: [{ path: POSITIONS_MEMBER, kind: 'numeric', dtype: 'float32', shape: [N_SPOTS, 2] }],
        },
        meta: {
          coordinate_space: layoutSpace,
          unit: 'pixel',
          // identity: a Visium import states its coordinates IN the space (`import_visium.py`)
          to_space: [1, 0, 0, 0, 1, 0],
        },
        content: {
          encoding: 'members',
          members: zarrArrayMembers(POSITIONS_MEMBER, values, {
            encoding: 'f32',
            dtype: 'float32',
            width: 2,
          }),
        },
      },
    ],
  })

  // …and the RASTER, whose own `meta` (the producer's) names `SPACE` in both arms.
  const seeded = await postSeedPlan(
    request,
    project.id,
    {
      artifacts: [
        {
          output_id: ENTRY.id,
          datatype: ENTRY.datatype,
          structure: ENTRY.structure,
          meta: ENTRY.meta as unknown,
          content: { encoding: 'input' },
        },
      ],
    },
    bytes,
  )
  const artifactId = seededId(seeded, ENTRY.id)
  expect(artifactId, 'the seed engine catalogued the raster').toBeTruthy()
  return { projectId: project.id as string, artifactId: artifactId as string, byteLength: bytes.byteLength }
}

// Every artifact byte-plane request the page issues, with its `?range=`. (A line comment, not a
// JSDoc block: the route pattern contains `*` followed by `/`, which closes a block comment and
// turns the rest of the line into code — a LEXICAL break whose first reported error lands a
// hundred lines later, which is exactly how long it takes to find.)
function trackDataRequests(page: Page) {
  const seen: { url: string; range: string | null; status?: number }[] = []
  page.on('request', r => {
    const u = new URL(r.url())
    if (/\/api\/artifacts\/[^/]+\/data/.test(u.pathname)) {
      seen.push({ url: u.pathname, range: u.searchParams.get('range') })
    }
  })
  page.on('response', async r => {
    const u = new URL(r.url())
    if (/\/api\/artifacts\/[^/]+\/data/.test(u.pathname)) {
      const hit = seen.find(s => s.url === u.pathname && s.status === undefined)
      if (hit) hit.status = r.status()
    }
  })
  return seen
}

/** Read the largest on-screen canvas back and describe what is painted on it. */
async function paintedCanvas(page: Page): Promise<{
  sampled: number
  opaque: number
  distinct: number
  digest: string
} | null> {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[]
    const c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0]
    if (!c || c.width === 0) return null
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')
    if (!ctx) return null
    try {
      ctx.drawImage(c, 0, 0)
      const { data } = ctx.getImageData(0, 0, off.width, off.height)
      const seen = new Set<number>()
      let sampled = 0
      let opaque = 0
      let h = 2166136261
      for (let i = 0; i < data.length; i += 4 * 37) {
        sampled++
        if (data[i + 3] > 0) {
          opaque++
          seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
        }
        h = ((h ^ data[i]) * 16777619) >>> 0
        h = ((h ^ data[i + 1]) * 16777619) >>> 0
        h = ((h ^ data[i + 2]) * 16777619) >>> 0
      }
      return { sampled, opaque, distinct: seen.size, digest: String(h) }
    } catch {
      return null
    }
  })
}

/** Switch the first grid pane to the raster kind, through the shipped switcher. */
async function switchPaneToRaster(page: Page): Promise<void> {
  const switcher = page
    .locator('[aria-label^="View kind for "], [aria-label^="Plot type: "]')
    .first()
  await expect(switcher, 'the shipped chart-kind switcher is on screen').toBeVisible({ timeout: 60_000 })
  await switcher.click()
  const option = page.getByRole('option', { name: 'image', exact: true })
  await expect(
    option,
    'the raster kind must be OFFERED — it is gated on the catalog reporting a spatial substrate',
  ).toBeVisible({ timeout: 30_000 })
  await option.click()
  await page.waitForTimeout(4000)
}

test('TEST-6 [acceptance] [invariant: INV-6] the BOUND overlay renders, and still reads a slice', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const bag = trackErrors(page)
  const bound = await seedBoundProject(request, SPACE)
  const reads = trackDataRequests(page)

  await loginAsOwner(page)
  await openWorkbench(page, bound.projectId)
  await switchPaneToRaster(page)

  const painted = await paintedCanvas(page)
  expect(painted, 'the pane paints').not.toBeNull()
  expect(painted!.opaque, 'opaque pixels are on screen').toBeGreaterThan(0)
  expect(painted!.distinct, 'a picture, not a uniform fill').toBeGreaterThan(8)

  // ── INV-6: a SLICE, not the object ────────────────────────────────────────────────────────
  const rasterReads = reads.filter(r => r.url.includes(bound.artifactId))
  expect(rasterReads.length, 'the raster was read at all').toBeGreaterThan(0)
  for (const r of rasterReads) {
    expect(r.range, `every raster read carries a range: ${r.url}`).not.toBeNull()
    expect([200, 206]).toContain(r.status ?? 200)
  }
  const total = rasterReads.reduce((n, r) => {
    const [a, b] = (r.range ?? '0-0').split('-').map(Number)
    return n + (b - a + 1)
  }, 0)
  console.log(
    `[#228 TEST-6] ${rasterReads.length} ranged reads, ${total} of ${bound.byteLength} bytes ` +
      `(${((100 * total) / bound.byteLength).toFixed(1)}%) — against the TILED layout #227 emits, ` +
      'so a viewport tile is one 512x512 block and one ranged read.',
  )
  // ── #259 TEST-12: THE BOUND, RE-DERIVED AGAINST THE TILED ARTIFACT ──────────────────────
  //
  // This was `byteLength / 3` — 55,612 bytes here — a share of the file size wearing the shape
  // of a bound, and loosened in the first place because the emitted layout was stripped. Both
  // reasons are gone. It is now stated in the artifact's own quantities, like the render spec's:
  //
  //     the COARSEST level in full        13,442 B   (`hires_coarsest_level_stored_bytes`)
  //   + ONE full-resolution tile          11,060 B   (`hires_level0_tile_x0_y0_stored_bytes`)
  //   + 3x the artifact's non-pixel bytes  6,888 B   (`hires_non_pixel_bytes` — see below)
  //   ────────────────────────────────────────────
  //                                       31,390 B
  //
  // ONE tile rather than the render spec's two: this camera serves the overview, and the
  // measurement says so. MEASURED on this branch, tiled: 6 ranged reads, 18,950 of 166,838 bytes
  // (11.4%) — no level-0 tile at all. The single-tile term is the headroom for one appearing,
  // which is what the same render costs in `spatial-image-render.spec.ts` on the runs where it
  // does (30,010 B — still inside this bound).
  //
  // WHAT THIS BOUND DOES AND DOES NOT ASSERT, stated because the two are easy to conflate. It
  // is an absolute budget on the raster traffic, so it refuses a whole-object read and a
  // fetch-every-tile regression. It does NOT assert the overlay adds ZERO raster reads — that
  // is a DELTA against the same page without the overlay, which this spec does not run, and the
  // budget deliberately carries headroom for one level-0 tile appearing. The delta is evidence
  // rather than assertion, and it is measured: the raster-only render in
  // `spatial-image-render.spec.ts` moves 18,950 B over 6 GETs on the same corpus — this spec's
  // figure to the byte — and 18,754 B over 7 GETs against `spatial-image-hires-stripped.ome.tif`,
  // i.e. the overlay adds no raster read under either layout. Do not read the failure message
  // below as asserting more than the budget.
  //
  // The OPEN's own allowance, DERIVED — not the `2 * 5_508` an earlier cut transcribed into
  // three spec files at once, which is the species of un-anchored number this branch exists to
  // remove. `hires_non_pixel_bytes` is everything in the artifact that is not pixel payload —
  // the TIFF header, the OME-XML and every level's directory, i.e. exactly what an open has to
  // read — derived from the file by `make-emitted-image-fixtures.py --oracle` (2,296 B here).
  // The open costs more than once that because geotiff re-reads its fixed 1024-byte window per
  // level; MEASURED at 5,508 B over 5 ranged GETs, i.e. 2.4x. The allowance is 3x.
  const openBudget = 3 * (ORACLE.hires_non_pixel_bytes as number)
  expect(ORACLE.hires_non_pixel_bytes as number).toBeGreaterThan(0)
  const coarsestLevelBytes = ORACLE.hires_coarsest_level_stored_bytes as number
  const oneTileBytes = ORACLE.hires_level0_tile_x0_y0_stored_bytes as number
  expect(coarsestLevelBytes).toBeGreaterThan(0)
  expect(oneTileBytes).toBeGreaterThan(0)
  expect(
    total,
    'the bound overlay must not have forced a whole-object read: the overlay draws point ' +
      'buffers the pane already holds, so the raster traffic must stay inside the budget the ' +
      'raster-only render already fits in. Budget: the coarsest ' +
      `level (${coarsestLevelBytes}) plus one full-resolution tile (${oneTileBytes}) plus the ` +
      `open (${openBudget}).`,
  ).toBeLessThan(openBudget + coarsestLevelBytes + oneTileBytes)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

test('TEST-6 the overlay is DRIVEN BY THE DECLARED SPACE — one string apart, a different picture', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)
  // TWO projects, identical but for the `coordinate_space` the coordinates artifact declares.
  const bound = await seedBoundProject(request, SPACE)
  const refused = await seedBoundProject(request, OTHER_SPACE)

  await loginAsOwner(page)
  await openWorkbench(page, bound.projectId)
  await switchPaneToRaster(page)
  const boundPaint = await paintedCanvas(page)
  expect(boundPaint).not.toBeNull()

  await openWorkbench(page, refused.projectId)
  await switchPaneToRaster(page)
  const refusedPaint = await paintedCanvas(page)
  expect(refusedPaint).not.toBeNull()

  // The RASTER is drawn in both — a refused binding withdraws the points, never the picture.
  expect(refusedPaint!.opaque, 'the refused pane still draws its raster').toBeGreaterThan(0)
  // …and the two differ, which is the 160 spots. If the pane had bound some OTHER layout, both
  // arms would draw no overlay and these would be equal — so a vacuous pass is not reachable.
  expect(
    boundPaint!.digest,
    'the ONLY difference between these two projects is one declared coordinate_space string; ' +
      'if the picture is the same, the overlay never rendered in either',
  ).not.toBe(refusedPaint!.digest)
})

test('TEST-17 the bound overlay is no worse at a 390px viewport than the surface it lives in', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)
  // ── WHAT THIS CASE HAD TO BECOME, AND WHY — MEASURED, NOT ASSUMED ──────────────────────────
  //
  // It began as "the bound overlay still paints at 390px" and went RED with ZERO opaque pixels.
  // The reason is not the overlay and it is not this item: BELOW 768px THE WORKBENCH RENDERS ITS
  // MOBILE SHELL, whose canvas region collapses to a ~354x1 element that paints nothing at all,
  // for EVERY pane kind. `spatial-image-render.spec.ts`'s own narrow arm found the same wall on
  // the raster alone and documents it at length; this item changes no layout, no component and no
  // stylesheet, so asserting a painted overlay there would be asserting a property of the SHELL
  // and would fail on correct code.
  //
  // Deleting the case would hide a real responsive gap, so it becomes the same TWO-ARM comparison
  // that spec settled on, with this item's arms: the SAME shape of project, narrowed the same way,
  // once with the pane in its DEFAULT kind and once with the bound overlay. If the default pane
  // paints at 390px and the overlay pane does not, that is an overlay-specific responsive defect
  // and this goes red. If NEITHER paints, the gap belongs to the shell and is REPORTED as such.
  //
  // Two projects, not one page narrowed twice, and both reasons are the shipped spec's: widening
  // a narrowed page leaves the collapsed canvas un-re-established, and the pane's plot kind is
  // PERSISTED PER PROJECT, so a "default kind" arm in the same browser would restore the kind the
  // other arm just set — a value compared against itself.
  const errors = trackErrors(page)
  const overlayArm = await seedBoundProject(request, SPACE)
  const controlArm = await seedBoundProject(request, SPACE)
  await loginAsOwner(page)

  // ── ARM B: the bound overlay, established at DESKTOP width, then narrowed ──────────────────
  await openWorkbench(page, overlayArm.projectId)
  await switchPaneToRaster(page)
  // POLLED, not measured once: the bytes arriving is not the same event as the pixels landing,
  // and an immediate read catches the pane mid-resolve — a control that fails on correct code.
  await expect
    .poll(async () => (await paintedCanvas(page))?.distinct ?? 0, {
      message: 'the overlay really is on screen before the reflow — the control',
      timeout: 120_000,
    })
    .toBeGreaterThan(8)
  await page.setViewportSize({ width: 390, height: 780 })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: 'test-results/spatial-binding-narrow.png' }).catch(() => {})
  const overlayAtNarrow = await paintedCanvas(page)
  // The OVERLAY arm's own overflow, measured while that page is still the one on screen.
  const overlayOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )

  // ── ARM A: a SEPARATE project, the DEFAULT pane kind, narrowed the same way ────────────────
  await page.setViewportSize({ width: 390, height: 780 })
  await openWorkbench(page, controlArm.projectId)
  await page.waitForTimeout(3_000)
  const defaultAtNarrow = await paintedCanvas(page)

  // eslint-disable-next-line no-console
  console.log(
    `[#228 TEST-17] at 390px — default pane: ${JSON.stringify(defaultAtNarrow)}; ` +
      `bound-overlay pane: ${JSON.stringify(overlayAtNarrow)}`,
  )

  // THE COMPARISON, with an honest statement of what it can prove. Both arms are measured
  // independently on their own projects, so `>=` is a real relation. Its DISCRIMINATING POWER
  // depends on the shell: while the mobile shell paints nothing for any pane kind, the default
  // arm is 0 and `x >= 0` holds for every x — so today this fails only if the overlay arm returns
  // `null` where the default arm returns a canvas, and it sharpens the moment the shell renders
  // anything. Stated rather than dressed up: the present value is the ATTRIBUTION.
  expect(
    overlayAtNarrow,
    'the overlay arm must at least have a readable canvas where the default arm does',
  ).not.toBeNull()
  expect(
    overlayAtNarrow!.opaque,
    'the bound-overlay pane must paint at least as much at 390px as the default pane kind does — ' +
      'anything less is an overlay-specific responsive defect',
  ).toBeGreaterThanOrEqual(defaultAtNarrow?.opaque ?? 0)

  const defaultOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overlayOverflow, 'no horizontal page scroll at 390px with the OVERLAY pane').toBeLessThanOrEqual(1)
  expect(defaultOverflow, 'no horizontal page scroll at 390px with the default pane').toBeLessThanOrEqual(1)

  expect(errors.errors, `a clean console: ${errors.errors.slice(0, 3).join(' | ')}`).toEqual([])
})
