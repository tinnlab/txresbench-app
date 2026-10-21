import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'
import { seedPlottableProject } from '../14-declarative-qc/_seed'

// The workbench command palette must be the TOPMOST thing at its own coordinates.
//
// ── The defect ──────────────────────────────────────────────────────────────────────────────
// The palette's result list used to be a plain `absolute … z-50` div rendered inside the header
// bar. `HeaderBarContainer` gives that bar `position: relative; z-index: 2`, which makes it a
// STACKING CONTEXT — so `z-50` only ever competed with the palette's own siblings. The canvas
// grid paints its per-plot chrome (pane toolbar, dividers, overlays) at `z-index: 2…7` from
// inside the dock host, which establishes NO stacking context of its own, so that chrome
// competes in the ROOT context and outranks the whole 50px header. Result: the dropdown
// rendered UNDER the canvas chrome and its options were unclickable.
//
// ── Why the assertion is `elementFromPoint` and not a class or a z-index ─────────────────────
// "the list has z-50" was true the entire time the bug existed. A z-index/class assertion
// cannot distinguish "wins" from "loses inside a clamped stacking context", which is exactly
// how this would regress. So the test asks the browser the question the user asks: at the
// centre of each option row, WHICH ELEMENT IS ON TOP?
//
// ── The positive control ────────────────────────────────────────────────────────────────────
// A palette that overlaps nothing passes trivially. On a fresh (empty-canvas) project it does
// exactly that — measured — so the spec seeds a PLOTTABLE project, waits for the real grid, and
// FAILS if the canvas chrome does not actually overlap the open list. A void premise is
// reported as a void premise, never as a pass.

/** Chrome the viz grid paints in the root stacking context, at the z-indexes that used to win.
 *  The per-plot toolbar is the one that measurably covered the list (its controls came out on top
 *  of the "Open produced artifacts" row). */
const CANVAS_CHROME = '[data-testid^="viz-pane-toolbar-"]'

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Open a project whose canvas really paints the deck grid + its chrome. */
async function openPlottedWorkbench(page: Page, request: Parameters<typeof createProject>[0]) {
  const id = await createProject(request, `Palette stacking ${Date.now()}`)
  await seedPlottableProject(request, id)
  await openWorkbench(page, id)
  await page.getByTestId('viz-grid-workspace').first().waitFor({ state: 'visible', timeout: 60_000 })
  // Let the grid finish its first data pass so the transient loading overlay is gone and the
  // per-plot chrome is at its settled position.
  await page
    .getByTestId('viz-grid-loading')
    .first()
    .waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => {})
  await expect(page.locator('[data-testid^="viz-pane-toolbar-"]').first()).toBeVisible({
    timeout: 60_000,
  })
}

/** Focus the palette input and wait for its option list. */
async function openPalette(page: Page) {
  await page.getByTestId('workbench-command-input').click()
  const list = page.locator('[role="listbox"]', { has: page.locator('[role="option"]') })
  await list.first().waitFor({ state: 'visible', timeout: 15_000 })
  return list.first()
}

