// THE GATE — the RENDERED pane, at its real width, against the BINDING MOCKUP.
//
// ── Why this exists, and why it could not be a cheaper check ────────────────────────────
//
// `docs/design/visualize-pane-mockup.html` is the binding reference (owner, 2026-08-13: *"yes,
// mockup is the binding reference"*). Before this file, NOTHING read it: `grep -i mockup` over
// the 152 KB design returned zero hits, the plan never cited it, and no test compared against
// it. The pane consequently shipped a control the reference does not describe — a divergence
// that was legal, typed, unit-tested and wrong.
//
// A structural or source-reading gate provably cannot catch that class. The shipped code was
// well-formed: no lint violation, no missing import, no wrong type, and every unit test passed
// because they asserted the behaviour that shipped. The only surface on which the defect is
// visible is the RENDERED RESULT — a person looking at the pane sees a question they were never
// meant to be asked. So this gate renders the real pane, in a real browser, against a real
// backend, and compares what a reader sees with what the reference says a reader should see.
//
// ── WHAT THE OWNER RULED ON 2026-08-13, and what this file now holds shut ──────────────
//
// The pane's first block was a control asking WHICH ROWS. It is DELETED. *"There is no such
// thing as a row space"*, and choosing between two axes is not a choice that exists. So:
//
//   · the pane's FIRST BLOCK is § Coordinates;
//   · § Coordinates lists immediately, with the FIRST set selected (ledger #24 — the owner
//     reversed the "nothing is chosen for you" rule for this control, which is a radio the
//     reader is looking at rather than an invisible binding);
//   · no option anywhere in the pane is an AXIS, in any branch — including the branch that
//     fires when a project declares no alignment at all, which is the branch the owner's own
//     data takes and the one a previous fix left untouched;
//   · a coordinate set declaring MORE than two components is not offered at all;
//   · the list is grouped under DATASET headings, ALWAYS — including at one dataset (ledger
//     #8/#16; the omission was an assistant's addition and the owner rejected it twice);
//   · EVERY coordinate row carries its own emit control, and there is no single wide button at
//     the foot of the card (ledger #27 — the mockup already showed this and the implementation
//     diverged; see `mockupRowsCarryEmit` below for why this gate could not see it).
//
// ── The mockup is PARSED, never transcribed ────────────────────────────────────────────
//
// The block vocabulary and the pane width are read out of the vendored HTML at test time.
// Transcribing them into literals here would make this file a second source of truth: the
// mockup could then be edited without failing anything, which is the exact state the pane
// shipped in. Edit either side alone and this goes red.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

import { BACKEND } from '../_owner'
import { loginAsOwner, ownerToken } from '../project/_helpers'
import { createProject } from '../14-workbench/_dock'
import { capture } from './_capture'
import {
  openVisualize,
  OWNER_SHAPE,
  seedOwnerImportedShape,
  seedTwoDatasetsOneCoordinateEach,
} from './_visualize'

/** The one dataset the owner-shape fixture writes — named here because the group heading is now
 *  asserted to READ it (ledger #8/#16). */
const DATASET_NAME = 'Population 1'

/** The binding reference, resolved from THIS file rather than from the runner's cwd — a
 *  cwd-relative path is the difference between "the gate read the mockup" and "the gate read
 *  nothing and passed". */
const MOCKUP = fileURLToPath(new URL('../../../../../docs/design/visualize-pane-mockup.html', import.meta.url))

function mockupHtml(): string {
  const html = readFileSync(MOCKUP, 'utf8')
  // A gate that silently reads an empty or wrong file is a gate that certifies anything. The
  // one landmark asserted here is the specimen's own pane class; everything else is derived.
  expect(html).toContain('class="pane"')
  return html
}

/** The vocabulary the mockup's pane BLOCKS define, in the order the specimen stacks them —
 *  now exactly the contributed sections' titles, the anchor's label having been deleted from
 *  the reference along with the control. */
