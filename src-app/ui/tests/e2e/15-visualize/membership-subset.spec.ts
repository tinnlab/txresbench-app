// membership-subset.spec.ts — dimension-membership TEST-23 / TEST-25 / TEST-54.
//
// Against the REAL backend, over real HTTP, reading REAL seeded artifacts. No route mocking.
//
// ── WHAT A SUBSET COORDINATE IS, AND WHY IT NEEDED A TIER OF ITS OWN ─────────────────────────
//
// Every fixture in this suite before this round declared the scalar `structure.aligned_to` and
// nothing else, which says *these values line up with that key sequence, all of them*. A derived
// population falsifies it: a filtered selection's positions rest on 40 of the axis's 200 rows,
// and a column beside it still describes all 200. Painting the column as it stands addresses row
// *i* of two hundred where row *i* of forty was meant — the off-by-thousands paint the whole
// membership model exists to make impossible.
//
// The three tests below are the three questions that shape asks, at the tier where a user asks
// them:
//
//   · TEST-23 — WHAT IS OFFERED, WHAT DOES EACH ROW SAY, and does picking one PAINT.
//   · TEST-25 — is a column about a DIFFERENT population of the SAME axis kept out, *with an
//     intersecting column present in the same run* so that "absent" cannot mean "the list
//     never rendered".
//   · TEST-54 — does a project holding NO membership at all go on offering exactly what it
//     offered before this round (INV-9: *"existing artifacts need a default, not a rewrite"*).
//
// ── EVERY ASSERTION HERE IS A SET OR A SENTENCE, NEVER A COUNT ───────────────────────────────
//
// A count-tolerant check absorbs a WRONG SET of the same size, and this round's failure mode is
// exactly a right-sized wrong answer: the correct NUMBER of the wrong rows. So the offer is
// compared as a sorted set of names, the two coverage sentences are DIFFERENT from each other
// (so one hardcoded string cannot satisfy both), and the paint is asserted on the buffer's
// PARTITION rather than on its length.

import { expect, test, type Page } from '@playwright/test'

import { createProject } from '../14-workbench/_dock'
import { loginAsOwner } from '../project/_helpers'
import { capture } from './_capture'
import {
  ANCHORED_COLUMN,
  openVisualize,
  seedAnchoredProject,
  seedPopulations,
  SECTIONS,
  SUBSET,
  SUBSET_LEVELS,
  SUBSET_STRIDE,
  subsetLegendCode,
  subsetMembers,
} from './_visualize'

/** The population the subset is taken out of. 200 rows, one member every {@link SUBSET_STRIDE},
 *  so the coordinate names 40 — a ratio no rounding can turn into the other number. */
const POPULATION = { name: 'Population 1', rows: 200, subset: true } as const
const MEMBERS = subsetMembers(POPULATION.rows)
/** How many rows the SUBSET coordinate is about — the denominator every sentence below prints. */
const SUBSET_ROWS = MEMBERS.length
/** …and how many of them the `intersecting` column describes (its members are the first half of
 *  the coordinate's own). */
const INTERSECTING_ROWS = Math.max(1, Math.floor(SUBSET_ROWS / 2))

// ── the surfaces ─────────────────────────────────────────────────────────────────────────────

const coordinates = (page: Page) => page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
const colourBy = (page: Page) => page.locator(`[data-section-id="${SECTIONS.colourBy}"]`)

/** Every column § Colour by currently offers, by NAME, sorted.
 *
 *  Read off the ▶ controls' accessible names, which is the one place the offer is stated per row
 *  and unambiguously (`Plot <name>`); the section's own text also carries headings, sentences and
 *  the coverage lines, so a substring search over it would answer a different question. */
async function offered(page: Page): Promise<string[]> {
  const names = await colourBy(page)
    .getByRole('button', { name: /^Plot / })
    .evaluateAll(els => els.map(e => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()))
  return names.map(n => n.replace(/^Plot\s+/, '')).sort()
}

/** Pick the coordinate set whose declared NAME is `name`. Never `.first()`: this fixture
 *  publishes TWO sets over one axis and taking either would make the test a coin toss. */
async function pickCoordinate(page: Page, name: string): Promise<void> {
  const picker = coordinates(page)
  await expect(picker).toBeVisible({ timeout: 30_000 })
  const option = picker.getByRole('radio', { name: new RegExp(name, 'i') })
  await expect(option, `§ Coordinates offered no set named "${name}"`).toHaveCount(1, { timeout: 60_000 })
  await option.click()
  await expect(option).toBeChecked({ timeout: 30_000 })
}

interface PaneColorSeam {
  epoch: number
  points: number
  rgba: number[]
  legend: { title: string; columnId: string | null; rawLabels: string[] | null } | null
  colorData: { column: string; categorical: boolean } | null
}

/** The per-pane colour buffer, from viz's own display store (the seam
 *  `streaming-reads.spec.ts` documents: the grid is WebGL and headless Chromium paints no pixel,
 *  so the colours are asserted where the pixels come FROM). */
