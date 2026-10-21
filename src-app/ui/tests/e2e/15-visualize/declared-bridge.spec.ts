// **A DECLARED BRIDGE IS DATA; A USER-ASSERTED BRIDGE IS A GUESS WEARING A UI.**
//
// ── Why this file exists (owner, 2026-08-13) ──────────────────────────────────────────────────
//
// The pane's first block used to be a control asking WHICH ROWS. It is deleted. One consequence
// only showed up when the e2e tier was re-run: several fixtures had coordinates in one dataset
// and columns in another, with NOTHING in the data linking them, and they passed because the
// user could anchor the second and the pane would then offer the first against it. That bridge
// was never in the data. It was asserted by a gesture, and painting one population's columns on
// another's coordinates is the precise failure the whole pane exists to prevent.
//
// Removing that could have thrown out a REAL case with it, and the two look identical from the
// outside — a coordinate set and a column that do not share a dataset. The difference is the
// only thing that matters:
//
//   · UNDECLARED — nothing says which rows the points are. No column may be offered. The
//     coordinates still PLOT (positions are positions); they simply cannot be coloured.
//   · DECLARED — the producer stamped `aligned_to` with the row's key sequence. The link is
//     data, so the columns ARE offered, across datasets, exactly as an integration needs.
//
// The mockup's own scenario is the second one: an integration produces coordinates for a merged
// population whose columns come from elsewhere. So this spec asserts BOTH directions against the
// rendered pane — the positive case is the point, and the negative case is what stops the
// positive one from being satisfied by a pane that simply offers everything again.

import { expect, test } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { capture } from './_capture'
import {
  ANCHORED_COLUMN,
  ANCHORED_COORDINATE,
  coordinateEmits,
  openVisualize,
  seedDeclaredCrossDatasetFrame,
} from './_visualize'

/** The § Coordinates control, addressed by the CONTROL's own stable name — which is one
 *  element whether or not the offer splits into per-dataset groups. */
const picker = (page: import('@playwright/test').Page) =>
  page.getByTestId('widget-coordinatePicker-radio')

test.describe('a DECLARED link bridges datasets; an undeclared one does not', () => {
  test('POSITIVE: coordinates in one dataset colour a column in another, because the link is declared', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `declared-bridge ${Date.now()}`)
    await seedDeclaredCrossDatasetFrame(request, projectId, { rows: 'Population 1', frame: 'Integration run' })
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    // The two datasets ⇒ § Coordinates draws a heading per dataset, and the ONE coordinate set
    // sits under the dataset that produced it — not under the one whose rows it describes.
    const control = picker(page)
    await expect(control).toBeVisible({ timeout: 30_000 })
    const options = control.getByRole('radio')
    await expect(options).toHaveCount(1, { timeout: 30_000 })

    // REWRITTEN (ledger #24). This asserted `not.toBeChecked()` and then drove a click, on the
    // rule that nothing is ever chosen for the user. The owner reversed that: the pane opens
    // with the first set selected, visibly, marked `auto` and one click from any other. So the
    // sole candidate is already the frame here, and the bridge is asserted from that state
    // rather than from a state the pane no longer has.
    await expect(options.first()).toBeChecked({ timeout: 30_000 })
    const colour = page.locator('[data-section-id="sc.viz.colour-by"]')
    await expect(colour).toBeVisible({ timeout: 30_000 })

    // ── THE ASSERTION ─────────────────────────────────────────────────────────────────────
    // The column lives in a DIFFERENT dataset from the coordinates and is offered anyway,
    // because the producer declared the key sequence. This is the integration case, working.
    await expect(
      page.getByRole('button', { name: `Plot ${ANCHORED_COLUMN.first}`, exact: true }),
    ).toHaveCount(1, { timeout: 30_000 })

    // …and the coordinate row carries its own ▶ (ledger #27) — the foot-of-card control this
    // used to address is gone, so "the frame can be drawn" is asserted on the row's control.
    await expect(coordinateEmits(page)).toHaveCount(1, { timeout: 30_000 })

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'declared-bridge-offers-the-column.png')
  })

  test('NEGATIVE CONTROL: withhold the declaration and the same shape offers NO column — but still PLOTS', async ({
    page,
    request,
  }) => {
    // The IDENTICAL arrangement with `aligned_to` withheld, and nothing else changed. Without
    // this the positive test above would be satisfied by a pane that had simply gone back to
    // offering every column in the project against every coordinate set — which is the defect,
    // not the fix.
    const projectId = await createProject(request, `undeclared-bridge ${Date.now()}`)
    await seedDeclaredCrossDatasetFrame(
      request,
      projectId,
      { rows: 'Population 1', frame: 'Unlinked run' },
      { declared: false },
    )
    await loginAsOwner(page)
    await openVisualize(page, projectId)

    const control = picker(page)
    await expect(control).toBeVisible({ timeout: 30_000 })
    const options = control.getByRole('radio')
    // The coordinate set is still OFFERED — being unlinked is not a reason to hide positions.
    await expect(options).toHaveCount(1, { timeout: 30_000 })
    // Selected on open (ledger #24) rather than clicked into place — see the note in the
    // positive test above.
    await expect(options.first()).toBeChecked({ timeout: 30_000 })

    // ── THE REFUSAL ───────────────────────────────────────────────────────────────────────
    // No column is offered, because nothing in the data says these points are those rows.
    await expect(
      page.getByRole('button', { name: `Plot ${ANCHORED_COLUMN.first}`, exact: true }),
    ).toHaveCount(0, { timeout: 30_000 })

    // ── AND IT STILL PLOTS ────────────────────────────────────────────────────────────────
    // The other half, and the defect this round actually shipped before it was caught: the
    // bare-frame ▶ used to be gated on the ROWS resolving, so a user who picked a coordinate
    // set here got a dead control with no explanation. Plotting positions needs positions.
    await expect(coordinateEmits(page)).toHaveCount(1, { timeout: 30_000 })

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'undeclared-bridge-plots-but-cannot-colour.png')
  })
})