function mockupBlockOrder(html: string): string[] {
  const pane = html.slice(html.indexOf('class="pane"'))
  const blocks: Array<{ at: number; text: string }> = []
  for (const m of pane.matchAll(/<div class="(anchor-label|sec-title)"[^>]*>|<span class="(anchor-label|sec-title)"[^>]*>/g)) {
    const start = m.index + m[0].length
    const end = pane.indexOf('<', start)
    blocks.push({ at: m.index, text: pane.slice(start, end).trim() })
  }
  // The specimen repeats its states further down the page (three more panes). The FIRST
  // occurrence of each word is the happy path, and duplicates are dropped rather than
  // asserted twice.
  const seen = new Set<string>()
  return blocks
    .sort((a, b) => a.at - b.at)
    .map(b => b.text)
    .filter(t => t !== '' && !seen.has(t) && (seen.add(t), true))
}

/**
 * ── THE WIDENING (ledger #27) ────────────────────────────────────────────────────────────
 *
 * This gate read the mockup for BLOCK ORDER and VOCABULARY, and both were satisfied by a pane
 * whose § Coordinates carried one wide button at the foot of the card while the reference put a
 * ▶ on every row. Order and words were identical; only the CONTROL PLACEMENT diverged, and the
 * gate had no eye for it — so the divergence shipped and the owner had to report it.
 *
 * Placement is now read out of the reference the same way everything else here is: for each of
 * the mockup's pane blocks, which of its option rows carry an emit control. The rule is a
 * PROPERTY of the reference rather than a fact about coordinates specifically — a block whose
 * every row carries a ▶ must render one control PER ROW, and a block that carries none must
 * render none — so the next block that grows a per-row action is covered without editing this.
 */
function mockupBlockRowEmits(html: string): Record<string, { rows: number; withEmit: number }> {
  const pane = html.slice(html.indexOf('class="pane"'))
  const out: Record<string, { rows: number; withEmit: number }> = {}
  // Each block is `<div class="sec">…<span class="sec-title">NAME</span>…<div class="sec-body">…`.
  for (const m of pane.matchAll(/<span class="sec-title"[^>]*>([^<]*)<\/span>([\s\S]*?)(?=<div class="sec">|$)/g)) {
    const name = m[1].trim()
    if (name === '' || out[name]) continue // first occurrence only — later panes repeat the states
    const body = m[2]
    const rows = [...body.matchAll(/<div class="opt">([\s\S]*?)<\/div>\s*(?=<div|<\/div>)/g)].map(r => r[1])
    out[name] = { rows: rows.length, withEmit: rows.filter(r => r.includes('class="emit"')).length }
  }
  return out
}

/** The pane's REAL WIDTH, declared by the mockup (`.pane { width: 300px }`). Read, not
 *  transcribed: the width is the constraint every section is designed against, so a pane that
 *  quietly became wider would make the specimen stop describing the thing it is a reference
 *  for. */
function mockupPaneWidth(html: string): number {
  const rule = /\.pane\s*\{[^}]*width:\s*(\d+)px/.exec(html)
  expect(rule, 'the mockup declares the pane width').not.toBeNull()
  return Number(rule![1])
}

/**
 * Put both side regions at `px` before the app boots, through the shipped persistence key
 * (`txr.wb.regions` — `regionsPersistence.ts`). BOTH, because which region hosts the pane is
 * an arrangement detail the user can change and this gate is about the pane's WIDTH.
 */
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

/**
 * The AXIS LABELS this project actually publishes, read from the catalog the app itself reads.
 *
 * Read rather than typed, and that is the whole point of the assertion it feeds: a spec that
 * spelled the labels would be checking that TWO PARTICULAR words are absent, which is the
 * "hardcode N spellings and miss the N+1th" shape. Whatever axes the fixture causes the backend
 * to declare, none of them may be offered as a choice.
 */
