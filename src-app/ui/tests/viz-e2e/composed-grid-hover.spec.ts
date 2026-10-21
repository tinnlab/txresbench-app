import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'

// A COMPOSED grid — one where the host namespaced every pane key because several independently
// authored declarations share the surface — HOVERED by a real pointer.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────────
// `composed-grid-drag.spec.ts` drives the same fixture with a real pointer, but a DRAG: it proves
// the grid can invert a pane's key off the DOM. Hover is a different route through the same
// ambiguity and it was broken on both of its branches, because the shared-deck hover handler
// recovered the hovered pane by PARSING the picked layer id — the text before the FIRST `::`.
// A plot publishes `<paneKey>::<layerName>` and a composing host mints `<view>::<pane>`, so the
// parse answered `<view>`: a string naming no pane on the surface.
//
//   · over the MATRIX pane (a plot sharing the workspace deck) the wrong-but-truthy parse
//     short-circuited past the `|| viewport.id` fallback that existed for exactly this case, so
//     the plot received no hover at all — no crosshair, no readout, in silence;
//   · over the POINT pane the picked index resolved to a key the grid does not hold, so its
//     readout and the cross-plot highlight were dropped. No fallback there, so a different
//     symptom from the same line of reasoning — which is why only one of the two would ever be
//     reported.
//
// ── WHY THIS MEASURES THE READOUT AND NOT THE HANDLER ───────────────────────────────────────────
// "the hover handler was called" is true on the broken build too — it is called, decides the
// hover belongs to nobody, and returns. The observable difference is whether the thing a USER
// reads appears, and whether it appears from the plot they are pointing at. So this asserts the
// readout badge is in the document, that the MATRIX pane's badge is rendered INSIDE that pane's
// own subtree (only that plot's own renderer can put it there), and that the two panes produce
// DIFFERENT text — one shared badge answering for both would pass a mere existence check.
//
// ── ADDRESSING ──────────────────────────────────────────────────────────────────────────────────
// By the pane TOOLBAR (`viz-pane-toolbar-<addressed>`), whose parent element IS the pane root, for
// the same reason `composed-grid-drag.spec.ts` gives: the test id carries the id an author wrote,
// never the host's fold key, and this file may spell neither the grid's own noun nor the key.

const TOOLBAR_PREFIX = 'viz-pane-toolbar-'
const TOOLBAR = `[data-testid^="${TOOLBAR_PREFIX}"]`
/** The positioned readout badge every hover surface renders (`VizTooltip`'s default test id). */
const READOUT = '[data-testid="viz-tooltip"]'

/** What the story publishes off the LIVE store: the host's key, the id a reader addresses, the kind. */
type PaneModel = { key: string; addressed: string; kind: string }

interface PaneBox {
  addressed: string
  x: number
  y: number
  width: number
  height: number
}

/** Each pane's addressed id and the box of the pane it heads (its toolbar's parent). */
async function panes(page: Page): Promise<PaneBox[]> {
  return page.$$eval(
    TOOLBAR,
    (els, prefix) =>
      els.map(e => {
        const b = (e.parentElement as HTMLElement).getBoundingClientRect()
        return {
          addressed: (e.getAttribute('data-testid') as string).slice(prefix.length),
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
        }
      }),
    TOOLBAR_PREFIX,
  )
}

/**
 * Sweep the pointer across a pane's plot area until the readout appears, and answer with its text.
 *
 * A sweep rather than one centre press because a POINT plot only reads out over an actual mark, and
 * where the marks land is a property of the fixture's seed, not of the routing under test. It cannot
 * turn a broken build green: on the broken route NO position in the pane reads out, because the
 * hover is attributed to a pane the grid does not hold before any position is considered.
 *
 * The upper band of the box is skipped — that is the pane's own chrome, not its plot.
 */
async function readoutBySweeping(
  page: Page,
  box: PaneBox,
  paneSelector: string,
): Promise<{ text: string; insidePane: boolean }> {
  const cols = 5
  const rows = 4
  const top = box.y + box.height * 0.35
  const usable = box.height * 0.55
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      await page.mouse.move(
        box.x + (box.width * (c + 1)) / (cols + 1),
        top + (usable * (r + 1)) / (rows + 1),
      )
      // One frame for the rAF-throttled hover→setState, plus slack for a software-WebGL pick.
      await page.waitForTimeout(140)
      // PRESENCE, TEXT and OWNERSHIP read in ONE evaluate. Separate round-trips are a race
      // against a badge re-rendered every frame: the second call re-queries, finds the node it
      // was handed detached, and retries until the test times out (measured — 180s, not a
      // hypothetical). One snapshot also means the three facts describe the same instant.
      const seen = await page.evaluate(
        ({ tipSel, paneSel }) => {
          const tip = document.querySelector(tipSel)
          if (!tip) return { text: '', insidePane: false }
          const pane = document.querySelector(paneSel)?.parentElement ?? null
          return {
            text: (tip.textContent ?? '').replace(/\s+/g, ' ').trim(),
            insidePane: pane != null && pane.contains(tip),
          }
        },
        { tipSel: READOUT, paneSel: paneSelector },
      )
      if (seen.text !== '') return seen
    }
  }
  return { text: '', insidePane: false }
}

