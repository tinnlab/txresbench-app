import { test, expect } from '@playwright/test'
import { openStory, trackErrors } from './_helpers'

// declarative-capability.spec.ts — viz-followups Area B, TEST-6. The declarative chart
// CAPABILITIES (registry `ChartCapabilities`: consumesSelection / producesSelection / dataZoomAxes /
// linkableColorScale) are now ENFORCED end-to-end (parse.ts stamps the cell → CellView.ChartBody
// threads ChartViewProps → the Views gate consume/produce/dataZoom). This spec drives the real
// declarative path through the viz-showcase.
//
// The pure enforcement seam is fully covered in node by
// `libs/viz/src/viz-core/charts/capabilityEnforcement.test.ts` (TEST-5) + `option/parse.test.ts`
// (TEST-4). This browser spec is the E2E complement: it proves the SHARED SELECTION actually fans
// out (the mechanism a consuming pane dims on) — the POSITIVE CONTROL — and scaffolds the
// opt-out / axis-restriction visual assertions that need a dedicated capability story.

test.describe('declarative capability enforcement (Area B)', () => {
  // POSITIVE CONTROL (runs today): brushing a sibling publishes a shared selection that fans to the
  // linked panes. This is the exact selection a `consumesSelection:true` pane emphasises on — so if
  // this fans out but an `emphasis:{consumesSelection:false}` pane stays un-dimmed (the fixme below),
  // the opt-out is what suppressed the dim (not a dead selection).
  test('a sibling brush publishes a shared selection to the linked grid (positive control)', async ({
    page,
  }) => {
    const bag = trackErrors(page)
    await openStory(page, 'viz-option-declarative')
    await expect(page.getByTestId('viz-option-declarative')).toBeVisible()

    const selLen = () =>
      page.evaluate(
        () =>
          ((window as unknown as { __VIZ_TEST__?: Record<string, unknown> }).__VIZ_TEST__
            ?.optionSelectionLength as number | undefined) ?? 0,
      )

    // Before: no selection.
    expect(await selLen()).toBe(0)
    // Dispatch a selection ORIGINATING from the scatter (the same fan-out a lasso produces).
    await page.getByTestId('option-dispatch-select').click()
    await expect.poll(selLen, { timeout: 10_000, message: 'shared selection fans out' }).toBeGreaterThan(0)
    // Clearing it removes the shared selection (so a consuming pane un-dims again).
    await page.getByTestId('option-dispatch-clear').click()
    await expect.poll(selLen, { timeout: 10_000 }).toBe(0)

    expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
  })

  // SCAFFOLD (fixme until the backing capability story lands). The visual opt-out + axis-restriction
  // assertions need a dedicated `viz-capability-declarative` story that mounts (via
  // controller.setOption) a grid whose panes exercise the opt-outs, e.g.:
  //
  //   grid:    [{id:'g-brush'}, {id:'g-consume'}, {id:'g-optout'}, {id:'g-zoomx'}]
  //   series:  [
  //     { id:'s-brush',   type:'scatter', coordId:'g-brush',   select:{produces:true} },
  //     { id:'s-consume', type:'violin',  coordId:'g-consume' },                       // default: DIMS
  //     { id:'s-optout',  type:'violin',  coordId:'g-optout',  emphasis:{consumesSelection:false} }, // stays put
  //   ]
  //   // plus a bar/violin pane whose descriptor `dataZoomAxes` is overridden to ['x'] only.
  //
  // and exposes, on `window.__VIZ_TEST__`, per-pane observability the spec can assert WITHOUT
  // pixel-reading deck.gl: e.g. `capabilityConsumeDim` = { 'g-consume': <groupDimmed:boolean>,
  // 'g-optout': <groupDimmed:boolean> } (read off the View's computed emphasis), and
  // `capabilityZoomAxes['g-zoomx'] = ['x']` (the axes its ValueDataZoom actually renders a rail for).
  test.fixme(
    'an emphasis:{consumesSelection:false} pane stays un-dimmed while its sibling lights up',
    async ({ page }) => {
      await openStory(page, 'viz-capability-declarative')
      // Brush the producer pane.
      await page.getByTestId('capability-brush').click()
      const dim = (cell: string) =>
        page.evaluate(
          (c) =>
            (
              (window as unknown as { __VIZ_TEST__?: { capabilityConsumeDim?: Record<string, boolean> } })
                .__VIZ_TEST__?.capabilityConsumeDim ?? {}
            )[c] ?? false,
          cell,
        )
      // Positive control: the default (consumesSelection unset) pane DIMS a non-selected group.
      await expect.poll(() => dim('g-consume')).toBe(true)
      // The opt-out pane does NOT dim on the very same sibling selection.
      expect(await dim('g-optout')).toBe(false)
    },
  )

  // NOTE for the implementer: pick the pane's chart type deliberately. `gateValueDataZoom` gates a
  // VALUE chart's (Bar/Box/Violin) rail on `'y'` — so a value chart with `dataZoomAxes:['x']` renders
  // NO value rail at all (its zoomable axis is the value axis = y). To assert an x-rail-visible/
  // y-rail-absent split, use a chart whose x is a real zoom axis (e.g. a matrix Heatmap/Dotplot via
  // `gateMatrixDataZoom`, or a world2d scatter's inside-zoom) and override its `dataZoomAxes` to ['x'].
  test.fixme('a dataZoomAxes:[\'x\'] pane exposes only the x zoom rail (no y rail)', async ({ page }) => {
    await openStory(page, 'viz-capability-declarative')
    // The x-only pane renders an x dataZoom rail…
    await expect(page.getByTestId('viz-capability-zoomx-x-rail')).toBeVisible()
    // …and NOT a y rail (the descriptor's y axis was gated out).
    await expect(page.getByTestId('viz-capability-zoomx-y-rail')).toHaveCount(0)
  })
})
