// LEDGER #38 — *"use virtual scrolling with proper aria row indices"* · *"Also do not use native
// scroll bar please"*, driven through the real app.
//
// ── Why this has to be an e2e ────────────────────────────────────────────────────────────
//
// The unit suite (`entryList.test.tsx`) proves the window's ARITHMETIC, but it proves it against
// a layout this file has to STATE, because jsdom has none: the viewport's height, each row's
// measured height, and the clamp the virtualiser applies to a programmatic scroll are all values
// the test writes down. That is legitimate for arithmetic and worthless for the two claims that
// are ONLY about a real browser:
//
//   · the virtualiser is bound to the node that actually scrolls. overlayscrollbars interposes
//     its own viewport, and a virtualiser measuring the HOST instead sees a box that never
//     changes — a window that never updates. In jsdom both nodes report whatever the test says,
//     so binding the wrong one passes there and fails here.
//   · the scrollbar is overlayscrollbars' and not the platform's, and its thumb is proportioned
//     to the FULL filtered set. The thumb is what made the "Showing 200 of 35,477" line
//     redundant, so its proportion is the claim, and `--os-viewport-percent` — the variable
//     overlayscrollbars computes it from — only has a value where there is layout.
//
// The pane is driven at the mockup's own 300px, and again at a 390px mobile viewport, because a
// list that windows correctly and overflows its rail is still broken.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { DT, textColumnArtifact } from '../14-declarative-qc/_fixtures'
import { capture } from './_capture'
import {
  OWNER_SHAPE,
  SECTIONS,
  SIBLING_AXIS,
  openVisualize,
  seedAnchoredProject,
  seedOwnerImportedShape,
} from './_visualize'

/** The pane's real width — the mockup's own, and the width every layout claim here is settled
 *  at. Set through the shipped persistence key before the app boots. */
const PANE_PX = 300
/** A mobile viewport. The rail is the same width; the WINDOW is not, so the question is whether
 *  the page overflows sideways once the list is inside an overlay scroller. */
const MOBILE = { width: 390, height: 780 }

/** Big enough that a window is unmistakable in the DOM and small enough to seed in one request.
 *  The owner's own axis is 35,477; the claim under test is the same at either size — the DOM
 *  holds a screenful — and this file is the one that pays for the seeding. */
const BULK_ENTRIES = 3_000

async function setRegionWidth(page: Page, px: number): Promise<void> {
  await page.addInitScript(
    ([key, width]: [string, number]) => {
      const raw = window.localStorage.getItem(key)
      const blob = raw ? (JSON.parse(raw) as Record<string, unknown>) : { v: 1, byProject: {} }
      blob.prefs = { leftWidth: width, rightWidth: width, bottomHeight: 240 }
      window.localStorage.setItem(key, JSON.stringify(blob))
    },
    ['txr.wb.regions', px] as [string, number],
  )
}

/** A project whose sibling axis carries {@link BULK_ENTRIES} entries — the shape this ledger row
 *  is about. Built from the same primitives as the contested fixture; only the cardinality
 *  differs. */
async function seedBulkEntryProject(request: APIRequestContext, projectId: string): Promise<void> {
  const keys = textColumnArtifact(
    'entry keys',
    Array.from({ length: BULK_ENTRIES }, (_, i) => `ent-${String(i).padStart(5, '0')}`),
    SIBLING_AXIS,
  )
  await seedAnchoredProject(request, projectId, [
    {
      output_id: 'entry-index',
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: { ...keys.structure, key: 'values' },
      meta: { ...keys.meta, is_axis_index: true },
      content: { encoding: 'members', members: keys.members },
    },
  ])
}

const entriesSection = (page: Page) => page.locator(`[data-section-id="${SECTIONS.entries}"]`)
const grid = (page: Page) => page.getByTestId('widget-entries-grid')
const scrollHost = (page: Page) => page.getByTestId('widget-entries-scroll')
const mountedRows = (page: Page) => page.locator('[data-testid^="widget-entries-row-"]')

/** Ensure the entry section is OPEN — idempotently (the section ships open; a blind click would
 *  close it). Same shape as `entries-contested.spec.ts`'s helper. */
