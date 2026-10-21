// incremental-landing.spec.ts — progressive paint, end to end (incremental-landing #29,
// TEST-14 / TEST-19).
//
// Against the REAL backend, over real HTTP, reading REAL seeded artifacts. No route mocking.
//
// ── WHAT THIS PROVES, AND THE HONEST SCOPE OF IT ─────────────────────────────────────────────
//
// The acceptance criterion: *an emit-plot's content is VISIBLE BEFORE its stream completes, and the
// final picture equals the wholesale-landed one* — with DELIBERATE arrival spacing so a single-task
// localhost read cannot pass it vacuously.
//
// This asserts that end-to-end observable on the app's own per-chunk PROGRESS seam
// (`WorkbenchStreamingSource.onProgress`, the read half this change's LANDING half sits on top of):
// an emitted plot's data column arrives IN STAGES — more than one arrival, a STRICT FRACTION of the
// rows landing before the terminal (`done`) one — and the FINAL arrival reports EVERY row (== the
// wholesale result). The chunk-delay seam is what makes the intermediate arrivals real rather than a
// single-task replay (`streaming-reads.spec.ts` measured that a localhost read otherwise lands every
// chunk in one task). Pixels are not the assertion — headless Chromium has no GPU, so the deck layer
// never paints (the `progressive-render.spec.ts` reasoning); the progress channel is the on-path
// witness.
//
// SCOPE: the progressive-landing BYTE MECHANICS ITEM-7 adds to the declarative `$data` consumer
// (each accumulated prefix, byte-identical to the wholesale read) are proven at the unit tier by
// TEST-13 (`columnarRead.test.ts`) and the accumulation/status/kernels by TEST-1..12/15..18. This
// e2e proves the END-TO-END progressive arrival + full completion on the real stack, which is the
// property a user actually sees and the one the acceptance criterion names.

import { expect, test, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { ANCHORED_COLUMN, frameThePane, openVisualize, seedAnchoredProject } from './_visualize'

// A multi-chunk shape: the anchored coordinate is seeded at `rows`, chunked at `chunkRows`, so a
// 512-row layout arrives in 4 chunks — MORE THAN ONE, which is what makes progressiveness testable.
const SHAPE = { rows: 512, chunkRows: 128 } as const
const METRIC_LABEL = ANCHORED_COLUMN.first
/** Long enough that a commit happens between two arrivals; short enough that the read still settles
 *  well within the timeout. */
const CHUNK_DELAY_MS = 40

interface Progress {
  key: string
  done: boolean
  chunks: number
  rowsSeen: number | null
  totalRows: number | null
  t: number
}

/** Space every stream's chunk ARRIVALS so a commit happens between them. Armed in an init script
 *  (like `__cyto_count_decodes`) so it cannot race the first read. */
async function armChunkDelay(page: Page, ms: number): Promise<void> {
  await page.addInitScript(delay => {
    ;(window as unknown as { __cyto_stream_chunk_delay_ms: number }).__cyto_stream_chunk_delay_ms = delay
  }, ms)
}

/** Every stream-progress event the page has observed, oldest first (the app's own per-chunk seam). */
async function progressLog(page: Page): Promise<Progress[]> {
  return page.evaluate(() => {
    const s = (window as unknown as { __cyto_stream?: { progress: () => Progress[] } }).__cyto_stream
    return s ? s.progress() : []
  })
}

test.describe('incremental / progressive paint (#29)', () => {
  test('TEST-14/19 — an emitted plot arrives IN STAGES before its stream completes; final covers every row (== wholesale)', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `incremental-landing ${Date.now()}`)
    await seedAnchoredProject(request, projectId, [], undefined, {
      rows: SHAPE.rows,
      chunkRows: SHAPE.chunkRows,
    })

    await armChunkDelay(page, CHUNK_DELAY_MS)
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // Frame the pane (emit the plot on the multi-chunk coordinate) and colour it by the metric — the
    // full emit a user drives. `frameThePane` places the pane; the ▶ colours it.
    await frameThePane(page, { coordinateRows: SHAPE.rows })
    const play = page.getByRole('button', { name: `Plot ${METRIC_LABEL}`, exact: true })
    await expect(play, `no colour-by row for "${METRIC_LABEL}"`).toHaveCount(1, { timeout: 60_000 })
    await play.click()

    // ── FINAL == WHOLESALE: the emitted plot's stream reported completion covering EVERY row ──────
    // A `done` arrival at the full row count is exactly what a wholesale read lands; a
    // mis-accumulating land would report a wrong total or never complete.
    await expect
      .poll(async () => (await progressLog(page)).some(e => e.done && e.totalRows === SHAPE.rows), {
        timeout: 60_000,
      })
      .toBe(true)

    const log = await progressLog(page)
    console.log('[incremental-landing] progress events:', JSON.stringify(log))

    // ── PROGRESSIVE: content became available IN STAGES before the stream completed ──────────────
    // MORE THAN ONE arrival, and at least one carried a STRICT FRACTION of the rows BEFORE the
    // terminal `done`. Without the chunk-delay a localhost read lands every chunk in one task and
    // publishes one arrival — so this leg is the one the deliberate spacing makes non-vacuous.
    const forThisRead = log.filter(e => e.totalRows === SHAPE.rows)
    const arrivals = forThisRead.length
    const fractionalBeforeDone = forThisRead.some(
      e => !e.done && e.rowsSeen != null && e.rowsSeen > 0 && e.rowsSeen < SHAPE.rows,
    )
    expect(arrivals, `expected MORE THAN ONE arrival; got ${arrivals}: ${JSON.stringify(forThisRead)}`).toBeGreaterThan(1)
    expect(
      fractionalBeforeDone,
      `content did not arrive in stages (no fractional arrival before done); events=${JSON.stringify(forThisRead)}`,
    ).toBe(true)
  })
})
