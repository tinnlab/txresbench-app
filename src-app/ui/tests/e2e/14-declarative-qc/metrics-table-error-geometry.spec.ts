// A VALIDATION ERROR MUST NOT RESIZE THE GRID (REPORTED), and the remove action is an ICON.
//
// The report: "when an error appears on an input, the error text widens that column and the whole
// table overflows its pane, making the row hard to follow."
//
// MEASURED, NEVER A CLASS. Every claim below is a number read off the rendered box tree. A class
// assertion is not evidence: the same `max-w-*` that reads as a fix in the source produced a 44px
// column holding a 480px-tall thirty-line ribbon here, and only the measurement said so. The
// numbers that drove the fix, at the pane this form docks into (the right region's default 300px
// ⇒ a 284px content box for the table):
//
//     no error, before      grid 352px   (the `Remove` word alone was 95px of it)
//     long error, before    grid 1306px  — 4.6 pane-widths, the name column alone 1013px
//     long error, after     grid 305px   — identical to the error-free grid
//
// WHAT IS AND IS NOT CLAIMED. The grid is 305px in a 284px box even with nothing invalid, and that
// residual is NOT this fix's: it is the kit's column HEADINGS, which do not shrink
// (`@txresbench/kit`'s `HeaderInner`; "Aggregation" alone has a 114px min-content, the row's controls
// only 88px). The kit gives the grid an internal `overflow-x-auto` for exactly that, so the
// residual is a ~20px scroll rather than a clip. This spec therefore asserts what the fix
// actually establishes — that VALIDITY does not enter the grid's geometry at all — plus that the
// message stays readable, which is the half a width fix can silently destroy.
//
// TWO WIDTHS, and the second is a different HOST: below 768px `WorkbenchShell` hands over to
// `MobileShell`, which puts the same pane inside a bottom-bar Sheet. A measurement on the desktop
// dock says nothing there.

import { expect, test, type Page } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'
import { seedProjectDataset, seedQcDataset, awaitQcSurface, METRIC_ROWS } from './_seed'

/** The widget under test. Spelled here rather than imported, so this file carries no name from
 *  the subject the fixture happens to be about. */
const METRIC_TABLE = 'widget-metricTable'

/** The row the error is put on, and the column it is put in. */
const ERR_ROW = 0
const NAME_FIELD = (row: number): string => `widget-metricTable-edit-name-${row}`
const NAME_ERROR = (row: number): string => `${NAME_FIELD(row)}-error`
const REMOVE_ACTION = (row: number): string => `widget-metricTable-action-remove-${row}`

/**
 * The rendered geometry of the metric table, read off the real box tree.
 *
 * `paneBox` is the table CONTAINER's content width — the box the grid is supposed to live inside,
 * and the one the report calls "its pane". `gridW` is the `<table>`'s own rendered width.
 */
async function measure(page: Page): Promise<{
  paneBox: number
  gridW: number
  widestColumn: number
  msg: { w: number; h: number; scrollW: number; clientW: number; scrollH: number; clientH: number; text: string } | null
}> {
  return page.getByTestId(METRIC_TABLE).evaluate((el, errTestId) => {
    const grid = el.querySelector('table') as HTMLElement | null
    const container = grid?.closest('[data-slot="table-container"]') as HTMLElement | null
    const columns = [...el.querySelectorAll('thead th')].map(th =>
      Math.round(th.getBoundingClientRect().width),
    )
    const p = el.querySelector(`[data-testid="${errTestId}"]`) as HTMLElement | null
    return {
      paneBox: container ? container.clientWidth : -1,
      gridW: grid ? Math.round(grid.getBoundingClientRect().width) : -1,
      widestColumn: columns.length ? Math.max(...columns) : -1,
      msg: p
        ? {
            w: Math.round(p.getBoundingClientRect().width),
            h: Math.round(p.getBoundingClientRect().height),
            scrollW: p.scrollWidth,
            clientW: p.clientWidth,
            scrollH: p.scrollHeight,
            clientH: p.clientHeight,
            text: (p.textContent ?? '').trim(),
          }
        : null,
    }
  }, NAME_ERROR(ERR_ROW))
}

