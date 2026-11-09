import { expect, test, type Locator } from '@playwright/test'

/**
 * TXRMODELS — the model screens' real-browser guard (ITEM-10's gallery-e2e
 * spec, backend-free: the `txrmodels/gallery.tsx` cassette + the per-story
 * id-scoped extensions answer the module's own reads over the synthetic
 * `fixtures.ts`, and every story drives the REAL pages over the REAL
 * stores — the same surfaces a clinician sees).
 *
 * Spec ↔ TESTS.md enumeration:
 *   · TEST-MOD-17 (INV-1/3, `txr-models-d`) — the pretrained board: the
 *     Step-4 header + the checked-against line + the verdict totals, the
 *     shared list rows (mono id · day N, tag, Published/Learned here chip,
 *     performance, verdict + detail, time, Model card), the built-in
 *     count chips + the four host chips, the selection-driven count +
 *     total, the research notice, checking a not-installed card starts the
 *     download (bytes + pct in the downloads strip) and the Run click is
 *     refused while it downloads; the Model card opens from the row
 *     action; with the strip clear, Run records the created-run payload
 *     + the in-frame navigation — EXAMPLE-UM-1.
 *   · TEST-MOD-18 (INV-1/2, `txr-models-i` + `txr-models-j` +
 *     `txr-models-d-narrow-390`) — the saved board's two run sections
 *     (facts lines, select-all checks the section's eligible models only,
 *     Rename/Delete actions), the Same-outcome chip narrowing to the
 *     matching endpoint/horizon, the find-a-model-or-run search, the
 *     sort flip (Newest run first → Patients covered); the J inventory
 *     table's board columns + the imported row + the footnotes, with the
 *     open-folder button ABSENT (web mode) while the path text is
 *     PRESENT; the 390 px story has no horizontal page overflow and the
 *     bottom-bar Run stays inside the viewport — EXAMPLE-UM-2/UM-3.
 *   · TEST-MOD-19 (INV-1/7, `txr-models-l` + `txr-models-l2`) — the L
 *     dialog opens over the results board through the REAL EventBus
 *     event (backdrop dimmed, no navigation), the checklist + the
 *     training-data warning + the cannot-run note + keep-training-files
 *     render, Save posts the save body through the cassette (the story
 *     seam shows it) and the L3 confirmation replaces the dialog with
 *     the real models root; "See my models" navigates in-frame; on L2 the
 *     set select + the new-set name hiding behave and Save posts the
 *     one-model body — EXAMPLE-UM-4/5.
 *
 * What the fixtures FORCE (records in `fixtures.ts`'s header + DRIFT-1
 * ITEM-10): every value is the module fixture family's own — 42 patients /
 * 4 markers / days 0,14,28,56 / decision day 60 / horizons 240 and 165,
 * the verdicts 4 fit + 2 some + 1 cannot (D) and 5 fit + 3 some + 2
 * cannot (I), the sizes 4,600,000 per card and the 800 KB–12.8 MB
 * produced spread — never a board example number (INV-4). The D story's
 * total for the three selected cards is 45 + 90 + 120 = 255 s → "about 4
 * minutes in total on this computer"; the download card's 1,234,567 of
 * 4,600,000 bytes reads "1.2 MB of 4.4 MB" at 27%.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-models.spec.ts
 */

const GALLERY = '/gallery.html?surface='

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// test on a freshly booted server (every `test:e2e:gallery` run boots its
// own worktree server) pays the whole graph's transform — minutes on a
// loaded box. This backend-free, dev-only spec opts into its own budget
// rather than inheriting the config's 120 s fast-loop cap.
test.setTimeout(600_000)

/** The board's research-use notice (DEC-13, the D/I bottom bars). */
const RESEARCH_NOTICE = "For research. Not for deciding a patient's treatment."

/** The checked-against line of the module fixture family (42 patients, 4
 *  markers, draws 0/14/28/56) — the D tail and the I tail. */
const D_CHECKED_LINE =
  'Checked against your file: 42 patients, 4 markers, draws at day 0, 14, 28 and 56. Pick as many as you like.'
const I_CHECKED_LINE =
  'Checked against your file: 42 patients, 4 markers, draws at day 0, 14, 28 and 56. Models from one training run are grouped; pick any of them.'