async function paneColorBuffers(page: Page): Promise<Record<string, PaneColorSeam>> {
  return page.evaluate(() => {
    const read = (window as unknown as { __vizPaneColors?: () => Record<string, PaneColorSeam> }).__vizPaneColors
    return read ? read() : {}
  })
}

/** The ONE coloured pane once its buffer has settled to `expectedPoints`. Fails loudly rather
 *  than returning an empty digest a later assertion would read as "all equal". */
async function settledColorPane(page: Page, expectedPoints: number): Promise<PaneColorSeam> {
  await expect
    .poll(
      async () => Object.values(await paneColorBuffers(page)).filter(c => c.points === expectedPoints).length,
      { timeout: 90_000 },
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
 *  colours and emphatically not the point count: a buffer with every point shaded identically
 *  has the right length and the right number of rows. */
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

// ══════════════════════════════════════════════════════════════════════════════════════════════

test.describe('§ a coordinate that is a SUBSET of its axis', () => {
  test('TEST-23 — the subset coordinate offers the axis’s columns, each row states how many of ITS rows the column describes, and picking one paints', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `membership-subset ${Date.now()}`)
    await seedPopulations(request, projectId, [POPULATION])
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickCoordinate(page, SUBSET.coordinate)

    // ── THE OFFER ────────────────────────────────────────────────────────────────────────
    //
    // As a SET. The whole-axis columns are offered because they describe every one of the
    // coordinate's rows; the intersecting subset column is offered because it describes some of
    // them; the disjoint one is not (that exclusion is TEST-25's subject, and it is asserted
    // here too because a set assertion that omitted it would be satisfied by a list that had it).
    await expect
      .poll(() => offered(page), { timeout: 60_000 })
      .toEqual([SUBSET.full, SUBSET.intersecting, SUBSET.legend].sort())

    // ── WHAT EACH ROW SAYS (ITEM-9 / ITEM-10) ────────────────────────────────────────────
    //
    // TWO DIFFERENT sentences, denominated on the COORDINATE's rows (INV-3) and not on the
    // column's own. That they differ is the point: a single hardcoded sentence, or a figure
    // taken from the column's own length, satisfies at most one of them.
    const listed = await colourBy(page).innerText()
    expect(listed, 'a whole-axis column describes every row of the subset').toContain(
      `describes all ${SUBSET_ROWS} rows`,
    )
    expect(listed, 'the intersecting column describes exactly its half').toContain(
      `describes ${INTERSECTING_ROWS} of ${SUBSET_ROWS} rows`,
    )
    // …and NEVER the parent axis's count. A figure denominated on the column would print 200.
    expect(listed, 'a figure was denominated on the COLUMN, not on the coordinate').not.toContain(
      `of ${POPULATION.rows} rows`,
    )

    await capture(test.info(), colourBy(page), 'subset-coordinate-offers.png')

    // ── AND PICKING ONE PAINTS (ITEM-14 / ITEM-20) ───────────────────────────────────────
    //
    // The whole point of the offer: an offered column is a PAINTED column, and it is painted at
    // the COORDINATE's rows. `subset legend` is categorical and its codes are arranged so the
    // gathered reading and a truncating one differ by PARTITION — on the member positions the
    // levels alternate, everywhere else they are constant — so a gather that read the parent's
    // first 40 rows would produce the same two levels in a lopsided split and fail below.
    const play = page.getByRole('button', { name: `Plot ${SUBSET.legend}`, exact: true })
    await expect(play, `§ Colour by offered no row for "${SUBSET.legend}"`).toHaveCount(1, { timeout: 60_000 })
    await play.click()

    const pane = await settledColorPane(page, SUBSET_ROWS)
    expect(pane.colorData, 'the pane published no colour column at all').not.toBeNull()
    expect(pane.colorData!.column, 'the pane is coloured by a column the row did not name').toBe(SUBSET.legend)
    expect(pane.colorData!.categorical, 'a categorical column was coloured as continuous').toBe(true)
    // The buffer is the COORDINATE's length, not the parent column's.
    expect(pane.points, 'the colour buffer is not the subset’s length').toBe(SUBSET_ROWS)
    expect(pane.rgba.length).toBe(SUBSET_ROWS * 4)

    // THE PARTITION — the exact rows, not the exact number of them. `expected` is derived from
    // the fixture's own member list, so it is a statement about WHICH axis rows were read.
    const groups = partitionByColour(pane.rgba)
    expect(
      groups.size,
      `every point was shaded the same (${[...groups.keys()].join(' / ')}) — the count is right and the ` +
        'picture is meaningless, which is why this is asserted on the bytes',
    ).toBe(SUBSET_LEVELS.length)
    const expected = new Map<number, number[]>()
    for (const [row, position] of MEMBERS.entries()) {
      const code = subsetLegendCode(position)
      expected.set(code, [...(expected.get(code) ?? []), row])
    }
    const actual = [...groups.values()].map(rows => rows.join(',')).sort()
    expect(
      actual,
      'the painted partition is not the one the coordinate’s OWN member positions select — ' +
        'the right NUMBER of the wrong rows is exactly what this round exists against',
    ).toEqual([...expected.values()].map(rows => rows.join(',')).sort())
  })

  test('TEST-25 — a same-axis column about a DISJOINT population is absent, while an intersecting one is present in the same run', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `membership-disjoint ${Date.now()}`)
    await seedPopulations(request, projectId, [POPULATION])
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickCoordinate(page, SUBSET.coordinate)

    // ── THE POSITIVE CONTROL, FIRST ──────────────────────────────────────────────────────
    //
    // Same axis, same DECLARED-member spelling, differing ONLY in which members. It must be
    // offered — and it is asserted BEFORE the exclusion, because "absent" is indistinguishable
    // from "the list never rendered" without something present beside it. The two columns are a
    // controlled pair: any difference between them is the member set and can be nothing else.
    const present = colourBy(page).getByRole('button', { name: `Plot ${SUBSET.intersecting}`, exact: true })
    await expect(
      present,
      'the intersecting column was not offered either — this run proves nothing about the disjoint one',
    ).toHaveCount(1, { timeout: 60_000 })

    // ── THE EXCLUSION (ITEM-7, state A4) ─────────────────────────────────────────────────
    //
    // Known axis, known members, and PROVABLY none of the coordinate's. Not "unknown, so
    // withheld": every undecidable intersection falls back to offered, which is what keeps a
    // legacy project's offers intact (INV-9), so this can only ever be removed on proof.
    await expect(
      colourBy(page).getByRole('button', { name: `Plot ${SUBSET.disjoint}`, exact: true }),
      'a column about a DIFFERENT population of the same axis was offered as a thing to colour these rows by',
    ).toHaveCount(0)
    expect(await offered(page), 'the disjoint column reached the offer under some other name').not.toContain(
      SUBSET.disjoint,
    )

    // ── AND THE WHOLE-AXIS COORDINATE STILL OFFERS IT ────────────────────────────────────
    //
    // The same column, the same project, one gesture apart. Without this the exclusion above is
    // satisfied by an implementation that simply never offers a member-declaring column at all —
    // which would be a defect wearing the fix's clothes.
    await pickCoordinate(page, 'projection')
    await expect(
      colourBy(page).getByRole('button', { name: `Plot ${SUBSET.disjoint}`, exact: true }),
      'against the WHOLE axis the same column describes real rows and must be offered',
    ).toHaveCount(1, { timeout: 60_000 })

    await capture(test.info(), colourBy(page), 'whole-axis-offers-both-populations.png')
  })

  test('TEST-54 — a project holding NO membership offers exactly what it offered before this round, and states no coverage', async ({
    page,
    request,
  }) => {
    // ── THE FIXTURE IS THE POINT ─────────────────────────────────────────────────────────
    //
    // `seedAnchoredProject` is UNTOUCHED by this round: scalar `aligned_to`, no `memberships`,
    // no index body, no digest — the shape every artifact in every existing project carries.
    // It is deliberately not this round's own fixture with the membership switched off, because
    // a fixture edited by the change under test is a weaker witness than one that predates it.
    const projectId = await createProject(request, `membership-legacy ${Date.now()}`)
    const seeded = await seedAnchoredProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await pickCoordinate(page, 'anchored projection')

    // ── THE OFFER, AS A SET AND IN ORDER ─────────────────────────────────────────────────
    //
    // `seeded.columns` is the fixture's own declared list, so this compares the offer against
    // what was seeded rather than against a literal transcribed from a run.
    await expect
      .poll(() => offered(page), { timeout: 60_000 })
      .toEqual([...seeded.columns].sort())
    // …and in the order the section renders them, which a sorted set cannot see.
    const rendered = (
      await colourBy(page)
        .getByRole('button', { name: /^Plot / })
        .evaluateAll(els => els.map(e => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()))
    ).map(n => n.replace(/^Plot\s+/, ''))
    expect(rendered, 'the legacy offer changed ORDER').toEqual([ANCHORED_COLUMN.first, ANCHORED_COLUMN.second])

    // ── AND IT SAYS NOTHING ABOUT COVERAGE ───────────────────────────────────────────────
    //
    // The anchor states no population, so the question "how many of these rows" is not posed —
    // and a row that answered it anyway would be inventing the denominator. `describes` is the
    // ONE word the sentence cannot be written without, so its absence is the whole assertion.
    const listed = await colourBy(page).innerText()
    expect(
      listed,
      'a legacy project printed a coverage sentence, which means a denominator was invented for it',
    ).not.toMatch(/describes/i)

    await capture(test.info(), colourBy(page), 'legacy-project-offer-unchanged.png')
  })
})
