import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'

// TEST-519 (ITEM-55) — `placeViews(area)` is wired for ALL dock areas, not only bottom.
// The built-in shell surfaces are registered as `center`/`left` views, and extensions can
// contribute into any area. This asserts the achievable browser proof: the
// `window.__workbench.placeViews` seam routes views per AREA. NEEDS the real backend.
//
// ITEM-9 deleted the RIGHT shell view (`workbench.selection`) and ITEM-33 the LEFT one
// (`workbench.visualize`, the field-provider rail), so `left` AND `right` are the
// EMPTY-area cases: the seam still answers for each, with no shell view placed. That is the
// honest post-deletion contract (DEC-H: the areas are vacant, not backfilled) — the AREAS
// stay open to any extension (a contributed `left`/`right` view still reconciles into its
// region as its own `view` pane), and no shell view is backfilled into them.
//
// ── WHY THE SECOND HALF OF THIS SPEC WAS REWRITTEN (visualize-pane ITEM-5) ────────────────
//
// It used to end by waiting for `workbench-area-left-empty` — `PlacedArea`'s empty state,
// on the theory that the LEFT REGION's body IS a placed area with nothing placed in it.
// That node can no longer render: the left region's pane kind is `visualize`, and ITEM-5
// moved it off `PlacedArea` onto `SectionStack`. Nothing renders `PlacedArea area="left"`
// on either shell (desktop `panes.tsx` routes `visualize` → `SectionStack`; `MobileShell`
// branches the left sheet to the same component), so the assertion was structurally
// unreachable — this branch broke it and owed it a replacement, not a deletion.
//
// So: what does the LEFT REGION'S EMPTINESS MEAN now that SECTIONS own it?
//
// It means "no SECTION applies to this project's data" — a different sentence from "no VIEW
// is placed in this area", and said by a different owner. A section is not a view (INV-12):
// it is never placed, reconciled, automounted or area-checked; it is selected by its
// `applies_to` against what the project actually holds. A bare project holds no
// `plottable-xy` artifact and no `metadata-column`, so all three shipped sections are
// unavailable and the stack says so itself. That is the node this spec now waits for.
//
// The negative is asserted too — `workbench-area-left-empty` must be absent from the whole
// document — because "the section stack rendered" alone would still pass if a second host
// for the left AREA came back beside it (which is exactly the duplicate-host bug that
// retired the `selection` pane). And the negative is paired with a POSITIVE CONTROL (the
// centre hero's placed area DID render): an absence assertion passes vacuously on a shell
// that never mounted, and "left is not a placed area" has to mean "sections own it", not
// "nothing loaded".

test.describe('placeViews wires every dock area (ITEM-55)', () => {
  test('views reach center / left / right — and the left REGION is a section stack, not a placed area', async ({
    page,
    request,
  }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB Areas ${Date.now()}`)
    await openWorkbench(page, id)

    // The read-only placement seam routes the built-in surfaces to their areas.
    const placed = await page.evaluate(() => {
      const wb = (window as unknown as {
        __workbench?: { placeViews: (area: string, ctx: unknown) => string[] }
      }).__workbench
      const ctx = { producedTypeIds: [] }
      return {
        center: wb?.placeViews('center', ctx) ?? [],
        left: wb?.placeViews('left', ctx) ?? [],
        right: wb?.placeViews('right', ctx) ?? [],
      }
    })
    expect(placed.center).toContain('workbench.canvas')
    // Left + right answer (the seam is wired for both) but hold no SHELL view any more.
    expect(Array.isArray(placed.left)).toBe(true)
    expect(placed.left).not.toContain('workbench.visualize')
    expect(placed.right).not.toContain('workbench.selection')

    // POSITIVE CONTROL — the centre hero IS a placed area, and it rendered from that
    // placement. This is what makes the two assertions below mean "the left region is a
    // different kind of thing" rather than "the shell never painted".
    await expect(page.locator('[data-testid^="workbench-area-center"]').first()).toBeVisible({
      timeout: 20_000,
    })

    // The LEFT REGION. Its pane is the default `visualize` leaf; select it if the shell
    // rendered region tabs (desktop), then read what its body says about being empty.
    const tab = page.getByTestId('region-tab-p-visualize')
    if (await tab.count()) await tab.click().catch(() => {})

    // EMPTINESS, IN THE SECTION VOCABULARY: this project holds no `plottable-xy` and no
    // `metadata-column` artifact, so none of the three shipped sections applies, and the
    // stack renders its own empty state — "No sections apply to this project's data".
    await expect(page.getByTestId('section-stack-visualize-empty').first()).toBeVisible({
      timeout: 30_000,
    })

    // …and the placed-area empty state is nowhere in the document. `PlacedArea area="left"`
    // has no render site left; a node with this testid means a second host for the left
    // area came back.
    await expect(page.getByTestId('workbench-area-left-empty')).toHaveCount(0)
  })
})