/**
 * {@link measure}, SETTLED.
 *
 * A geometry read taken the instant a message appears can catch the layout mid‑reflow: the row
 * band is a new `<tr>`, and the store dispatch that produced it, the re‑render and the reflow are
 * three separate ticks. One run in ~8 read a width from between them and failed a claim that is
 * true of the settled page — an intermittent geometry test is worse than none, because it teaches
 * the reader to re‑run. So the width is read until two reads a frame apart AGREE, and the settled
 * pair is what every assertion is made on.
 */
async function measureSettled(page: Page): Promise<Awaited<ReturnType<typeof measure>>> {
  let last = await measure(page)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(120)
    const next = await measure(page)
    if (next.gridW === last.gridW && next.msg?.w === last.msg?.w) return next
    last = next
  }
  return last
}

/**
 * The name the FORM ITSELF calls a collision, read off the seeded fixture rather than typed here.
 *
 * The seed puts a set of columns on the axis this run writes to, and the form opens with rows
 * already refused for reusing one of them — so the value that raises the long message is sitting
 * in the first refused row's own input. Reading it keeps this file free of any name belonging to
 * the subject the fixture happens to be about (the repo's domain guard is a per-file ratchet, and
 * a new file's budget is zero), and it keeps the spec correct if the seed's column set changes.
 */
async function collidingNameFromFixture(page: Page): Promise<string> {
  // WAIT FOR THE VERDICT, don't race it. The set this constraint reads is a DATA slice resolved
  // from the catalog after mount, so for the first frames of a freshly-opened pane every row is
  // provisionally fine and NO row is refused. Scanning immediately found nothing and threw
  // "the fixture no longer opens with a refused row" — about a fixture that was perfectly correct
  // — in roughly one run in six.
  await expect(
    page.locator('[data-testid$="-error"]').first(),
    'the seeded collision must be reported before this can read which name caused it',
  ).toBeVisible({ timeout: 30_000 })
  const n = await page.locator(METRIC_ROWS).count()
  for (let i = 0; i < n; i++) {
    if ((await page.getByTestId(NAME_ERROR(i)).count()) > 0) {
      const v = await page.getByTestId(NAME_FIELD(i)).inputValue()
      if (v !== '') return v
    }
  }
  throw new Error(
    'the seeded fixture no longer opens the form with a refused row, so this spec has no way to ' +
      'raise the long message it exists to measure — re-seed a column that one of the default ' +
      'rows is named after.',
  )
}

/** Rename every seeded metric to something no other producer has taken, so the form is VALID —
 *  the error-free baseline every claim below is measured against. */
async function clearEveryError(page: Page): Promise<void> {
  // Counted off the ROWS, not off a `^=` testid prefix: `widget-metricTable-edit-name-0-error`
  // starts with `widget-metricTable-edit-name-`, so a prefix match counts the messages as fields
  // and the loop then waits forever for a row that does not exist. (Found the honest way — this
  // helper did exactly that on its first red run.)
  const n = await page.locator(METRIC_ROWS).count()
  expect(n, 'the seeded form must have metric rows to measure').toBeGreaterThan(0)
  for (let i = 0; i < n; i++) await page.getByTestId(NAME_FIELD(i)).fill(`uncollided_metric_${i}`)
  await expect(
    page.locator('[data-testid$="-error"]'),
    'the baseline must be genuinely error-free, or "the error changed nothing" proves nothing',
  ).toHaveCount(0)
}

