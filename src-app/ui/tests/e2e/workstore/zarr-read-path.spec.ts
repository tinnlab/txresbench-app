import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, openWorkbench, trackErrors } from '../14-workbench/_dock'
import { seedPlottableProject, type SeedPlottableResult } from '../14-declarative-qc/_seed'

// TEST-30 + TEST-32 [artifact-model · ITEM-25 / ITEM-12].
//
// The acceptance criterion for deleting `/read` is a NEGATIVE one that no unit test can
// state: a POPULATED surface must render the same values it always did, through the
// chunked byte path, with the deleted endpoint never touched. So this drives the RUNNING
// app against the REAL backend with NO route mocking, seeds a project whose artifacts
// declare real `structure` documents, and asserts three things:
//
//   1. the SAME values come back through the new path (the decode is correct);
//   2. NOTHING requests `/read` (the old path is not silently still in use);
//   3. the requests are CHUNK-GRANULAR — many small ranged reads of specific members,
//      not one whole-artifact fetch. This is the one that would silently regress: a
//      client that fetched `/data` with no `Range:` would look identical from the
//      rendered output and be catastrophic on a 368 MB artifact.
//
// TEST-32 adds the 390px narrow-viewport render the UI-surface checklist requires for
// any surface whose data path moves.

/** A `/read` request is a hard failure, not a soft signal: the route is deleted, so a
 *  request to it means a caller was never rewired and is now getting a 404 it may be
 *  swallowing. Collected across the whole page lifetime. */
function trackReadPathRequests(page: import('@playwright/test').Page) {
  const readRequests: string[] = []
  const dataRequests: { url: string; range: string | null }[] = []
  page.on('request', req => {
    const url = req.url()
    if (!url.includes('/api/artifacts/')) return
    if (/\/read(\?|$)/.test(url)) readRequests.push(url)
    if (url.includes('/data')) dataRequests.push({ url, range: req.headers()['range'] ?? null })
  })
  return { readRequests, dataRequests }
}

