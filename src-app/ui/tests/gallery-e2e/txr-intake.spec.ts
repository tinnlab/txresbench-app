import { expect, test, type Page } from '@playwright/test'

/**
 * TXRINTAKE — the gallery story's real-browser guard (ITEM-11's gallery-e2e
 * spec, backend-free: the `MethodCatalogue.*` / `FileValidation.*` cassette
 * of `txrintake/gallery.tsx` answers the page's real hooks and the real
 * file-validator calls).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-INT-14 (INV-1, INV-3, `txr-intake-b`)  — the live fit panel:
 *     count + descriptive line + per-method reason lines; a checkbox toggle
 *     re-runs the eligibility (the cassette's second response) and the
 *     count + left-out list update; "Show all N" expands the clip.
 *   · TEST-INT-15 (INV-2, INV-3, `txr-intake-c`)  — the C screen: the spec
 *     reads the story's fixture seam and feeds the card inputs with REAL
 *     `File` objects (the PROV-FV-7 parse runs in the browser), then the
 *     status box + the three board problem lines (row 14 day text, P0187
 *     missing, ldh/LDH join question), the join-accept re-validation (the
 *     A03 offer row disappears), the error-problem Continue gate and its
 *     enablement on the warning-only state.
 *   · TEST-INT-16 (INV-3, `txr-intake-n` + `txr-intake-narrow-390`) —
 *     the N screen's predict-mode validate + Continue reading
 *     `/pretrained-models` for intent `pretrained`; and the three screens at
 *     390×844: no horizontal overflow, cards stack, Continue on-screen.
 *
 * What the fixtures FORCE (records in `fixtures.ts`'s header + DRIFT-1
 * ITEM-11): the measurements table's row 14 is the non-numeric day, rows
 * 88..91 are patient P0187's, and `ldh`/`LDH` are two spellings of one
 * marker — so the card's problem list (row 14, four P0187 rows, the A03
 * join question) and the CONTINUE gate (error → disabled, warning-only →
 * enabled) are the fixture's own bytes, never the boards' design-example
 * counts. The eligibility responder is a function of the preview body:
 * ctDNA unchecked → 22 fit / 4 some / 13 left out; checked → 25 fit /
 * 3 some / 11 left out.
 *
 * The story host exposes two dev-only seams (the pages are never probed):
 * `txr-intake-story-fixtures` (the fixture CSV texts) and
 * `txr-intake-nav-result` (the route the page's Continue reached).
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-intake.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server (every `test:e2e:gallery` run boots its
// own worktree server) pays the whole graph's transform — minutes on a
// loaded box at CAP_CPUS=4. This backend-free, dev-only spec opts into its
// own budget rather than inheriting the config's fast-loop cap.
test.setTimeout(600_000)

/** The story's fixture bundle (the CSV texts the File construction uses). */
async function readFixtureBundle(page: Page): Promise<{
  patients: string
  measurements: string
  measurementsFixed: string
  predict: string
}> {
  const raw = await page.getByTestId('txr-intake-story-fixtures').textContent()
  expect(raw, 'the story fixture seam must be present').not.toBeNull()
  return JSON.parse(raw!) as {
    patients: string
    measurements: string
    measurementsFixed: string
    predict: string
  }
}

/** Drop one CSV text onto a card through the card's REAL file input. */
async function dropCsv(page: Page, cardTestId: string, name: string, text: string): Promise<void> {
  await page
    .getByTestId(cardTestId)
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') })
}

