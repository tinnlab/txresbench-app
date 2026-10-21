// The tooltip arrow's drawn edge must follow the tooltip's PLACEMENT.
//
//   "why the arrow (it's the diamond with shadow), always have bottom shadow and looks like it is
//    only for top tooltip"
//
// The arrow is a square under `rotate-45`, so which two of its four edges face outward depends on
// where the popup sits. The edge classes were hardcoded `border-r border-b` — the correct pair for
// a tooltip ABOVE its trigger and for no other placement — so every other side drew its edge on the
// two INWARD faces, which reads as a shadow on the wrong side.
//
// WHY THIS IS AN E2E TEST AND NOT A UNIT TEST
// The property is CSS. In jsdom Tailwind is never compiled, so `getComputedStyle` returns nothing
// and the only thing left to assert is the class STRING — a source-text assertion, which this repo
// has already rejected twice (the activity-rail static guards were replaced by a mounted-component
// harness once a hand-written analyser's evasion space proved unbounded). So this measures COMPUTED
// border widths in a real browser against really-compiled CSS.
//
// It also never reads the class list from source. It takes it off the LIVE arrow element of a real,
// really-hovered tooltip, so an implementation that switched to inline styles or a different
// technique would still be measured correctly rather than reported as a false failure.

import { expect, test, type Page } from '@playwright/test'

/** Computed border widths in TRBL order. */
type Widths = [number, number, number, number]

/**
 * The outward-facing pair per resolved `data-side`, derived from the rotation rather than copied:
 * `rotate(45deg)` is clockwise in screen coordinates (y points down), which sends the pre-rotation
 * edge normals to  t→up-right, r→down-right, b→down-left, l→up-left.  The arrow pokes TOWARD the
 * trigger and `data-side` names where the POPUP is, so the outward pair is the two edges whose
 * normals point the way it pokes. Indices are TRBL.
 */
const OUTWARD: Record<string, [number, number]> = {
  top: [1, 2], // popup above,  pokes down  → right + bottom
  bottom: [0, 3], // popup below,  pokes up     → top + left
  left: [0, 1], // popup left,   pokes right  → top + right
  right: [2, 3], // popup right,  pokes left   → bottom + left
}

/**
 * Base UI emits a LOGICAL `data-side` only when the consumer passed a logical `side`, and resolves
 * it by writing direction (`getLogicalSide`: inline-end → physical right under ltr, left under
 * rtl). The rotation is physical and does not mirror, so the correct pair swaps with `dir`.
 */
const LOGICAL: Record<string, { ltr: string; rtl: string }> = {
  'inline-start': { ltr: 'left', rtl: 'right' },
  'inline-end': { ltr: 'right', rtl: 'left' },
}

const EDGE = ['top', 'right', 'bottom', 'left'] as const

function expectPair(widths: Widths, physicalSide: string, label: string): void {
  const outward = OUTWARD[physicalSide]
  for (let i = 0; i < 4; i++) {
    const shouldDraw = outward.includes(i)
    expect(
      widths[i] > 0,
      `${label}: border-${EDGE[i]} should be ${shouldDraw ? 'DRAWN (outward)' : 'ZERO (inward)'} ` +
        `— measured TRBL ${JSON.stringify(widths)}`,
    ).toBe(shouldDraw)
  }
}

/** Open a real tooltip on the datasets surface and return its live arrow element handle. */
async function openRealTooltip(page: Page) {
  await page.goto('/gallery.html?surface=datasets', { waitUntil: 'domcontentloaded' })
  const trigger = page.locator('[data-slot="tooltip-trigger"]').first()
  await trigger.waitFor({ state: 'visible', timeout: 30_000 })
  await trigger.hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(1, { timeout: 10_000 })
}

