// The user-reported defect, driven end to end through a REAL popped-out OS window:
//
//   "Tooltips and other things that show in a popup won't work in popup or separate window
//    because its container is on the main window."
//
// A pane popped out of the workbench renders into a second window's document (`window.open` →
// `@txresbench/dock`'s `ContainerWindows` portals the pane's React subtree into it). Every kit overlay is
// portaled by Base UI, which resolved its target as `container ?? parentPortalNode ?? document.body`
// — with `document` being the AMBIENT global, i.e. the OPENER's. So an overlay opened from inside a
// popped-out pane was appended to the main window instead: invisible where the user is looking, and
// positioned against the wrong viewport.
//
// jsdom cannot falsify this. A unit test with one document passes on the broken code, and the two
// suites that DO use two documents (sdk/packages/kit/src/kit/portal-container.test.tsx and
// src/modules/workbench/core/shell/regions/popoutPortalContainer.test.tsx) use an iframe as the
// stand-in. This spec is the only place a genuine `window.open` popup is exercised, so it is the
// only place the actual report is reproduced.
//
// Each test asserts THREE things, because two of them are individually satisfiable by a bug:
//   1. the overlay exists in the popup;
//   2. it does NOT exist in the opener (this is the assertion the defect fails);
//   3. it is laid out INSIDE the popup's own viewport — an overlay portaled into the right document
//      but positioned against the opener's 1280×820 viewport would sit off-screen in a 900×680
//      window, which is the "mispositioned" half of the report.
//
// Backend-free: the gallery mounts the real WorkbenchShell over a seeded fake host.

import { expect, test } from '@playwright/test'
// The popout driver + the popup's geometry live in ONE module (`tests/visual/_popout.ts`),
// shared with the popup-WIDTH spec that runs under `playwright.visual.config.ts`. A second
// copy here would drift silently: a driver that quietly stopped popping out reads exactly
// like a working one, because nothing downstream of it is ever reached.
import { expectInsidePopupViewport, openWorkbench, popOutPane } from '../visual/_popout'

test('a TOOLTIP opened inside a popped-out window renders in that window, not the opener', async ({
  page,
}) => {
  await openWorkbench(page)
  const { popup } = await popOutPane(page, 'jobs')

  const trigger = popup.getByTestId('workbench-jobs-stop-j1')
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  await trigger.hover()

  await expect(popup.locator('[data-slot="tooltip-content"]')).toHaveCount(1, { timeout: 10_000 })
  // The defect: the tooltip was appended to the OPENER's body.
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
  await expectInsidePopupViewport(popup, '[data-slot="tooltip-content"]')
})

test('a SELECT opened inside a popped-out window renders — with its options — in that window', async ({
  page,
}) => {
  await openWorkbench(page)
  const { popup, paneId } = await popOutPane(page, 'compare')

  const trigger = popup.getByTestId(`workbench-compare-add-${paneId}`)
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  await trigger.click({ force: true })

  await expect(popup.locator('[data-slot="select-content"]')).toHaveCount(1, { timeout: 10_000 })
  // Options must be in the popup too — a list left behind in the opener is unusable, and an
  // options-only leak would slip past a content-only assertion.
  expect(await popup.locator('[role="option"]').count()).toBeGreaterThan(0)
  await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0)
  await expect(page.locator('[role="option"]')).toHaveCount(0)
  await expectInsidePopupViewport(popup, '[data-slot="select-content"]')
})

test('the popped-out window carries the stylesheets and root theme attributes an overlay needs', async ({
  page,
}) => {
  // A portal that lands in the right document but unstyled is still broken: every kit colour token
  // is defined on `:root` / `html.dark`, so a popup missing the sheets or the root class renders
  // the overlay with no background at all, or in the wrong theme.
  await openWorkbench(page)
  const opener = await page.evaluate(() => ({
    cls: document.documentElement.className,
    dir: document.documentElement.getAttribute('dir'),
  }))
  const { popup } = await popOutPane(page, 'jobs')

  const inPopup = await popup.evaluate(() => ({
    sheets: document.head.querySelectorAll('style,link[rel="stylesheet"]').length,
    cls: document.documentElement.className,
    dir: document.documentElement.getAttribute('dir'),
    // ContainerWindows owns this — it must survive the root-attribute mirroring.
    htmlHeight: document.documentElement.style.height,
  }))

  expect(inPopup.sheets).toBeGreaterThan(0)
  expect(inPopup.cls).toBe(opener.cls)
  expect(inPopup.dir).toBe(opener.dir)
  expect(inPopup.htmlHeight).toBe('100%')

  // The token actually resolves in the popup — proving the sheets are not merely present but live.
  const bg = await popup.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--popover').trim(),
  )
  expect(bg).not.toBe('')
})