/** The fixture total for the three selected installed cards (45+90+120 s). */
const D_TOTAL_TEXT = 'about 4 minutes in total on this computer'

/** The gated-Run line (the D page's constant for a still-downloading card). */
const GATE_DOWNLOADING_LINE =
  'A selected model is still downloading. Wait for it to finish, or uncheck it.'

/** The fixture ids (the D cards' row keys — DEC-8's `ps:` prefix over the
 *  catalogue id; the I rows' uuid keys via the ID helpers). */
const PS_ROW = (k: number): string => `ps:ps-${k}`
const PS = (k: number): string => `ps-${k}`
const FM = (k: number): string => `a0000000-0000-4000-8000-0000000000${String(k).padStart(2, '0')}`

/** The D row's name/tag block (the board's mono id line + the tag line). */
function yOf(row: Locator): Promise<number> {
  return row.evaluate(el => el.getBoundingClientRect().top)
}

test.describe('txr-models-d — choose the pretrained models (TEST-MOD-17)', () => {
  test('board bytes, chips, selection → total, download gate, Model card, Run payload', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-models-d`)

    await expect(page.getByTestId('txr-models-d')).toBeVisible()
    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId(`txr-list-row-${PS_ROW(1)}`)).toBeVisible()

    // ── the header bytes (fixture-derived facts, never board examples) ──
    await expect(page.getByTestId('txr-models-d')).toContainText('Step 4 of 4')
    await expect(page.getByTestId('txr-models-d')).toContainText('Choose the models to run')
    await expect(page.getByTestId('txr-models-d-checked')).toHaveText(D_CHECKED_LINE)
    await expect(page.getByTestId('txr-models-d-totals')).toHaveText('6 can run, 1 cannot')

    // ── the first row's board bytes (Pretrained.dc.html's row surface) ──
    const row = await page.getByTestId(`txr-list-row-${PS_ROW(1)}`).textContent()
    for (const needle of [
      'ps-1 · day 60',
      'Rule from the paper; colorectal',
      'Published',
      'other cohorts: AUC 0.71',
      'Can run',
      'all 42 patients',
      'under 1 min',
      'Model card',
    ]) {
      expect(row, `row ps:1 must carry ${needle!}`).toContain(needle!)
    }

    // ── built-ins + the four host chips (fixture counts) ──
    // The built-in "Can run" count is ROW-derived (the enabled checkboxes):
    // the fixture's row family is 3 can + 2 some + 2 cannot (the two
    // genuinely-cannot cards — missing Ki-67, unavailable asset), so it
    // reads 5, while the header totals (4 fit + 2 some + 1 cannot — the
    // response's own record) read 6 can run / 1 cannot. Both halves are
    // pinned by the ITEM-4/6 unit suites' own sources; the 5-vs-6
    // discrepancy is the pre-existing fixture-family nuance (DRIFT-1
    // ITEM-10 #10).
    await expect(page.getByTestId('txr-list-filter-all')).toHaveText('All 7')
    await expect(page.getByTestId('txr-list-filter-can-run')).toHaveText('Can run 5')
    await expect(page.getByTestId('txr-list-filter-published')).toHaveText('Published rules 4')
    await expect(page.getByTestId('txr-list-filter-learned')).toHaveText(
      'Learned by the benchmark 3',
    )
    await expect(page.getByTestId('txr-list-filter-checked-2-plus')).toHaveText(
      'Checked on 2 or more other cohorts 3',
    )

    // ── the host chip narrows the rows; the selection survives the view ──
    await page.getByTestId('txr-list-filter-published').click()
    await expect(page.getByTestId(`txr-list-row-${PS_ROW(2)}`)).toHaveCount(0)
    await expect(page.getByTestId(`txr-list-row-${PS_ROW(1)}`)).toBeVisible()
    await page.getByTestId('txr-list-filter-published').click()
    await expect(page.getByTestId(`txr-list-row-${PS_ROW(2)}`)).toBeVisible()

    // ── three selected installed cards → count + the DEC-7 total ──
    await page.getByTestId(`txr-list-checkbox-${PS_ROW(1)}`).click()
    await page.getByTestId(`txr-list-checkbox-${PS_ROW(3)}`).click()
    await page.getByTestId(`txr-list-checkbox-${PS_ROW(4)}`).click()
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('3 models selected')
    await expect(page.getByTestId('txr-list-total-time')).toContainText(D_TOTAL_TEXT)
    // The research notice is the bar's verbatim line; the E-only at-a-time
    // + save controls are absent on this screen (INV-3).
    await expect(page.getByTestId('txr-list-bottom-bar')).toContainText(RESEARCH_NOTICE)
    await expect(page.getByTestId('txr-list-at-a-time')).toHaveCount(0)
    await expect(page.getByTestId('txr-list-save-models')).toHaveCount(0)

    // ── checking the not-installed card starts its download (the D strip) ──
    await page.getByTestId(`txr-list-checkbox-${PS_ROW(5)}`).click()
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('4 models selected')
    await expect(page.getByTestId('txr-models-downloads')).toBeVisible()
    await expect(page.getByTestId('txr-models-download-ps-5')).toBeVisible()
    await expect(page.getByTestId('txr-models-download-ps-5-bytes')).toHaveText(
      'downloading · 1.2 MB of 4.4 MB',
    )
    await expect(page.getByTestId('txr-models-download-ps-5-pct')).toHaveText('27%')

    // ── Run while a selected card downloads: refused, never created ──
    await page.getByTestId('txr-list-run').click()
    await expect(page.getByTestId('txr-models-d-run-error')).toHaveText(GATE_DOWNLOADING_LINE)
    await expect(page.getByTestId('txr-models-run-result')).toHaveText('run not fired yet')

    // ── Model card from the row action (the paper is TEXT, never a link) ──
    await page.getByTestId(`txr-list-row-${PS_ROW(1)}-action`).click()
    await expect(page.getByTestId('txr-models-card-ps-1')).toBeVisible()
    await expect(page.getByTestId('txr-models-card-body')).toContainText('Fixture Paper 1, 2023')
    // The fixture family's licence for ps-1 is 'Apache-2.0' (INV-8: one of
    // the fixture strings; the card's Licence line renders card.licence).
    await expect(page.getByTestId('txr-models-card-body')).toContainText('Apache-2.0')
    await expect(page.getByTestId('txr-models-card-body')).toContainText(RESEARCH_NOTICE)
    await expect(page.getByTestId('txr-models-card-body').locator('a')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('txr-models-card-ps-1')).toHaveCount(0)

    // ── uncheck the downloading card, Run → the recorded payload + nav ──
    await page.getByTestId(`txr-list-checkbox-${PS_ROW(5)}`).click()
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('3 models selected')
    await page.getByTestId('txr-list-run').click()
    await expect(page.getByTestId('txr-models-run-result')).toBeVisible()
    const resultText = await page.getByTestId('txr-models-run-result').textContent()
    const result = JSON.parse(resultText ?? '{}') as {
      path: string
      body: { mode?: string; model_ids?: unknown[]; config?: Record<string, unknown> }
    }
    expect(result.path).toBe('/analysis/run-d/running')
    expect(result.body.mode).toBe('reuse')
    expect(result.body.model_ids, `run payload (${resultText})`).toHaveLength(4)
    expect(result.body.config?.endpoint).toBe('pfs')
    expect(result.body.config?.look_ahead_day).toBe(240)
    await expect(page.getByTestId('txr-models-d-run-landed')).toBeVisible()
  })
})

test.describe('txr-models-d-narrow-390 — the board at the mobile width (TEST-MOD-18)', () => {
  test('no horizontal overflow, Run on-screen at 390 px', async ({ page }) => {
    await page.goto(`${GALLERY}txr-models-d-narrow-390`)

    await expect(page.getByTestId('txr-models-d')).toBeVisible()
    await expect(page.getByTestId(`txr-list-row-${PS_ROW(1)}`)).toBeVisible()

    // ── no horizontal page overflow (the entry-list measured pattern) ──
    const pageOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(pageOverflow, 'page horizontal overflow px').toBeLessThanOrEqual(1)

    // ── the bottom-bar Run stays on the screen: reachable, inside the width ──
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

test.describe('txr-models-i — choose the saved models (TEST-MOD-18)', () => {
  test('two run sections, section select-all, same-outcome chip, search, sort', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-models-i`)

    await expect(page.getByTestId('txr-models-i')).toBeVisible()
    await expect(page.getByTestId('txr-list')).toBeVisible()
    await expect(page.getByTestId(`txr-list-row-${FM(1)}`)).toBeVisible()

    // ── the header (the fixture's 10-model family) ──
    await expect(page.getByTestId('txr-models-i-checked')).toHaveText(I_CHECKED_LINE)
    // ITEM-5 (RES-22): ONE accounting — "can run" is what can START (the
    // 5 fit + 3 some verdicts), so the sentence agrees with the "Can run
    // 8" chip; the old line read "5 can run … 3 partly" next to the chip.
    await expect(page.getByTestId('txr-models-i-totals')).toHaveText(
      '10 saved models shown · 8 can run, 2 cannot (3 of them for some patients)',
    )

    // ── the two run sections with their facts lines + actions ──
    const setA = page.getByTestId('txr-list-section-set-a')
    await expect(setA).toContainText('CRC cohort, day 60')
    await expect(setA).toContainText(
      'trained 29 Nov on patients.csv · 42 patients · 7 models · progression, death by day 240',
    )
    const setB = page.getByTestId('txr-list-section-set-b')
    await expect(setB).toContainText('Lung pilot, day 35')
    await expect(setB).toContainText(
      'trained 9 Oct on lung-pilot.csv · 42 patients · 3 models · death by day 165',
    )
    await expect(page.getByTestId('txr-list-section-action-set-a-rename')).toHaveText('Rename')
    await expect(page.getByTestId('txr-list-section-action-set-a-delete')).toHaveText(
      "Delete the run's models",
    )

    // ── a row's board bytes (the DEC-13 subtitle + Trained-by-you chip) ──
    const row = await page.getByTestId(`txr-list-row-${FM(1)}`).textContent()
    for (const needle of [
      'fm-1',
      'decision day 60',
      'Trained by you',
      'own data, cross-checked: AUC 0.71',
      'Can run',
      'Details',
    ]) {
      expect(row, `row fm-1 must carry ${needle!}`).toContain(needle!)
    }

    // ── built-ins + the same-outcome chip count (pfs + day 240: six rows) ──
    await expect(page.getByTestId('txr-list-filter-all')).toHaveText('All 10')
    await expect(page.getByTestId('txr-list-filter-can-run')).toHaveText('Can run 8')
    await expect(page.getByTestId('txr-list-filter-same-outcome')).toHaveText(
      'Same outcome as my file 6',
    )

    // ── section select-all: exactly the section's eligible rows ──
    await page.getByTestId('txr-list-section-select-all-set-a').click()
    await expect(page.getByTestId('txr-list-selected-count')).toHaveText('5 models selected')
    for (const key of [FM(3), FM(7)]) {
      await expect(page.getByTestId(`txr-list-checkbox-${key}`)).toHaveAttribute(
        'data-disabled',
        '',
      )
      await expect(page.getByTestId(`txr-list-checkbox-${key}`)).toHaveAttribute(
        'aria-checked',
        'false',
      )
    }
    await expect(page.getByTestId(`txr-list-checkbox-${FM(8)}`)).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // ── the same-outcome chip narrows to the matching endpoint/horizon ──
    await page.getByTestId('txr-list-filter-same-outcome').click()
    await expect(page.getByTestId(`txr-list-row-${FM(8)}`)).toHaveCount(0)
    await expect(page.getByTestId('txr-list-section-set-b')).toHaveCount(0)
    await expect(page.getByTestId(`txr-list-row-${FM(1)}`)).toBeVisible()
    await page.getByTestId('txr-list-filter-same-outcome').click()

    // ── find-a-model-or-run search (the run's text is searched too) ──
    await page.getByTestId('txr-list-search').fill('lung')
    await expect(page.getByTestId(`txr-list-row-${FM(8)}`)).toBeVisible()
    await expect(page.getByTestId(`txr-list-row-${FM(1)}`)).toHaveCount(0)
    await page.getByTestId('txr-list-search').fill('')
    await expect(page.getByTestId(`txr-list-row-${FM(1)}`)).toBeVisible()

    // ── the sort flip: newest-run order vs patients-covered order ──
    expect(await yOf(page.getByTestId(`txr-list-row-${FM(3)}`))).toBeLessThan(
      await yOf(page.getByTestId(`txr-list-row-${FM(5)}`)),
    )
    await page.getByTestId('txr-list-sort').click()
    await page.getByRole('option', { name: 'Patients covered' }).click()
    await expect
      .poll(async () => {
        const a = await yOf(page.getByTestId(`txr-list-row-${FM(5)}`))
        const b = await yOf(page.getByTestId(`txr-list-row-${FM(3)}`))
        return a - b
      })
      .toBeLessThan(0)
  })
})