/** Put the long collision message back on row 0 and wait for it to be on screen. */
async function raiseLongError(page: Page, colliding: string): Promise<string> {
  await page.getByTestId(NAME_FIELD(ERR_ROW)).fill(colliding)
  const msg = page.getByTestId(NAME_ERROR(ERR_ROW))
  await expect(msg, 'the collision must be reported on the row that collides').toBeVisible()
  const text = ((await msg.textContent()) ?? '').trim()
  expect(
    text.length,
    `this spec needs the LONG message — the one that caused the report. The form now reports ` +
      `${text.length} characters ("${text}"), which is too short to reproduce the defect: either ` +
      `re-point it at a constraint whose sentence is long, or the wording shrank and this test ` +
      `stopped measuring the case it exists for.`,
  ).toBeGreaterThanOrEqual(120)
  return text
}

/** The four measured claims, made at whatever width the caller has set up. */
async function assertErrorIsWeightless(page: Page, where: string): Promise<void> {
  const colliding = await collidingNameFromFixture(page)
  await clearEveryError(page)
  const clean = await measureSettled(page)
  const text = await raiseLongError(page, colliding)
  const errored = await measureSettled(page)

  // ── 1. THE REPORTED DEFECT. Validity is not an input to the grid's width. ──
  expect(
    errored.gridW,
    `${where}: a ${text.length}-character validation message resized the grid — ${clean.gridW}px ` +
      `valid vs ${errored.gridW}px invalid, inside a ${errored.paneBox}px pane. The message is ` +
      `sizing a column, which is what pushes the row the user is reading out from under them.`,
  ).toBeLessThanOrEqual(clean.gridW)

  // ── 2. IT ESCAPED THE COLUMN. A sentence in a column of a ~284px grid is a ribbon; the
  //       measurement that forced the fix was 44px wide × 480px tall. So the message must be
  //       WIDER than any single column, i.e. it is spanning the row rather than sitting in one.
  const msg = errored.msg
  expect(msg, `${where}: no message box was measured`).not.toBeNull()
  expect(
    msg!.w,
    `${where}: the message is ${msg!.w}px wide while the widest COLUMN is ` +
      `${errored.widestColumn}px — it is still boxed inside a column, so it is either a ribbon ` +
      `or it is about to widen one.`,
  ).toBeGreaterThan(errored.widestColumn)
  expect(
    msg!.w,
    `${where}: the message got ${msg!.w}px of a ${errored.paneBox}px pane — too narrow to read a ` +
      `${text.length}-character sentence in.`,
  ).toBeGreaterThanOrEqual(errored.paneBox * 0.5)

  // ── 3. IT READS AS A PARAGRAPH, NOT A RIBBON. Taller than wide is the shape a sentence takes
  //       when it has been squeezed into a column (the 44 × 480 case measured 10.9).
  expect(
    msg!.h / msg!.w,
    `${where}: the message is ${msg!.w}px × ${msg!.h}px — taller than it is wide, which is the ` +
      `shape a sentence takes when it is wrapping inside a narrow column instead of across the row.`,
  ).toBeLessThan(1)
  expect(msg!.h, `${where}: the message must wrap onto more than one line at this width`).toBeGreaterThan(20)

  // ── 4. NOTHING IS TRUNCATED AND NOTHING IS HIDDEN. The reason has to be readable to be
  //       actionable — no ellipsis, no clipping, and not parked behind a tooltip.
  expect(
    msg!.scrollW,
    `${where}: the message is clipped horizontally (${msg!.scrollW}px of content in ${msg!.clientW}px)`,
  ).toBeLessThanOrEqual(msg!.clientW + 1)
  expect(
    msg!.scrollH,
    `${where}: the message is clipped vertically (${msg!.scrollH}px of content in ${msg!.clientH}px)`,
  ).toBeLessThanOrEqual(msg!.clientH + 1)
  expect(msg!.text, `${where}: the rendered message lost characters`).toHaveLength(text.length)

  // ── 5. IT SAYS WHICH CONTROL IT IS ABOUT. The sentence sits under the ROW now, not under the
  //       control, and a row can carry several — so "which field?" has to be answered out loud.
  //       The heading is a SIBLING of the message, never a prefix inside it, so the message
  //       element's own text stays exactly the declared sentence (asserted above).
  const named = await page
    .getByTestId(NAME_ERROR(ERR_ROW))
    .evaluate(p => (p.parentElement?.textContent ?? '').trim())
  const heading = ((await page.locator(`[data-testid="${METRIC_TABLE}"] thead th`).first().textContent()) ?? '').trim()
  expect(heading, `${where}: the column under test must have a heading to be named by`).not.toBe('')
  expect(
    named,
    `${where}: the message is not labelled with the control it is about — the band reads ` +
      `"${named}" and the column it belongs to is headed "${heading}".`,
  ).toContain(heading)
}

