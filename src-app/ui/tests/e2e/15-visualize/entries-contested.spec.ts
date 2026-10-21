// TEST-65 / TEST-A15 (ITEM-52 / ITEM-57 / INV-15) — TWO ENTRIES WITH THE SAME NAME, driven
// through the real app.
//
// ── Why this one has to be an e2e ────────────────────────────────────────────────────────
//
// The rule is a claim about what a USER SEES when two entries legitimately share a name:
// *"two rows … is the CORRECT result, not a collision to resolve"*, and
// *"the science NEVER sees the storage-disambiguated `CD3-1`"*. Both halves of that span the
// whole chain — the producer's `meta.groups_entries` declaration, the server publishing the
// sibling axis, the engine's contested-only qualifier, the widget's rendering, and the title of
// the plot that comes out the far end. A unit test can pin any one link; only this can show
// that the user ends up looking at two correctly distinguished rows.
//
// The fixture is a REAL contest: two entries whose `Symbol` is `CD3`, in two different declared
// groups, on an axis whose keys are read from a real inline-utf8 string column.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { loginAsOwner } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { ENTITY_AXIS, DT, cscArtifact, textColumnArtifact } from '../14-declarative-qc/_fixtures'
import {
  ANCHORED_ROWS,
  CONTESTED,
  SECTIONS,
  canvasPanes,
  frame,
  frameThePane,
  openVisualize,
  seedAnchoredProject,
  seedContestedEntryProject,
} from './_visualize'

/** The section's own list. Addressed by the widget id the shipped spec declares, so a rename of
 *  the section's title does not silently make this spec assert about nothing. */
const list = (page: Page) => page.getByTestId('widget-entries')

/** One row's ▶. The renderer composes a per-row action's name as `<label> <row TITLE>` — the
 *  ALWAYS-qualified name, not the bare label — and addressing it BY THAT NAME is what asserts
 *  ITEM-30.
 *
 *  It used to pass the bare label, which is why this file could not see the defect it is about:
 *  on a contested name the two rows' buttons were called the same thing, `.first()` picked one
 *  arbitrarily, and every assertion below passed while a screen-reader user had two identical
 *  controls. So the callers now pass the qualified form, and the distinctness itself is asserted
 *  by {@link plotNamesAreDistinct}. */
const plotButton = (page: Page, name: string) =>
  page.getByRole('button', { name: `Plot ${name}`, exact: true })

/** ITEM-30 stated as the property it is: the ▶ of two rows that SHARE a display name must not
 *  share an accessible name. Read off the list rather than constructed, so it fails when the
 *  composition changes rather than when this spec's arithmetic does. */
async function plotNamesAreDistinct(page: Page, sharedLabel: string): Promise<void> {
  const names = await list(page)
    .getByRole('button', { name: new RegExp(`^Plot ${sharedLabel}\\b`) })
    .evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? ''))
  expect(names.length, 'the contest is not on screen — this assertion would be vacuous').toBeGreaterThanOrEqual(2)
  expect(new Set(names).size, `two ▶ share one accessible name: ${names.join(' | ')}`).toBe(names.length)
}

/**
 * Ensure the entry section is OPEN — idempotently.
 *
 * It used to click the header UNCONDITIONALLY, because the section shipped collapsed and a
 * click was therefore always an open. The package now declares `collapsed: false` (owner,
 * 2026-08-13 — the binding mockup renders it open), so an unconditional click CLOSES it and
 * every assertion after this helper fails on a section that is not there.
 *
 * So it asks the state first. That is what "ensure" means, and it is also why this helper
 * survives a future flip in either direction rather than encoding one of them: a toggle driven
 * blind is a toggle that is right half the time.
 *
 * Addressed by the declared SECTION ID and by the ARIA state the trigger owns, never by the
 * title: the title is the package's own vocabulary and may be re-worded, the id is the contract.
 */