test.describe('txr-intake-b — the live "N of M fit" panel (TEST-INT-14)', () => {
  test('seeded answers → cassette counts, checkbox toggle → new response, Show all expands', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-intake-b`)

    // The panel lands after the hooks' (instant-ish) cassette responses.
    await expect(page.getByTestId('txr-intake-panel-fit-count')).toContainText('22')
    await expect(page.getByTestId('txr-intake-panel-fit-count')).toContainText('of 39 methods fit')

    // The descriptive line (board template, data-filled from the seeded answers).
    await expect(page.getByTestId('txr-intake-panel-sentence')).toHaveText(
      'for colorectal cancer, risk by a day, with no marker groups. This updates as you answer.',
    )
    await expect(page.getByTestId('txr-intake-panel-some')).toHaveText(
      '4 can run for some patients',
    )
    await expect(page.getByTestId('txr-intake-panel-excluded')).toContainText(
      '13 methods are left out',
    )

    // The board's own reason bytes (EXAMPLE-INT-1), one line per method.
    const excluded = page.getByTestId('txr-intake-panel-excluded')
    await expect(excluded).toContainText('cox-ctdna-status-rfs')
    await expect(excluded).toContainText(
      'cox-ctdna-status-rfsneeds a detection-call marker, not in your file',
    )
    await expect(excluded).toContainText(
      'ki67-two-week-four-groupneeds Ki-67, not in your file',
    )
    await expect(excluded).toContainText('dynforestneeds 3 or more draws')

    // The clip: 6 rows visible, "Show all 13" reveals the full list.
    const showAll = page.getByTestId('txr-intake-excluded-show-all')
    await expect(showAll).toBeVisible()
    await expect(showAll).toHaveText('Show all 13')
    await showAll.click()
    await expect(showAll).toHaveText('Show fewer')
    await expect(excluded.getByRole('listitem')).toHaveCount(13)

    // ── "This updates as you answer": checking ctDNA re-runs the eligibility ──
    await page.getByTestId('txr-intake-study-group-ctdna').click()
    await expect(page.getByTestId('txr-intake-panel-fit-count')).toContainText('25')
    await expect(page.getByTestId('txr-intake-panel-sentence')).toHaveText(
      'for colorectal cancer, risk by a day, with ctDNA. This updates as you answer.',
    )
    await expect(page.getByTestId('txr-intake-panel-some')).toHaveText(
      '3 can run for some patients',
    )
    await expect(page.getByTestId('txr-intake-panel-excluded')).toContainText(
      '11 methods are left out',
    )
    // The second response's list re-renders (the expanded state is kept):
    // 11 rows now, and the clip button reads the NEW count after collapsing.
    await expect(excluded.getByRole('listitem')).toHaveCount(11)
    await showAll.click()
    await expect(showAll).toHaveText('Show all 11')
  })
})

test.describe('txr-intake-c — the shared file-card flow (TEST-INT-15)', () => {
  test('drop → parse → inspect → validate: the three problem lines, join re-validation, Continue gate', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-intake-c`)
    const fixtures = await readFixtureBundle(page)

    // 1. The two cards start neutral; drop the patients file first.
    await dropCsv(page, 'txr-intake-file-drop-patients', 'fixture-patients.csv', fixtures.patients)
    await expect(page.getByTestId('txr-intake-file-card-patients')).toContainText('30 rows read')
    // One file only — NO validate call, the measurements card keeps its hold state.
    await expect(page.getByTestId('txr-intake-continue')).toBeDisabled()

    // 2. Drop the problem measurements file (row 14, P0187, ldh/LDH).
    await dropCsv(
      page,
      'txr-intake-file-drop-measurements',
      'fixture-measurements.csv',
      fixtures.measurements,
    )

    // The card's problem box: "5 problems in 120 rows" + one line per row.
    const measurementsStatus = page.getByTestId('txr-intake-file-status-measurements')
    await expect(measurementsStatus).toContainText('5 problems in 120 rows')
    const problems = page.getByTestId('txr-intake-file-problems-measurements')
    await expect(problems).toContainText('Row 14: week 4 is not a number in the day column')
    await expect(problems).toContainText('Row 88: P0187 is not in the patients table')
    await expect(problems).toContainText('Row 91: P0187 is not in the patients table')
    await expect(problems.getByRole('listitem')).toHaveCount(5)

    // The A03 join question is its own offer row (never a problem line).
    const joinOffer = page.getByTestId('txr-intake-join-offer-ldh')
    await expect(joinOffer).toBeVisible()
    await expect(joinOffer).toContainText('Marker "ldh" and "LDH" look the same: join them?')

    // The patients card stays green (its file is clean) — the cross-table
    // rows belong to the measurements card.
    await expect(page.getByTestId('txr-intake-file-status-patients')).toContainText(
      '✓ 30 patients read',
    )

    // The error problems block Continue (DEC-10).
    await expect(page.getByTestId('txr-intake-continue')).toBeDisabled()

    // 3. Accept the join → re-validation → the A03 offer row disappears
    //    (the errors stay — Continue stays disabled).
    await joinOffer.getByRole('button', { name: 'Join them' }).click()
    await expect(page.getByTestId('txr-intake-join-offer-ldh')).toHaveCount(0)
    await expect(page.getByTestId('txr-intake-file-problems-measurements').getByRole('listitem')).toHaveCount(5)
    await expect(page.getByTestId('txr-intake-continue')).toBeDisabled()

    // 4. The fixed twin: "Fix and choose the file again" → drop the corrected
    //    file → the warning-only state → the green box + 1 note, Continue enables.
    await page.getByTestId('txr-intake-file-fix-measurements').click()
    await dropCsv(
      page,
      'txr-intake-file-drop-measurements',
      'fixture-measurements-fixed.csv',
      fixtures.measurementsFixed,
    )
    await expect(page.getByTestId('txr-intake-file-status-measurements')).toContainText(
      '✓ 24 patients read',
    )
    await expect(page.getByTestId('txr-intake-file-status-measurements')).toContainText(
      'Found 120 rows: markers ldh and cea; draws at day 0, 14, 28 and 56. Ready.',
    )
    // The warning-only resolution: the remaining question is the A03 offer
    // row again (warnings never block — DEC-10), and Continue enables.
    await expect(page.getByTestId('txr-intake-join-offer-ldh')).toBeVisible()
    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()

    // 5. Continue → the declared E route (/choose-methods), recorded in the seam.
    await page.getByTestId('txr-intake-continue').click()
    await expect(page.getByTestId('txr-intake-nav-result')).toHaveText('/choose-methods')
  })
})

