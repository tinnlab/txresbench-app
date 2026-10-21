// TEST-45 (ITEM-32) / TEST-49 (ITEM-36, DEC-9) / TEST-41 (ITEM-30) / TEST-46 (ITEM-33) /
// TEST-56 (ITEM-43) — THE EMIT MODEL, driven through the real app.
//
// ── Why this spec is the one that matters ────────────────────────────────────────────────
//
// The owner's ruling for a second press of the SAME row is verbatim: *"if they click twice then
// it will visualize it on 2 viz grid panes."* Not a toggle, not a replace, not an idempotent
// scroll-into-view. That is a statement about what appears on the canvas, and no unit test can
// see it: the declaration half is pinned in `core/spec/visualizeEmitModel.test.ts` (the action
// appends, and nothing removes or overwrites), but "two plots appear" is a property of the whole
// chain — the row's ▶, the section's own list, the per-plot dataset base, the composed grid.
//
// The grid is deck.gl/WebGL2 and a headless browser paints no pixel, so the assertion reads the
// app's own read-only pane seam (`window.__canvasPanes`, the same one the workbench specs use)
// rather than a screenshot. That is where the pixels come from.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import {
  ANCHORED_COLUMN,
  canvasPanes,
  coordinateEmits,
  frameThePane,
  openVisualize,
  seedAnchoredProject,
} from './_visualize'

/** The ▶ of a named colour-by row. The renderer composes a per-row action's accessible name as
 *  `<label> <row name>`, which is ITEM-30's whole point: forty rows get forty distinct names
 *  instead of forty controls called "Plot". Addressing them BY THAT NAME is what asserts it. */
const plotButton = (page: import('@playwright/test').Page, column: string) =>
  page.getByRole('button', { name: `Plot ${column}`, exact: true })