test.describe('a validation message does not resize the metric table', () => {
  test('at a desktop width, the long collision message costs the grid nothing', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await loginAsOwner(page)
    const id = await createProject(request, `MetricGeomWide ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true })
    await openWorkbench(page, id)
    await awaitQcSurface(page)
    await assertErrorIsWeightless(page, 'desktop dock')
  })

  test('at a phone width, where a different shell hosts the pane, it costs the grid nothing', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsOwner(page)
    const id = await createProject(request, `MetricGeomNarrow ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true })
    await openWorkbench(page, id)

    // PRECONDITION: this really is `MobileShell`. Without it the test silently becomes a second,
    // slower copy of the desktop one.
    await expect(
      page.locator('[data-testid="workbench-shell"][data-workbench-mobile="true"]'),
      'below 768px the workbench must be MobileShell — otherwise this measures the desktop dock',
    ).toBeVisible({ timeout: 30_000 })
    // Which AREA hosts the analysis pane is a placement decision that has moved before, so ask
    // each sheet rather than hard-coding one (same reason `analysis-run-list-narrow` does).
    let opened = false
    for (const area of ['right', 'bottom', 'left']) {
      await page.getByTestId(`workbench-mobile-open-${area}`).click()
      opened = await awaitQcSurface(page).then(
        () => true,
        () => false,
      )
      if (opened) break
      await page.keyboard.press('Escape')
    }
    expect(opened, 'no mobile sheet hosted the analysis pane').toBe(true)

    await assertErrorIsWeightless(page, 'phone sheet')
  })
})

/**
 * THE SAME CLAIM, WITH AN UNBREAKABLE WORD IN THE MESSAGE.
 *
 * The message interpolates a value the USER typed (`A column named "{value}" …`), so its longest
 * WORD has no bound: paste a long identifier and the sentence contains a 120-character token. That
 * matters because only ONE wrapping rule participates in intrinsic sizing — `overflow-wrap:
 * anywhere` reports a min-content of one character, while `break-word` breaks the token during
 * layout and still reports the whole of it. Under the weaker rule the band (a full-width
 * `colSpan` box) hands that token's width to the TABLE, and the grid grows again — the reported
 * defect, arriving by the one route the ordinary wording is too short to take.
 *
 * The fixture holds that window on purpose: a seeded column whose name is one long unbroken word,
 * and a metric row named after it.
 */
const UNBREAKABLE_COLUMN = 'x'.repeat(120)