test('a populated surface renders through the CHUNKED path, with no request to /read — TEST-30', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request)
  const proj = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `Zarr read path ${Date.now()}`, description: '' },
    })
  ).json()
  const seed: SeedPlottableResult = await seedPlottableProject(request, proj.id)

  await loginAsOwner(page)
  const bag = trackErrors(page)
  const net = trackReadPathRequests(page)
  await openWorkbench(page, proj.id)
  await expect(page.getByTestId('workbench-canvas-host').first()).toBeAttached({ timeout: 20_000 })
  await page.waitForFunction(() => !!(window as unknown as { __txr_ds?: unknown }).__txr_ds, undefined, {
    timeout: 20_000,
  })

  // ── the REAL catalog→select flow, exactly as the color-by picker drives it ──────────
  const flow = await page.evaluate(async projectId => {
    const mk = (
      window as unknown as {
        __txr_ds?: (id: string) => {
          catalog: () => Promise<{
            valueColumns: string[]
            categoricalColumns: { id: string; label: string }[]
            layouts: { id: string }[]
          }>
          positions: (id: string) => Promise<{ positions: Float32Array; length: number }>
          valueColumn: (key: string) => Promise<{ row: Uint32Array; value: Float32Array }>
          categorical: (key: string) => Promise<{ codes: Uint16Array; categories: string[]; length: number }>
        }
      }
    ).__txr_ds
    if (!mk) return { error: 'no __txr_ds seam' }
    const ds = mk(projectId)
    const cat = await ds.catalog()
    const layout = cat.layouts[0]
    const positions = layout ? await ds.positions(layout.id) : null
    const colKey = cat.valueColumns[0]
    const col0 = colKey ? await ds.valueColumn(colKey) : null
    const catEntry = cat.categoricalColumns[0]
    const categorical = catEntry ? await ds.categorical(catEntry.id) : null
    return {
      layoutId: layout?.id ?? null,
      positionsLength: positions?.length ?? null,
      firstPositions: positions ? Array.from(positions.positions.slice(0, 4)) : null,
      colKey,
      colRows: col0 ? Array.from(col0.row) : null,
      colValues: col0 ? Array.from(col0.value) : null,
      catKey: catEntry?.id ?? null,
      catCategories: categorical?.categories ?? null,
      catLength: categorical?.length ?? null,
      catFirstCodes: categorical ? Array.from(categorical.codes.slice(0, 6)) : null,
    }
  }, proj.id)

  expect('error' in flow ? flow.error : null, 'the DataSource seam is exposed').toBeNull()
  const f = flow as Exclude<typeof flow, { error: string }>

  // ── 1. the SAME values, through the new path ───────────────────────────────────────
  // positions: the seeded ring layout, first point at (cos 0, sin 0) × 10 = (10, 0).
  expect(f.layoutId, 'the seeded 2-D coordinate artifact surfaces as a layout').toBe(
    seed.embedding_artifact_id,
  )
  expect(f.positionsLength, 'one point per seeded row').toBe(seed.n_cells)
  expect(f.firstPositions?.[0]).toBeCloseTo(10, 4)
  expect(f.firstPositions?.[1]).toBeCloseTo(0, 4)

  // Value column 0 is non-zero at every row whose index divides evenly by the matrix's
  // column count, at value 1 (`cscExpression`).
  expect(f.colKey, 'a value-column key is the composite <artifactId>#<index>').toContain('#')
  expect(f.colRows).toEqual(
    Array.from({ length: seed.n_cells / seed.n_genes }, (_, i) => i * seed.n_genes),
  )
  expect(f.colValues?.every(v => v === 1)).toBe(true)

  // the categorical decodes against its DECLARED level set — including the level that
  // never occurs in the data, which a reader deriving levels from the codes would drop.
  expect(f.catKey).toBe(`${seed.clustering_artifact_id}#${seed.clustering_column}`)
  expect(f.catCategories).toEqual(seed.clustering_levels)
  expect(f.catLength).toBe(seed.n_cells)
  expect(f.catFirstCodes).toEqual([0, 1, 2, 0, 1, 2])

  // ── 2. `/read` was NEVER requested ─────────────────────────────────────────────────
  expect(net.readRequests, `something still calls /read: ${net.readRequests.join(', ')}`).toEqual([])

  // …and the route really is gone, asserted directly rather than inferred from silence
  // (a client that simply stopped calling it would satisfy the check above even if the
  // endpoint still existed — this is the negative control for assertion 2).
  const readResp = await request.get(
    `${BACKEND}/api/artifacts/${seed.expression_artifact_id}/read?col=0`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  expect(readResp.status(), 'GET /artifacts/{id}/read is deleted (ITEM-12)').toBe(404)

  // ── 3. the reads are CHUNK-GRANULAR ────────────────────────────────────────────────
  const memberReads = net.dataRequests.filter(r => /\/data\/.+/.test(r.url))
  expect(memberReads.length, 'the client read named MEMBERS, not the artifact').toBeGreaterThan(0)

  // The CSC column is read through the SAME Zarr path as everything else — the matrix is a
  // `zarr_v3` store whose `kind` is `sparse_csc`, so its three members are Zarr arrays, and
  // a column is a chunk-scoped read of each. What matters is that the client named MEMBERS
  // under the matrix (`indptr/…`, `indices/…`, `data/…`) and never asked for the artifact
  // whole — the whole-artifact case is asserted separately below.
  const cscReads = memberReads.filter(r => r.url.includes(seed.expression_artifact_id))
  const cscMembers = new Set(
    cscReads.map(r => r.url.split('/data/')[1].split('?')[0].split('/')[0]),
  )
  expect([...cscMembers].sort()).toEqual(['data', 'indices', 'indptr'])
  expect(
    cscReads.some(r => /\/(indices|data)\/c\//.test(r.url)),
    'the value members were read at CHUNK granularity',
  ).toBe(true)

  // The 2-D layout member is read chunk by chunk: one request per inner chunk (plus its
  // `zarr.json`), NOT one request for the whole array.
  const embReads = memberReads.filter(r => r.url.includes(seed.embedding_artifact_id))
  const embChunkReads = embReads.filter(r => r.url.includes('/embedding/c/'))
  expect(
    embChunkReads.length,
    `the layout member was read in ${embChunkReads.length} chunk request(s); the fixture has ${seed.embedding_chunks}`,
  ).toBe(seed.embedding_chunks)
  expect(seed.embedding_chunks, 'the fixture is multi-chunk, or this assertion is vacuous').toBeGreaterThan(1)

  // No whole-artifact fetch of a bulk artifact anywhere in the run.
  const wholeArtifactReads = net.dataRequests.filter(
    r =>
      /\/data(\?|$)/.test(r.url) &&
      (r.url.includes(seed.expression_artifact_id) || r.url.includes(seed.embedding_artifact_id)),
  )
  expect(wholeArtifactReads, 'no whole-artifact fetch of the matrix or the layout').toEqual([])

  expect(bag.errors, `console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

test('the populated surface renders at 390px — TEST-32', async ({ page, request }) => {
  const token = await ownerToken(request)
  const proj = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `Zarr read path narrow ${Date.now()}`, description: '' },
    })
  ).json()
  const seed: SeedPlottableResult = await seedPlottableProject(request, proj.id)

  // The narrow state the UI-surface checklist requires for any surface whose data path
  // moves. Set BEFORE navigation so the first render is the narrow one — a resize after
  // mount would test the reflow, not the initial paint.
  await page.setViewportSize({ width: 390, height: 844 })
  await loginAsOwner(page)
  const bag = trackErrors(page)
  const net = trackReadPathRequests(page)
  await openWorkbench(page, proj.id)

  await expect(page.getByTestId('workbench-canvas-host').first()).toBeAttached({ timeout: 20_000 })
  await page.waitForFunction(() => !!(window as unknown as { __txr_ds?: unknown }).__txr_ds, undefined, {
    timeout: 20_000,
  })

  // The data path is the same at any width — assert it resolves here too rather than only
  // that the layout survives, so a narrow-viewport-only read regression cannot hide.
  const positionsLength = await page.evaluate(async projectId => {
    const mk = (
      window as unknown as {
        __txr_ds?: (id: string) => {
          catalog: () => Promise<{ layouts: { id: string }[] }>
          positions: (id: string) => Promise<{ length: number }>
        }
      }
    ).__txr_ds
    if (!mk) return null
    const ds = mk(projectId)
    const layout = (await ds.catalog()).layouts[0]
    return layout ? (await ds.positions(layout.id)).length : null
  }, proj.id)
  expect(positionsLength).toBe(seed.n_cells)

  // No horizontal overflow — the narrow-viewport failure that actually reaches a user.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'the page does not scroll horizontally at 390px').toBeLessThanOrEqual(1)

  expect(net.readRequests).toEqual([])
  expect(bag.errors, `console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