test('a REAL tooltip draws its edge on the outward pair for the side base UI actually placed it on', async ({
  page,
}) => {
  await openRealTooltip(page)

  const real = await page.evaluate(() => {
    const arrow = document.querySelector('[data-slot="tooltip-content"] > :last-child')
    if (!arrow) return null
    const cs = getComputedStyle(arrow)
    return {
      side: arrow.getAttribute('data-side'),
      widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(
        v => parseFloat(v),
      ) as Widths,
    }
  })

  expect(real, 'no arrow found on the opened tooltip').not.toBeNull()
  // Base UI really does stamp the side, and the CSS really does respond to it — this is what stops
  // the matrix below from testing a contract that does not exist.
  expect(real!.side, 'base UI stamped no data-side').toBeTruthy()
  expectPair(real!.widths, real!.side!, `real placement data-side=${real!.side}`)
})

test('every placement draws its OWN outward pair, and the logical sides swap with direction', async ({
  page,
}) => {
  // NOTE ON COVERAGE. Only `top` is reachable as a REAL placement here: no gallery surface renders
  // a hoverable tooltip with a non-default `side`, and collision-flipping could not be forced —
  // shrinking the viewport scrolls the layout, moving the trigger off-screen rather than up against
  // the edge. So the other placements are driven by setting `data-side` (and `dir`), which is
  // precisely the contract Base UI drives, on the arrow taken from the real tooltip above. The CSS
  // being measured is fully real; only the side attribute is supplied by the test.
  await openRealTooltip(page)

  const measured = await page.evaluate(
    ({ sides }) => {
      const arrow = document.querySelector('[data-slot="tooltip-content"] > :last-child')
      if (!arrow) return null
      // The LIVE class list — never a string from source.
      const probe = document.createElement('div')
      probe.className = arrow.className
      document.body.appendChild(probe)

      const root = document.documentElement
      const previousDir = root.getAttribute('dir')
      const out: Record<string, number[]> = {}
      try {
        for (const dir of ['ltr', 'rtl']) {
          root.setAttribute('dir', dir)
          for (const side of sides) {
            probe.setAttribute('data-side', side)
            const cs = getComputedStyle(probe)
            out[`${dir}/${side}`] = [
              cs.borderTopWidth,
              cs.borderRightWidth,
              cs.borderBottomWidth,
              cs.borderLeftWidth,
            ].map(v => parseFloat(v))
          }
        }
      } finally {
        if (previousDir === null) root.removeAttribute('dir')
        else root.setAttribute('dir', previousDir)
        probe.remove()
      }
      return out
    },
    { sides: [...Object.keys(OUTWARD), ...Object.keys(LOGICAL)] },
  )

  expect(measured, 'no arrow found on the opened tooltip').not.toBeNull()

  for (const dir of ['ltr', 'rtl'] as const) {
    for (const side of Object.keys(OUTWARD)) {
      // A physical side is physical: it must NOT mirror.
      expectPair(measured![`${dir}/${side}`] as Widths, side, `${dir} data-side=${side}`)
    }
    for (const [side, resolves] of Object.entries(LOGICAL)) {
      expectPair(measured![`${dir}/${side}`] as Widths, resolves[dir], `${dir} data-side=${side}`)
    }
  }

  // Negative control. Every assertion above is satisfiable by a class list that draws the SAME pair
  // everywhere if OUTWARD were ever weakened, and the original defect was exactly that. Require the
  // four physical sides to produce four DISTINCT pairs, so a side-invariant arrow fails here even
  // if it somehow satisfied the per-side checks.
  const distinct = new Set(
    Object.keys(OUTWARD).map(side => JSON.stringify(measured![`ltr/${side}`])),
  )
  expect(distinct.size, 'the arrow draws the same edges on every side — it is side-invariant').toBe(4)

  // …and the logical sides must genuinely differ between the two writing directions.
  for (const side of Object.keys(LOGICAL)) {
    expect(
      JSON.stringify(measured![`ltr/${side}`]),
      `data-side=${side} does not swap with dir`,
    ).not.toBe(JSON.stringify(measured![`rtl/${side}`]))
  }
})
