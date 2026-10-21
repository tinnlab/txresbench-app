// streaming-reads.spec.ts — the slice-B e2e arc (TESTS.md TEST-8 / TEST-13 / TEST-14 / TEST-24).
//
// Against the REAL backend, over real HTTP, reading REAL seeded artifacts. No route mocking.
//
// ── WHY THESE ASSERT WHAT THEY ASSERT, AND NOT PIXELS ────────────────────────────────────────
//
// The grid is deck.gl/WebGL2 and headless Chromium has no GPU, so the layer never paints here. A
// canvas diff would assert the harness rather than the behaviour — the same reasoning
// `progressive-render.spec.ts` writes down at length. So each spec below asserts the app's own
// state at the seam the behaviour actually passes through:
//
//   · TEST-8   — `window.__canvasPanes()` (the pane identity fold) + `window.__cyto_read.decodes`
//                (DECODES, not requests: artifact bytes are served `immutable`, so a repeated read
//                usually issues no second request while still paying a full decode — a
//                request-counting assertion reads 1 for both the shared case and the repeated one).
//   · TEST-13  — `window.__cyto_stream.progress()`, the app's per-chunk arrival channel
//                (`WorkbenchStreamingSource.onProgress`, ITEM-19) — the producer `CanvasCoverage`
//                renders.
//   · TEST-14  — the same channel, on a SINGLE-chunk artifact.
//   · TEST-24  — the coverage INDICATOR in the DOM, recorded by a `MutationObserver` installed
//                before navigation.
//
// ── RESTATEMENT OF TEST-13 / TEST-14 (this file) ─────────────────────────────────────────────
//
// TESTS.md wrote both against "the canvas pane's progress seam", meaning the `CpuRasterView`
// progress hook the plan originally routed progressive paint through. That component is NOT on the
// grid path: `CategoricalPointsView` / `CpuRasterView` are exported from neither viz barrel and are
// rendered only by showcase stories, and the grid draws dense panes through the shared deck
// (`useGridDeckInputs` → `SelectableScatterLayer` over the pane's own positions). Asserting there
// would have measured a surface no user reaches — the same wrong-surface correction TEST-11
// (DRIFT-1.44) and TEST-52 (DRIFT-1.50) each needed.
//
// They are restated onto the app's per-chunk PROGRESS publications, which is the channel that is
// on the real path: `buildProjectSources` → `WorkbenchStreamingSource.onProgress` → `CanvasCoverage`.
// The subject is unchanged — content becomes available IN STAGES, and does not below the chunk
// size — and so is the ITEM coverage (ITEM-9 / ITEM-10).
//
// ── WHAT THIS ARC DOES *NOT* CLAIM ───────────────────────────────────────────────────────────
//
// TEST-13 asserts that the real path publishes MORE THAN ONE arrival carrying a STRICT fraction of
// the total before a terminal one. It does NOT, on its own, distinguish "yields as it goes" from
// "gathers everything then replays the callbacks" — a promise-settlement oracle is what does that,
// and it is pinned at the unit tier by TEST-59 ("at least one event lands while the read is still
// UNFINISHED"). What TEST-13 adds is that this happens on the REAL path against the REAL backend.
// TEST-24 supplies the arrival half at this tier by a different route: the indicator is only ever
// observable in the DOM if React COMMITTED between two arrivals, which a single-microtask replay
// cannot produce.

import { expect, test, type Page } from '@playwright/test'

import { createProject } from '../14-workbench/_dock'
import { loginAsOwner } from '../project/_helpers'
import { seededId, type SeedEngineResponse } from '../14-declarative-qc/_seed'
// The member path the positions fixture writes, imported rather than spelled: one literal for the
// whole tier, so a producer-side rename fails in the fixture instead of in four assertions here.
import { POSITIONS_MEMBER } from '../14-declarative-qc/_fixtures'
import {
  categoricalColumn,
  coordinateEmits,
  frameThePane,
  openVisualize,
  seedAnchoredProject,
  seedOwnerImportedShape,
} from './_visualize'


/** The row shape TEST-13 / TEST-24 need: MORE than one inner chunk, so arrival can be staged at
 *  all. The property that matters is the CHUNK COUNT, not the row count — the indicator's gate is
 *  `arrived >= 2` and the progress channel emits per arrived chunk — so the two shapes below hold
 *  the row count FIXED and vary only the chunk, which is what makes them a controlled pair: any
 *  difference observed between them is the chunking and cannot be the size of the read.
 *
 *  Deliberately not the producer's real 8,192-row inner chunk with a >8,192-row fixture: the
 *  owner-imported seed also writes a `rows × 50` decomposition and a CSC matrix, so a fixture at
 *  that scale is a multi-megabyte seed POST for a property that turns on the chunk count alone. */
const MULTI = { rows: 2_000, chunkRows: 512, chunks: 4 } as const
/** …and the shape the indicator must stay ABSENT for: the SAME rows in ONE chunk — the shape of
 *  the owner's live 3,460-row layout, where the producer's 8,192-row inner chunk means the whole
 *  layout arrives at once. Below the chunk size nothing can fill progressively no matter what the
 *  read does, and an indicator that appeared would be an affordance lying about the system. */
const SINGLE = { rows: 2_000, chunkRows: 4_096, chunks: 1 } as const

// ── readers over the app's own seams ─────────────────────────────────────────────────────────

interface Progress {
  key: string
  done: boolean
  chunks: number
  rowsSeen: number | null
  totalRows: number | null
  t: number
}