async function declaredAxisNames(request: import('@playwright/test').APIRequestContext, projectId: string): Promise<string[]> {
  const token = await ownerToken(request)
  const r = await request.get(`${BACKEND}/api/projects/${projectId}/catalog`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(r.ok(), `catalog read failed (${r.status()})`).toBeTruthy()
  const body = (await r.json()) as { axes?: Array<{ name?: string }> }
  const names = (body.axes ?? []).map(a => (a.name ?? '').trim()).filter(n => n !== '')
  // A vacuous assertion is worse than none: this project is seeded WITH axes, so an empty list
  // means the read is wrong and the check below would pass against anything.
  expect(names.length, 'the project declares axes to be absent from the pane').toBeGreaterThan(0)
  return names
}

/** Every CHOICE the pane offers, by accessible name — radios, checkboxes and options across
 *  every section, whatever contributed them. This is "an option ANYWHERE in the pane". */
async function offeredChoices(page: Page): Promise<string[]> {
  const stack = page.getByTestId('section-stack-visualize')
  const names = await stack.getByRole('radio').allTextContents()
  const boxes = await stack.getByRole('checkbox').allTextContents()
  const opts = await stack.getByRole('option').allTextContents()
  return [...names, ...boxes, ...opts].map(t => t.trim()).filter(t => t !== '')
}

/** THE CLASS ASSERTION, applied to whatever the pane rendered: no axis is a choice, and the
 *  words the owner struck are on no surface at all. */
async function assertNoAxisIsOffered(page: Page, axes: readonly string[]): Promise<void> {
  const choices = await offeredChoices(page)
  const lower = axes.map(a => a.toLowerCase())
  for (const choice of choices) {
    expect(
      lower,
      `"${choice}" is offered as a choice and it is an axis — no axis may be an option in this pane`,
    ).not.toContain(choice.toLowerCase())
  }
  // …and not as a HEADING either, which is the other way a list can end up organised by axis.
  const headings = await page.getByTestId('section-stack-visualize').locator('p, h3, h4').allInnerTexts()
  for (const h of headings.map(t => t.trim()).filter(Boolean)) {
    expect(lower, `"${h}" heads a list and it is an axis`).not.toContain(h.toLowerCase())
  }
  const paneText = (await page.getByTestId('section-stack-visualize').innerText()).toLowerCase()
  expect(paneText, 'the pane says "row space" somewhere').not.toContain('row space')
}

/** The § Coordinates radio options, by accessible name. The section's picker is the only
 *  radiogroup in that section, whether or not it is split into per-dataset groups. */
function coordinateSection(page: Page) {
  return page.locator('[data-section-id="sc.viz.coordinates"]')
}

test.describe('the pane matches its binding mockup (docs/design/visualize-pane-mockup.html)', () => {
  test("the owner's shape — one dataset, two axes, nothing declares alignment", async ({ page, request }) => {
    const html = mockupHtml()
    const expectedOrder = mockupBlockOrder(html)
    // THE REFERENCE ITSELF, first: the pane's first block is § Coordinates. Asserted against the
    // mockup so the two cannot drift apart silently, and asserted as a LITERAL as well because
    // the owner's ruling is about this exact word — a mockup edited to restore an anchor above
    // it would satisfy the first check and fail the second.
    expect(expectedOrder[0]).toBe('Coordinates')
    expect(expectedOrder.map(t => t.toLowerCase())).not.toContain('row space')

    const projectId = await createProject(request, `visualize-undeclared ${Date.now()}`)
    // THE OWNER'S OWN SHAPE, and it is the DEFAULT this suite runs against rather than an extra
    // case: no `aligned_to` anywhere, an axis and its identifier twin both declaring the same
    // key sequence, and every coordinate set named after its datatype. Three previous fixes to
    // this pane passed against well-declared fixtures and changed nothing on their screen.
    await seedOwnerImportedShape(request, projectId, DATASET_NAME)
    const axes = await declaredAxisNames(request, projectId)
    // The fixture is only a fixture for THIS defect if it really produced the two-axis shape.
    expect(axes.length, 'the fixture publishes two axes to be absent from the pane').toBeGreaterThan(1)

    await loginAsOwner(page)
    // ── THE WIDTH ────────────────────────────────────────────────────────────────────────
    // The reference declares the width every section in it is designed against, and says so in
    // its own prose: *"that constraint is not incidental … any section designed at desktop
    // width will meet it."* So the pane is DRIVEN to that width before anything below is read.
    await setRegionWidth(page, mockupPaneWidth(html))
    await openVisualize(page, projectId)

    const coords = coordinateSection(page)
    await expect(coords).toBeVisible({ timeout: 30_000 })

    const box = await page.getByTestId('section-stack-visualize').boundingBox()
    expect(box, 'the pane has a box').not.toBeNull()
    expect(Math.abs(box!.width - mockupPaneWidth(html)), `pane rendered at ${box!.width}px`).toBeLessThanOrEqual(24)

    // ── THE FIRST BLOCK IS § COORDINATES ────────────────────────────────────────────────
    // Read off the rendered pane, top to bottom, and compared with the mockup's own order — so
    // reintroducing a block above it fails here against the reference rather than against a
    // literal somebody typed.
    const rendered = await page
      .getByTestId('section-stack-visualize')
      .locator('[data-section-id] [data-testid^="section-title"], [data-section-id] h3')
      .allInnerTexts()
    // ── ONE DELIBERATE DIVERGENCE FROM THE REFERENCE: SPELLING (ledger #23) ────────────
    //
    // The mockup writes *"Colour by"*; the owner later ruled *"please use American English"*.
    // The mockup is binding on STRUCTURE — which blocks exist, in what order, carrying which
    // controls — and the later instruction wins on spelling, so the comparison is made over
    // Americanised text rather than the gate being loosened or the reference quietly edited.
    // The divergence is then held shut from the other side, below: the RENDERED pane may not
    // carry a British spelling at all.
    const americanise = (t: string): string => t.replace(/colour/gi, m => (m[0] === 'C' ? 'Color' : 'color'))
    const normalise = (s: string): string => americanise(s.trim()).toLowerCase()
    const seenOrder = rendered.map(normalise).filter(t => t !== '')
    const expected = expectedOrder.map(normalise)
    expect(seenOrder.length).toBeGreaterThan(1)
    for (const block of seenOrder) expect(expected, `"${block}" is a block the mockup defines`).toContain(block)
    // A SUBSEQUENCE, not an equality: a section is only listed where the project's data
    // satisfies its `applies_to`, so a project holding no entry axis correctly renders one
    // block fewer. What may NOT happen is a block the reference does not define, or two of them
    // in the reference's other order — or anything at all ABOVE Coordinates.
    expect(seenOrder).toEqual(expected.filter(t => seenOrder.includes(t)))
    expect(seenOrder[0]).toBe('coordinates')

    // ── § COORDINATES LISTS, AND THE FIRST IS CHOSEN (ledger #24) ───────────────────────
    //
    // REWRITTEN: this asserted that nothing was chosen. The owner reversed the rule for this
    // control, and the reversal is narrow — the selection is visible in a radio, marked `auto`,
    // and one click from any other, which is a different act from the invisible binding the old
    // rule was written against.
    const options = coords.getByRole('radio')
    await expect(options).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })
    await expect(options.first()).toBeChecked({ timeout: 30_000 })
    for (let i = 1; i < OWNER_SHAPE.coordinateSets; i++) await expect(options.nth(i)).not.toBeChecked()

    // …AND THE >2-D SET IS ABSENT. Same datatype, same capability, same axis as the ones that
    // ARE offered; the only difference is that it declares fifty components. No component
    // picker and no "first two" default — it is simply not there.
    await expect(coords).not.toContainText(OWNER_SHAPE.wideName)

    // ── ONE DATASET STILL DRAWS ITS HEADING (ledger #8 / #16) ────────────────────────────
    //
    // REWRITTEN: this asserted `toHaveCount(0)` — the suppression an assistant added and the
    // owner rejected twice (*"why there are no header for Datasets?"*, *"didn't I tell you to
    // group by dataset?"*). The heading is not competing with the option labels; it is the only
    // thing on screen naming whose data the pane is about.
    const headings = coords.getByTestId(/widget-coordinatePicker-group-/)
    await expect(headings).toHaveCount(1, { timeout: 30_000 })
    await expect(headings.first()).toHaveText(DATASET_NAME)

    // ── CONTROL PLACEMENT, AGAINST THE REFERENCE (ledger #27) ───────────────────────────
    //
    // The mockup puts a ▶ on every row of this block. So: one emit control per option, and
    // NONE outside the option rows — which is what rules out the wide button at the card's
    // foot that shipped instead.
    const reference = mockupBlockRowEmits(html)['Coordinates']
    expect(reference, 'the mockup declares a Coordinates block with option rows').toBeTruthy()
    expect(reference.rows, 'the mockup Coordinates block lists options').toBeGreaterThan(0)
    expect(reference.withEmit, 'every mockup Coordinates row carries an emit control').toBe(reference.rows)
    const emits = coords.locator('[data-testid^="widget-coordinatePicker-emit-"]')
    await expect(emits).toHaveCount(OWNER_SHAPE.coordinateSets, { timeout: 30_000 })
    // …and every emit control sits INSIDE an option row rather than loose in the section. Read
    // off the DOM: an emit whose nearest radio-row ancestor does not exist is a foot button.
    const looseEmits = await coords.evaluate(section =>
      [...section.querySelectorAll('[data-testid^="widget-coordinatePicker-emit-"]')].filter(
        b => b.closest('label') == null,
      ).length,
    )
    expect(looseEmits, 'an emit control sits outside the coordinate rows').toBe(0)

    // ── AMERICAN ENGLISH, ON THE RENDERED PANE (ledger #23) ─────────────────────────────
    //
    // Asserted as a CLASS over the pane's whole visible text rather than as "Color by is
    // spelled Color by": the owner's instruction was *"please use American English"*, and a
    // check that pinned the one reported word would pass the next one through — which is the
    // exact narrowing this ledger exists to record.
    const paneWords = (await page.getByTestId('section-stack-visualize').innerText()).toLowerCase()
    for (const british of ['colour', 'behaviour', 'catalogue', 'normalise', 'organise', 'customise', 'centre', 'licence', 'favourite', 'cancelled']) {
      expect(paneWords, `the pane renders the British spelling "${british}"`).not.toContain(british)
    }

    // ── THE CLASS: NO AXIS IS AN OPTION, IN THIS BRANCH ─────────────────────────────────
    // This project declares NO alignment anywhere, which is the branch that used to fall back
    // to offering every axis — and it is the branch the owner's own data takes.
    await assertNoAxisIsOffered(page, axes)

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'visualize-pane-owner-shape.png')
  })

  test('two datasets: one group heading each, and still no axis is offered', async ({ page, request }) => {
    const html = mockupHtml()
    const names = ['Population 1', 'Population 2']
    const projectId = await createProject(request, `visualize-two-datasets ${Date.now()}`)
    await seedTwoDatasetsOneCoordinateEach(request, projectId, names)
    const axes = await declaredAxisNames(request, projectId)

    await loginAsOwner(page)
    await setRegionWidth(page, mockupPaneWidth(html))
    await openVisualize(page, projectId)

    const coords = coordinateSection(page)
    await expect(coords).toBeVisible({ timeout: 30_000 })

    // ONE HEADING PER DATASET — the mockup's own shape for this block, and the reason the
    // deleted anchor is not missed: which population a coordinate set belongs to is a HEADING
    // over the sets, not a separate question asked before them.
    const headings = coords.getByTestId(/widget-coordinatePicker-group-/)
    await expect(headings).toHaveCount(names.length, { timeout: 30_000 })
    for (const name of names) await expect(coords).toContainText(name)

    // Both sets are offered, one under each heading, and the FIRST is chosen (ledger #24) —
    // exactly one of them, which is what makes this a claim about a single-valued control
    // rather than about a control that checked everything.
    const both = coords.getByRole('radio')
    await expect(both).toHaveCount(names.length)
    await expect(both.first()).toBeChecked({ timeout: 30_000 })
    await expect(both.nth(1)).not.toBeChecked()

    await assertNoAxisIsOffered(page, axes)

    await capture(test.info(), page.getByTestId('section-stack-visualize'), 'visualize-pane-two-datasets.png')
  })
})