test.describe('txr-models-j — your models (TEST-MOD-18)', () => {
  test('the inventory table, the imported row, the footnotes, web-mode open-folder', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-models-j`)

    await expect(page.getByTestId('txr-models-j')).toBeVisible()
    await expect(page.getByTestId('txr-models-j-table')).toBeVisible()

    // ── the board columns + a run-trained row's subline ──
    const header = await page.getByTestId('txr-models-j-table').locator('thead').textContent()
    for (const column of ['Model', 'Method', 'Predicts', 'Decision day', 'Trained on', 'Made']) {
      expect(header, `column ${column}`).toContain(column)
    }
    const runRow = await page.getByTestId(`txr-models-row-${FM(11)}`).textContent()
    for (const needle of ['CRC cohort, day 60', '6 markers · uses age', 'landmark-cox-current', 'progression, death by day 240', '42 patients']) {
      expect(runRow, `row fm-11 must carry ${needle!}`).toContain(needle!)
    }

    // ── the imported row: the board's verb (never a fabricated training) ──
    const importedRow = await page.getByTestId(`txr-models-row-${FM(13)}`).textContent()
    for (const needle of [
      'From a colleague: colon panel',
      'opened from colleague-panel.txr · 5 markers',
      'not recorded',
      'opened 4 Dec 2026',
    ]) {
      expect(importedRow, `imported row must carry ${needle!}`).toContain(needle!)
    }

    // ── the footnotes: the REAL models root, no open-folder in web mode ──
    await expect(page.getByTestId('txr-models-j-models-path')).toHaveText(
      '/home/txr-fixture/models',
    )
    await expect(page.getByTestId('txr-models-j')).toContainText(
      'Deleting a model removes its file. Results already made with it are kept in History.',
    )
    await expect(page.getByTestId('txr-models-open-folder')).toHaveCount(0)

    // ── ITEM-5 growth (RES-19/RES-17): the kind's word, never "0 markers",
    //    and the set segment distinguishing same-named rows ──
    const anyRow = await page.getByTestId(`txr-models-row-${FM(16)}`).textContent()
    expect(anyRow).toContain('any marker')
    const sameNameRow = await page.getByTestId(`txr-models-row-${FM(15)}`).textContent()
    expect(sameNameRow).toContain("6 markers · uses age · from the set 'Second run, day 60'")
  })

  test('the 390 px story has no horizontal page overflow and the import affordance stays inside', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-models-j-narrow-390`)
    await expect(page.getByTestId('txr-models-j')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    const importButton = await page.getByTestId('txr-models-import').boundingBox()
    expect(importButton).not.toBeNull()
    expect(importButton!.x + importButton!.width).toBeLessThanOrEqual(390)
  })
})