/** Every stream-progress event this page has observed, oldest first. */
async function progressLog(page: Page): Promise<Progress[]> {
  return page.evaluate(() => {
    const s = (window as unknown as { __cyto_stream?: { progress: () => Progress[] } }).__cyto_stream
    return s ? s.progress() : []
  })
}

/** Just the POSITIONS-channel events — the read the user is waiting on to see points. The channel
 *  key is `"positions\n…"`; a colour column's events are a different read and mixing them would
 *  report a number that means nothing. */
const positionsEvents = (log: Progress[]): Progress[] => log.filter(e => e.key.startsWith('positions\n'))

async function paneIdentities(
  page: Page,
): Promise<Array<{ id: string; datasetKey: string | null; spaceKey: string | null; identity: string | null; rows: number | null }>> {
  return page.evaluate(() => {
    const read = (window as unknown as { __canvasPanes?: () => Array<Record<string, unknown>> }).__canvasPanes
    return (read ? read() : []).map(p => ({
      id: String(p.id ?? ''),
      datasetKey: (p.datasetKey as string | null) ?? null,
      spaceKey: (p.spaceKey as string | null) ?? null,
      identity: (p.identity as string | null) ?? null,
      rows: (p.rows as number | null) ?? null,
    }))
  })
}

/** Arm the DECODE counter BEFORE any app script runs.
 *
 *  Not `__cyto_read.decodes.enable()`: by the time a spec holds a page, the coordinate section has
 *  already resolved and `zarrReader` caches decoded chunks, so every later read is served from that
 *  cache and records ZERO decodes. TEST-8's first run measured exactly that — `{"|values/values":
 *  2}`, with no positions decode at all — and an assertion written against it would have been
 *  satisfied by a correct implementation and by one with the multicast removed alike. */
async function armDecodesFromLoad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __cyto_count_decodes: boolean }).__cyto_count_decodes = true
  })
}

async function decodeCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const r = (window as unknown as { __cyto_read?: { decodes: { counts: () => Record<string, number> } } })
      .__cyto_read
    return r ? r.decodes.counts() : {}
  })
}

/** Record EVERY appearance of the coverage indicator, from before the first navigation. The
 *  indicator is removed on completion by design, so polling for it would be racing a thing that is
 *  meant to disappear; a `MutationObserver` records what happened instead of what is still there. */
async function watchCoverage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Array<{ pct: number; text: string }> = []
    ;(window as unknown as { __coverageSeen: typeof seen }).__coverageSeen = seen
    const SEL = '[data-testid="workbench-canvas-coverage"]'
    const note = (el: Element) => {
      const pct = Number(el.getAttribute('data-coverage-pct') ?? 'NaN')
      seen.push({ pct, text: (el as HTMLElement).innerText ?? '' })
    }
    const scan = (n: Node) => {
      if (!(n instanceof Element)) return
      if (n.matches?.(SEL)) note(n)
      n.querySelectorAll?.(SEL).forEach(note)
    }
    const start = () => {
      document.querySelectorAll(SEL).forEach(note)
      new MutationObserver(records => {
        for (const r of records) {
          r.addedNodes.forEach(scan)
          if (r.type === 'attributes' && r.target instanceof Element && r.target.matches(SEL)) note(r.target)
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-coverage-pct'],
      })
    }
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start, { once: true })
  })
}

async function coverageSeen(page: Page): Promise<Array<{ pct: number; text: string }>> {
  return page.evaluate(
    () => (window as unknown as { __coverageSeen?: Array<{ pct: number; text: string }> }).__coverageSeen ?? [],
  )
}

/** Space the chunk ARRIVALS of every read on this page, before any app module has run.
 *
 *  Why this exists is a MEASUREMENT, not a preference. TEST-24's two legs both turn on whether
 *  React COMMITS between two arrivals, and on a localhost read of a 4-chunk fixture all four
 *  arrivals can land inside ONE task — React commits once, and the committed state is already the
 *  post-`done` `null`. That produced two distinct failures on this branch: the presence leg was
 *  FLAKY at ~1 in 3 (the indicator never observable at all), and the absence leg's control did NOT
 *  go red at `MIN_CHUNKS_TO_SHOW = 1`, so the leg was green for a reason other than the rule it
 *  claims to test.
 *
 *  A longer timeout cannot fix either: the timeout was already 60s and the read finishes in well
 *  under a second. What was missing was a commit, so the seam creates one — it does not wait
 *  longer, and it does not weaken an assertion. Set in `addInitScript` (like
 *  `__cyto_count_decodes`) so arming cannot race the first read. */
async function armChunkDelay(page: Page, ms: number): Promise<void> {
  await page.addInitScript(delay => {
    ;(window as unknown as { __cyto_stream_chunk_delay_ms: number }).__cyto_stream_chunk_delay_ms = delay
  }, ms)
}

/** Long enough that React cannot batch two arrivals into one commit, short enough that a 4-chunk
 *  read still settles in well under a second. */
const CHUNK_DELAY_MS = 120

// ── the per-pane COLOUR BUFFER seam (owner-granted 2026-08-16) ───────────────────────────────

interface PaneColorSeam {
  epoch: number
  points: number
  rgba: number[]
  legend: { title: string; columnId: string | null; rawLabels: string[] | null } | null
  colorData: { column: string; categorical: boolean } | null
}

/** What each grid pane's colour buffer currently is.
 *
 *  This is a viz-side seam and NOT `__canvasPanes`, because the colour buffer is not reachable from
 *  the app: it lives in the per-workspace display store that `GridWorkspace` mints, which is
 *  not one of `VizStores`' five members — so `defaultVizStores`, the only viz state the app's own
 *  seam can read, does not hold it. Re-checked before the grant was spent, not inherited. */