test('a composed grid reads out under the pointer, from the plot the pointer is on', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'composed-grid')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  await expect(page.locator(TOOLBAR)).toHaveCount(2)

  // ── 1. the fixture really is composed ──────────────────────────────────────────────────────────
  // Without this the rest is theatre: on an un-composed grid the parse and the viewport agree, so
  // both routes below hold on the broken build too.
  const model = await vizTest<PaneModel[]>(page, 'composedPanes')
  expect(model, 'the story publishes its live model').toHaveLength(2)
  for (const p of model) {
    expect(p.key, "the host namespaced this pane's key").toContain('::')
    expect(p.key.endsWith(`::${p.addressed}`), 'the two ids name the same pane').toBe(true)
  }

  const boxes = await panes(page)
  expect(boxes).toHaveLength(2)
  // The MATRIX pane is the one sharing the workspace deck as a plot-view; the other draws points.
  const matrixAddressed = model.find(p => p.kind === 'heatmap')?.addressed
  expect(matrixAddressed, 'the fixture contributes a matrix pane').toBeTruthy()
  const matrixBox = boxes.find(b => b.addressed === matrixAddressed) as PaneBox
  const pointBox = boxes.find(b => b.addressed !== matrixAddressed) as PaneBox
  expect(matrixBox && pointBox, 'both panes have a box to point at').toBeTruthy()

  // ── 2. NEGATIVE CONTROL for the measurement ────────────────────────────────────────────────────
  // Park the pointer off every pane first. If a badge were permanently in the document, every
  // assertion below would pass without a working hover.
  await page.mouse.move(4, 4)
  await page.waitForTimeout(300)
  expect(
    await page.locator(READOUT).count(),
    'a readout badge is not a permanent fixture of the page',
  ).toBe(0)

  // ── 3. the MATRIX pane reads out, from ITS OWN renderer ────────────────────────────────────────
  const matrixSel = `[data-testid="${TOOLBAR_PREFIX}${matrixAddressed}"]`
  const matrix = await readoutBySweeping(page, matrixBox, matrixSel)
  expect(
    matrix.text,
    'pointing at the matrix produced no readout. The grid routes a shared-deck hover to the pane ' +
      'under the pointer; a composed pane key (`<view>::<pane>`) contains the separator too, so an ' +
      'owner parsed out at the FIRST `::` names no pane and the hover reaches nothing.',
  ).not.toBe('')
  // Rendered INSIDE the matrix pane's own subtree — only that plot's renderer can do that, so this
  // is the hover arriving at the right plot rather than merely arriving somewhere.
  expect(
    matrix.insidePane,
    "the matrix pane's readout must come from that pane's own renderer",
  ).toBe(true)

  // ── 4. …and the POINT pane reads out too, with DIFFERENT text ──────────────────────────────────
  await page.mouse.move(4, 4)
  await expect(page.locator(READOUT), 'leaving a pane clears its readout').toHaveCount(0, {
    timeout: 10_000,
  })

  const point = await readoutBySweeping(page, pointBox, matrixSel)
  expect(
    point.text,
    'pointing at a mark in the point plot produced no readout. The picked index is an offset into ' +
      "that pane's own buffer, so it is dropped when the hover is attributed to a key the grid " +
      'does not hold — which is what parsing the owner out of the layer id produced here.',
  ).not.toBe('')
  expect(
    point.text,
    'each pane must answer for ITSELF — one badge answering for both would pass an existence check',
  ).not.toBe(matrix.text)
  // …and it is NOT the matrix pane's badge lingering: the point readout is drawn by the workspace,
  // outside every pane's subtree.
  expect(
    point.insidePane,
    "the point plot's readout is not the matrix pane's badge under a new name",
  ).toBe(false)

  const realErrors = bag.errors.filter(
    e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e),
  )
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