test.describe('txr-models-l — the save-set dialog (TEST-MOD-19)', () => {
  test('the EventBus-driven dialog over the results board: checklist, warning, save → L3, navigation', async ({
    page,
  }) => {
    await page.goto(`${GALLERY}txr-models-l`)

    // The results board (the fixture run's G state) is the backdrop.
    await expect(page.getByTestId('txr-models-open-l')).toBeVisible()
    await page.getByTestId('txr-models-open-l').click()

    // ── the dialog opens over the board (no navigation, no stack) ──
    await expect(page.getByTestId('txr-models-save')).toBeVisible()
    await expect(page.getByTestId('txr-models-landed')).toHaveCount(0)

    // ── the run-facts headline + the count line (fixture numbers) ──
    await expect(page.getByTestId('txr-models-save-made-from')).toContainText(
      'Made from patients.csv, 42 patients, decision day 60',
    )
    await expect(page.getByTestId('txr-models-save-count')).toHaveText(
      '7 of 7 selected · about 27 MB',
    )

    // ── the checklist rows: ids + group labels + sizes ──
    const checklist = page.getByTestId('txr-models-save-list')
    await expect(checklist).toContainText('rm-1')
    await expect(checklist).toContainText('Response probability')
    await expect(checklist).toContainText('0.8 MB')
    await expect(checklist).toContainText('Dynamic risk')
    await expect(checklist).toContainText('Static risk')

    // ── the cannot-run note (D15) + the training-data warning ──
    await expect(page.getByTestId('txr-models-save-cannot-run')).toContainText(
      'rm-8 could not run, so it has no model to save.',
    )
    await expect(page.getByTestId('txr-models-save-warning')).toContainText(
      '2 models (rm-4, rm-5) keep parts of the training data inside them.',
    )

    // ── the new-set name (the save body's target arm) ──
    await page.getByTestId('txr-models-save-name').fill('My fixture set')

    // ── Select none / Only the small ones drive the count line ──
    await page.getByTestId('txr-models-save-only-small').click()
    await expect(page.getByTestId('txr-models-save-count')).toHaveText(
      '5 of 7 selected · about 9.3 MB',
    )
    await page.getByTestId('txr-models-save-select-none').click()
    await expect(page.getByTestId('txr-models-save-count')).toHaveText('0 of 7 selected')
    await page.getByTestId('txr-models-save-only-small').click()

    // ── Save posts the PROV-MS-3 body (read through the story seam) and
    //    the L3 confirmation replaces the dialog ──
    await page.getByTestId('txr-models-save-confirm').click()
    await expect(page.getByTestId('txr-models-request-seam')).toContainText('"saveModels"')
    const seam = JSON.parse(
      (await page.getByTestId('txr-models-request-seam').textContent()) ?? '[]',
    ) as Array<{ op: string; body: Record<string, unknown> }>
    const save = seam.find(entry => entry.op === 'saveModels')
    expect(save, 'the save request must be recorded').toBeDefined()
    expect(save!.body.run_id).toBe('run-c')
    expect(save!.body.target).toEqual({ set_name: 'My fixture set' })

    await expect(page.getByTestId('txr-models-saved')).toBeVisible()
    await expect(page.getByTestId('txr-models-saved-summary')).toContainText(
      'in /home/txr-fixture/models',
    )

    // ── "See my models" navigates to the models path (in-frame) ──
    await page.getByTestId('txr-models-saved-see-models').click()
    await expect(page.getByTestId('txr-models-landed')).toContainText('/models')
  })
})