async function paneColorBuffers(page: Page): Promise<Record<string, PaneColorSeam>> {
  return page.evaluate(() => {
    const read = (window as unknown as { __vizPaneColors?: () => Record<string, PaneColorSeam> }).__vizPaneColors
    return read ? read() : {}
  })
}

/** The ONE coloured pane, once its buffer has settled to the expected row count. Fails loudly
 *  rather than returning an empty digest a later assertion would then read as "all equal". */
async function settledColorPane(page: Page, expectedPoints: number): Promise<PaneColorSeam> {
  await expect
    .poll(
      async () => {
        const panes = Object.values(await paneColorBuffers(page))
        return panes.filter(c => c.points === expectedPoints).length
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  const all = await paneColorBuffers(page)
  const panes = Object.entries(all).filter(([, c]) => c.points === expectedPoints)
  expect(
    panes.length,
    `expected exactly one coloured pane at ${expectedPoints} points; got ${Object.entries(all)
      .map(([id, c]) => `${id}:${c.points}`)
      .join(', ')}`,
  ).toBe(1)
  return panes[0][1]
}

/** Group row indices by their RGBA tuple. The PARTITION is the property — not the number of
 *  colours, and emphatically not the point count: a buffer with every point shaded identically has
 *  the right length and the right count, which is the exact defect TEST-53 exists to catch. */
function partitionByColour(rgba: number[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (let i = 0; i * 4 < rgba.length; i++) {
    const k = `${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]},${rgba[i * 4 + 3]}`
    const g = groups.get(k)
    if (g) g.push(i)
    else groups.set(k, [i])
  }
  return groups
}


/** Seed + open a Visualize pane on a project whose coordinate sets have the given shape. */
async function openShaped(
  page: Page,
  request: import('@playwright/test').APIRequestContext,
  shape: { rows: number; chunkRows: number },
  label: string,
): Promise<SeedEngineResponse> {
  const projectId = await createProject(request, `${label} ${Date.now()}`)
  const seeded = await seedOwnerImportedShape(request, projectId, 'Population 1', shape)
  await loginAsOwner(page)
  await openVisualize(page, projectId)
  return seeded
}

// ── TEST-8 [acceptance] [INV-6] — one coordinate artifact, one base, ONE positions decode ────

test('TEST-8 — two panes on one coordinate artifact fold onto one base and cost ONE positions decode', async ({
  page,
  request,
}) => {
  await armDecodesFromLoad(page)
  await openShaped(page, request, MULTI, 'streaming-fold')

  const emits = coordinateEmits(page)
  await expect(emits.first()).toBeVisible({ timeout: 60_000 })

  // What the page had decoded BEFORE either pane existed. Recorded rather than cleared: the
  // invariant is about how many times the positions are turned into numbers ON THIS PAGE, and
  // clearing here would hide a first read the section had already paid for and leave the assertion
  // measuring nothing (see `armDecodesFromLoad`).
  const before = await decodeCounts(page)

  // BACK-TO-BACK, deliberately not awaited between: the second pane is opened while the first
  // pane's positions read is still in flight. That is the leg that makes this an invariant proof
  // rather than a restatement of the shipped fold — a source that only deduplicated reads it had
  // already FINISHED would decode the member twice here and once in the settled case.
  await emits.first().click()
  await emits.first().click()

  await expect
    .poll(async () => (await paneIdentities(page)).length, { timeout: 60_000 })
    .toBe(2)
  await expect
    .poll(async () => (await paneIdentities(page)).every(p => p.identity != null && p.rows != null), {
      timeout: 60_000,
    })
    .toBe(true)
  // Both panes' positions reads have TERMINATED, so the count below is final rather than a moment.
  await expect
    .poll(async () => positionsEvents(await progressLog(page)).some(e => e.done), { timeout: 60_000 })
    .toBe(true)

  const panes = await paneIdentities(page)
  console.log(`[TEST-8] panes: ${panes.map(p => `${p.datasetKey} ⇒ ${p.spaceKey} [${p.identity}]`).join(' | ')}`)
  expect(panes[0].datasetKey).toBe(panes[1].datasetKey)
  expect(panes[0].spaceKey).toBe(panes[1].spaceKey)
  expect(panes[0].identity).not.toBeNull()
  expect(panes[0].identity).toBe(panes[1].identity)
  expect(panes[0].rows, 'both panes resolved the seeded row space').toBe(MULTI.rows)
  expect(panes[1].rows).toBe(MULTI.rows)

  const after = await decodeCounts(page)
  console.log(`[TEST-8] decodes before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)

  // ── THE PUMP-COUNT LEG: exactly ONE read per positions key ────────────────────────────────
  //
  // This is what the decode leg below CANNOT see, and the gap was measured rather than reasoned
  // about: with the multicast fully removed the decode count stayed at 4 and TEST-8 passed,
  // because `zarrReader` caches DECODED chunks — so a second read pays no decode whether or not it
  // joined the first. The decode leg measures the decode CACHE.
  //
  // The multicast's own signature is visible one layer up: `#subscribe` starts ONE `#pump` per
  // key, and each pump emits its own progress series beginning at `chunks: 1`. A second read of
  // the same key therefore produces a SECOND `chunks: 1` event — which no cache can suppress,
  // because the events are emitted by the pump and not by the decoder.
  const posEvents = positionsEvents(await progressLog(page))
  console.log(
    `[TEST-8] ${posEvents.length} positions events: ` +
      posEvents.map(e => `${e.chunks}c${e.done ? ' DONE' : ''}`).join(' → '),
  )
  const keys = new Set(posEvents.map(e => e.key))
  // Non-vacuity: a page that streamed no positions at all would satisfy "one pump per key" by
  // having no keys.
  expect(keys.size, 'no positions stream was observed, so "one read" proves nothing').toBe(1)
  for (const key of keys) {
    const starts = posEvents.filter(e => e.key === key && !e.done && e.chunks === 1)
    expect(
      starts.length,
      `the positions member was pumped ${starts.length} times for ONE key — a second pump is a ` +
        'second read, which is the "second byte path" DEC-20 forbids and the multicast exists to fold',
    ).toBe(1)
    const terminals = posEvents.filter(e => e.key === key && e.done)
    expect(terminals.length, 'more than one terminal event for one key — two reads settled').toBe(1)
  }

  // The counter keys a store-level decode as `|<member path>` — the zarr layer addresses a STORE,
  // not an artifact, so it has no artifact id to key with (`decodeCounter.ts`).
  const key = `|${POSITIONS_MEMBER}`
  const decodes = after[key] ?? 0

  // Non-vacuity: the positions really were decoded on this page. An assertion of "exactly 4" over
  // a member nothing ever read is satisfied by every implementation, including a broken one.
  expect(decodes, `no positions decode was ever recorded; recorded: ${Object.keys(after).join(', ')}`).toBeGreaterThan(0)

  // ONE copy of the positions, decoded chunk-for-chunk exactly once, for the WHOLE page life —
  // the coordinate section's own read plus BOTH panes. Two independent reads of a 4-chunk member
  // cost 8. This is INV-6's claim stated as a total rather than as a delta, and the total is the
  // form that survives what the delta measured: see the MEASURED SCOPE note below.
  expect(
    decodes,
    `positions decoded ${decodes} times for ${MULTI.chunks} chunks — one decode per chunk is the ` +
      'invariant; a multiple of it is a second read',
  ).toBe(MULTI.chunks)

  // ── MEASURED SCOPE, stated rather than glossed ────────────────────────────────────────────
  //
  // The MID-STREAM leg TESTS.md names for this test — a second pane opened while the first pane's
  // read is still in flight — is NOT exercised here, and the run that proved it is recorded rather
  // than reasoned about: `before` and `after` were IDENTICAL (four decodes on both sides), i.e.
  // the coordinate SECTION had already decoded the positions in full before an emit control
  // existed to click. On this path the two panes therefore fold onto an already-decoded member,
  // and no amount of clicking sooner makes that deterministic.
  //
  // So the mid-stream join is pinned where it CAN be driven deterministically: TEST-7 leg (b) at
  // the unit tier ("a consumer that subscribes AFTER half the chunks have been emitted receives
  // the already-emitted chunks then the live tail, still with ONE decode"). What this test
  // contributes is the real-path total, which the unit tier cannot give.
  expect(
    before[key] ?? 0,
    'the emits caused additional positions decodes — the mid-stream note above is stale and this ' +
      'test should be restated to assert the delta',
  ).toBe(decodes)
})

// ── TEST-13 [ITEM-9, ITEM-10] — arrival is STAGED on the real path ───────────────────────────

test('TEST-13 — a multi-chunk coordinate read arrives in more than one stage, ending at the artifact row count', async ({
  page,
  request,
}) => {
  await openShaped(page, request, MULTI, 'streaming-stages')

  const emits = coordinateEmits(page)
  await expect(emits.first()).toBeVisible({ timeout: 60_000 })
  await emits.first().click()

  // Wait for the read to TERMINATE, not for a wall-clock: the terminal `done` event is the app's
  // own statement that the stream finished, and asserting before it would measure a moment.
  await expect
    .poll(async () => positionsEvents(await progressLog(page)).some(e => e.done), { timeout: 60_000 })
    .toBe(true)

  const events = positionsEvents(await progressLog(page))
  console.log(
    `[TEST-13] ${events.length} positions events: ` +
      events.map(e => `${e.chunks}c ${e.rowsSeen}/${e.totalRows}${e.done ? ' DONE' : ''}`).join(' → '),
  )

  const arrivals = events.filter(e => !e.done)
  // MORE THAN ONE stage. A single-step fill fails here, which is the whole claim.
  expect(arrivals.length, 'the read reported one stage or none — nothing arrived progressively').toBeGreaterThan(1)

  // The denominator is the catalog's real row count, on every event — a consumer can therefore
  // render DETERMINATE progress rather than an indefinite spinner.
  expect(new Set(events.map(e => e.totalRows))).toEqual(new Set([MULTI.rows]))

  // STRICTLY rising, and never over-reporting.
  let prevRows = -1
  let prevChunks = 0
  for (const e of arrivals) {
    expect(e.rowsSeen, 'a positions arrival reported no row count').not.toBeNull()
    expect(e.rowsSeen!, 'rows seen went backwards').toBeGreaterThan(prevRows)
    expect(e.rowsSeen!).toBeLessThanOrEqual(MULTI.rows)
    expect(e.chunks, 'arrived chunks went backwards').toBeGreaterThan(prevChunks)
    prevRows = e.rowsSeen!
    prevChunks = e.chunks
  }

  // At least one arrival carried a STRICT fraction of the total. An implementation that reported
  // once, at the end, satisfies "progress was reported" while telling a consumer nothing it can
  // show — and it is exactly what TEST-59's control removes at the unit tier.
  expect(
    arrivals.some(e => e.rowsSeen != null && e.rowsSeen < MULTI.rows),
    'every reported stage was already the whole read — nothing partial was ever observable',
  ).toBe(true)

  // …and it converged on the artifact's real row count.
  const done = events.filter(e => e.done)
  expect(done.length, 'the stream never reported a terminal event').toBeGreaterThan(0)
  expect(arrivals[arrivals.length - 1].chunks).toBe(MULTI.chunks)
  expect(arrivals[arrivals.length - 1].rowsSeen).toBe(MULTI.rows)
})

// ── TEST-14 [ITEM-9] — below the chunk size, nothing gets slower or wronger ───────────────────

test('TEST-14 — a single-chunk coordinate read arrives in exactly one stage and resolves the same rows', async ({
  page,
  request,
}) => {
  await openShaped(page, request, SINGLE, 'streaming-single')

  const emits = coordinateEmits(page)
  await expect(emits.first()).toBeVisible({ timeout: 60_000 })
  await emits.first().click()

  await expect
    .poll(async () => (await paneIdentities(page)).some(p => p.rows != null), { timeout: 60_000 })
    .toBe(true)
  await expect
    .poll(async () => positionsEvents(await progressLog(page)).some(e => e.done), { timeout: 60_000 })
    .toBe(true)

  const events = positionsEvents(await progressLog(page))
  console.log(
    `[TEST-14] ${events.length} positions events: ` +
      events.map(e => `${e.chunks}c ${e.rowsSeen}/${e.totalRows}${e.done ? ' DONE' : ''}`).join(' → '),
  )
  const arrivals = events.filter(e => !e.done)

  // EXACTLY one stage — the honest consequence of a one-chunk read, and the reason the indicator
  // must stay absent for it (TEST-24). Asserted as an equality rather than as "≤ 1", so a read
  // that reported nothing at all fails here too.
  expect(arrivals.length, 'a single-chunk read reported more than one stage').toBe(1)
  expect(arrivals[0].chunks).toBe(SINGLE.chunks)
  expect(arrivals[0].rowsSeen).toBe(SINGLE.rows)
  expect(arrivals[0].totalRows).toBe(SINGLE.rows)

  // …and the pane state is the same as it always was: the seeded rows, resolved.
  const panes = await paneIdentities(page)
  expect(panes.length).toBe(1)
  expect(panes[0].rows).toBe(SINGLE.rows)
  expect(panes[0].identity).not.toBeNull()
})

// ── TEST-24 [ITEM-19] — the coverage indicator, and its ABSENCE ──────────────────────────────

test('TEST-24 — the coverage indicator appears and advances on a multi-chunk read, then goes', async ({
  page,
  request,
}) => {
  await armChunkDelay(page, CHUNK_DELAY_MS)
  await watchCoverage(page)
  await openShaped(page, request, MULTI, 'streaming-coverage')

  const emits = coordinateEmits(page)
  await expect(emits.first()).toBeVisible({ timeout: 60_000 })
  // ASSERT THE STATE THIS MEASURES FROM. `CanvasCoverage` renders inside the canvas HOST, so a
  // host that is not mounted when the read runs can never show an indicator however correct the
  // rule is — and "it never appeared" would then be a fact about the harness, not about the app.
  await expect(
    page.getByTestId('workbench-canvas-host').first(),
    'the canvas host is not mounted, so the indicator had nowhere to render',
  ).toBeAttached({ timeout: 60_000 })
  await emits.first().click()

  // It APPEARED. Recorded by the observer, so a bar that came and went inside one poll interval is
  // still evidence — and its appearance at all proves React committed BETWEEN two arrivals, which
  // a gather-then-replay read cannot produce.
  await expect
    .poll(async () => (await coverageSeen(page)).length, { timeout: 60_000 })
    .toBeGreaterThan(0)

  await expect
    .poll(async () => positionsEvents(await progressLog(page)).some(e => e.done), { timeout: 60_000 })
    .toBe(true)

  const seen = await coverageSeen(page)
  console.log(`[TEST-24] coverage states: ${seen.map(s => `${s.pct}%`).join(' → ')}`)
  // ADVANCED PAST 0 — a bar pinned at 0 for the whole load is not a coverage indicator.
  expect(Math.max(...seen.map(s => s.pct)), 'the indicator never advanced past 0%').toBeGreaterThan(0)
  // T7 — REPLACES `expect(Math.max(...pct)).toBeLessThan(100)`, which could not fail: the
  // component computes `Math.min(99, …)`, so the maximum is 99 by construction whatever the read
  // did. It asserted the component's own clamp back at itself.
  //
  // What is actually at risk is that the number RISES and that it is a fraction of a denominator
  // the test knows independently. So: the observed percentages must be non-decreasing (a bar that
  // jumps backwards is reporting a per-chunk figure, not coverage) and must strictly rise at
  // least once (a bar frozen at its first value is not advancing), and the last figure the user
  // was shown must be a STRICT fraction of MULTI.rows — rows seen below the total, and a
  // percentage that is the one those two numbers imply rather than an unrelated clamp.
  //
  // WHEN THE DEFECT IS PRESENT (the indicator reports chunk index, a stale count, or the total
  // instead of the arrived rows) the fraction below stops agreeing with the reported percentage,
  // or `rowsSeen` reaches the total while the bar is still up, and this goes red.
  const pcts = seen.map(s => s.pct)
  for (let i = 1; i < pcts.length; i++) {
    expect(pcts[i], `coverage went BACKWARDS: ${pcts.join(' → ')}`).toBeGreaterThanOrEqual(pcts[i - 1])
  }
  expect(pcts.at(-1), `coverage never rose: ${pcts.join(' → ')}`).toBeGreaterThan(pcts[0])
  // It says WHOSE rows, in real numbers — the honesty half of the affordance — and that number is
  // measured against the denominator THIS TEST fixed (`MULTI.rows`), not against the component.
  const last = seen[seen.length - 1]
  expect(last.text).toMatch(/of 2,000 rows/)
  const rowsSeen = Number((/([\d,]+) of [\d,]+ rows/.exec(last.text)?.[1] ?? '').replace(/,/g, ''))
  expect(Number.isFinite(rowsSeen), `could not read the arrived-row count from "${last.text}"`).toBe(true)
  expect(rowsSeen).toBeGreaterThan(0)
  expect(rowsSeen, 'the bar was still up while claiming every row had arrived').toBeLessThan(MULTI.rows)
  // The percentage is the one those two real numbers imply — not an independent counter.
  expect(last.pct).toBe(Math.min(99, Math.floor((rowsSeen / MULTI.rows) * 100)))

  // …and it is GONE once the read completed. Never a bar left sitting at 100%.
  await expect(page.getByTestId('workbench-canvas-coverage')).toHaveCount(0, { timeout: 30_000 })
})

test('TEST-24 — the coverage indicator is ABSENT for a single-chunk read, at every moment', async ({
  page,
  request,
}) => {
  // The SAME spacing the presence leg runs under, and that is what makes this leg discriminate.
  // WITHOUT it the single-chunk read's one arrival and its `done` land in the same task, React
  // commits once, and the committed state is already `null` — so the indicator was absent for a
  // reason that has nothing to do with the chunk threshold, and lowering `MIN_CHUNKS_TO_SHOW` to 1
  // left the leg GREEN (measured, recorded as CONTROL-E). With the arrival spaced, a threshold of
  // 1 genuinely shows a bar here, so this leg now fails when the rule is removed.
  await armChunkDelay(page, CHUNK_DELAY_MS)
  await watchCoverage(page)
  await openShaped(page, request, SINGLE, 'streaming-coverage-absent')

  const emits = coordinateEmits(page)
  await expect(emits.first()).toBeVisible({ timeout: 60_000 })
  await emits.first().click()

  // Drive the read to completion first, so this is not "it had not appeared yet".
  await expect
    .poll(async () => positionsEvents(await progressLog(page)).some(e => e.done), { timeout: 60_000 })
    .toBe(true)
  await expect
    .poll(async () => (await paneIdentities(page)).some(p => p.rows === SINGLE.rows), { timeout: 60_000 })
    .toBe(true)

  // The OBSERVER is what makes this meaningful: an end-state check passes for an implementation
  // that flashes a full bar mid-load and hides it on completion. This says it was never there.
  const seen = await coverageSeen(page)
  expect(
    seen,
    `the indicator was shown ${seen.length} time(s) on a single-chunk read: ${seen.map(s => `${s.pct}%`).join(', ')}`,
  ).toHaveLength(0)

  // Non-vacuity: the observer WORKS — the same instrumentation records states on the multi-chunk
  // case above, and the read this case watched really did complete with one chunk.
  const arrivals = positionsEvents(await progressLog(page)).filter(e => !e.done)
  expect(arrivals.length, 'no read was observed at all, so its absence proves nothing').toBe(1)
  expect(arrivals[0].chunks).toBe(SINGLE.chunks)
})

// ── the colour arc: TEST-28 + TEST-53 ────────────────────────────────────────────────────────
//
// Both need the SETTLED per-pane colour buffer, and both are written against the seam granted for
// exactly that (`window.__vizPaneColors`). Neither is expressible against a point count, and that
// refusal is deliberate rather than an omission: a buffer with every point shaded identically has
// the right point count, the right length and the right pane identity — it is precisely the defect
// TEST-53 exists to catch, so an approximation by count would pass while the thing under test is
// broken. The per-row bytes are the property; everything else is a proxy.
//
// THE ORACLE IS THE FIXTURE, NOT THE APP. `seedOwnerImportedShape` writes the categorical column
// as `k % 4` over the row range, so row `i`'s category is computable here without reading anything
// the app derived. Asserting against `colorData.codes` (the app's own resident copy of the column)
// would be asking the implementation to confirm itself.

/** The seeded categorical column's category for row `i`.
 *
 *  Straight from `zarrClusteringArtifact`'s own construction (`codes = i % 3`), so the oracle is
 *  the FIXTURE and never the app: asserting against `colorData.codes` — the app's resident copy of
 *  the column it just coloured by — would be asking the implementation to confirm itself.
 *
 *  Note the asymmetry the fixture deliberately carries: FOUR levels are DECLARED and only THREE
 *  ever occur (`'NEVER-OBSERVED'` is declared and unused, INV-11). That is what lets TEST-28 assert
 *  the DECLARED set while TEST-53 asserts the OBSERVED partition, and it is why neither can be
 *  derived from the other. */
const SEEDED_OBSERVED_CATEGORIES = 3
const SEEDED_DECLARED_LEVELS = 4
/** The three levels that actually OCCUR, in code order — `zarrClusteringArtifact`'s `['0','1','2']`
 *  minus its declared-but-unused fourth. Asserted as a SET so a rename or a swap fails. */
const SEEDED_OBSERVED_LEVELS = ['0', '1', '2']
const seededCategoryOf = (row: number): number => row % SEEDED_OBSERVED_CATEGORIES

/** The colour-by row the two tests press. Distinct from the shared plottable seed's own clustering
 *  column name, so "the ▶ I pressed" cannot be another dataset's row of the same name. */
const COLOUR_COLUMN = 'cluster label'

/** Seed the anchored fixture at the MULTI shape, frame it, and emit a plot COLOURED BY the seeded
 *  categorical column. Returns that pane's settled colour buffer.
 *
 *  ── WHICH FIXTURE, AND WHY NOT THE OWNER-IMPORTED ONE (measured, not preferred) ──────────────
 *
 *  The first shape of this helper used `seedOwnerImportedShape` + § Colour by's ▶. It was MEASURED
 *  not to reach a pane at all: `__canvasPanes()` reported `[]` for the whole 60s and the canvas
 *  held the grid's own default `pane-1` rather than a declarative pane. Emitting the coordinate ▶
 *  on that fixture DOES place a pane (`link-space.spec.ts` does exactly that), but the resulting
 *  pane's colour-by picker offers an EMPTY listbox — that pane's catalog carries no columns — so
 *  there is no way to colour it.
 *
 *  The anchored fixture is the one whose § Colour by ▶ demonstrably emits a pane
 *  (`emit-and-close.spec.ts`, passing), so it is the surface where a per-pane colour buffer exists
 *  to be right or wrong about. It is seeded here at 2,000 rows in 512-row chunks — the same MULTI
 *  shape the rest of this file uses — via the `rows`/`chunkRows` parameters added beside the ones
 *  `seedOwnerImportedShape` already carried. Same subject, same ITEM coverage, a surface a user
 *  reaches: the same wrong-surface correction TEST-11 (DRIFT-1.44), TEST-52 (DRIFT-1.50) and
 *  TEST-13/14 each needed, and it is recorded rather than routed around silently. */
async function openColouredPane(
  page: Page,
  request: import('@playwright/test').APIRequestContext,
  label: string,
): Promise<PaneColorSeam> {
  const projectId = await createProject(request, `${label} ${Date.now()}`)
  await seedAnchoredProject(
    request,
    projectId,
    [categoricalColumn('col-cluster', COLOUR_COLUMN, { rows: MULTI.rows })],
    undefined,
    { rows: MULTI.rows, chunkRows: MULTI.chunkRows },
  )
  await loginAsOwner(page)
  await openVisualize(page, projectId)
  await frameThePane(page, { coordinateRows: MULTI.rows })

  // The row's OWN ▶, addressed by the accessible name the renderer composes per row (ITEM-30).
  // Exactly one node answers to it — a shared "Plot" label could not have that property, and a
  // locator matching several would make the click a coin toss between columns.
  const play = page.getByRole('button', { name: `Plot ${COLOUR_COLUMN}`, exact: true })
  await expect(play, `§ Colour by offered no row for "${COLOUR_COLUMN}"`).toHaveCount(1, { timeout: 60_000 })
  await play.click()

  // ASSERT THE STATE THIS MEASURES FROM. A pane must exist AND have resolved the seeded row space
  // before its colours mean anything: an empty digest read off a canvas with no pane satisfies "no
  // colour is wrong" for every implementation, which is the vacuity this whole arc is written
  // against.
  await expect.poll(async () => (await paneIdentities(page)).length, { timeout: 60_000 }).toBe(1)
  await expect
    .poll(async () => (await paneIdentities(page)).some(p => p.rows === MULTI.rows), { timeout: 60_000 })
    .toBe(true)
  await expect
    .poll(async () => positionsEvents(await progressLog(page)).some(e => e.done), { timeout: 60_000 })
    .toBe(true)

  const pane = await settledColorPane(page, MULTI.rows)
  console.log(
    `[${label}] panes=${JSON.stringify(await paneIdentities(page))} ` +
      `points=${pane.points} epoch=${pane.epoch} column=${pane.colorData?.column} ` +
      `labels=${JSON.stringify(pane.legend?.rawLabels)}`,
  )
  return pane
}

// ── TEST-28 [ITEM-20, ITEM-21] — an emitted colour-by plot keeps its rows and its category set ──

test('TEST-28 — an emitted categorical colour-by plot renders every seeded row and the whole declared category set', async ({
  page,
  request,
}) => {
  const pane = await openColouredPane(page, request, 'streaming-colour-emit')
  console.log(
    `[TEST-28] column=${pane.colorData?.column} categorical=${pane.colorData?.categorical} ` +
      `points=${pane.points} labels=${JSON.stringify(pane.legend?.rawLabels)} epoch=${pane.epoch}`,
  )

  // It is the column the row's ▶ named, and it is being treated as CATEGORICAL. The fail-open
  // class ITEM-20/21 are about is a gate that quietly reclassifies rather than refusing, so the
  // classification is asserted and not inferred from the picture looking plausible.
  expect(pane.colorData, 'the pane published no colour column at all').not.toBeNull()
  expect(pane.colorData!.column, 'the pane is coloured by a column the row did not name').toBe(COLOUR_COLUMN)
  expect(pane.colorData!.categorical, 'the categorical column was coloured as continuous').toBe(true)

  // EVERY seeded row is in the buffer — not "about as many". A read that dropped the tail would
  // still render a plausible plot.
  expect(pane.points, 'the colour buffer covers fewer rows than the artifact has').toBe(MULTI.rows)
  expect(pane.rgba.length).toBe(MULTI.rows * 4)

  // THE CATEGORY SET, whole — asserted as a SET, not as a count. A migration that lost a category,
  // renamed one, or silently added one moves this and nothing else does; a count would absorb a
  // rename and a swap.
  //
  // ── WHAT THIS SET IS, MEASURED ────────────────────────────────────────────────────────────
  //
  // The fixture DECLARES four levels and only three ever occur (`'NEVER-OBSERVED'` is declared and
  // unused, INV-11). The pane's legend reports the THREE OBSERVED ones. That is recorded as a
  // measurement rather than asserted away in either direction: TEST-28's claim in TESTS.md is that
  // the emitted plot keeps "the same category set as before the typed migration" — a regression
  // control over ITEM-20/21 — and it is NOT the claim that the producer's declared level set
  // reaches the raster legend. That second claim is TEST-57's, on the criteria picker, where it
  // passes. The gap between the two surfaces is reported in TEST_RESULTS rather than silently
  // encoded here as either a pass or a failure of a test that never asserted it.
  expect(pane.legend, 'a categorical colour-by published no legend').not.toBeNull()
  const labels = pane.legend!.rawLabels
  expect(labels, 'the legend carried no raw category names').not.toBeNull()
  expect(labels, `the offered category set moved; got ${JSON.stringify(labels)}`).toEqual(SEEDED_OBSERVED_LEVELS)
  expect(pane.legend!.columnId, 'the legend describes a different column than the buffer').toBe(COLOUR_COLUMN)
  // The measurement above, pinned so it cannot go stale silently: the declared set is strictly
  // larger than the one the legend reports, and this line fails the moment that stops being true —
  // in EITHER direction, so a later change that routes the declared set here is not absorbed.
  expect(SEEDED_DECLARED_LEVELS).toBeGreaterThan(labels!.length)

  // NON-VACUITY, and the reason this test is not a point count: the buffer must actually
  // DISTINGUISH the categories. Every point shaded identically satisfies every assertion above.
  const groups = partitionByColour(pane.rgba)
  expect(
    groups.size,
    `every point was shaded the same (${[...groups.keys()].join(' / ')}) — the point count is right and the ` +
      'plot is meaningless, which is why this is asserted on the bytes',
  ).toBe(SEEDED_OBSERVED_CATEGORIES)
  // …and no row was left unpainted. A transparent tail is the shape of a colour pass that sized
  // itself from the wrong array.
  for (let i = 0; i < MULTI.rows; i++) {
    if (pane.rgba[i * 4 + 3] === 0) throw new Error(`row ${i} was left fully transparent by the colour pass`)
  }
})

// ── TEST-53 [ITEM-41] — the settled raster shades the RIGHT points, not merely the right number ──

test('TEST-53 — the settled colour buffer partitions rows exactly as the seeded categorical column does', async ({
  page,
  request,
}) => {
  // Run under the SAME arrival spacing the coverage legs use, deliberately. ITEM-41 is about the
  // MIXED state — a partial positions buffer while a complete colour column is applied — and a
  // read whose four chunks land in one task never visits that state at all. Spacing the arrivals
  // is what makes this an end-to-end control for the mixed-arrival indexing rather than a check on
  // a buffer that was only ever assembled once.
  await armChunkDelay(page, CHUNK_DELAY_MS)
  const pane = await openColouredPane(page, request, 'streaming-colour-partition')

  const groups = partitionByColour(pane.rgba)
  console.log(
    `[TEST-53] ${groups.size} distinct colours over ${pane.points} rows: ` +
      [...groups.entries()].map(([k, rows]) => `${k}×${rows.length}`).join(' | '),
  )

  // The buffer covers the whole artifact, and it is not one flat shade. Both are non-vacuity
  // guards: the partition assertion below is trivially satisfiable by a buffer of length 0, and
  // "the counts match" is trivially satisfiable by a uniform buffer when the classes are equal
  // sized — which they are here, by construction, which is exactly why this asserts MEMBERSHIP.
  expect(pane.points).toBe(MULTI.rows)
  expect(groups.size, 'the settled raster used one colour for everything').toBe(SEEDED_OBSERVED_CATEGORIES)

  // THE PROPERTY. Each colour's row set must be exactly one of the seeded categories' row sets,
  // and the four must be distinct — i.e. the colour partition IS the category partition.
  //
  // Not the per-category COUNTS on their own: the seeded classes are equal-sized (500 each), so a
  // rotation of the palette, an off-by-one row shift, or a buffer assembled against a stale
  // prefix all preserve every count while shading the wrong points. Counts are the proxy;
  // membership is the property, and this is the third time on this branch that swapping one for
  // the other came out strictly stronger.
  const expected = new Map<number, string>()
  for (let c = 0; c < SEEDED_OBSERVED_CATEGORIES; c++) {
    const rows: number[] = []
    for (let i = 0; i < MULTI.rows; i++) if (seededCategoryOf(i) === c) rows.push(i)
    expected.set(c, rows.join(','))
  }
  const claimed = new Set<number>()
  for (const [colour, rows] of groups) {
    const key = rows.join(',')
    const match = [...expected.entries()].find(([, v]) => v === key)
    expect(
      match,
      `colour ${colour} covers ${rows.length} rows that are not any seeded category's row set ` +
        `(first rows: ${rows.slice(0, 8).join(',')}…) — the raster shaded the wrong points`,
    ).toBeDefined()
    expect(claimed.has(match![0]), `two colours claimed category ${match![0]}`).toBe(false)
    claimed.add(match![0])
  }
  expect(claimed.size, 'not every seeded category got its own colour').toBe(SEEDED_OBSERVED_CATEGORIES)

  // …and the counts follow from the membership, stated because TESTS.md words TEST-53 that way.
  // Derived from the fixture rather than written as `rows / 3`: 2,000 does not divide by 3, and a
  // hand-rounded expectation is how a test starts asserting arithmetic instead of behaviour.
  const expectedCounts = Array.from({ length: SEEDED_OBSERVED_CATEGORIES }, (_, c) =>
    Array.from({ length: MULTI.rows }, (_, i) => i).filter(i => seededCategoryOf(i) === c).length,
  ).sort((a, b) => a - b)
  expect([...groups.values()].map(r => r.length).sort((a, b) => a - b)).toEqual(expectedCounts)
  expect(
    [...groups.values()].reduce((n, r) => n + r.length, 0),
    'the colour groups do not cover every row',
  ).toBe(MULTI.rows)
})
