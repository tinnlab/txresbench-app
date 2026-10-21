import { test, expect, type Page } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'

// A COMPOSED grid — one where the host namespaced every pane key because several independently
// authored declarations share the surface — driven by a real pointer.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────────
// The drag hit-test snapshots pane boxes off the DOM and feeds the recovered ids straight into the
// store. It reads them from the pane's dedicated store-key attribute (named, with the reason, in
// `viz-core`'s own pane-DOM-identity suite), NOT from the test id — the test id is what a reader
// addresses (the id a declaration wrote) while the store is keyed by the host's fold key.
// Every other grid spec drives a fixture where those two are the SAME STRING, so inverting through
// the wrong one succeeds there by coincidence and no existing test can see the difference. jsdom
// cannot cover it either: `getBoundingClientRect` is all zeros there, so every box is degenerate
// and the hit-test resolves nothing. Hence a real browser, on the one fixture where the two ids
// differ.
//
// ── HOW IT IS ADDRESSED ─────────────────────────────────────────────────────────────────────────
// By the pane TOOLBAR (`viz-pane-toolbar-<addressed>`), whose parent element IS the pane root — so
// the pane's box is one hop away — and by the grip's ROLE plus its accessible name, which is the
// selector priority this repo asks for anyway. Neither needs a prefix that this file, a shared
// helper of it, is not allowed to spell (`_helpers.ts` carries no budget for the grid's own noun,
// and shared helpers here stay generic on purpose).

/** What the story publishes off the LIVE store: the host's key, the id a reader addresses, the kind. */
type PaneModel = { key: string; addressed: string; kind: string }

const TOOLBAR_PREFIX = 'viz-pane-toolbar-'
const TOOLBAR = `[data-testid^="${TOOLBAR_PREFIX}"]`

/** Each pane's addressed id and the box of the pane it heads (its toolbar's parent). */
async function panes(page: Page) {
  return page.$$eval(
    TOOLBAR,
    (els, prefix) =>
      els.map(e => {
        const box = (e.parentElement as HTMLElement).getBoundingClientRect()
        return {
          addressed: (e.getAttribute('data-testid') as string).slice(prefix.length),
          cx: box.x + box.width / 2,
          cy: box.y + box.height / 2,
        }
      }),
    TOOLBAR_PREFIX,
  )
}

/**
 * Every test id THIS CODEBASE stamps, so a leak is caught by CLASS rather than by a maintained list.
 *
 * `[data-panel]` is excluded, and the exclusion is a FINDING rather than a convenience.
 * `react-resizable-panels` renders each split-tree leaf and writes `data-testid={id}` **and**
 * `id={id}` from its own `id` prop — with the caller's rest props spread FIRST, so the library's
 * value always wins and a `data-testid` passed in is silently discarded. That `id` has to stay the
 * grid's key: it is what the layout and the pane registry are keyed by, and two declarations may
 * legitimately name a pane the same thing, so the authored id is not unique enough to key a layout.
 * Shaping it would take a wrapper element around every leaf, which is a layout change, not an id
 * change. Recorded here instead of quietly widening the assertion's silence.
 */
async function ourTestIds(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid]:not([data-panel])', els =>
    els.map(e => e.getAttribute('data-testid') as string),
  )
}

test('a composed grid is addressed by authored ids, and a real drag still swaps its panes', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'composed-grid')
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  await expect(page.locator(TOOLBAR)).toHaveCount(2)

  // ── 1. the fixture really is composed ──────────────────────────────────────────────────────────
  // Without this the rest is theatre: on an un-composed grid both halves below hold trivially.
  const before = await vizTest<PaneModel[]>(page, 'composedPanes')
  expect(before, 'the story publishes its live model').toHaveLength(2)
  for (const p of before) {
    expect(p.key, "the host namespaced this pane's key").toContain('::')
    expect(p.addressed, 'what a reader addresses is the id its author wrote').not.toContain('::')
    expect(p.key.endsWith(`::${p.addressed}`), 'the two ids name the same pane').toBe(true)
  }
  expect(before[0].kind, 'the two panes differ, so a swap is observable').not.toBe(before[1].kind)

  // ── 2. nothing in the DOM carries the host's separator ─────────────────────────────────────────
  const leaked = (await ourTestIds(page)).filter(id => id.includes('::'))
  expect(
    leaked,
    'a test id carrying the separator makes every reader of it — a spec, a screenshot diff, a ' +
      'person — depend on which declaration happened to contribute the pane',
  ).toEqual([])

  // ── 3. a real drag still swaps them ────────────────────────────────────────────────────────────
  const boxes = await panes(page)
  expect(boxes.map(b => b.addressed).sort()).toEqual(before.map(p => p.addressed).sort())
  // Drag the SECOND pane's grip (its toolbar is clear of the workspace's left-edge tool rail) onto
  // the FIRST pane's centre — `dropZoneFor`'s centre square is what resolves to a swap rather than
  // a reposition, so the drop point has to be the middle of the target, not its chrome.
  const source = page.locator(TOOLBAR).nth(1).getByRole('button', { name: /^Drag / })
  const grip = await source.boundingBox()
  expect(grip, 'the grip has a box to press').toBeTruthy()
  if (!grip) return
  const target = boxes[0]

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.cx, target.cy, { steps: 14 })

  // Mid-drag, the floating ghost is appended to the document BODY — outside the workspace, which is
  // why the per-pane suites cannot see it. It is stamped from the same id as everything else.
  const mid = await ourTestIds(page)
  expect(mid.filter(id => id.includes('::')), 'the drag ghost leaks nothing either').toEqual([])
  expect(
    mid.some(id => id.endsWith(`-${boxes[1].addressed}`) && !id.startsWith(TOOLBAR_PREFIX)),
    'the drag must actually have started (its ghost is in the document)',
  ).toBe(true)

  await page.mouse.up()

  // The panes traded content, keeping their keys and positions — which the store can only have done
  // from the id recovered off the DOM. Had the hit-test inverted through the addressed id, the
  // store would have been handed an id it does not hold and the swap would silently no-op.
  await expect
    .poll(async () => (await vizTest<PaneModel[]>(page, 'composedPanes')).map(p => p.kind).join(','), {
      timeout: 15_000,
    })
    .toBe([before[1].kind, before[0].kind].join(','))

  const after = await vizTest<PaneModel[]>(page, 'composedPanes')
  expect(after.map(p => p.key), 'a swap trades content, never keys').toEqual(before.map(p => p.key))
  expect(after.map(p => p.addressed), '…and never what a reader addresses').toEqual(
    before.map(p => p.addressed),
  )

  const realErrors = bag.errors.filter(
    e => !/context (lost|restored)|webglcontextlost|deck\.gl: assertion|deck: initialization/i.test(e),
  )
  expect(realErrors, `console errors: ${realErrors.join('\n')}`).toEqual([])
})
