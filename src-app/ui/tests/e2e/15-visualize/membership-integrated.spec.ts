// membership-integrated.spec.ts — dimension-membership TEST-24 / TEST-46 / TEST-51 / TEST-52.
//
// Against the REAL backend, over real HTTP, reading REAL seeded artifacts. No route mocking.
//
// ── WHAT AN INTEGRATED COORDINATE IS ─────────────────────────────────────────────────────────
//
// An integration rests on TWO entity axes at once — a coordinate that declares a membership PER
// axis (INV-1). Its rows are a CORRESPONDENCE (INV-6): row r is entry `memA[r]` of dataset A AND
// entry `memB[r]` of dataset B, and the fixture makes `memA[r] ≠ memB[r]` (memB reverses memA), so
// an index-identity gather returns a full, well-typed, WRONG column. The membership ARRAY order is
// the coordinate's declared SEGMENT ORDER (INV-7).
//
//   · TEST-24 — § Colour by offers columns from BOTH datasets on the one integrated coordinate.
//   · TEST-46 [acceptance INV-1] — the coordinate is resolvable on BOTH axes; the SECOND-declared
//     axis's column is offered, which is the arm a single-pair truncation kills.
//   · TEST-51 [acceptance INV-6] — painting by the SECOND dataset's column reads each row at its
//     OWN correspondence index j (= memB[r]), not at r; the partition proves i ≠ j was honoured.
//   · TEST-52 [acceptance INV-7] — the painted partition follows the membership DECLARATION for the
//     axis it colours by; the same column, gathered through a coordinate that declares the axes in
//     the REVERSED order, paints the SAME correspondence — segment order is read off the
//     declaration, never invented.

import { expect, test, type Page } from '@playwright/test'

import { createProject } from '../14-workbench/_dock'
import { loginAsOwner } from '../project/_helpers'
import { capture } from './_capture'
import {
  INTEGRATED,
  integratedMembersB,
  openVisualize,
  SECTIONS,
  seedIntegratedCoordinate,
} from './_visualize'

const coordinates = (page: Page) => page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
const colourBy = (page: Page) => page.locator(`[data-section-id="${SECTIONS.colourBy}"]`)

interface PaneColorSeam {
  epoch: number
  points: number
  rgba: number[]
  legend: { title: string; columnId: string | null; rawLabels: string[] | null } | null
  colorData: { column: string; categorical: boolean } | null
}

async function paneColorBuffers(page: Page): Promise<Record<string, PaneColorSeam>> {
  return page.evaluate(() => {
    const read = (window as unknown as { __vizPaneColors?: () => Record<string, PaneColorSeam> }).__vizPaneColors
    return read ? read() : {}
  })
}