test.describe('the emit model', () => {
  test('pressing one row’s ▶ TWICE opens TWO grid panes (DEC-9)', async ({ page, request }) => {
    const projectId = await createProject(request, `visualize-emit ${Date.now()}`)
    await seedAnchoredProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page)

    const column = ANCHORED_COLUMN.first
    const play = plotButton(page, column)
    // ITEM-30 — the control is named for its ROW. Exactly one node answers to this name, which
    // is the property a shared label ("Plot") could not have.
    await expect(play).toHaveCount(1, { timeout: 30_000 })

    await play.click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(1)

    // THE RULING. A second press of the SAME row is not a toggle and not a replacement.
    await play.click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(2)

    const panes = await canvasPanes(page)
    // Two DISTINCT panes, not one pane counted twice: a duplicate id would have merged them into
    // a single overlaid plot, which is why the ids are derived per position rather than per
    // artifact.
    expect(new Set(panes.map(p => p.id)).size).toBe(2)
    // Both are the SAME picture, so both carry the same title — the plot says what it is about,
    // including whose row space (ITEM-35).
    for (const pane of panes) expect(pane.title).toContain(column)

    // …and a THIRD press keeps adding. "Two" is not a special case; the row is a verb.
    await play.click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(3)
  })

  test('two DIFFERENT rows give two plots, each about its own column', async ({ page, request }) => {
    const projectId = await createProject(request, `visualize-emit-close ${Date.now()}`)
    await seedAnchoredProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page)

    const { first, second } = ANCHORED_COLUMN
    await plotButton(page, first).click()
    await plotButton(page, second).click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(2)
    const titles = (await canvasPanes(page)).map(p => p.title ?? '')
    expect(titles.some(t => t.includes(first))).toBe(true)
    expect(titles.some(t => t.includes(second))).toBe(true)
  })

  test('closing a plot removes it, and it does not come back (ITEM-32)', async ({ page, request }) => {
    // ITEM-32 — the close routes to the EMITTING section's own action, which removes the entry
    // from that section's list. The plot must not reappear on the NEXT render: a raw pane removal
    // would be re-created by the `for_each` (the reopen loop), which is why the close is declared
    // and routed rather than handled by the grid.
    //
    // ONE plot, deliberately. The pane toolbar folds its low-rank actions into an overflow at
    // narrow widths, and Close is the lowest-ranked of them — so a two-pane grid hides the very
    // control this asserts, and the assertion would be about the toolbar's layout rather than
    // about the routing. The two-plot claim is the test above.
    const projectId = await createProject(request, `visualize-close ${Date.now()}`)
    await seedAnchoredProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page)

    await plotButton(page, ANCHORED_COLUMN.first).click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(1)

    const remove = page.getByRole('button', { name: /^Remove/i }).first()
    await expect(remove).toBeVisible({ timeout: 30_000 })
    await remove.click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(0)
    // Held, not merely observed once: a reopen loop would restore it a frame later.
    await page.waitForTimeout(1_000)
    expect((await canvasPanes(page)).length).toBe(0)
  })

  test('the SELECTED coordinate emits a BARE frame (ITEM-43)', async ({ page, request }) => {
    // *"Without it an uncoloured coordinate set is unreachable in a pane where only colour-by rows
    // emit."* The control is named for its subject — the coordinate the user chose — rather than
    // for the verb, which is why it can be addressed by that name at all.
    const projectId = await createProject(request, `visualize-bare-frame ${Date.now()}`)
    await seedAnchoredProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page)

    // Ledger #27 — the ▶ is on the ROW now, one per coordinate set, so it is addressed as the
    // row's control. Its accessible name still NAMES THE SUBJECT rather than the verb, which is
    // what the old `textContent() !== 'Plot'` assertion was reaching for and which an icon-only
    // control can only state through its name.
    const bare = coordinateEmits(page).first()
    await expect(bare).toBeVisible({ timeout: 30_000 })
    expect((await bare.getAttribute('aria-label')) ?? '').not.toBe('Plot')
    await bare.click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBe(1)
  })

  test('a section states what it HOLDS, and keeps it through a collapse (ITEM-64 / R6)', async ({ page, request }) => {
    const projectId = await createProject(request, `visualize-badge ${Date.now()}`)
    await seedAnchoredProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page)

    await plotButton(page, ANCHORED_COLUMN.first).click()
    const badge = page.getByTestId('section-badge-sc.viz.colour-by')
    await expect(badge).toBeVisible({ timeout: 30_000 })
    await expect(badge).toHaveText('1')

    // ── the subject has to be INSIDE the panel ────────────────────────────────────────
    //
    // This test asserted only the badge, and the badge lives in the Accordion header's
    // `extra` slot — OUTSIDE the collapsible panel. So it survived making collapse inert
    // entirely, and, worse, it survived the real defect: base-ui's `keepMounted` defaults to
    // false, so the collapsed section's `DeclarativeRegion` was UNMOUNTED, its badge-cleanup
    // effect fired, and the badge was retracted from the store — while this assertion, reading
    // an element the unmount never touched, stayed green.
    //
    // So the ROW is the subject now: it is rendered by the section's own body, inside the
    // panel. `toBeAttached()` (not `toBeVisible()`) is the whole point — a collapsed panel is
    // HIDDEN, and the claim under test is precisely that hidden ≠ gone.
    //
    // Addressed by TESTID, not by role. A collapsed base-ui panel carries `hidden`, which
    // removes its subtree from the ACCESSIBILITY TREE — so `getByRole` cannot see it even
    // with `toBeAttached()`, and a role-based subject would report "not attached" for a node
    // that is very much still mounted. (The role-based address is asserted while the section
    // is OPEN, just above and in the sibling specs, so ITEM-30's per-row naming stays pinned.)
    // The section's own body, addressed by the widget it renders. It was
    // `widget-categoricalColumns` — the categorical TABLE — until ledger #32 replaced the
    // section's two grids with one `entry_list`; the subject is unchanged in kind (a node the
    // section's `DeclarativeRegion` renders, inside the collapsible panel) and only its id
    // moved.
    const rowInsideThePanel = page.getByTestId('widget-columns')
    await expect(plotButton(page, ANCHORED_COLUMN.first)).toBeVisible()
    await expect(rowInsideThePanel).toBeVisible()

    // Collapse is DISPLAY, not reset.
    //
    // Addressed by the section's own trigger rather than by `{ name: 'Color by', exact: true }`.
    // The badge moved INSIDE the accordion trigger (owner, ledger #25 — the count sits left of
    // the collapse control, and the header's `extra` slot renders after the whole trigger, so
    // nothing arranged there could), which makes it part of the trigger's accessible NAME: the
    // control now announces as `Color by 1`. That is the intended trade — the number a section
    // is holding is a fair part of what the control is called, and hiding it from assistive tech
    // to keep the name tidy would hide exactly the fact R6 exists to state — so it is the exact
    // match that gives, not the badge.
    await page
      .locator('[data-section-id="sc.viz.colour-by"] [data-slot="accordion-trigger"]')
      .first()
      .click()

    // (a) the panel really did collapse — the body the section OWNS is no longer shown …
    await expect(rowInsideThePanel).toBeHidden({ timeout: 30_000 })
    await expect(plotButton(page, ANCHORED_COLUMN.first)).toBeHidden()
    // (b) … and it is still MOUNTED. This is the assertion that goes red without `keepMounted`.
    await expect(rowInsideThePanel).toBeAttached()
    // (c) the mark the collapse exists for survives …
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('1')
    // (d) … and so does the picture it counts.
    expect((await canvasPanes(page)).length).toBe(1)

    // (e) re-expanding restores the same section with the same state — collapse round-trips
    //     without resetting anything, which a remount could not guarantee.
    await page
      .locator('[data-section-id="sc.viz.colour-by"] [data-slot="accordion-trigger"]')
      .first()
      .click()
    await expect(rowInsideThePanel).toBeVisible()
    await expect(plotButton(page, ANCHORED_COLUMN.first)).toBeVisible()
    await expect(badge).toHaveText('1')
    expect((await canvasPanes(page)).length).toBe(1)
  })
})
