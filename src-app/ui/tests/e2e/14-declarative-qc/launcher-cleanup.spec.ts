import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from '../14-workbench/_dock'

// TEST-21 (ITEM-16 / DEC-4) — the analysis launcher lists ONLY real, user-launchable
// analyses. Registration is untouched: a hidden analysis stays resolvable by id (DEC-7);
// only the user-facing list drops it, at the pure `launcherVisibleAnalyses` choke point.
//
// ── REWRITTEN: five of this spec's assertions could not fail ─────────────────────────
// It asserted `toHaveCount(0)` on `workbench-launcher-row-demo.{leiden,dependent,picker,
// stepped,conditional}`. NOTHING in the repo registers those ids: no shipped
// `packages/*/manifest.yaml` declares a `demo.*` analysis, and `demo.leiden` exists
// only in `src/modules/workbench/core/__testutil__/demoExtension.ts` — a unit-test util
// the app never imports (`discoverBuiltins` globs `./extensions/*/extension.ts`, which
// matches zero modules). Four of the five ids (`demo.dependent`/`picker`/`stepped`/
// `conditional`) do not exist ANYWHERE. Deleting `isLauncherVisible` outright would not
// have moved one of them, so they asserted nothing and are gone.
//
// Replaced by an assertion the filter can actually fail: the DELTA between what is
// REGISTERED (`window.__workbenchRegistry.analyses()`) and what the launcher LISTS. Each
// id asserted absent is first required to BE registered — so a rename/deletion fails this
// spec loudly instead of turning its absence assertion into another free pass — and the
// delta is required to be non-empty, so replacing `isLauncherVisible` with `() => true`
// turns this red. NEEDS NO SEEDED DATA.
//
// (This block used to say the `launchable: false` half of `isLauncherVisible` had no
// shipped instance to drive from an e2e, and that nothing in `packages/*/manifest.yaml`
// set it. Both halves are now false: a shipped preflight declares it PERMANENTLY, and the
// hidden set below is DERIVED from the manifests, so this spec drives BOTH hiding reasons
// over real shipped declarations. `launcherAvailability.test.ts` still covers the
// predicate itself.)

/** REGISTERED (resolvable by id, runnable on ingest or by another form) but never offered
 *  in the launcher — DERIVED from the shipped manifests, one entry per reason
 *  `isLauncherVisible` hides a row.
 *
 *  It was a hand-written list of two ids, and by the time anyone looked it was missing two
 *  more — which is the ordinary fate of a spelled list beside a growing tree, and it is why
 *  the delta assertion below had quietly become a claim nobody could satisfy. Deriving it
 *  keeps the cross-check real (the app's RUNTIME registry + DOM on one side, the DATA
 *  manifests on the other) while surviving a rename, where a spelled id finds nothing and
 *  reports success.
 *
 *  One id moved OUT of this set rather than in: the dataset-integration analysis declared
 *  `launchable: false` while its form was a placeholder, kept the line after the real form
 *  landed, and was therefore unreachable by a person. It is now listed. */
function launcherHidden(): { ids: string[]; onIngest: string[]; optedOut: string[] } {
  const root = fileURLToPath(new URL('../../../../packages', import.meta.url))
  const onIngest: string[] = []
  const optedOut: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = `${root}/${entry.name}/manifest.yaml`
    if (!existsSync(file)) continue
    const manifest = parseYaml(readFileSync(file, 'utf8')) as {
      contributes?: { analyses?: Array<{ id?: string; trigger?: string; launchable?: boolean }> }
    }
    for (const a of manifest.contributes?.analyses ?? []) {
      if (typeof a?.id !== 'string') continue
      if (a.trigger === 'on-ingest') onIngest.push(a.id)
      else if (a.launchable === false) optedOut.push(a.id)
    }
  }
  return { ids: [...onIngest, ...optedOut], onIngest, optedOut }
}

const HIDDEN = launcherHidden()
const LAUNCHER_HIDDEN = HIDDEN.ids

const LAUNCHER_LISTED = ['qc.10x', 'cell.filter', 'cellranger.count'] as const

test.describe('analysis launcher cleanup — real analyses only (ITEM-16)', () => {
  test('lists the real analyses; hides the registered-but-not-launchable ones', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `Launcher Cleanup ${Date.now()}`)
    await openWorkbench(page, id)

    // The launcher pane is open by default — wait for its rows to render.
    await page
      .locator('[data-testid^="workbench-launcher-row-"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })

    // ── POSITIVE: the real, user-launchable analyses ARE listed. ──────────────────────
    for (const listed of LAUNCHER_LISTED) {
      await expect(page.getByTestId(`workbench-launcher-row-${listed}`)).toBeVisible()
    }

    // ── NON-VACUITY PRECONDITION for every negative below ─────────────────────────────
    // Read the REGISTERED analysis ids off the read-only registry seam. An id that is not
    // registered cannot meaningfully be "hidden from the launcher" — asserting its
    // absence would be exactly the defect this rewrite removes.
    const registered = await page.evaluate(() => {
      const reg = (window as unknown as { __workbenchRegistry?: { analyses: () => string[] } })
        .__workbenchRegistry
      return reg?.analyses() ?? []
    })
    expect(registered.length, 'the registry seam is installed and non-empty').toBeGreaterThan(0)
    // A DERIVED set can go empty, or collapse onto ONE reason, and then every negative below
    // is a loop over nothing — the exact vacuum this spec was rewritten to remove, arriving
    // by a different door. Both reasons must be represented before either is asserted.
    expect(
      HIDDEN.onIngest.length,
      'no shipped manifest declares an on-ingest analysis, so the converter half of ' +
        '`isLauncherVisible` is asserted over an empty set',
    ).toBeGreaterThan(0)
    expect(
      HIDDEN.optedOut.length,
      'no shipped manifest declares `launchable: false`, so the opt-out half of ' +
        '`isLauncherVisible` is asserted over an empty set',
    ).toBeGreaterThan(0)
    for (const hidden of LAUNCHER_HIDDEN) {
      expect(
        registered,
        `${hidden} IS registered — so its absence from the launcher is a FILTER fact, ` +
          'not a "nothing by that name exists" fact',
      ).toContain(hidden)
    }

    // ── NEGATIVE: registered, but never offered in the launcher. ──────────────────────
    for (const hidden of LAUNCHER_HIDDEN) {
      await expect(page.getByTestId(`workbench-launcher-row-${hidden}`)).toHaveCount(0)
    }

    // ── POSITIVE CONTROL ON THE FILTER ITSELF ────────────────────────────────────────
    // The launcher's set must be a STRICT subset of the registered set. If
    // `isLauncherVisible` stopped filtering (or the launcher stopped calling it), the
    // delta collapses to empty and this fails — which none of the deleted `demo.*`
    // assertions would have caught.
    const listedIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="workbench-launcher-row-"]')].map(el =>
        (el.getAttribute('data-testid') as string).replace('workbench-launcher-row-', ''),
      ),
    )
    expect(listedIds.length, 'the launcher rendered rows').toBeGreaterThan(0)
    const delta = registered.filter(rid => !listedIds.includes(rid))
    expect(
      delta,
      'the launcher filter is doing work — some registered analyses are deliberately ' +
        'not offered',
    ).not.toHaveLength(0)
    expect(delta.sort(), 'the hidden set is exactly LAUNCHER_HIDDEN').toEqual(
      [...LAUNCHER_HIDDEN].sort(),
    )
    // …and nothing the launcher lists is unregistered (no phantom rows).
    expect(listedIds.filter(lid => !registered.includes(lid))).toEqual([])
  })
})