test.describe('workbench command palette stacking', () => {
  test('every option row is the topmost element at its own coordinates, over the canvas', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    await openPlottedWorkbench(page, request)
    const list = await openPalette(page)

    const probe = await page.evaluate(
      ({ chromeSelector }) => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        }
        const listEl = document.querySelector('[role="listbox"]:has([role="option"])')
        if (!listEl) return { error: 'no open listbox' as const }
        const options = Array.from(listEl.querySelectorAll('[role="option"]'))
        const describe = (el: Element | null): string => {
          if (!el) return 'nothing'
          const e = el as HTMLElement
          const cs = getComputedStyle(e)
          const own = e.dataset.testid ? ` testid=${e.dataset.testid}` : ''
          const near = e.closest('[data-testid]') as HTMLElement | null
          const owner = near && near !== e ? ` under=${near.dataset.testid}` : ''
          return `<${e.tagName.toLowerCase()}${own}${owner} z=${cs.zIndex}>`
        }
        return {
          listBox: box(listEl),
          chrome: Array.from(document.querySelectorAll(chromeSelector)).map(box),
          options: options.map(o => {
            const r = o.getBoundingClientRect()
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return {
              testid: (o as HTMLElement).dataset.testid ?? '(none)',
              covered: !(top && (top === o || o.contains(top))),
              topmost: describe(top),
            }
          }),
        }
      },
      { chromeSelector: CANVAS_CHROME },
    )

    expect(probe.error, 'the palette list must be open for this test to mean anything').toBeUndefined()
    if ('error' in probe) return

    // POSITIVE CONTROL — the premise. If the canvas chrome does not overlap the open list, this
    // spec proves nothing and must say so rather than pass.
    const overlapping = probe.chrome.filter(c => overlaps(c, probe.listBox))
    expect(
      overlapping.length,
      `the canvas chrome must overlap the open palette list for this test to be meaningful ` +
        `(list=${JSON.stringify(probe.listBox)}, chrome=${JSON.stringify(probe.chrome)})`,
    ).toBeGreaterThan(0)

    expect(probe.options.length, 'the palette must offer commands').toBeGreaterThan(0)
    const covered = probe.options.filter(o => o.covered)
    expect(
      covered,
      `these palette options are painted OVER by something else:\n` +
        covered.map(o => `  ${o.testid} → topmost ${o.topmost}`).join('\n'),
    ).toEqual([])
  })

  test('the palette stays a valid composite combobox (listbox / option / activedescendant)', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    await openPlottedWorkbench(page, request)
    await openPalette(page)
    // Move the highlight so `aria-activedescendant` is populated by a real interaction.
    await page.keyboard.press('ArrowDown')

    const a11y = await page.evaluate(() => {
      const input = document.querySelector<HTMLElement>('[data-testid="workbench-command-input"]')
      if (!input) return { error: 'no palette input' as const }
      const controlsId = input.getAttribute('aria-controls')
      const controlled = controlsId ? input.ownerDocument.getElementById(controlsId) : null
      const listEl =
        controlled?.getAttribute('role') === 'listbox'
          ? controlled
          : (controlled?.querySelector<HTMLElement>('[role="listbox"]') ??
            document.querySelector<HTMLElement>('[role="listbox"]:has([role="option"])'))
      const activeId = input.getAttribute('aria-activedescendant')
      const active = activeId ? input.ownerDocument.getElementById(activeId) : null
      return {
        role: input.getAttribute('role'),
        expanded: input.getAttribute('aria-expanded'),
        hasListbox: !!listEl,
        // aria-required-children: every ELEMENT child of the listbox is an option (or a
        // group/presentational wrapper that itself only holds options).
        nonOptionChildren: listEl
          ? Array.from(listEl.children)
              .filter(c => {
                const role = c.getAttribute('role')
                if (role === 'option') return false
                if (role === 'group' || role === 'presentation' || role === 'none') return false
                // An unroled wrapper is only acceptable if it contributes options.
                return !c.querySelector('[role="option"]')
              })
              .map(c => `<${c.tagName.toLowerCase()} role=${c.getAttribute('role')}>`)
          : ['(no listbox)'],
        optionCount: listEl ? listEl.querySelectorAll('[role="option"]').length : 0,
        activeIsOption: !!active && active.getAttribute('role') === 'option',
        activeInListbox: !!active && !!listEl && listEl.contains(active),
        activeId,
      }
    })

    expect(a11y.error).toBeUndefined()
    if ('error' in a11y) return
    expect(a11y.role, 'the palette input must be a combobox').toBe('combobox')
    expect(a11y.expanded).toBe('true')
    expect(a11y.hasListbox, 'aria-controls must resolve to the listbox').toBe(true)
    expect(a11y.optionCount).toBeGreaterThan(0)
    expect(a11y.nonOptionChildren, 'a listbox may only own options').toEqual([])
    expect(a11y.activeId, 'aria-activedescendant must be set once an option is highlighted').toBeTruthy()
    expect(a11y.activeIsOption, 'aria-activedescendant must resolve to a real option').toBe(true)
    expect(a11y.activeInListbox, 'the active option must live inside the listbox').toBe(true)

    // …and the whole open palette must be axe-clean for the roles/aria rules.
    const results = await new AxeBuilder({ page })
      .include('[data-testid="workbench-command-input"]')
      .include('[role="listbox"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()
    expect(
      results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`),
    ).toEqual([])
  })
})

test.describe('workbench command palette launches repeatedly', () => {
  // A launcher must RE-run the command it just ran. This is the assertion a value-retaining
  // combobox fails: a single-select combobox only fires `onValueChange` when the value CHANGES, so
  // picking the same command a second time would be silently swallowed. The palette therefore
  // retains no value (`value={null}`), and this drives the SECOND use — the one nobody tries.
  test('the same command runs again after its pane is closed, and Enter launches the top match', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Palette relaunch ${Date.now()}`)
    await openWorkbench(page, id)

    const artifactsTab = page.locator('[role="tab"][aria-label="Artifacts"]')

    // 1st launch — by CLICK.
    await page.getByTestId('workbench-command-input').click()
    await page.getByTestId('workbench-command-workbench.openArtifacts').click()
    await expect(artifactsTab).toHaveCount(1)
    // A launcher keeps no selection: the field is empty again, not holding the launched title.
    await expect(page.getByTestId('workbench-command-input')).toHaveValue('')

    // Close the pane, so the 2nd launch has something observable to do.
    const paneId = ((await artifactsTab.getAttribute('data-testid')) as string).slice(
      'region-tab-'.length,
    )
    await artifactsTab.hover()
    await page.getByTestId(`region-tab-close-${paneId}`).click()
    await expect(artifactsTab).toHaveCount(0)

    // 2nd launch — SAME command, by KEYBOARD this time (type → the top match is armed → Enter).
    // That covers `autoHighlight`: without it nothing is highlighted and Enter runs nothing.
    await page.getByTestId('workbench-command-input').click()
    await page.getByTestId('workbench-command-input').fill('Open produced artifacts')
    await expect(page.getByTestId('workbench-command-workbench.openArtifacts')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(artifactsTab).toHaveCount(1)
    // …and the TYPED query is gone too, so the next command starts from an empty field rather
    // than from the last one's search terms.
    await expect(page.getByTestId('workbench-command-input')).toHaveValue('')

    // Re-opening must not present a previously-run command as SELECTED. A launcher has no current
    // value; a combobox that retained one would tick the last command it ran and carry that state
    // into the next open.
    await page.getByTestId('workbench-command-input').click()
    await expect(page.getByTestId('workbench-command-workbench.openArtifacts')).toBeVisible()
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(0)

    // Escape ABANDONS the search (pre-existing behaviour): the typed query is dropped, so the
    // palette is not still filtered by it the next time it is opened.
    await page.getByTestId('workbench-command-input').fill('artifacts')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('workbench-command-input')).toHaveValue('')
  })
})
