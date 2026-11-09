import { expect, test, type Locator } from '@playwright/test'

/**
 * TXRLIST — THE BOARD-LAYOUT FALL-DETECTOR (ITEM-9's gallery-e2e spec).
 *
 * This is the module's real-browser guard: the four CONTENT-BEARING
 * dev-gallery surfaces (`txrlist/gallery.tsx`, backend-free — the
 * `MethodCatalogue.*` cassette answers the adapter hooks inside the page)
 * driven through the DOM, so the BOARD BYTES of the three screens stay
 * true in an actual layout engine (the unit suites pin the same bytes in
 * jsdom; the e2e pins them where a clinician would see them). The three
 * no-rows surfaces (empty/error/loading, EXAMPLE-UL-7) are pinned by the
 * unit suite + the ITEM-8 smoke; the enumerated e2e rows (TEST-UL-12/13)
 * drive the four with content.
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-UL-12  (INV-1, `txr-list-e`)      — rows, chips, selection,
 *                                              estimate total, Run callback
 *   · TEST-UL-13  (INV-2, `txr-list-i`)      — run groups, section
 *                                              select-all, search, sort
 *   · TEST-UL-14  (INV-1, `txr-list-narrow-390` + `txr-list-d`)
 *                                              — no overflow, wrap, Run
 *                                              on-screen, D notice verbatim
 *
 * What the fixture FORCES (records in `fixtures.ts`'s header + DRIFT-1
 * ITEM-8 #1): the first five enabled screen-E rows carry
 * [120, 120, 12, 840, 240] so the server's greedy LPT at 3 lanes is exactly
 * 840 s → the pinned "about 14 minutes in total" total,
 * while dynforest's ROW time is the fixture's one adjusted number
 * ("about 14 min"; the board's "about 5 min" is a design example). The
 * spec checks the FIRST FIVE rows and reads its totals from the same LPT
 * rule, as the fixture note instructs.
 *
 * The Run callback is asserted through the story host's discrepancy seam
 * (`txr-list-run-result`, `gallery.tsx`): the story host records the keys +
 * options the component emitted; the component itself is never probed.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-list.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server (every `test:e2e:gallery` run boots its
// own worktree server) pays the whole graph's transform — minutes on a
// loaded box at CAP_CPUS=4. This backend-free, dev-only spec opts into its
// own budget rather than inheriting the config's 120 s fast-loop cap.
test.setTimeout(600_000)

/** The fixture's first five ENABLED rows, in catalogue/click order (see above). */
const E_FIRST_FIVE_KEYS = [
  'direct-on',
  'cox-timevarying-slope',
  'baseline-ctdna-detectability',
  'dynforest',
  'flirti',
]

/** The board's research-use notice (DEC-13, D/I bottom bars). */
const RESEARCH_NOTICE = "For research. Not for deciding a patient's treatment."

/** The exact long-form total the fixture's LPT makespan serves (DEC-7/12). */
const E_TOTAL_TEXT = 'about 14 minutes in total'

/** A row's name/tag block: the row's monospace id line + paper line. */
async function rowNameBlock(row: Locator) {
  return row.evaluate(el => {
    const block = Array.from(el.querySelectorAll('div')).find(div =>
      getComputedStyle(div).fontFamily.includes('Source Code Pro'),
    )
    return block === undefined ? null : block.getBoundingClientRect().toJSON()
  })
}

/** A row's status block: the span whose <b> carries the verdict headline. */
async function rowStatusBlock(row: Locator) {
  return row.evaluate(el => {
    const block = Array.from(el.querySelectorAll('span')).find(
      span => (span.firstElementChild?.tagName ?? '') === 'B',
    )
    return block === undefined ? null : block.getBoundingClientRect().toJSON()
  })
}

