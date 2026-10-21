import { test, expect } from '@playwright/test'
import { openStory, canvasNonBlank, trackErrors, vizTest } from './_helpers'

// SESSION-STATE PRODUCTION GLUE: the consolidated `<Viz option onChange>` props (ITEM-5) + the
// restore-after-`setOption(replace)` path, exercised on a REAL `<Viz>` mount (not a hand-wired store
// round-trip). Mutate through the controller → the debounced `onChange` captures a `VizOption`
// (via getOption) → REMOUNT `<Viz>` with that option as `option={saved}` (models the app re-fetching
// the data by id) → the selection + color override come back after the fresh mount's
// `setOption(replace)` resolves. This is the full production path for `<Viz>`-driven save/restore.
test('session-state glue: <Viz option/onChange> restores selection + override after remount', async ({
  page,
}) => {
  // A 60k-point deck + async owned-data pull + a full `<Viz>` REMOUNT (a second setOption + restore)
  // under headless swiftshader are slow — give this surface the same wide budget as data-ownership.
  test.setTimeout(120_000)
  const bag = trackErrors(page)
  await openStory(page, 'session-state-viz-glue')

  // The story + the workspace mount, and the deck renders non-blank from the self-pulled buffers.
  await expect(page.getByTestId('viz-session-state-glue')).toBeVisible()
  await expect(page.getByTestId('viz-grid-workspace')).toBeVisible()
  await expect
    .poll(async () => canvasNonBlank(page, 0), {
      message: 'deck renders non-blank from the owned buffers',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  // Baseline — nothing selected, no override.
  expect(await vizTest<number>(page, 'glueSelLen')).toBe(0)
  expect(await vizTest<string | null>(page, 'glueOverride')).toBeNull()

  // MUTATE through the controller (select) + the override store — the debounced `onStateChange`
  // then captures a snapshot.
  await page.getByTestId('viz-glue-mutate').click()
  await expect
    .poll(async () => vizTest<number>(page, 'glueSelLen'), {
      message: 'controller.select published the 5-id selection',
    })
    .toBe(5)
  expect(await vizTest<string | null>(page, 'glueOverride')).toBe('#ff0000')

  // `onChange` is DEBOUNCED (~150ms) AND fires an EMPTY option on the initial setOption, so
  // "an option exists" is not enough — POLL until the CAPTURED option actually holds the 5-id
  // selection, else the reload would restore a stale pre-mutation (empty) option.
  await expect
    .poll(async () => vizTest<number>(page, 'glueOptionSelLen'), {
      message: 'the debounced onChange captured an option holding the 5-id selection',
      timeout: 5_000,
    })
    .toBe(5)

  // RELOAD: remount `<Viz>` with the captured option as `option={saved}`.
  const mountBefore = await vizTest<number>(page, 'glueMountKey')
  await page.getByTestId('viz-glue-reload').click()
  await expect
    .poll(async () => vizTest<number>(page, 'glueMountKey'), {
      message: 'clicking reload bumped the mount key (a fresh <Viz> mounted)',
    })
    .toBeGreaterThan(mountBefore)

  // THE KEY ASSERTION — after the fresh `<Viz>` mount, its `setOption` clears the selection, then
  // the restore-after-setOption path re-hydrates the selection + override from the passed `option`.
  // This proves the production restore path on a REAL `<Viz>` mount (not a hand-wired store write).
  await expect
    .poll(async () => vizTest<number>(page, 'glueSelLen'), {
      message: 'the passed option restored the 5-id selection after the remount setOption',
      timeout: 30_000,
    })
    .toBe(5)
  expect(await vizTest<string | null>(page, 'glueOverride')).toBe('#ff0000')

  // The remounted deck renders non-blank again (the restore did not blank the grid).
  await expect
    .poll(async () => canvasNonBlank(page, 0), {
      message: 'the remounted <Viz> renders non-blank content',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
