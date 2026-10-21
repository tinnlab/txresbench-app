// fusion.spec.ts — dimension-membership TEST-41 (ITEM-32).
//
// Against the REAL backend, over real HTTP, reading REAL seeded artifacts. No route mocking.
//
// ── SAME NAME IS NOT SAME COLUMN — THE VOCABULARY DECIDES ─────────────────────────────────────
//
// Two datasets that rest on one entity axis can each carry a column of the same NAME. Whether §
// Colour by offers them as ONE thing to colour by or as TWO is not a question about the name — it
// is a question about the VOCABULARIES (`vocabFusion.ts`): reconcilable ⇒ one offer that names
// BOTH datasets; conflicting ⇒ two offers, because fusing them would build a legend whose levels
// are two datasets' and mean different things.
//
// ── BOTH ARMS IN ONE SPEC (the shape TESTS.md pins) ──────────────────────────────────────────
//
// A fusion-ALWAYS implementation passes the reconcilable arm and fails the conflicting one; a
// fusion-NEVER implementation does the reverse. So the two arms are asserted here as a pair, over
// fixtures that differ in exactly one field — the second dataset's declared level set — which is
// what makes any difference between them attributable to the vocabulary and to nothing else.

import { expect, test, type Page } from '@playwright/test'

import { createProject } from '../14-workbench/_dock'
import { loginAsOwner } from '../project/_helpers'
import { capture } from './_capture'
import { FUSION, openVisualize, SECTIONS, seedFusionPair } from './_visualize'

const coordinates = (page: Page) => page.locator(`[data-section-id="${SECTIONS.coordinates}"]`)
const colourBy = (page: Page) => page.locator(`[data-section-id="${SECTIONS.colourBy}"]`)

/** Pick the fusion coordinate — never `.first()`, the section may split per dataset. */
async function pickFusionCoordinate(page: Page): Promise<void> {
  const option = coordinates(page).getByRole('radio', { name: new RegExp(FUSION.coordinate, 'i') })
  await expect(option, `§ Coordinates offered no set named "${FUSION.coordinate}"`).toHaveCount(1, { timeout: 60_000 })
  await option.click()
  await expect(option).toBeChecked({ timeout: 30_000 })
}

/** How many § Colour by rows offer the shared column NAME — the whole assertion turns on this
 *  being 1 when the vocabularies reconcile and 2 when they conflict. */
function offersOfSharedColumn(page: Page) {
  return colourBy(page).getByRole('button', { name: `Plot ${FUSION.column}`, exact: true })
}

test.describe('§ two same-named columns fuse only when their vocabularies reconcile', () => {
  test('TEST-41 — reconcilable vocabularies are ONE offer naming both datasets; conflicting ones are TWO', async ({
    page,
    request,
  }) => {
    // ── ARM 1: RECONCILABLE ⇒ ONE OFFER, NAMING BOTH DATASETS ────────────────────────────
    const fused = await createProject(request, `fusion-reconcilable ${Date.now()}`)
    await seedFusionPair(request, fused, true)
    await loginAsOwner(page)
    await openVisualize(page, fused)
    await pickFusionCoordinate(page)

    // ONE offer for the shared name — the two same-named columns from the two datasets merged.
    // With two identical-vocabulary columns present, a fusion-NEVER implementation would list TWO
    // "Plot group label" rows here; that it lists exactly ONE is the merge. (The provenance that the
    // fused offer SPANS both datasets — its `datasets` field — is pinned at the unit tier by TEST-40;
    // "2 datasets" in the section chrome is the PROJECT's dataset count and appears either way, so it
    // is not used as the discriminator here.)
    await expect(
      offersOfSharedColumn(page),
      'the two same-named columns with identical vocabularies did not fuse into ONE offer',
    ).toHaveCount(1, { timeout: 60_000 })

    await capture(test.info(), colourBy(page), 'fusion-reconcilable-one-offer.png')

    // ── ARM 2: CONFLICTING ⇒ TWO OFFERS ──────────────────────────────────────────────────
    //
    // A fresh project, identical but for the second dataset's level set. If the first arm passed
    // by fusing everything, this one catches it; if it passed by never fusing, the first arm caught
    // that. One spec, both directions.
    const split = await createProject(request, `fusion-conflicting ${Date.now()}`)
    await seedFusionPair(request, split, false)
    await openVisualize(page, split)
    await pickFusionCoordinate(page)

    await expect(
      offersOfSharedColumn(page),
      'two columns with DISJOINT vocabularies were fused into one offer — a legend whose levels are ' +
        'two datasets’ and mean different things',
    ).toHaveCount(2, { timeout: 60_000 })

    await capture(test.info(), colourBy(page), 'fusion-conflicting-two-offers.png')
  })
})
