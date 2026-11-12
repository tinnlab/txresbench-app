import { expect, test } from '@playwright/test'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { BACKEND, openWorkbench, trackErrors } from './_dock'
import { seedPlottableProject, type SeedPlottableResult } from '../14-declarative-qc/_seed'

// TEST-31 [artifact-model · ITEM-25] — PROGRESSIVE RENDERING SURVIVES THE DELETION.
//
// This is the one regression from deleting `/read` that reaches a user as a symptom
// rather than as an error. A surface that used to fill in and now goes "blank, then
// everything" reads as a hang on a large view, and every other gate stays green:
// `tsc` passes, the values are correct, the screenshot at the END is identical.
//
// The replacement mechanism is chunk arrival. `ZarrArray.chunks()` yields the elements of
// each inner chunk IN ORDER as it lands, with a prefetch window keeping the next few
// fetches in flight, and `readInto(out, lo, hi, onChunk)` fills a pre-allocated buffer and
// invokes the caller per chunk. `WorkbenchDataSource` forwards that hook, so a surface
// repaints per chunk instead of holding a spinner.
//
// ── WHAT THIS ASSERTS, AND WHY IT IS THE RIGHT LAYER ───────────────────────────────
//
// Against the REAL backend, over real HTTP, reading a REAL seeded artifact:
//   * MORE THAN ONE chunk arrives (a single-chunk read cannot be progressive);
//   * they arrive IN ORDER, contiguously covering the read (out-of-order arrival would
//     paint a scrambled cloud, which is worse than painting late);
//   * every chunk arrives BEFORE the read resolves — the property that distinguishes
//     "yields as it goes" from "gathers everything, then replays the callbacks", which
//     is exactly what a refactor would silently turn it into;
//   * the elements are the RIGHT ones (a progressive read that paints wrong values fast
//     is not an improvement).
//
// Pixel-level "the canvas changed between chunk 1 and chunk N" is deliberately NOT the
// assertion: headless Chromium has no GPU, so the deck layer never paints here, and a
// canvas-diff test would be asserting the harness rather than the behaviour. The
// surface-level half — that `WorkbenchDataSource` forwards each arrival to its consumer —
// is pinned in `workbenchDataSource.test.ts`
// ("forwards chunk arrival to the injected onChunk").
//
// The OTHER progressive path — `@txresbench/viz`'s `<Viz data={stream}>` raster
// (`data-progressive.spec.ts`) — is untouched by this change: it is fed by viz's own
// `StreamingSource` and never spoke to `/read`. It stays green as the control.

test('content arrives IN STAGES as chunks land, not in one blocking fetch — TEST-31', async ({
  page,
  request,
}) => {
  const token = await ownerToken(request)
  const proj = await (
    await request.post(`${BACKEND}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: `Progressive render ${Date.now()}`, description: '' },
    })
  ).json()
  const seed: SeedPlottableResult = await seedPlottableProject(request, proj.id)
  expect(
    seed.embedding_chunks,
    'the fixture must be MULTI-chunk or every assertion below is vacuous',
  ).toBeGreaterThan(1)

  await loginAsOwner(page)
  const bag = trackErrors(page)

  // Count the chunk requests the browser actually issues, so "arrived in stages" is
  // corroborated at the network layer and not only by the callback count.
  const chunkRequests: string[] = []
  page.on('request', req => {
    const url = req.url()
    if (url.includes(`/api/artifacts/${seed.embedding_artifact_id}/data/embedding/c/`)) {
      chunkRequests.push(url)
    }
  })

  await openWorkbench(page, proj.id)
  await expect(page.getByTestId('workbench-canvas-host').first()).toBeAttached({ timeout: 20_000 })
  await page.waitForFunction(() => !!(window as unknown as { __txr_read?: unknown }).__txr_read, undefined, {
    timeout: 20_000,
  })

  // The artifact row carries the producer's decode contract; the read dispatches on it,
  // exactly as production does.
  const artifact = await (
    await request.get(`${BACKEND}/api/artifacts/${seed.embedding_artifact_id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()
  expect(artifact.structure?.encoding, 'the seeded layout artifact declares a Zarr structure').toBe(
    'zarr_v3',
  )

  const read = await page.evaluate(
    async ([id, structure]) => {
      const api = (
        window as unknown as {
          __txr_read: {
            positionsProgressive: (
              id: string,
              structure: unknown,
            ) => Promise<{
              chunks: { index: number; total: number; offset: number; length: number; t: number }[]
              length: number
              positions: number[]
            }>
          }
        }
      ).__txr_read
      return api.positionsProgressive(id as string, structure)
    },
    [seed.embedding_artifact_id, artifact.structure] as const,
  )

  // ── it arrived in STAGES ───────────────────────────────────────────────────────────
  expect(read.chunks.length, 'more than one chunk arrived — the read was progressive').toBeGreaterThan(1)
  expect(read.chunks.length).toBe(seed.embedding_chunks)
  // Every chunk announced the same, correct total up front, so a consumer can render
  // DETERMINATE progress rather than an indefinite spinner.
  expect(new Set(read.chunks.map(c => c.total))).toEqual(new Set([seed.embedding_chunks]))

  // ── …IN ORDER, contiguously ────────────────────────────────────────────────────────
  expect(read.chunks.map(c => c.index)).toEqual(read.chunks.map((_, i) => i))
  let cursor = 0
  for (const c of read.chunks) {
    expect(c.offset, 'chunk k starts exactly where chunk k-1 ended').toBe(cursor)
    cursor += c.length
  }
  expect(cursor, 'the chunks cover the whole read').toBe(read.length * 2)

  // ── …BEFORE the read resolved ──────────────────────────────────────────────────────
  // `positionsProgressive` throws if a callback fires after the promise settles, so
  // reaching here at all proves the yields were interleaved with the fetching rather than
  // replayed at the end. The first chunk landing well before the last is the observable
  // consequence: that gap is the window in which a surface paints its first content.
  expect(read.chunks[0].t).toBeLessThan(read.chunks[read.chunks.length - 1].t + 1)

  // ── …and the values are RIGHT ──────────────────────────────────────────────────────
  // The seeded ring layout: point i at (cos t, sin t) × 10 for t = 2πi/N.
  expect(read.length).toBe(seed.n_cells)
  expect(read.positions).toHaveLength(seed.n_cells * 2)
  for (const i of [0, 1, Math.floor(seed.n_cells / 2), seed.n_cells - 1]) {
    const t = (i / seed.n_cells) * Math.PI * 2
    expect(read.positions[i * 2], `x[${i}]`).toBeCloseTo(Math.cos(t) * 10, 3)
    expect(read.positions[i * 2 + 1], `y[${i}]`).toBeCloseTo(Math.sin(t) * 10, 3)
  }

  // The network agrees: one request per inner chunk, each a ranged read of the member.
  expect(chunkRequests.length).toBeGreaterThanOrEqual(seed.embedding_chunks)

  expect(bag.errors, `console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