test.describe('txr-intake-n — predict mode (TEST-INT-16)', () => {
  test('one card validates in predict mode, Continue reads /pretrained-models', async ({ page }) => {
    await page.goto(`${GALLERY}txr-intake-n`)
    const fixtures = await readFixtureBundle(page)

    // The N screen: ONE measurements card, no patients card.
    await expect(page.getByTestId('txr-intake-file-card-measurements')).toBeVisible()
    await expect(page.getByTestId('txr-intake-file-card-patients')).toHaveCount(0)
    await expect(page.getByTestId('txr-intake-aside')).toContainText(
      'No outcomes are needed, and no patients file.',
    )

    await dropCsv(page, 'txr-intake-file-drop-measurements', 'fixture-predict.csv', fixtures.predict)

    // The board-N green box (EXAMPLE-INT-3's shape, data-filled).
    await expect(page.getByTestId('txr-intake-file-status-measurements')).toContainText(
      '✓ 24 patients read',
    )
    await expect(page.getByTestId('txr-intake-file-status-measurements')).toContainText(
      'Found 96 rows: markers ldh; draws at day 0, 14, 28 and 56. Next you choose the models that can run on it.',
    )

    await expect(page.getByTestId('txr-intake-continue')).toBeEnabled()
    await page.getByTestId('txr-intake-continue').click()
    await expect(page.getByTestId('txr-intake-nav-result')).toHaveText('/pretrained-models')
  })
})

test.describe('txr-intake-narrow-390 — the three screens at 390 px (TEST-INT-16)', () => {
  test('no horizontal overflow, cards stack, Continue on-screen', async ({ page }) => {
    await page.goto(`${GALLERY}txr-intake-narrow-390`)

    const frameOverflow = (frame: import('@playwright/test').Locator) =>
      frame.evaluate(el => el.scrollWidth - el.clientWidth)

    const assertBoxFits = async (label: string) => {
      const box = page.getByTestId(`txr-intake-narrow-${label}`)
      await expect(box).toBeVisible()
      const overflow = await frameOverflow(box)
      expect(overflow, `txr-intake-narrow-${label} horizontal overflow px`).toBeLessThanOrEqual(1)
      return box
    }

    // B — the questions + the panel stack inside 390 with no sideways push.
    const bBox = await assertBoxFits('b')
    await expect(bBox.getByTestId('txr-intake-panel-fit-count')).toContainText('22')
    const bContinue = bBox.getByTestId('txr-intake-study-continue')
    await bContinue.scrollIntoViewIfNeeded()
    await expect(bContinue).toBeInViewport()
    const bPanelBox = await bBox.getByTestId('txr-intake-panel').boundingBox()
    expect(
      bPanelBox!.x + bPanelBox!.width,
      'the B panel must stay inside the 390 frame',
    ).toBeLessThanOrEqual(390 + 1)

    // C — the two cards stack (measurements below patients); the role table
    // scrolls inside the card, never the page.
    const cBox = await assertBoxFits('c')
    const patientsCard = cBox.getByTestId('txr-intake-file-card-patients')
    const measurementsCard = cBox.getByTestId('txr-intake-file-card-measurements')
    await expect(patientsCard).toBeVisible()
    await expect(measurementsCard).toBeVisible()
    const patientsBox = await patientsCard.boundingBox()
    const measurementsBox = await measurementsCard.boundingBox()
    expect(
      measurementsBox!.y,
      'the measurements card must stack below the patients card at 390 px',
    ).toBeGreaterThanOrEqual(patientsBox!.y + patientsBox!.height - 1)
    const cContinue = cBox.getByTestId('txr-intake-continue')
    await cContinue.scrollIntoViewIfNeeded()
    await expect(cContinue).toBeInViewport()

    // N — the main column and the aside stack inside 390, Continue on-screen.
    const nBox = await assertBoxFits('n')
    const aside = nBox.getByTestId('txr-intake-aside')
    await expect(aside).toBeVisible()
    const asideBox = await aside.boundingBox()
    expect(asideBox!.x + asideBox!.width, 'the N aside must fit the 390 frame').toBeLessThanOrEqual(
      390 + 1,
    )
    const nContinue = nBox.getByTestId('txr-intake-continue')
    await nContinue.scrollIntoViewIfNeeded()
    await expect(nContinue).toBeInViewport()
  })
})
