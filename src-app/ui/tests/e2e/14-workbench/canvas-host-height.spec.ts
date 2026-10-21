import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'
import { createProject, openWorkbench } from './_dock'

// Regression guard for bug 1 of 61c90f88 ("canvas height"): `ViewHost`'s `chrome={false}` body
// wrapper is `flex flex-col min-h-0 flex-1 overflow-auto`. Before the fix it was a plain BLOCK
// (`min-h-0 flex-1 overflow-auto`), so `CanvasView`'s root — `flex min-h-0 flex-1 …` — had an
// inert `flex-1` (a flex property is only honoured by a FLEX parent) and collapsed to its own
// content height. The deck canvas then had no box to paint into.
//
// ⚠ A `height > 0` assertion ALONE is a FALSE GREEN. On a fresh project `CanvasView` renders its
// `Empty` state, which has intrinsic content height — so the host measures non-zero even with the
// broken BLOCK parent. This spec therefore asserts the two things that actually distinguish the
// two layouts:
//   (1) STRUCTURAL — the host's parent computes `display: flex` + `flex-direction: column`.
//   (2) BEHAVIOURAL — the host FILLS that parent (height ≈ parent's height), which is exactly what
//       collapses to the Empty's intrinsic height under the broken block parent.
//
// DOM chain asserted (RegionShell → PaneBody → `canvas` renderer → PlacedArea → ViewHost):
//   region-pane-body-<id>  →  workbench-area-center  →  <section>  →  ViewHost body div
//     →  workbench-canvas-host
// NEEDS the real backend.

test.describe('center canvas host fills its ViewHost parent (61c90f88 bug 1)', () => {
  test('canvas host parent is a flex column and the host fills it', async ({ page, request }) => {
    await loginAsOwner(page)
    const id = await createProject(request, `WB CanvasH ${Date.now()}`)
    await openWorkbench(page, id)

    const host = page.getByTestId('workbench-canvas-host').first()
    await expect(host).toBeVisible({ timeout: 20_000 })
    // Fresh project → the honest empty state (this is the state whose intrinsic height would mask
    // a height-only check — hence the structural + fill assertions below).
    await expect(page.getByTestId('workbench-canvas-empty').first()).toBeVisible()

    const box = await host.evaluate(el => {
      const parent = el.parentElement
      if (!parent) throw new Error('canvas host has no parent element')
      const ps = getComputedStyle(parent)
      const hs = getComputedStyle(el)
      return {
        parentDisplay: ps.display,
        parentDirection: ps.flexDirection,
        parentHeight: parent.getBoundingClientRect().height,
        hostGrow: hs.flexGrow,
        hostHeight: el.getBoundingClientRect().height,
      }
    })

    // (1) STRUCTURAL — the parent must be a flex COLUMN, otherwise the host's `flex-1` is inert.
    expect(box.parentDisplay).toBe('flex')
    expect(box.parentDirection).toBe('column')
    // The host declares itself growable; combined with (1) that is what makes it fill.
    expect(Number(box.hostGrow)).toBeGreaterThan(0)

    // (2) BEHAVIOURAL — the host actually fills the parent's box rather than shrinking to the
    // Empty's intrinsic content height. Sanity-check the parent has real height first, so a
    // 0-vs-0 comparison can never pass this vacuously.
    expect(box.parentHeight).toBeGreaterThan(120)
    expect(box.hostHeight).toBeGreaterThan(120)
    expect(box.hostHeight).toBeGreaterThanOrEqual(box.parentHeight - 2)
  })
})