test.describe('txr-list-e — screen E, adapter-fed (TEST-UL-12)', () => {
  test('cassette-fed rows, built-in counts, selection → estimate total → Run callback', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-list-e`)

    // The list renders after the hooks' (instant-ish) cassette response.
    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-direct-on')).toBeVisible()

    // ── the board's row bytes (Busy.dc.html), one row per aspect ──
    const row = await page.getByTestId('txr-list-row-direct-on').textContent()
    for (const needle of [
      'direct-on',
      'Paper 2021, R',
      'Response probability',
      'Can run',
      'all 151 patients',
      'about 2 min',
      'About',
    ]) {
      expect(row, `row direct-on must carry ${needle!}`).toContain(needle!)
    }
    // The monospace id is the board's byte, not a theme font.
    const nameFont = await page
      .getByTestId('txr-list-row-direct-on')
      .evaluate(el => {
        const div = Array.from(el.querySelectorAll('div')).find(d =>
          getComputedStyle(d).fontFamily.includes('Source Code Pro'),
        )
        return div === undefined ? null : getComputedStyle(div).fontFamily
      })
    expect(nameFont).toContain('Source Code Pro')

    // The `some` row: the fixture's ONE adjusted number (dynforest 840 s) and
    // the board's partial-coverage line (EXAMPLE-UL-2).
    const someRow = await page.getByTestId('txr-list-row-dynforest').textContent()
    for (const needle of [
      'Can run for some patients',
      'needs 3 or more draws; 120 of 151 have them',
      'about 14 min',
    ]) {
      expect(someRow, `row dynforest must carry ${needle!}`).toContain(needle!)
    }

    // The `cannot` row: board line + disabled checkbox that never ticks.
    // The row carries NO estimate (qa-fixes ITEM-2 CM-4: a method that
    // cannot run has no time — the estimate never computed one).
    const cannotRow = await page.getByTestId('txr-list-row-cox-ctdna-status-rfs').textContent()
    for (const needle of ['Cannot run', 'needs LDH, not in your file']) {
      expect(cannotRow, `row cox-ctdna-status-rfs must carry ${needle!}`).toContain(needle!)
    }
    expect(cannotRow, 'a cannot-run row carries no estimate').not.toContain('min')
    await expect(page.getByTestId('txr-list-checkbox-cox-ctdna-status-rfs')).toHaveAttribute(
      'data-disabled',
      '',
    )
    await expect(page.getByTestId('txr-list-checkbox-cox-ctdna-status-rfs')).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // ── built-in count chips (26 of 38 can run: 21 fit + 5 partial) ──
    await expect(page.getByTestId('txr-list-filter-all')).toHaveText('All 38')
    await expect(page.getByTestId('txr-list-filter-can-run')).toHaveText('Can run 26')

    // ── the bar before any selection: 0 selected, the "…" total slot ──
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('0 methods selected')
    // The at-a-time segment renders INSIDE the total-time slot on E (the
    // board's "· run <n> at a time" line), so the slot is "…" + the segment.
    await expect(page.getByTestId('txr-list-total-time')).toContainText('…')
    // The E screen's bar carries the at-a-time + save controls (absent on D/I).
    await expect(page.getByTestId('txr-list-at-a-time')).toBeVisible()
    await expect(page.getByTestId('txr-list-save-models')).toBeVisible()

    // ── check the first five enabled rows → the pinned 840-s total ──
    for (const id of E_FIRST_FIVE_KEYS) {
      await page.getByTestId(`txr-list-checkbox-${id}`).click()
    }
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('5 methods selected')
    // The total slot also carries the at-a-time segment on E (see above), so
    // the assert is CONTAINS for the pinned total line.
    await expect(page.getByTestId('txr-list-total-time')).toContainText(E_TOTAL_TEXT)
    await expect(page.getByTestId('txr-list-run')).toHaveText('Run 5 methods')

    // ── Run emits exactly the selected keys + the current options ──
    await page.getByTestId('txr-list-run').click()
    await expect(page.getByTestId('txr-list-run-result')).toBeVisible()
    const resultText = await page.getByTestId('txr-list-run-result').textContent()
    const result = JSON.parse(resultText ?? '{}') as {
      keys: string[]
      atATime: number
      saveModels: boolean
    }
    expect(result.keys, `run keys (${resultText})`).toEqual(E_FIRST_FIVE_KEYS)
    expect(result.atATime).toBe(3)
    expect(result.saveModels).toBe(false)

    // ── the host group chip narrows the rows; the selection never shrinks ──
    await page.getByTestId('txr-list-filter-Response probability').click()
    await expect(page.getByTestId('txr-list-row-glm-chem-probability')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-cox-timevarying-slope')).toHaveCount(0)
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('5 methods selected')
  })
})

test.describe('txr-list-d — screen D, host-built rows (TEST-UL-14 part)', () => {
  test('pretrained rows, chips, initial selection, research notice, no E-only controls', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-list-d`)

    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-ctdna-clearance')).toBeVisible()

    // The board's first D row verbatim (Pretrained.dc.html): tag, knowledge
    // chip, performance fact, verdict, time, action.
    const row = await page.getByTestId('txr-list-row-ctdna-clearance').textContent()
    for (const needle of [
      'Rule from the paper; colorectal, immunotherapy',
      'Published',
      'other cohorts: AUC 0.64',
      'Can run',
      'all 38 patients',
      'under 1 min',
      'Model card',
    ]) {
      expect(row, `row ctdna-clearance must carry ${needle!}`).toContain(needle!)
    }
    // The D cannot row: disabled box, the "what is missing" line.
    await expect(
      page.getByTestId('txr-list-checkbox-ki67-two-week-four-group'),
    ).toHaveAttribute('data-disabled', '')
    const cannotRow = await page.getByTestId('txr-list-row-ki67-two-week-four-group').textContent()
    expect(cannotRow).toContain('Cannot run')
    expect(cannotRow).toContain('needs Ki-67, not in your file')

    await expect(page.getByTestId('txr-list-filter-all')).toHaveText('All 7')
    await expect(page.getByTestId('txr-list-filter-can-run')).toHaveText('Can run 5')

    // The story host starts with 3 models selected (the board's checked rows).
    const bar = page.getByTestId('txr-list-bottom-bar')
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('3 models selected')
    // The research notice is the bar's verbatim line (DEC-13); the E-only
    // at-a-time + save controls are absent on this screen (EXAMPLE-UL-3).
    await expect(bar).toContainText(RESEARCH_NOTICE)
    await expect(page.getByTestId('txr-list-at-a-time')).toHaveCount(0)
    await expect(page.getByTestId('txr-list-save-models')).toHaveCount(0)
  })
})