async function settledColorPane(page: Page, expectedPoints: number): Promise<PaneColorSeam> {
  await expect
    .poll(async () => Object.values(await paneColorBuffers(page)).filter(c => c.points === expectedPoints).length, {
      timeout: 90_000,
    })
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

function partitionByColour(rgba: readonly number[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (let i = 0; i * 4 < rgba.length; i++) {
    const k = `${rgba[i * 4]},${rgba[i * 4 + 1]},${rgba[i * 4 + 2]},${rgba[i * 4 + 3]}`
    const g = groups.get(k)
    if (g) g.push(i)
    else groups.set(k, [i])
  }
  return groups
}

/** The set of row-index groups the seeded categorical produces when the coordinate reads side B at
 *  its OWN correspondence index j = memB[r]. Level of entry e is `e % levels`, so row r paints
 *  level `memB[r] % levels`. Returned as sorted "csv" group strings for a set comparison. */
function expectedByCorrespondence(): string[] {
  const memB = integratedMembersB(INTEGRATED.rows)
  const groups = new Map<number, number[]>()
  for (let r = 0; r < INTEGRATED.rows; r++) {
    const level = memB[r] % INTEGRATED.levels.length
    groups.set(level, [...(groups.get(level) ?? []), r])
  }
  return [...groups.values()].map(rows => rows.slice().sort((a, b) => a - b).join(',')).sort()
}

/** The WRONG grouping an index-identity gather would produce — row r painted `r % levels` (its own
 *  position, not its correspondence index). The negative control: this must NOT equal the observed
 *  partition, or the correspondence was ignored. */
function indexIdentityGrouping(): string[] {
  const groups = new Map<number, number[]>()
  for (let r = 0; r < INTEGRATED.rows; r++) {
    const level = r % INTEGRATED.levels.length
    groups.set(level, [...(groups.get(level) ?? []), r])
  }
  return [...groups.values()].map(rows => rows.slice().sort((a, b) => a - b).join(',')).sort()
}

async function pickIntegrated(page: Page): Promise<void> {
  const option = coordinates(page).getByRole('radio', { name: new RegExp(INTEGRATED.coordinate, 'i') })
  await expect(option, `§ Coordinates offered no set named "${INTEGRATED.coordinate}"`).toHaveCount(1, {
    timeout: 60_000,
  })
  await option.click()
  await expect(option).toBeChecked({ timeout: 30_000 })
}

function offered(page: Page) {
  return colourBy(page).getByRole('button', { name: /^Plot / })
}

// ══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('§ an INTEGRATED coordinate rests on two axes at once', () => {
  test('TEST-24 — § Colour by offers columns from BOTH datasets on the one integrated coordinate', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `integrated-both ${Date.now()}`)
    await seedIntegratedCoordinate(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickIntegrated(page)

    // Both datasets' columns describe the integrated coordinate's rows — one via axis A, one via
    // axis B — so both are offered. Compared as a SET: a scalar (single-axis) anchor would offer
    // only the first dataset's and still render a non-empty list.
    const names = await offered(page)
      .evaluateAll(els => els.map(e => (e.getAttribute('aria-label') ?? '').replace(/^Plot\s+/, '').trim()))
    expect(
      new Set(names),
      `§ Colour by did not offer BOTH datasets' columns — got ${JSON.stringify(names)}`,
    ).toEqual(new Set([INTEGRATED.columnA, INTEGRATED.columnB]))

    await capture(test.info(), colourBy(page), 'integrated-offers-both.png')
  })

  test('TEST-46 — the integrated coordinate resolves on BOTH axes; the SECOND axis’s column is offered (INV-1)', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `integrated-inv1 ${Date.now()}`)
    await seedIntegratedCoordinate(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickIntegrated(page)

    // The coordinate declares its memberships in the order [axis A, axis B]. A single-pair
    // implementation resolves on the FIRST and silently drops the second — so the discriminating
    // assertion is that the SECOND axis's column (dataset B's) is present. Its sibling on axis A is
    // the positive control in the same run: without it, "present" could not be told from "the list
    // never rendered".
    const b = colourBy(page).getByRole('button', { name: `Plot ${INTEGRATED.columnB}`, exact: true })
    const a = colourBy(page).getByRole('button', { name: `Plot ${INTEGRATED.columnA}`, exact: true })
    await expect(a, 'the first axis’s column was not offered — this run proves nothing').toHaveCount(1, {
      timeout: 60_000,
    })
    await expect(
      b,
      'the SECOND-declared axis’s column is absent — the second membership pair was truncated away (INV-1)',
    ).toHaveCount(1, { timeout: 60_000 })

    await capture(test.info(), colourBy(page), 'integrated-both-axes-resolve.png')
  })

  test('TEST-51 — a correspondence row reads the SECOND side at its OWN index j (≠ r), not by identity (INV-6)', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `integrated-correspondence ${Date.now()}`)
    await seedIntegratedCoordinate(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickIntegrated(page)

    // Colour by the SECOND dataset's column. Row r of the coordinate corresponds to entry memB[r]
    // of dataset B, so its painted level is `memB[r] % levels` — read at B's OWN index, not at r.
    const play = colourBy(page).getByRole('button', { name: `Plot ${INTEGRATED.columnB}`, exact: true })
    await expect(play, `§ Colour by offered no row for "${INTEGRATED.columnB}"`).toHaveCount(1, { timeout: 60_000 })
    await play.click()

    const pane = await settledColorPane(page, INTEGRATED.rows)
    expect(pane.colorData!.column, 'the pane is coloured by a column the row did not name').toBe(INTEGRATED.columnB)
    expect(pane.points, 'the colour buffer is not the integrated coordinate’s length').toBe(INTEGRATED.rows)

    const groups = partitionByColour(pane.rgba)
    const actual = [...groups.values()].map(rows => rows.slice().sort((a, b) => a - b).join(',')).sort()
    // The correspondence partition — row r grouped by `memB[r] % levels`.
    expect(
      actual,
      'the painted partition is not the one the correspondence selects — the second side was read at ' +
        'the coordinate’s own index r instead of at its correspondence index j',
    ).toEqual(expectedByCorrespondence())
    // NEGATIVE CONTROL: an index-identity gather (row r ↦ r % levels) is a DIFFERENT partition here
    // by construction (memB is a non-monotonic permutation that SCRAMBLES the level residues — see
    // `integratedMembersB`; a plain reverse would preserve them and this control would be toothless),
    // so its equality with the observed one would be the bug.
    expect(
      actual,
      'the observed partition equals the index-identity one — the correspondence was ignored',
    ).not.toEqual(indexIdentityGrouping())

    await capture(test.info(), colourBy(page), 'integrated-correspondence-paint.png')
  })

  test('TEST-52 — segment order is read off the coordinate’s DECLARATION; reversing it keeps the correspondence honest (INV-7)', async ({
    page,
    request,
  }) => {
    // The SAME correspondence, declared with the axes in the REVERSED membership order. The painted
    // partition for dataset B's column must be the SAME correspondence grouping — the gather reads
    // the membership triple for the axis it colours by, off the declaration, regardless of which
    // array position that membership sits in. An implementation that indexed the memberships
    // POSITIONALLY (segment 0 always leads) would read side B through side A's member body under the
    // reversed declaration and paint the index-identity partition instead.
    const projectId = await createProject(request, `integrated-segment-order ${Date.now()}`)
    await seedIntegratedCoordinate(request, projectId, { reversed: true })
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickIntegrated(page)

    const play = colourBy(page).getByRole('button', { name: `Plot ${INTEGRATED.columnB}`, exact: true })
    await expect(play, `§ Colour by offered no row for "${INTEGRATED.columnB}"`).toHaveCount(1, { timeout: 60_000 })
    await play.click()

    const pane = await settledColorPane(page, INTEGRATED.rows)
    const groups = partitionByColour(pane.rgba)
    const actual = [...groups.values()].map(rows => rows.slice().sort((a, b) => a - b).join(',')).sort()
    // Under the reversed declaration the correspondence is unchanged — dataset B's column still reads
    // at memB[r]. A positional (segment-0-leads) reader would produce the index-identity partition.
    expect(
      actual,
      'reversing the membership DECLARATION changed the correspondence — segment order was taken from ' +
        'the array position rather than from the declared axis (INV-7)',
    ).toEqual(expectedByCorrespondence())
    expect(
      actual,
      'the reversed declaration painted the index-identity partition — a positional segment reader',
    ).not.toEqual(indexIdentityGrouping())

    await capture(test.info(), colourBy(page), 'integrated-segment-order.png')
  })
})