async function openEntries(page: Page): Promise<void> {
  const header = page.getByTestId(frame(SECTIONS.entries)).getByRole('button').first()
  if ((await header.count()) && (await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click()
  }
  await expect(list(page)).toBeVisible({ timeout: 30_000 })
}

/** Switch the header to the annotation that CONTESTS. The default is the axis key (ITEM-49),
 *  under which nothing is contested — which is the point: a contest is a fact about the
 *  DISPLAYED names, so the spec has to put the pane in the state where one exists. */
async function showAnnotation(page: Page, title: string): Promise<void> {
  const select = page.getByTestId('widget-entries-show-select')
  await expect(select).toBeVisible({ timeout: 30_000 })
  await select.click()
  await page.getByRole('option', { name: title, exact: true }).click()
}

/**
 * The SECOND fixture — the same contest with NOBODY declaring a grouping.
 *
 * A declared grouping column is ONE import path, and it is the one the grouped case above
 * covers. The ordinary path is a project whose entry axis carries names and no declared
 * grouping at all, and there the contest is exactly as real: two entries whose `Symbol` reads
 * the same. Seeded HERE rather than beside its sibling in `_visualize.ts` because that file is
 * another workstream's this round; the only difference from `seedContestedEntryProject` is the
 * absent `groups_entries` declaration, which is precisely the variable under test.
 */
const UNGROUPED_AXIS = ((cscArtifact().structure as { axes: string[] }).axes).find(
  a => a !== ENTITY_AXIS,
) as string

async function seedUngroupedContestedProject(
  request: APIRequestContext,
  projectId: string,
): Promise<void> {
  const keys = textColumnArtifact('entry keys', CONTESTED.keys, UNGROUPED_AXIS)
  const symbol = textColumnArtifact(CONTESTED.symbolTitle, CONTESTED.symbol, UNGROUPED_AXIS)
  await seedAnchoredProject(request, projectId, [
    {
      output_id: 'entry-index',
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: { ...keys.structure, key: 'values' },
      meta: { ...keys.meta, is_axis_index: true },
      content: { encoding: 'members', members: keys.members },
    },
    {
      // The display annotation, and NOTHING else. No `groups_entries` anywhere in the project.
      output_id: 'entry-symbol',
      datatype: DT.metadataColumn,
      scope: 'dataset',
      structure: symbol.structure,
      meta: symbol.meta,
      content: { encoding: 'members', members: symbol.members },
    },
  ])
}

test.describe('two entries may correctly share a name', () => {
  test('the contested name is disambiguated by its DECLARED group, never by a storage index', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-entries ${Date.now()}`)
    await seedContestedEntryProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page, { coordinateRows: ANCHORED_ROWS })
    await openEntries(page)

    // ITEM-49 — the header opens on the axis KEY, and SAYS that is what it picked rather than
    // appearing to have been configured.
    await expect(page.getByTestId('widget-entries-show-note')).toBeVisible({ timeout: 30_000 })

    await showAnnotation(page, CONTESTED.symbolTitle)

    // TWO rows, both reading `CD3`. Not one row, not a merged row, and not an error.
    const shared = CONTESTED.symbol[0]
    const contested = list(page).getByText(shared, { exact: false })
    await expect.poll(async () => await contested.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)

    // …distinguished by the DECLARED qualifier — the same `meta.groups_entries` column that
    // draws the headings. Both groups' names appear beside the two rows.
    const firstKey = CONTESTED.keys[0]
    const secondKey = CONTESTED.keys[1]
    await expect(page.getByTestId(`widget-entries-qualifier-${firstKey}`)).toHaveText(
      ` (${CONTESTED.panel[0]})`,
    )
    await expect(page.getByTestId(`widget-entries-qualifier-${secondKey}`)).toHaveText(
      ` (${CONTESTED.panel[1]})`,
    )
    // …and the UNCONTESTED rows carry none: a distinguisher appears only where there is
    // something to distinguish (INV-17).
    await expect(page.getByTestId(`widget-entries-qualifier-${CONTESTED.keys[2]}`)).toHaveCount(0)

    // THE NAMED WRONG FIX, absent. The storage-disambiguated form of a shared name is what
    // INV-15 exists to keep out of the science, and it is one line away from looking helpful.
    await expect(page.locator('body')).not.toContainText(`${shared}-1`)

    // ITEM-51 — the entry with NO value under this header shows its KEY and says the value is
    // absent, rather than borrowing another annotation's vocabulary.
    await expect(page.getByTestId(`widget-entries-missing-${CONTESTED.keys[3]}`)).toHaveText(
      `— no ${CONTESTED.symbolTitle}`,
    )
  })

  test('the groups carry counts and survive a search; emitting one carries its qualifier', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-entries-emit ${Date.now()}`)
    await seedContestedEntryProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page, { coordinateRows: ANCHORED_ROWS })
    await openEntries(page)
    await showAnnotation(page, CONTESTED.symbolTitle)

    // ITEM-54 — a heading per declared group, with its count, so a small group is discoverable
    // beside a large one.
    const groups = [...new Set(CONTESTED.panel)]
    for (const group of groups) {
      await expect(page.getByTestId(`widget-entries-group-${group}`)).toBeVisible({ timeout: 30_000 })
    }

    // ITEM-55 — searching the contested name returns BOTH groups with their hits, never a
    // flattened list: grouping must not disappear exactly when disambiguation matters most.
    await page.getByTestId('widget-entries-search').fill(CONTESTED.symbol[0])
    for (const group of groups) {
      await expect(page.getByTestId(`widget-entries-group-${group}`)).toContainText('of')
    }

    // ITEM-58 — press one of the two, and the PLOT's title carries the qualifier even though a
    // title is read alone. Two plots carrying one name are two pictures nobody can tell apart,
    // which is the same failure as two panes sharing a title.
    await plotNamesAreDistinct(page, CONTESTED.symbol[0])
    const play = plotButton(page, `${CONTESTED.symbol[0]} (${CONTESTED.panel[0]})`)
    await expect(play.first()).toBeVisible({ timeout: 30_000 })
    await play.first().click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    const titles = (await canvasPanes(page)).map(p => p.title ?? '')
    expect(titles.some(t => t.includes(`${CONTESTED.symbol[0]} (${CONTESTED.panel[0]})`))).toBe(true)
    // TEST-A15 — and the storage-disambiguated form is absent from the emitted title too.
    expect(titles.every(t => !t.includes(`${CONTESTED.symbol[0]}-1`))).toBe(true)
  })

  // ── the OTHER half of "what if the names are not unique?" ──────────────────────────────
  //
  // Everything above rests on a producer having declared `groups_entries`. Most projects
  // declare no such thing, and the two rows reading `CD3` are just as contested there. Before
  // this case the ungrouped contest was untested at every tier, and the section answered it
  // with two byte-identical rows and two plots carrying one title — the exact failure the
  // grouped case is written to rule out, reachable by simply not declaring a grouping.
  test('with NO declared grouping the contest is settled by the entry KEY, in the list and in the title', async ({
    page,
    request,
  }) => {
    const projectId = await createProject(request, `visualize-entries-ungrouped ${Date.now()}`)
    await seedUngroupedContestedProject(request, projectId)
    await loginAsOwner(page)
    await openVisualize(page, projectId)
    await frameThePane(page, { coordinateRows: ANCHORED_ROWS })
    await openEntries(page)

    // NOTHING groups: no heading is rendered for either of the grouped fixture's groups, so
    // this really is the other path and not the same one with a different seed.
    for (const group of [...new Set(CONTESTED.panel)]) {
      await expect(page.getByTestId(`widget-entries-group-${group}`)).toHaveCount(0)
    }

    await showAnnotation(page, CONTESTED.symbolTitle)

    // Two rows still read the same — that is the CORRECT result, here as there.
    const shared = CONTESTED.symbol[0]
    const contested = list(page).getByText(shared, { exact: false })
    await expect.poll(async () => await contested.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)

    // …and each says WHICH entry it is, by the identity it already carries. The rung below the
    // declared group, and the only one that exists in every project.
    const [firstKey, secondKey, thirdKey] = CONTESTED.keys
    await expect(page.getByTestId(`widget-entries-qualifier-${firstKey}`)).toHaveText(` (${firstKey})`)
    await expect(page.getByTestId(`widget-entries-qualifier-${secondKey}`)).toHaveText(` (${secondKey})`)
    // …while an UNCONTESTED row is still bare: contested-only is unchanged, a list is scanned.
    await expect(page.getByTestId(`widget-entries-qualifier-${thirdKey}`)).toHaveCount(0)

    // THE NAMED WRONG FIX, still absent — the ladder gained a rung, not a storage index.
    await expect(page.locator('body')).not.toContainText(`${shared}-1`)

    // ITEM-58 — press one of the two, and the emitted plot's title carries the key. Two plots
    // of two different entries are two pictures anyone can tell apart.
    await plotNamesAreDistinct(page, shared)
    const play = plotButton(page, `${shared} (${firstKey})`)
    await expect(play.first()).toBeVisible({ timeout: 30_000 })
    await play.first().click()
    await expect.poll(async () => (await canvasPanes(page)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    const titles = (await canvasPanes(page)).map(p => p.title ?? '')
    expect(titles.some(t => t.includes(`${shared} (${firstKey})`))).toBe(true)
    expect(titles.every(t => !t.includes(`${shared}-1`))).toBe(true)
  })
})