test.describe('txr-list-i — screen I, run groups (TEST-UL-13)', () => {
  test('two run groups, section select-all 9-of-11, danger action, search, sort', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-list-i`)

    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId('txr-list-section-crc-cohort-day-56')).toBeVisible()
    await expect(page.getByTestId('txr-list-section-lung-pilot-day-42')).toBeVisible()

    // ── the run-group headers: title, run facts, actions (EXAMPLE-UL-4) ──
    const crc = page.getByTestId('txr-list-section-crc-cohort-day-56')
    await expect(crc).toContainText('CRC cohort, day 56')
    await expect(crc).toContainText(
      'trained 19 Oct on patients.csv · 151 patients · 11 models · progression or death by day 238',
    )
    const rename = page.getByTestId('txr-list-section-action-crc-cohort-day-56-rename')
    const deleteAction = page.getByTestId('txr-list-section-action-crc-cohort-day-56-delete')
    await expect(rename).toHaveText('Rename')
    await expect(deleteAction).toHaveText("Delete the run's models")
    // The danger tone is the board literal (#b3261e), the default the link blue.
    expect(await deleteAction.evaluate(el => getComputedStyle(el).color)).toBe(
      'rgb(179, 38, 30)',
    )
    expect(await rename.evaluate(el => getComputedStyle(el).color)).toBe('rgb(29, 78, 137)')

    // ── built-ins over the 13 saved models (9 + 1 eligible of the groups) ──
    await expect(page.getByTestId('txr-list-filter-all')).toHaveText('All 13')
    await expect(page.getByTestId('txr-list-filter-can-run')).toHaveText('Can run 10')

    // ── section select-all: exactly the 9 eligible of the 11 CRC models ──
    await crc.getByRole('checkbox').click()
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('9 models selected')
    // The 2 disabled never tick; the other run's rows never move.
    for (const key of ['cox-ctdna-status-rfs', 'psa-nadir-ttn-four-group']) {
      const checkbox = page.getByTestId(`txr-list-checkbox-${key}`)
      await expect(checkbox).toHaveAttribute('data-disabled', '')
      await expect(checkbox).toHaveAttribute('aria-checked', 'false')
    }
    await expect(
      page.getByTestId('txr-list-checkbox-baseline-cox-cumulative-hazard'),
    ).toHaveAttribute('aria-checked', 'false')

    // ── find-a-model search narrows by name (within the run's order) ──
    await page.getByTestId('txr-list-search').fill('dynforest')
    await expect(page.getByTestId('txr-list-row-dynforest')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-landmark-dynforest')).toBeVisible()
    await expect(page.getByTestId('txr-list-row-flirti')).toHaveCount(0)
    // The emptied Lung group renders no header; the CRC group stays.
    await expect(page.getByTestId('txr-list-section-lung-pilot-day-42')).toHaveCount(0)
    await expect(page.getByTestId('txr-list-section-crc-cohort-day-56')).toBeVisible()

    // ── sort reorders the run's models ("Newest run first" → "Patients
    //    covered": covered-38 models rise above covered-36; the fixture's
    //    stable sort keeps the rest) ──
    await page.getByTestId('txr-list-search').fill('')
    const yOf = async (key: string) => {
      const box = await page.getByTestId(`txr-list-row-${key}`).boundingBox()
      expect(box, `row ${key} must be mounted`).not.toBeNull()
      return box!.y
    }
    // Fixture order: cox-cutpoint-risk is the first CRC row, dynforest third.
    expect(await yOf('cox-cutpoint-risk')).toBeLessThan(await yOf('dynforest'))
    await page.getByTestId('txr-list-sort').click()
    await page.getByRole('option', { name: 'Patients covered' }).click()
    await expect
      .poll(async () => {
        const a = await yOf('dynforest')
        const b = await yOf('cox-cutpoint-risk')
        return a - b
      })
      .toBeLessThan(0)
  })
})

test.describe('txr-list-narrow-390 — the wrap path (TEST-UL-14)', () => {
  test('no horizontal overflow, rows wrap, Run on-screen at 390 px', async ({ page }) => {
    await page.goto(`${GALLERY}txr-list-narrow-390`)

    await expect(page.getByTestId('txr-list')).toBeVisible()
    // The long-id and long-missing-marker rows are the fixture's overflow
    // cases — wait for the long-id one specifically.
    await expect(
      page.getByTestId(
        'txr-list-row-coxs-slope-with-piecewise-constant-treatment-effect-and-ctdna-landmark',
      ),
    ).toBeVisible()

    // ── no horizontal page overflow (the entry-list measured pattern) ──
    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(pageOverflow, 'page horizontal overflow px').toBeLessThanOrEqual(1)

    // ── every row stays inside its scroll window and WRAPS: the name/tag
    //    block sits on a line ABOVE the status/detail block (EXAMPLE-UL-6) ──
    const windowRect = await page
      .getByTestId('txr-list-content')
      .evaluate(el => el.getBoundingClientRect().toJSON())
    const overflows: string[] = []
    const notWrapped: string[] = []
    const rowTestIds = [
      'direct-on',
      'cox-timevarying-slope',
      'baseline-ctdna-detectability',
      'dynforest',
      'coxs-slope-with-piecewise-constant-treatment-effect-and-ctdna-landmark',
      'ctdna-clearance-with-lod-imputation-extension',
    ]
    for (const key of rowTestIds) {
      const row = page.getByTestId(`txr-list-row-${key}`)
      await expect(row).toBeVisible()
      const name = await rowNameBlock(row)
      const status = await rowStatusBlock(row)
      expect(name, `row ${key} name block`).not.toBeNull()
      expect(status, `row ${key} status block`).not.toBeNull()
      const rect = await row.evaluate(el => el.getBoundingClientRect().toJSON())
      if (rect.left < windowRect.left - 1 || rect.right > windowRect.right + 1) {
        overflows.push(`${key}: row [${rect.left}..${rect.right}] vs window [${windowRect.left}..${windowRect.right}]`)
      }
      // The status line starts BELOW the name/tag block → name/tag wrap first.
      if (status!.top < name!.bottom - 1) {
        notWrapped.push(`${key}: status.top ${status!.top} < name.bottom ${name!.bottom}`)
      }
    }
    expect(overflows, 'rows wider than the list window').toEqual([])
    expect(notWrapped, 'rows that did not wrap').toEqual([])

    // ── the Run button stays on the screen — reachable, and never pushed
    //    off horizontally by the wrap rows: scroll it into the viewport (the
    //    gallery frame is 720 tall; the list's bar sits at its bottom), then
    //    it must be fully visible with its x-extent inside the page ──
    const run = page.getByTestId('txr-list-run')
    await run.scrollIntoViewIfNeeded()
    await expect(run).toBeVisible()
    const runBox = await run.boundingBox()
    expect(runBox, 'Run button must be mounted').not.toBeNull()
    expect(runBox!.x).toBeGreaterThanOrEqual(0)
    expect(runBox!.x + runBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await expect(run).toBeInViewport()
  })
})