async function openEntries(page: Page): Promise<void> {
  const section = entriesSection(page)
  await expect(section).toBeVisible({ timeout: 30_000 })
  const header = section.getByRole('button').first()
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
}

test.describe('the entry list is windowed, and scrolls without a native scrollbar', () => {
  test('300px — a 3,000-entry axis mounts a screenful, and says 3,000 to a screen reader', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `entries-virt ${Date.now()}`)
    await seedBulkEntryProject(request, projectId)
    await loginAsOwner(page)
    await setRegionWidth(page, PANE_PX)
    await openVisualize(page, projectId)
    await openEntries(page)

    const g = grid(page)
    await expect(g).toBeVisible({ timeout: 30_000 })

    // ── the ARIA half: the count is the SET ─────────────────────────────────────────────
    await expect(g).toHaveAttribute('role', 'grid')
    await expect(g).toHaveAttribute('aria-rowcount', String(BULK_ENTRIES), { timeout: 30_000 })

    // ── the WINDOW half: the DOM holds a screenful of it ────────────────────────────────
    const mounted = await mountedRows(page).count()
    expect(mounted, 'nothing is mounted — this whole spec would be vacuous').toBeGreaterThan(0)
    expect(mounted, 'the list is not windowed').toBeLessThan(120)

    // …and the rows say WHERE IN THE SET they are, not where in the window.
    const firstIndex = await mountedRows(page).first().getAttribute('aria-rowindex')
    expect(Number(firstIndex)).toBe(1)

    // ── the SCROLLER is overlayscrollbars', and its thumb is the set's ──────────────────
    const report = await g.evaluate((el: HTMLElement) => {
      const vp = el.closest('[data-overlayscrollbars-viewport]') as HTMLElement | null
      const bar = el.closest('[data-overlayscrollbars-initialize]')?.querySelector('.os-scrollbar-vertical')
      return {
        boundToOverlayViewport: vp !== null,
        // The node that actually scrolls, and whether its content is the whole set.
        scrollHeight: vp?.scrollHeight ?? 0,
        clientHeight: vp?.clientHeight ?? 0,
        // overlayscrollbars' OWN thumb proportion — clientHeight / scrollHeight.
        viewportPercent: bar === undefined || bar === null
          ? null
          : Number(getComputedStyle(bar as HTMLElement).getPropertyValue('--os-viewport-percent')),
        // Every native y-scroller inside the widget. There must be none.
        nativeScrollers: [...(el.closest('[data-testid="widget-entries"]')?.querySelectorAll('*') ?? [])]
          .filter(n => {
            if ((n as HTMLElement).hasAttribute('data-overlayscrollbars-viewport')) return false
            const oy = getComputedStyle(n).overflowY
            return (oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1
          })
          .map(n => (n as HTMLElement).getAttribute('data-testid') ?? n.tagName),
      }
    })

    expect(report.boundToOverlayViewport, 'the grid is not inside an overlayscrollbars viewport').toBe(true)
    expect(report.nativeScrollers, 'a native scroll box survives inside the list').toEqual([])
    // THE HONEST THUMB. The scroller's content is the whole set, so the thumb is a small
    // fraction of the track — which is the statement that replaced "Showing 200 of 3,000".
    expect(report.scrollHeight).toBeGreaterThan(report.clientHeight * 10)
    expect(report.viewportPercent, 'overlayscrollbars computed no thumb proportion').toBeGreaterThan(0)
    expect(report.viewportPercent, 'the thumb claims the list is a screenful long').toBeLessThan(0.2)

    // ── the END IS REACHABLE, which is what the removed Show-more control used to carry ──
    await g.focus()
    await page.keyboard.press('End')
    await expect(page.getByTestId(`widget-entries-entry-ent-0${BULK_ENTRIES - 1}`)).toBeVisible({
      timeout: 30_000,
    })
    const lastIndex = await page
      .locator(`[data-testid="widget-entries-row-ent-0${BULK_ENTRIES - 1}"]`)
      .getAttribute('aria-rowindex')
    expect(Number(lastIndex)).toBe(BULK_ENTRIES)

    // …and the SEARCH still reaches an entry the window never held.
    await page.keyboard.press('Home')
    await page.getByTestId('widget-entries-search').fill('ent-02500')
    await expect(page.getByTestId('widget-entries-entry-ent-02500')).toBeVisible({ timeout: 30_000 })
    await expect(g).toHaveAttribute('aria-rowcount', '1')

    // The image the honesty claim is read off: a 3,000-entry list at 300px, with a thumb
    // proportioned to 3,000 and no count line under it.
    await page.getByTestId('widget-entries-search').fill('')
    await page.mouse.move(160, 400)
    await capture(test.info(), entriesSection(page), 'entries-virtualized-300-bulk.png')
  })

  test('300px — the owner’s own shape, captured', async ({ page, request }) => {
    // The screenshot this row is judged on: the shipped pane at the mockup's width, on the
    // fixture built from an ordinary import. Written to a PATH and asserted non-empty (see
    // `_capture.ts` — six earlier captures in this suite were green and produced no files).
    const projectId = await createProject(request, `entries-virt-owner ${Date.now()}`)
    await seedOwnerImportedShape(request, projectId, 'Population 1')
    await loginAsOwner(page)
    await setRegionWidth(page, PANE_PX)
    await openVisualize(page, projectId)
    await openEntries(page)

    await expect(grid(page)).toBeVisible({ timeout: 30_000 })
    await expect(grid(page)).toHaveAttribute('aria-rowcount', String(OWNER_SHAPE.entries), {
      timeout: 30_000,
    })
    // A short list is fully mounted and acquires no window furniture — the property the mount
    // budget also had, and the reason a five-row axis does not grow a scrollbar.
    await expect(mountedRows(page)).toHaveCount(OWNER_SHAPE.entries)

    // The SECTION, not the whole stack: the stack screenshot is clipped to the viewport and the
    // list sits below the fold, so a stack capture would prove the pane opened and show nothing
    // of the thing this row is about.
    const path = await capture(test.info(), entriesSection(page), 'entries-virtualized-300.png')
    test.info().annotations.push({ type: 'capture', description: path })
    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'entries-virtualized-300-pane.png')
  })

  test('390px mobile — the windowed list does not push the page sideways', async ({ page, request }) => {
    const projectId = await createProject(request, `entries-virt-mobile ${Date.now()}`)
    await seedBulkEntryProject(request, projectId)
    await page.setViewportSize(MOBILE)
    await loginAsOwner(page)
    await setRegionWidth(page, PANE_PX)
    // Below 768px the stack lives in `MobileShell`'s LEFT sheet and is opened by its own
    // affordance — the dock tab `openVisualize` clicks does not exist there. Same route
    // `pane-legibility.spec.ts` takes for its phone surface.
    await page.goto(`/projects/${projectId}/workspace`)
    const shell = page.getByTestId('workbench-shell')
    await shell.waitFor({ state: 'visible', timeout: 60_000 })
    await expect(shell).toHaveAttribute('data-workbench-mobile', 'true')
    const trigger = page.getByRole('button', { name: 'Visualize', exact: true }).first()
    if (await trigger.count()) await trigger.click()
    await expect(page.getByTestId('section-stack-visualize')).toBeVisible({ timeout: 60_000 })
    await openEntries(page)

    await expect(grid(page)).toBeVisible({ timeout: 30_000 })
    await expect(mountedRows(page).first()).toBeVisible({ timeout: 30_000 })

    // The absolutely-positioned row track is the thing that could overflow: it is `width: 100%`
    // of a positioned grid, so it must not become a wider box than the scroller that holds it.
    const fits = await scrollHost(page).evaluate((host: HTMLElement) => ({
      host: host.getBoundingClientRect().width,
      track: (host.querySelector('[role="rowgroup"]') as HTMLElement).getBoundingClientRect().width,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: document.documentElement.clientWidth,
    }))
    expect(fits.track).toBeLessThanOrEqual(fits.host + 1)
    expect(fits.docScrollW, 'the page scrolls sideways at 390px').toBeLessThanOrEqual(fits.docClientW + 1)

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'entries-virtualized-390.png')
  })
})
