import { test, expect } from '@playwright/test'
import { openStory, trackErrors, vizTest } from './_helpers'

// PROVES selection follows the canonical POINT ID across a permuted embedding (story
// `selection-by-point-id`). Three scatters read ONE shared coordination store:
//   • A — identity order (row r carries canonical id r); the seed button selects cluster 0 here.
//   • B — the SAME points as A, but a PERMUTATION of the row order AND a different embedding.
//   • C — a DISJOINT canonical point set (ids [N..2N-1]).
//
// The money assertion is `bSelectedMatchesA`: after seeding A, B must light up the EXACT SAME
// canonical points (by id), not the same array positions — an index-based sync would light B's
// WRONG rows, yielding a mismatch (false) and an unequal count. C shares no ids, so it lights
// nothing. Asserted purely on the story's `__VIZ_TEST__` hooks (a headless harness can't lasso).

test('selection follows point ID across a permuted embedding (id-based sync, not index-based)', async ({
  page,
}) => {
  // Three swiftshader deck.gl scatters (3000 points each) — a wide budget.
  test.setTimeout(180_000)
  const bag = trackErrors(page)
  await openStory(page, 'selection-by-point-id')

  await expect(page.getByTestId('viz-sel-by-id')).toBeVisible()
  await expect(page.getByTestId('viz-sel-by-id-a')).toBeVisible()
  await expect(page.getByTestId('viz-sel-by-id-b')).toBeVisible()
  await expect(page.getByTestId('viz-sel-by-id-c')).toBeVisible()

  // The shared selection starts empty.
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'selection starts empty' })
    .toBe(0)

  // ── Seed cluster 0 in A → the shared store gets its canonical point ids. ─────────────────
  await page.getByTestId('viz-sel-by-id-seed-a').click()

  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), {
      message: 'seeding A publishes canonical ids to the shared store',
    })
    .toBeGreaterThan(0)

  const aCount = await vizTest<number>(page, 'aSelectedCount')
  expect(aCount, 'A lit some points (cluster 0 ⊂ A)').toBeGreaterThan(0)

  // B has the SAME points as A (permuted order + different embedding) → the SAME count …
  await expect
    .poll(() => vizTest<number>(page, 'bSelectedCount'), {
      message: 'B lights the SAME number of points as A (same underlying set)',
    })
    .toBe(aCount)

  // … and — the correctness proof — the SAME points BY ID (an index-based sync would be false).
  await expect
    .poll(() => vizTest<boolean>(page, 'bSelectedMatchesA'), {
      message: 'B lights the SAME canonical points as A, by id (not by array position)',
    })
    .toBe(true)

  // C is a disjoint canonical point set → a selection never crosses point sets → nothing lit.
  await expect
    .poll(() => vizTest<number>(page, 'cSelectedCount'), {
      message: 'C (disjoint point set) lights nothing',
    })
    .toBe(0)

  // ── Clear resets the shared selection. ──────────────────────────────────────────────────
  await page.getByTestId('viz-sel-by-id-clear').click()
  await expect
    .poll(() => vizTest<number>(page, 'pointSelectionLength'), { message: 'Clear empties the selection' })
    .toBe(0)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