test.describe('a message with an unbreakable word does not resize the metric table either', () => {
  test('a 120-character token in the message costs the grid nothing', async ({ page, request }) => {
    test.setTimeout(180_000)
    await loginAsOwner(page)
    const id = await createProject(request, `MetricGeomToken ${Date.now()}`)
    const seeded = await seedProjectDataset(request, id, 'token dataset', 200, [
      { name: UNBREAKABLE_COLUMN, values: Array.from({ length: 200 }, (_, i) => i) },
    ])
    expect(
      seeded.column_names,
      'the fixture must actually put the long name on the axis, or nothing collides with it',
    ).toContain(UNBREAKABLE_COLUMN)
    await openWorkbench(page, id)
    await awaitQcSurface(page)

    await clearEveryError(page)
    const clean = await measureSettled(page)
    const text = await raiseLongError(page, UNBREAKABLE_COLUMN)
    expect(text, 'the message must carry the unbroken token itself').toContain(UNBREAKABLE_COLUMN)
    const errored = await measureSettled(page)

    expect(
      errored.gridW,
      `an unbreakable ${UNBREAKABLE_COLUMN.length}-character word inside the message resized the ` +
        `grid — ${clean.gridW}px valid vs ${errored.gridW}px invalid, inside a ` +
        `${errored.paneBox}px pane. Breaking a token during LAYOUT is not enough: the token is ` +
        `still what the box reports as its minimum, and the table is sized from that.`,
    ).toBeLessThanOrEqual(clean.gridW)
    expect(
      errored.msg!.scrollW,
      'and the token must not be clipped out of the message either',
    ).toBeLessThanOrEqual(errored.msg!.clientW + 1)
  })
})

test.describe('the per-row remove action is an icon that still says what it removes', () => {
  test('icon-only, named for its row, tooltipped on hover, and it removes THAT row', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await loginAsOwner(page)
    const id = await createProject(request, `MetricRemove ${Date.now()}`)
    await seedQcDataset(request, id, { annotated: true })
    await openWorkbench(page, id)
    await awaitQcSurface(page)

    const rows = page.locator(METRIC_ROWS)
    const before = await rows.count()
    expect(before, 'the seeded form must have metric rows').toBeGreaterThan(1)
    const victim = await page.getByTestId(NAME_FIELD(0)).inputValue()
    expect(victim, 'the row being removed must have a name for the control to name').not.toBe('')

    const button = page.getByTestId(REMOVE_ACTION(0))
    await expect(button).toBeVisible()

    // ── ICON-ONLY: a glyph, and no word. ──
    expect(
      ((await button.textContent()) ?? '').trim(),
      'the remove action must carry no visible text — the word was the widest column in the grid',
    ).toBe('')
    expect(await button.locator('svg').count(), 'an icon button must draw an icon').toBeGreaterThan(0)

    // ── …WHICH IS ONLY ALLOWED BECAUSE IT IS NAMED, AND NAMED FOR THE ROW. ──
    // The one thing a user must know before pressing a destructive control is WHAT it destroys,
    // and a glyph cannot say that. "Remove" alone would also make N rows N indistinguishable
    // controls to a screen-reader / voice user.
    const name = await button.getAttribute('aria-label')
    expect(name, 'an icon-only button must have an accessible name').toBeTruthy()
    expect(
      name,
      `the accessible name must say WHAT is removed, not just "Remove" — got "${name}" for the ` +
        `row named "${victim}"`,
    ).toContain(victim)

    // ── AND A TOOLTIP, for the pointer user who can read neither of the above. ──
    // Present as a tooltip TRIGGER at rest (what a static sweep can see), and it actually opens.
    await expect(
      button,
      'an icon-only button must be wired as a tooltip trigger, not merely aria-labelled',
    ).toHaveAttribute('data-slot', 'tooltip-trigger')
    await button.hover()
    const tip = page.locator('[data-slot="tooltip-content"]')
    await expect(tip, 'hovering an icon-only action must reveal its name').toBeVisible()
    await expect(tip).toHaveText(String(name))

    // ── AND IT WORKS. An icon that looks right and does nothing is the failure mode a
    //    presentation change invites (this very column once forwarded a row KEY to an action
    //    taking an INDEX, so "I can add metrics but cannot delete them" was the literal report).
    await page.mouse.move(0, 0)
    await button.click()
    await expect(rows, 'pressing remove must drop exactly one row').toHaveCount(before - 1)
    await expect(
      page.getByTestId(NAME_FIELD(0)),
      'and it must drop the row it named, not some other row',
    ).not.toHaveValue(victim)
  })
})