test.describe('txr-models-l2 — the save-one dialog (TEST-MOD-19)', () => {
  test('set select, the new-set name hiding, the one-model body', async ({ page }) => {
    await page.goto(`${GALLERY}txr-models-l2`)

    await expect(page.getByTestId('txr-models-open-l2')).toBeVisible()
    await page.getByTestId('txr-models-open-l2').click()

    await expect(page.getByTestId('txr-models-saveone')).toBeVisible()
    await expect(page.getByTestId('txr-models-saveone-summary')).toContainText(
      'rm-2 · 2.3 MB · learned from 42 patients, decision day 60',
    )

    // ── the set select: "A new set" first + the two fixture sets' counts ──
    const select = page.getByTestId('txr-models-saveone-set-select')
    await select.click()
    for (const option of [
      'A new set',
      'CRC cohort, day 60 (7 models already saved)',
      'Lung pilot, day 35 (3 models already saved)',
    ]) {
      await expect(page.getByRole('option', { name: option })).toBeVisible()
    }
    await page.getByRole('option', { name: 'A new set' }).click()
    // The default is "A new set": the name field is visible for the
    // new-set case and hides when an existing set is chosen.
    await expect(page.getByTestId('txr-models-saveone-name')).toBeVisible()
    await select.click()
    await page.getByRole('option', { name: 'CRC cohort, day 60 (7 models already saved)' }).click()
    await expect(page.getByTestId('txr-models-saveone-name')).toHaveCount(0)

    // ── Save posts the one-model body with the existing-set target ──
    await page.getByTestId('txr-models-saveone-confirm').click()
    await expect(page.getByTestId('txr-models-request-seam')).toContainText('"saveModels"')
    const seam = JSON.parse(
      (await page.getByTestId('txr-models-request-seam').textContent()) ?? '[]',
    ) as Array<{ body: Record<string, unknown> }>
    expect(seam[seam.length - 1]!.body.target).toEqual({ set_id: 'set-a' })
  })
})
