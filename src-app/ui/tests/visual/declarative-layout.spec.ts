/**
 * Layer A — the declarative-engine gate:ui spec (declarative-rendering-hardening Slice 3,
 * ITEM-15). This is what `npm run gate:ui` runs as its visual step, so anything that must be
 * GATED lives here (not only in `tests/gallery-e2e/`, which no repo gate runs).
 *
 * It covers two things:
 *   • deterministic LAYOUT invariants + axe a11y (INV-5 / INV-6) — every assertion is a
 *     bug-by-definition rather than a pixel baseline, so it is machine-portable;
 *   • the BEHAVIOURAL invariants of Slice 2 (INV-1 / INV-2 / INV-3 / INV-4) on the real
 *     rendered surfaces, because a green gate that would stay green after deleting
 *     `RegionStatus` proves nothing.
 *
 * It exists because EVERY processor UI renders through `DeclarativeRegion`, and before this
 * branch there was ZERO gallery coverage of any declarative surface — so the Slice-1 layout
 * fix (`RegionBody` + `WidgetField`) had nothing guarding it and could silently regress.
 *
 * Run standalone (backend-free; use a dedicated port on a shared box):
 *   GALLERY_PORT=1479 npx playwright test -c playwright.visual.config.ts declarative-layout.spec.ts
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { THEMES, listSurfaces, openGallery } from './_gallery'

/** How many runs the `run-feedback` story seeds (`fixtureSpecs.ts::RUN_FEEDBACK_RUN_COUNT`).
 *  A LITERAL, for the same reason `FIXTURE_KEYS` is one — and additionally because this spec runs
 *  under a plain node loader that cannot resolve the app's CSS imports, so `src/` is not
 *  importable here at all. It is the positive control: a story that stopped attributing its
 *  seeded runs to this analysis renders an empty band, and an empty band would satisfy every
 *  geometric assertion below. */
const RUN_FEEDBACK_RUN_COUNT = 3

/** The surfaces `DeclarativeFixtureStories` registers. Kept as
 *  a literal here — not imported from `src/` — so the spec proves the surfaces are REGISTERED
 *  and REACHABLE rather than merely re-deriving them from the same module that builds them. */
const FIXTURE_KEYS = [
  'loaded',
  'empty-data',
  'error-data',
  'foreach-stress',
  'long-label',
  'malformed-widget',
  'fresh-form',
  'run-feedback',
] as const
const VARIANTS = ['narrow', 'wide'] as const
/** The criteria-table fixture takes the SIDE-PANE band instead of narrow/wide, so its two
 *  slugs are listed separately rather than folded into the cross product above. */
const DOCK_SLUGS = ['declarative-criteria-table-dock-min', 'declarative-criteria-table-dock-default'] as const
/** The run-feedback fixture's THIRD frame: a pane SHORTER than the band pinned to its bottom.
 *  It is the only variant that varies height, so it is listed separately rather than folded into
 *  the narrow/wide cross product every other fixture takes. */
const SHORT_SLUG = 'declarative-run-feedback-short'
const ALL_SLUGS = [
  ...FIXTURE_KEYS.flatMap(k => VARIANTS.map(v => `declarative-${k}-${v}`)),
  ...DOCK_SLUGS,
  SHORT_SLUG,
]

/** Fixtures whose region is handed data (`host: 'data'`), i.e. the ones whose form layout is
 *  meaningful to measure. Mirrors `DECLARATIVE_FIXTURES[].host === 'data'`. */
const FORM_KEYS = ['loaded', 'foreach-stress', 'long-label', 'malformed-widget'] as const

/** `RegionBody`'s `max-w-lg` cap in px — the number the wide-case assertions are anchored to. */
const REGION_BODY_MAX_W = 512
/** A content-sized action button must be well under half the form column (it was 1.0 — a
 *  full-bleed button — before Slice 1). */
const MAX_BUTTON_WIDTH_RATIO = 0.5
/** Sub-pixel tolerance for a scrollWidth/clientWidth comparison. */
const OVERFLOW_TOLERANCE_PX = 1

// TEST-13 — the acceptance test for INV-5.
test('every declarative fixture surface is registered and mounts (INV-5)', async ({ page }) => {
  const { seeded } = await listSurfaces(page)
  for (const slug of ALL_SLUGS) {
    expect(seeded, `gallery must enumerate ${slug} (the gate enumerates the same manifest)`).toContain(
      slug,
    )
  }

  for (const slug of ALL_SLUGS) {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()
    const body = page.locator(`[data-testid="declarative-region-body-gallery-${slug}"]`)
    await expect(body, `${slug} rendered no declarative region body`).toHaveCount(1)
  }
})

// TEST-14 — the acceptance test for INV-6 (the Slice-1 promises, MEASURED).
//
// `test.slow()` because the loop is one FULL RELOAD per surface (isolation is the point — a
// surface measured after another one has rendered is measured in a page that already resolved
// its modules), and the surface count grew past the 60s default. It is a budget, not a
// flake-suppressant: the assertions inside are all synchronous measurements.
test.slow()
test('Slice-1 layout invariants hold on every declarative fixture (INV-6)', async ({ page }) => {
  for (const slug of ALL_SLUGS) {
    await openGallery(page, { surface: slug })
    const body = page.locator(`[data-testid="declarative-region-body-gallery-${slug}"]`).first()
    await expect(body).toBeVisible()

    // (a) the form is INSET from the pane on all four sides — it was flush (0) before Slice 1.
    //
    // Measured as the form's OFFSET from the pane frame rather than as `padding` on the form
    // itself: the inset moved OUT of `RegionBody` and onto the pane body
    // (`RegionShell::paneContentClass`), which is now its single owner for every pane kind. The
    // OUTCOME — "the form does not sit flush against the pane's edges" — is what this test was
    // ever about, and stating it as an offset keeps it true wherever the padding is declared.
    // (The pane-INSET spec, `pane-inset.spec.ts`, is what pins the value and its one-ness.)
    const inset = await body.evaluate((el, sel) => {
      const frame = document.querySelector(sel)!
      const f = frame.getBoundingClientRect()
      const b = el.getBoundingClientRect()
      const fs = getComputedStyle(frame)
      const bw = {
        l: parseFloat(fs.borderLeftWidth),
        r: parseFloat(fs.borderRightWidth),
        t: parseFloat(fs.borderTopWidth),
        b: parseFloat(fs.borderBottomWidth),
      }
      return {
        top: b.top - (f.top + bw.t),
        left: b.left - (f.left + bw.l),
        // The form column is width-capped, so its RIGHT gap is the cap, not the inset. The
        // inset's own right/bottom are read off the pane frame that supplies them.
        right: parseFloat(fs.paddingRight),
        bottom: parseFloat(fs.paddingBottom),
      }
    }, `[data-testid="declarative-fixture-frame-${slug}"]`)
    expect(inset.top, `${slug} top inset`).toBeGreaterThan(0)
    expect(inset.right, `${slug} right inset`).toBeGreaterThan(0)
    expect(inset.bottom, `${slug} bottom inset`).toBeGreaterThan(0)
    expect(inset.left, `${slug} left inset`).toBeGreaterThan(0)

    // (c) no horizontal overflow — measured on the region body ITSELF (the scroll container
    // that owns the form column), not only on the outer frame: the frame can never overflow
    // because `RegionBody` is `w-full`, so asserting on the frame alone would pass even with
    // a control bursting out of the column.
    const overflow = await body.evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
    expect(
      overflow.scrollWidth,
      `${slug} form column overflows horizontally (${overflow.scrollWidth} > ${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(overflow.clientWidth + OVERFLOW_TOLERANCE_PX)
  }

  // (b) in the WIDE case an action button must stay CONTENT-sized, not span the form column,
  // and the form column itself must stay width-capped rather than stretching to the pane.
  for (const key of FORM_KEYS) {
    const slug = `declarative-${key}-wide`
    await openGallery(page, { surface: slug })
    const body = page.locator(`[data-testid="declarative-region-body-gallery-${slug}"]`).first()
    const button = page.getByTestId('widget-addCriterion')
    await expect(button).toBeVisible()

    const bodyBox = await body.boundingBox()
    const btnBox = await button.boundingBox()
    expect(bodyBox, `${slug} region body has no box`).not.toBeNull()
    expect(btnBox, `${slug} action button has no box`).not.toBeNull()
    const ratio = btnBox!.width / bodyBox!.width
    expect(ratio, `${slug} action button spans the form column (ratio ${ratio.toFixed(2)})`).toBeLessThan(
      MAX_BUTTON_WIDTH_RATIO,
    )

    // The form column stays capped well inside a wide pane.
    const frameBox = await page.getByTestId(`declarative-fixture-frame-${slug}`).boundingBox()
    expect(frameBox!.width, 'the wide fixture frame must actually be wide').toBeGreaterThan(700)
    expect(
      bodyBox!.width,
      `${slug} form column stretched past its max-w-lg cap (${bodyBox!.width} of ${frameBox!.width})`,
    ).toBeLessThanOrEqual(REGION_BODY_MAX_W + OVERFLOW_TOLERANCE_PX)
  }
})

// ── NOTHING CLIPS, at every width a side pane can be dragged to ──────────────────────────────
//
// The reported defect: the criteria table was WIDER THAN THE PANE it lives in, so the last
// column heading and the row action were cut off. It was not scrolling — it was overflowing,
// which is a different failure with a different cause: the table widget returned a bare `<div>`
// into a `RegionBody` that is `items-start`, so the div sized to its own CONTENT, and the kit
// grid's own `overflow-x-auto` container — being `w-full` OF THAT DIV — was never narrower than
// what it held. A scroller that is always as wide as its content never scrolls.
//
// The rule this asserts is the repo's, not a preference: WIDE CONTENT SCROLLS INSIDE ITS OWN
// CONTAINER, never past the pane or the page. So there are two claims, and they are different:
//
//   · at EVERY allowed width — nothing spills the pane. An element may sit outside the visible
//     box of an x-SCROLLABLE ancestor (that is what a scroller is for), but the scroller itself,
//     and everything not inside one, must be within the form column, and neither the column nor
//     the page may scroll sideways.
//   · at the DEFAULT width — nothing needs scrolling AT ALL. This is the half a "fits" claim is
//     usually missing: a grid that technically scrolls still hides its own last column until the
//     user discovers it can be dragged.
//
// It is measured in a browser because that is the only place layout exists — a unit test
// asserting a column COUNT cannot tell a table that fits from one that is cut off — and it is
// measured on a MIXED row set, because the folded column renders a different control for a
// continuous row than for a categorical one and a table of one kind proves only its own half.

/** One element that reaches past the form column's right edge. */
interface Spill {
  tag: string
  testid: string | null
  text: string
  right: number
  /** The nearest x-scrollable ancestor INSIDE the form column, if any — an element inside one
   *  is scrolled to, not clipped away, so it is not a spill. */
  scroller: string | null
}

interface OverflowReport {
  bodyScrollWidth: number
  bodyClientWidth: number
  frameScrollWidth: number
  frameClientWidth: number
  pageScrollWidth: number
  pageClientWidth: number
  /** Every element whose right edge passes the form column's, WITH no scrollable ancestor. */
  spills: Spill[]
  /** The x-scrollable containers inside the column, and whether each currently needs to scroll. */
  scrollers: { testid: string | null; scrollWidth: number; clientWidth: number; right: number }[]
}

async function overflowReport(
  page: import('@playwright/test').Page,
  slug: string,
): Promise<OverflowReport> {
  return page.evaluate(
    ({ slug, tol }) => {
      const body = document.querySelector(`[data-testid="declarative-region-body-gallery-${slug}"]`)!
      const frame = document.querySelector(`[data-testid="declarative-fixture-frame-${slug}"]`)!
      const bodyRight = body.getBoundingClientRect().right
      const scrollableX = (el: Element): boolean => {
        const ox = getComputedStyle(el).overflowX
        return ox === 'auto' || ox === 'scroll'
      }
      const name = (el: Element): string | null => el.getAttribute('data-testid')
      const spills: Spill[] = []
      const scrollers: OverflowReport['scrollers'] = []
      for (const el of Array.from(body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (scrollableX(el)) {
          scrollers.push({
            testid: name(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            right: r.right,
          })
        }
        if (r.right <= bodyRight + tol) continue
        // Walk up to the form column looking for a scroller. Finding one means this element is
        // REACHABLE by scrolling that container rather than lost off the pane.
        let scroller: string | null = null
        for (let p = el.parentElement; p && p !== body; p = p.parentElement) {
          if (scrollableX(p)) {
            scroller = name(p) ?? p.tagName.toLowerCase()
            break
          }
        }
        if (scroller) continue
        spills.push({
          tag: el.tagName.toLowerCase(),
          testid: name(el),
          text: (el.textContent ?? '').trim().slice(0, 40),
          right: Math.round(r.right),
          scroller,
        })
      }
      return {
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        frameScrollWidth: frame.scrollWidth,
        frameClientWidth: frame.clientWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
        spills,
        scrollers,
      }
    },
    { slug, tol: OVERFLOW_TOLERANCE_PX },
  )
}

const describeSpills = (r: OverflowReport): string =>
  r.spills.map(s => `    • <${s.tag}> ${s.testid ?? '(no testid)'} right=${s.right} "${s.text}"`).join('\n')

test('the criteria table is CONTAINED at every width a side pane can be dragged to', async ({
  page,
}) => {
  for (const slug of DOCK_SLUGS) {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId('widget-criteriaTable')).toBeVisible()
    // The mixed row set is a PRECONDITION of the measurement, not a side observation: the
    // folded column draws bounds on a continuous row and a keep-set on a categorical one, so a
    // run where one branch never rendered would measure half the surface and report success.
    await expect(page.getByTestId('widget-criteriaTable-edit-min-0')).toBeVisible()
    await expect(page.getByTestId('widget-criteriaTable-multiselect-keep-1')).toBeVisible()

    const r = await overflowReport(page, slug)

    expect(
      r.spills,
      `${slug}: ${r.spills.length} element(s) reach past the form column with nothing to scroll them back:\n${describeSpills(r)}`,
    ).toHaveLength(0)
    expect(
      r.bodyScrollWidth,
      `${slug}: the form column itself scrolls sideways (${r.bodyScrollWidth} > ${r.bodyClientWidth})`,
    ).toBeLessThanOrEqual(r.bodyClientWidth + OVERFLOW_TOLERANCE_PX)
    expect(
      r.frameScrollWidth,
      `${slug}: content is clipped by the pane (${r.frameScrollWidth} > ${r.frameClientWidth})`,
    ).toBeLessThanOrEqual(r.frameClientWidth + OVERFLOW_TOLERANCE_PX)
    expect(
      r.pageScrollWidth,
      `${slug}: the PAGE scrolls sideways (${r.pageScrollWidth} > ${r.pageClientWidth})`,
    ).toBeLessThanOrEqual(r.pageClientWidth + OVERFLOW_TOLERANCE_PX)
    // A scroller that is itself wider than the column would have moved the problem up one box
    // rather than solved it.
    for (const s of r.scrollers) {
      expect(
        s.clientWidth,
        `${slug}: scroll container ${s.testid ?? '(anonymous)'} is wider than the form column`,
      ).toBeLessThanOrEqual(r.bodyClientWidth + OVERFLOW_TOLERANCE_PX)
    }
  }
})

test('at the pane width it OPENS at, the criteria table needs no scrolling to be read', async ({
  page,
}) => {
  const slug = 'declarative-criteria-table-dock-default'
  await openGallery(page, { surface: slug })
  await expect(page.getByTestId('widget-criteriaTable')).toBeVisible()

  const r = await overflowReport(page, slug)
  const needing = r.scrollers.filter(s => s.scrollWidth > s.clientWidth + OVERFLOW_TOLERANCE_PX)
  expect(
    needing,
    `${slug}: the grid does not fit its own pane — ${needing
      .map(s => `${s.testid ?? '(anonymous)'} ${s.scrollWidth}px of ${s.clientWidth}px`)
      .join(', ')}`,
  ).toHaveLength(0)

  // …and the two controls the report named — the last heading and the row action — are inside
  // the column, at their own boxes, rather than merely "somewhere in a scroller".
  //
  // The second probe used to be the row's full-width range band (`-slider-range-0`). The band is
  // deleted, so the probe moves to the RIGHTMOST bound of the folded constraint column: the pair
  // has to be the last two things in the row, or the measurement stops covering the right edge
  // it exists to cover.
  const bodyRight = (await page.locator(`[data-testid="declarative-region-body-gallery-${slug}"]`).boundingBox())!
  const limit = bodyRight.x + bodyRight.width + OVERFLOW_TOLERANCE_PX
  for (const testid of ['widget-criteriaTable-action-remove-0', 'widget-criteriaTable-edit-max-0']) {
    const box = (await page.getByTestId(testid).boundingBox())!
    expect(box, `${slug}: ${testid} has no box`).not.toBeNull()
    expect(
      box.x + box.width,
      `${slug}: ${testid} is cut off (right edge ${Math.round(box.x + box.width)} > ${Math.round(limit)})`,
    ).toBeLessThanOrEqual(limit)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE FEEDBACK FOR AN ACTION IS ON SCREEN — at the sizes a form actually reaches.
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// The defect: the per-analysis run band was the last child of the FORM's scroll container, so it
// sat wherever the form happened to end — and a declarative form's list is rows a user ADDS.
// Measured before the fix, with nothing scrolled:
//
//   declarative-foreach-stress-narrow   run band at y = 9169..9222, in a track ending at 906
//   declarative-run-feedback-wide       run band at y = 1011..1146, in a track ending at 927
//                                       (its most recent run's row: y = 1032..1062)
//
// 12 of the 16 surfaces then in the gate were in that state. i.e. the moment after pressing Run,
// the run you just created was off the pane, with nothing on screen saying to scroll. In the app
// the same measurement was y≈808 in a 720-tall viewport after adding ONE row to a shipped
// analysis' form, and the e2e was carrying an explicit `scrollIntoViewIfNeeded` to work around it.
//
// These are LAYOUT-OUTCOME assertions, not CSS assertions: they ask where the thing IS, with
// nothing scrolled. A rule about `overflow` or `flex-1` would be the mechanism, and a mechanism
// can be satisfied while the surface is still broken.

/** Sub-pixel tolerance for a rect-containment comparison. */
const CONTAINMENT_TOLERANCE_PX = 1

interface PaneGeometry {
  /** The pane's own visible box (the fixture frame IS the pane's track), plus its CONTENT
   *  bottom — the frame's box inset by its own border and the pane's content inset
   *  (`RegionShell::paneContentClass`, mirrored onto the fixture frame). A band pinned to the
   *  bottom of a pane is flush with the pane's CONTENT, not with its border: the gap between
   *  them is the pane's inset, which is deliberate and shared by all four sides. */
  frame: { top: number; bottom: number; contentBottom: number }
  /** The run band, if it rendered. */
  band: { top: number; bottom: number; height: number; width: number } | null
  /** The first run ROW, if the band has any. */
  firstRow: { top: number; bottom: number; testid: string | null } | null
  /** EVERY run row's box, with the nearest y-SCROLLABLE ancestor inside the pane. A row inside a
   *  scroller is reachable by scrolling that box; a row outside every scroller whose rect passes
   *  the pane is simply clipped away. That is the same distinction `overflowReport` draws on the
   *  x axis, and for the same reason. */
  rows: { top: number; bottom: number; testid: string | null; scroller: string | null }[]
  /** Every scrolled ancestor between the band and the document, so "without scrolling" is a
   *  measured claim rather than an assumption about what the harness did. */
  scrolled: { testid: string | null; tag: string; scrollTop: number }[]
  /** Does the FORM genuinely need to scroll? A surface whose form fits proves nothing about a
   *  form that does not, so this is asserted as the PRECONDITION of the measurement.
   *
   *  Read off the form's SCROLL TRACK — the nearest y-scroll container at or above the form
   *  column — not off the column itself. The two used to be one element; separating them is what
   *  moved the form's scrollbar from the middle of the pane to its edge (`pane-scroll.spec.ts`),
   *  and a measurement pinned to the column would silently report "nothing overflows" afterwards,
   *  turning every precondition below into a vacuous pass. */
  formScrollHeight: number
  formClientHeight: number
}

async function paneGeometry(
  page: import('@playwright/test').Page,
  slug: string,
): Promise<PaneGeometry> {
  return page.evaluate(s => {
    const frameEl = document.querySelector(`[data-testid="declarative-fixture-frame-${s}"]`)!
    const form = document.querySelector(`[data-testid="declarative-region-body-gallery-${s}"]`)!
    // A VERTICAL scroll track. `data-overlayscrollbars-viewport` FIRST, because overlayscrollbars
    // reports `overflow-y: hidden` on its viewport while the content fits — so a computed-overflow
    // test alone loses the track on exactly the surfaces whose form fits, which is the case
    // `fresh-form` exists to be.
    const isTrack = (el: Element): boolean => {
      if (el.hasAttribute('data-overlayscrollbars-viewport')) return true
      const oy = getComputedStyle(el).overflowY
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
    }
    // The form's SCROLL TRACK: the nearest one at or above the form column (`at` matters — before
    // the split they were the same element). Falls back to the column so a structure with no
    // track at all still reports numbers rather than throwing.
    let formTrack: Element = form
    for (let p: Element | null = form; p && frameEl.contains(p); p = p.parentElement) {
      if (isTrack(p)) {
        formTrack = p
        break
      }
    }
    const bandEl = document.querySelector(`[data-testid="analysis-runs-gallery-${s}"]`)
    const rowEls = [...document.querySelectorAll('[data-testid^="analysis-run-"]')]
    const rowEl = rowEls[0]
    const fr = frameEl.getBoundingClientRect()
    const fcs = getComputedStyle(frameEl)
    const frameContentBottom =
      fr.bottom - parseFloat(fcs.borderBottomWidth) - parseFloat(fcs.paddingBottom)
    const scrolled: PaneGeometry['scrolled'] = []
    for (let p = (bandEl ?? form) as Element | null; p; p = p.parentElement) {
      if (p.scrollTop > 0) {
        scrolled.push({ testid: p.getAttribute('data-testid'), tag: p.tagName.toLowerCase(), scrollTop: p.scrollTop })
      }
    }
    if (document.documentElement.scrollTop > 0) {
      scrolled.push({ testid: null, tag: 'html', scrollTop: document.documentElement.scrollTop })
    }
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
    }
    return {
      frame: {
        top: Math.round(fr.top),
        bottom: Math.round(fr.bottom),
        contentBottom: Math.round(frameContentBottom),
      },
      band: bandEl ? rect(bandEl) : null,
      firstRow: rowEl ? { ...rect(rowEl), testid: rowEl.getAttribute('data-testid') } : null,
      rows: rowEls.map(e => {
        let scroller: string | null = null
        for (let p = e.parentElement; p && p !== frameEl; p = p.parentElement) {
          if (isTrack(p)) {
            scroller = p.getAttribute('data-testid') ?? p.tagName.toLowerCase()
            break
          }
        }
        return { ...rect(e), testid: e.getAttribute('data-testid'), scroller }
      }),
      scrolled,
      formScrollHeight: formTrack.scrollHeight,
      formClientHeight: formTrack.clientHeight,
    }
  }, slug)
}

// The invariant across EVERY declarative surface, including the 50-row stress one — which is the
// "as rows accumulate" half. It is stated over all of them rather than over one chosen fixture
// because a run band that only stays put on the surfaces someone thought to check is the same
// opt-in shape this repo keeps paying for.
test.slow()
test('the run band is on screen without scrolling, on every declarative surface', async ({ page }) => {
  const offenders: string[] = []
  for (const slug of ALL_SLUGS) {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()
    await expect(page.getByTestId(`analysis-runs-gallery-${slug}`)).toBeAttached()
    const g = await paneGeometry(page, slug)
    expect(g.band, `${slug}: no run band rendered at all`).not.toBeNull()
    expect(
      g.scrolled,
      `${slug}: something was already scrolled, so this measurement is not about the resting state`,
    ).toHaveLength(0)
    if (
      g.band!.top < g.frame.top - CONTAINMENT_TOLERANCE_PX ||
      g.band!.bottom > g.frame.bottom + CONTAINMENT_TOLERANCE_PX
    ) {
      offenders.push(
        `${slug}: run band at y=${g.band!.top}..${g.band!.bottom}, pane track is ` +
          `${g.frame.top}..${g.frame.bottom} (form ${g.formScrollHeight}px in a ${g.formClientHeight}px track)`,
      )
    }
  }
  expect(
    offenders,
    'the feedback for pressing Run is off the pane on these surfaces — a user has to scroll to ' +
      `find the run they just launched, and nothing says so:\n  ${offenders.join('\n  ')}`,
  ).toHaveLength(0)
})

// The OUTCOME, on the surface that models a real session: a form grown by adding rows, with runs
// already launched. The assertion is on a RUN ROW — the thing the user came back for — not on the
// region that would hold one.
for (const variant of VARIANTS) {
  const slug = `declarative-run-feedback-${variant}`
  test(`a launched run is readable without scrolling (${slug})`, async ({ page }) => {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()

    // POSITIVE CONTROL. Without it every assertion below passes vacuously on a band that renders
    // no rows — which is exactly what a gallery page WOULD render if the seeded runs stopped
    // being attributed to this analysis.
    const rows = page.locator('[data-testid^="analysis-run-"]')
    expect(
      RUN_FEEDBACK_RUN_COUNT,
      'the story seeds no runs, so the count assertion below would pass on an empty band',
    ).toBeGreaterThan(0)
    await expect(rows, `${slug}: the seeded runs did not reach the band`).toHaveCount(
      RUN_FEEDBACK_RUN_COUNT,
    )

    const g = await paneGeometry(page, slug)

    // PRECONDITION. A form that fits its pane cannot demonstrate anything about a form that does
    // not, so this says so instead of passing.
    expect(
      g.formScrollHeight,
      `${slug}: the form fits its own track (${g.formScrollHeight} of ${g.formClientHeight}px), so ` +
        'this surface is not the case under test — grow RUN_FEEDBACK_ROW_COUNT',
    ).toBeGreaterThan(g.formClientHeight)
    expect(g.scrolled, `${slug}: something was already scrolled`).toHaveLength(0)

    expect(g.firstRow, `${slug}: no run row rendered`).not.toBeNull()
    expect(
      g.firstRow!.bottom,
      `${slug}: the most recent run sits at y=${g.firstRow!.top}..${g.firstRow!.bottom}, below the ` +
        `pane track (${g.frame.top}..${g.frame.bottom}) — the user must scroll to see the run they ` +
        'just launched',
    ).toBeLessThanOrEqual(g.frame.bottom + CONTAINMENT_TOLERANCE_PX)
    expect(
      g.firstRow!.top,
      `${slug}: the most recent run is above the pane track`,
    ).toBeGreaterThanOrEqual(g.frame.top - CONTAINMENT_TOLERANCE_PX)

    // …and it is a real, hittable row rather than a zero-height sliver clipped to nothing.
    await expect(rows.first()).toBeVisible()
    expect(g.firstRow!.bottom - g.firstRow!.top, `${slug}: the run row is collapsed`).toBeGreaterThan(12)

    // The band must not have eaten the pane either: the form is still the majority of it. A
    // "fix" that pinned the band and left the form a sliver would satisfy every line above.
    expect(
      g.band!.height,
      `${slug}: the run band claims ${g.band!.height}px of a ${g.frame.bottom - g.frame.top}px pane`,
    ).toBeLessThan((g.frame.bottom - g.frame.top) / 2)

    // The band spans the form column rather than shrinking to its own text — it was 73px wide
    // inside `RegionBody`'s `items-start`, a rule a fifth of the way across the column.
    const formWidth = (await page
      .locator(`[data-testid="declarative-region-body-gallery-${slug}"]`)
      .boundingBox())!.width
    expect(
      g.band!.width,
      `${slug}: the run band is content-sized (${g.band!.width}px of a ${Math.round(formWidth)}px column)`,
    ).toBeGreaterThan(formWidth - 2)

    // …and its content LINES UP with the form's. The band left the form's frame to become a
    // track of its own, so it now supplies its own inset; forgetting that puts the runs hard
    // against the pane edge while everything above them is inset, which reads as two surfaces
    // rather than one pane. Measured as a RELATION to the form's own inset, so it holds at every
    // width and survives a change to the padding scale.
    const inset = await page.evaluate(s => {
      const form = document.querySelector(`[data-testid="declarative-region-body-gallery-${s}"]`)!
      const band = document.querySelector(`[data-testid="analysis-runs-gallery-${s}"]`)!
      const heading = band.querySelector('h3')!
      const pad = parseFloat(getComputedStyle(form).paddingInlineStart)
      return {
        formContentStart: form.getBoundingClientRect().left + pad,
        bandContentStart: heading.getBoundingClientRect().left,
      }
    }, slug)
    expect(
      Math.abs(inset.bandContentStart - inset.formContentStart),
      `${slug}: the run band's content starts at ${inset.bandContentStart} while the form's starts ` +
        `at ${inset.formContentStart} — the band is not inset to match the form it belongs to`,
    ).toBeLessThanOrEqual(1)
  })
}

// A PINNED footer is only safe while it FITS. This is the other half of the decision: in a pane
// dragged shorter than the band's own natural height, the band must give ground rather than push
// the form to nothing or hang off the bottom — and it must still show a run.
//
// Without this surface the band's `max-h` proportion would be unfalsifiable: every other frame is
// 720px tall, which is far taller than anything the band asks for, so deleting the cap would
// change nothing anywhere the gate looks.
test('in a pane shorter than the band, the band gives ground instead of taking the pane', async ({
  page,
}) => {
  await openGallery(page, { surface: SHORT_SLUG })
  await expect(page.getByTestId(`declarative-fixture-frame-${SHORT_SLUG}`)).toBeVisible()
  const rows = page.locator('[data-testid^="analysis-run-"]')
  await expect(rows.first(), `${SHORT_SLUG}: no run rendered`).toBeVisible()

  const g = await paneGeometry(page, SHORT_SLUG)
  const paneHeight = g.frame.bottom - g.frame.top
  // PRECONDITION: this frame really is shorter than what the band would take unconstrained. The
  // band is ~147px for three runs; a frame that grew past that would make every claim below
  // vacuous rather than false.
  expect(
    paneHeight,
    `${SHORT_SLUG}: the frame (${paneHeight}px) is no longer short enough to constrain the band — ` +
      'lower VARIANT_HEIGHT_PX.short or this surface asks nothing',
  ).toBeLessThan(300)

  expect(
    g.band!.bottom,
    `${SHORT_SLUG}: the band hangs off the bottom of the pane (${g.band!.bottom} > ${g.frame.bottom})`,
  ).toBeLessThanOrEqual(g.frame.bottom + CONTAINMENT_TOLERANCE_PX)
  expect(
    g.band!.height,
    `${SHORT_SLUG}: the band took ${g.band!.height}px of a ${paneHeight}px pane`,
  ).toBeLessThanOrEqual(paneHeight / 2 + CONTAINMENT_TOLERANCE_PX)
  // …and the FORM was not annihilated to pay for it: there is still a usable track above.
  expect(
    g.formClientHeight,
    `${SHORT_SLUG}: the form track collapsed to ${g.formClientHeight}px`,
  ).toBeGreaterThan(paneHeight / 4)
  // …and a run is still READABLE inside the shrunken band, not merely present in its scroll
  // content. The band scrolls internally; the first row must be in its visible box.
  expect(g.firstRow, `${SHORT_SLUG}: no run row`).not.toBeNull()
  expect(
    g.firstRow!.bottom,
    `${SHORT_SLUG}: the most recent run (${g.firstRow!.top}..${g.firstRow!.bottom}) is not inside ` +
      `the band's visible box (${g.band!.top}..${g.band!.bottom})`,
  ).toBeLessThanOrEqual(g.band!.bottom + CONTAINMENT_TOLERANCE_PX)

  // …and the rows the band cannot fit are SCROLLED, not spilled. A capped band whose list does
  // not clip renders its overflow straight through the bottom of the pane — where the frame's
  // `overflow-hidden` erases it — which is the original defect in miniature, and invisible to
  // every assertion above because they only ever look at the FIRST row.
  const spilling = g.rows.filter(
    r => r.bottom > g.frame.bottom + CONTAINMENT_TOLERANCE_PX && r.scroller === null,
  )
  expect(
    spilling,
    `${SHORT_SLUG}: ${spilling.length} run row(s) render past the bottom of the pane ` +
      `(${g.frame.bottom}) with nothing to scroll them back — the band is capped but its list ` +
      'does not scroll inside it: ' +
      spilling.map(r => `${r.testid} at ${r.top}..${r.bottom}`).join(', '),
  ).toHaveLength(0)
  // The positive half: some row genuinely IS out of the band's visible box here (the band is
  // smaller than its list), so the clause above is doing work rather than describing a band that
  // happens to fit.
  expect(
    g.rows.filter(r => r.bottom > g.band!.bottom + CONTAINMENT_TOLERANCE_PX).length,
    `${SHORT_SLUG}: every row fits the capped band, so the internal-scroll claim is untested here`,
  ).toBeGreaterThan(0)
})

// The other half of a PINNED band: it is pinned at the pane's BOTTOM, not merely "after the
// form". On a form that FITS, a band that simply follows the widgets floats wherever the content
// happens to stop — so the place a user looks for their runs would move with the length of their
// own form. `fresh-form` is the surface whose form fits (it is the empty one), so it is the only
// one that can tell the two arrangements apart.
for (const variant of VARIANTS) {
  const slug = `declarative-fresh-form-${variant}`
  test(`the run band is flush with the pane's bottom even when the form fits (${slug})`, async ({
    page,
  }) => {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()
    const g = await paneGeometry(page, slug)

    // PRECONDITION: this really is the fits-in-its-track case.
    expect(
      g.formScrollHeight,
      `${slug}: the form overflows its track (${g.formScrollHeight} of ${g.formClientHeight}px), so ` +
        'it cannot distinguish a pinned band from one that merely follows the widgets',
    ).toBeLessThanOrEqual(g.formClientHeight + CONTAINMENT_TOLERANCE_PX)

    const paneHeight = g.frame.bottom - g.frame.top
    expect(
      g.frame.contentBottom - g.band!.bottom,
      `${slug}: the run band ends ${g.frame.contentBottom - g.band!.bottom}px above the pane's ` +
        "content bottom — it is following the form rather than being pinned, so it moves as the " +
        'form grows',
    ).toBeLessThanOrEqual(CONTAINMENT_TOLERANCE_PX)
    // …and the form still owns the pane. A column whose height collapsed would ALSO put the band
    // at the bottom, for the wrong reason.
    expect(
      g.formClientHeight,
      `${slug}: the form track collapsed to ${g.formClientHeight}px of a ${paneHeight}px pane`,
    ).toBeGreaterThan(paneHeight / 2)
  })
}

// TEST-20 — the acceptance test for INV-1, RUN BY THE GATE. Without this, deleting
// `RegionStatus` from `DeclarativeRegion` would leave `npm run gate:ui` green.
test('a failed fetch is visually distinguishable from genuine no-data (INV-1)', async ({ page }) => {
  // ERROR: the host rejects → a named, retryable error state, and NOT the empty state.
  await openGallery(page, { surface: 'declarative-error-data-wide' })
  const errorBox = page.getByTestId('declarative-status-error-gallery-declarative-error-data-wide')
  await expect(errorBox).toBeVisible()
  await expect(errorBox).toContainText(/couldn't load/i)
  await expect(page.getByRole('button', { name: /try again/i })).toBeVisible()
  await expect(
    page.getByTestId('declarative-status-empty-gallery-declarative-error-data-wide'),
  ).toHaveCount(0)
  // The raw resolver text is behind the Details disclosure, never inline.
  await expect(errorBox).not.toContainText(/artifact service unavailable/i)
  await page.getByRole('button', { name: /details/i }).click()
  await expect(errorBox).toContainText(/artifact service unavailable/i)

  // EMPTY: the host has nothing → the no-data state, and NOT an error.
  await openGallery(page, { surface: 'declarative-empty-data-wide' })
  await expect(
    page.getByTestId('declarative-status-empty-gallery-declarative-empty-data-wide'),
  ).toContainText(/no data yet/i)
  await expect(
    page.getByTestId('declarative-status-error-gallery-declarative-empty-data-wide'),
  ).toHaveCount(0)

  // LOADED: neither.
  await openGallery(page, { surface: 'declarative-loaded-wide' })
  await expect(
    page.getByTestId('declarative-status-error-gallery-declarative-loaded-wide'),
  ).toHaveCount(0)
  await expect(
    page.getByTestId('declarative-status-empty-gallery-declarative-loaded-wide'),
  ).toHaveCount(0)
})

// TEST-21 — the status surface must never HIDE the region's controls. This is the regression
// that made a single-region processor undriveable: `qc.yaml`'s only region holds the Run
// button, and the datatype it declares is produced BY that run.
test('the status surface renders ABOVE the widgets, never instead of them (INV-1)', async ({
  page,
}) => {
  for (const slug of ['declarative-empty-data-wide', 'declarative-error-data-wide']) {
    await openGallery(page, { surface: slug })
    // the status surface is there…
    const status = page.locator(
      `[data-testid="declarative-status-empty-gallery-${slug}"], [data-testid="declarative-status-error-gallery-${slug}"]`,
    )
    await expect(status).toHaveCount(1)
    // …AND the region's own action button is still reachable.
    const button = page.getByTestId('widget-addCriterion')
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()

    // ABOVE, measured — presence alone would stay green if the status were moved BELOW the
    // widgets, which is a different (and wrong) layout.
    const statusBox = await status.boundingBox()
    const buttonBox = await button.boundingBox()
    expect(statusBox, `${slug}: status has no box`).not.toBeNull()
    expect(buttonBox, `${slug}: button has no box`).not.toBeNull()
    expect(
      statusBox!.y,
      `${slug}: the status surface must render ABOVE the region's widgets`,
    ).toBeLessThan(buttonBox!.y)
  }
})

// TEST-22 — the acceptance test for INV-3, on the REAL rendered control. The empty-data
// fixture's `$derived.catColumns` resolves to nothing, so its pickers are the genuine
// options-less case.
test('an options-less control carries an explicit affordance, never a blank box (INV-3)', async ({
  page,
}) => {
  await openGallery(page, { surface: 'declarative-empty-data-wide' })

  const groupBy = page.getByTestId('widget-groupBy')
  await expect(groupBy).toBeVisible()
  await expect(groupBy).toBeDisabled()
  await expect(groupBy).toContainText(/no options yet/i)
  // The state is ALSO carried OUTSIDE the (untabbable) disabled control, in its own
  // description element — asserting on an ancestor would pass purely from the <option> text
  // inside the select and would survive deleting the description entirely.
  const description = page.getByTestId('widget-groupBy-field-description')
  await expect(description).toBeVisible()
  await expect(description).toHaveText(/no options yet/i)
  // …and it is PROGRAMMATICALLY associated with the control, not merely adjacent.
  const descId = await description.getAttribute('id')
  expect(descId).toBeTruthy()
  await expect(groupBy).toHaveAttribute('aria-describedby', descId!)

  const picker = page.getByTestId('widget-sourceDataset-select')
  await expect(picker).toBeVisible()
  await expect(picker).toBeDisabled()
  await expect(picker).toContainText(/no datasets available/i)

  // Control case: the loaded fixture has real columns, so the same control is enabled.
  await openGallery(page, { surface: 'declarative-loaded-wide' })
  await expect(page.getByTestId('widget-groupBy')).toBeEnabled()
  await expect(page.getByTestId('widget-groupBy')).not.toContainText(/no options yet/i)
})

// TEST-23 — the acceptance test for INV-4 + INV-2 on the PRODUCTION binding. The unit tests
// pass `resetKey` by hand, so they cannot catch `DeclarativeRegion` wiring the WRONG signal;
// this drives a real state mutation and proves the latch survives it.
test('a malformed widget degrades to a named, retryable placeholder that LATCHES (INV-4/INV-2)', async ({
  page,
}) => {
  const renderFailures: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && m.text().includes('[declarative] widget render failed'))
      renderFailures.push(m.text())
  })

  await openGallery(page, { surface: 'declarative-malformed-widget-wide' })

  const placeholder = page.getByTestId('widget-error-brokenRow')
  await expect(placeholder).toBeVisible()
  await expect(placeholder).toContainText(/broken/i)
  await expect(placeholder).toContainText(/failed to render/i)
  await expect(page.getByTestId('widget-error-retry-brokenRow')).toBeVisible()

  // Isolation: the sibling widgets are untouched.
  await expect(page.getByTestId('widget-addCriterion')).toBeVisible()
  await expect(page.getByTestId('widget-groupBy')).toBeVisible()

  // INV-2: a STATE mutation (Add criterion → the store's `revision` bumps, `dataRevision`
  // does NOT) must not reset the boundary. If `DeclarativeRegion` wired `resetKey` to
  // `revision` — or back to the `scope` object — the boundary would clear, re-render the
  // throwing child and log AGAIN, which is exactly the F7 symptom.
  const before = renderFailures.length
  expect(before).toBeGreaterThan(0)

  // The control must NOT be idle: a dispatch that silently failed would leave the console
  // count flat for the wrong reason. So first prove the click really mutated the store — the
  // healthy criteria row is a `for_each` over `$state.criteria`, so its count is the witness.
  const rows = page.getByTestId('widget-criterionRow')
  const rowsBefore = await rows.count()
  await page.getByTestId('widget-addCriterion').click()
  await expect(rows, 'Add criterion did not mutate the store — the control is idle').toHaveCount(
    rowsBefore + 1,
  )

  expect(
    renderFailures.length,
    `the boundary re-threw on a state change (${before} → ${renderFailures.length}) — the reset key is not data-only`,
  ).toBe(before)
  await expect(placeholder).toBeVisible()
})

// TEST-15 — the a11y half of the Layer-A pass (and the proof ITEM-14 made the step execute).
for (const theme of THEMES) {
  // Same budget note as TEST-14: one full reload plus a full axe pass per surface.
  test.slow()
  test(`axe: no critical/serious violations on the declarative surfaces (${theme})`, async ({ page }) => {
    for (const slug of ALL_SLUGS) {
      await openGallery(page, { surface: slug, theme })
      // The story is lazy-loaded inside the surface section — axe's `include` throws
      // "No elements found" if it runs before the frame has mounted.
      await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()
      const results = await new AxeBuilder({ page })
        .include(`[data-testid="declarative-fixture-frame-${slug}"]`)
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
      const blocking = results.violations.filter(v => ['critical', 'serious'].includes(v.impact ?? ''))
      expect(
        blocking,
        `axe violations on ${slug} [${theme}]:\n${blocking
          .map(v => `  • ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
          .join('\n')}`,
      ).toHaveLength(0)
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE SHAPE OF A FORM AT REST — measured in a browser, because both claims are LAYOUT claims.
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Neither of these can be held shut in jsdom: Tailwind is not compiled there and no layout is
// performed, so a class-string assertion passes whatever the class means (and passes just as
// happily for a class that no longer exists). Both are measured here on real boxes and real
// computed styles.
//
// The surface is `fresh-form`: an empty required list and two buttons that differ ONLY in what
// their actions do — one dispatches a run, one appends a row.

/** A distinctive clause of the sentence `fixtureSpecs.ts` DECLARES as the table's `empty_text`.
 *  A clause rather than the whole string so a re-wrap cannot break it, and a clause the engine
 *  could not have invented so a renderer that ignored the declaration and wrote its own wording
 *  is caught. */
const DECLARED_EMPTY_CLAUSE = 'one line of the list this run works through'
/** The ENGINE's own half of the empty state — `renderers.tsx::TABLE_EMPTY_TITLE`. */
const ENGINE_EMPTY_TITLE = 'Nothing here yet'

const FRESH_SLUGS = ['declarative-fresh-form-narrow', 'declarative-fresh-form-wide'] as const

test('an EMPTY table renders an empty STATE, not headings over a void', async ({ page }) => {
  for (const slug of FRESH_SLUGS) {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()

    // The grid is not merely hidden — it is not rendered. A grid drawn behind an overlay would
    // still put its headings in the accessibility tree and still claim its width.
    await expect(
      page.getByTestId('widget-rowTable-grid'),
      `${slug}: the grid is still rendered over an empty row set`,
    ).toHaveCount(0)
    const empty = page.getByTestId('widget-rowTable-empty')
    await expect(empty, `${slug}: no empty state rendered`).toBeVisible()

    // …and no column HEADING survives anywhere in the region. This is the half that says
    // "not an empty table": a heading row with nothing under it is exactly what was there.
    await expect(
      page.locator(`[data-testid="declarative-region-body-gallery-${slug}"] th`),
      `${slug}: a column heading is still on screen with no rows beneath it`,
    ).toHaveCount(0)

    // BOTH halves of the state: the engine's heading, and the VIEW's sentence — which is the
    // useful one (what a row is, and where the first comes from). Asserting only the first
    // would pass for a renderer that drops the declaration on the floor.
    await expect(empty).toContainText(ENGINE_EMPTY_TITLE)
    await expect(
      empty,
      `${slug}: the view's declared empty_text did not reach the screen`,
    ).toContainText(DECLARED_EMPTY_CLAUSE)

    // It occupies REAL space — an empty state collapsed to nothing is a blank gap, which is
    // the state it replaced.
    const box = (await empty.boundingBox())!
    expect(box, `${slug}: the empty state has no box`).not.toBeNull()
    expect(box.height, `${slug}: the empty state is collapsed`).toBeGreaterThan(40)
  }
})

test('the empty state is driven by the ROW SET — adding one row replaces it with the grid', async ({
  page,
}) => {
  // The positive control. Without it, a renderer that ALWAYS draws the empty state (and never a
  // grid) passes every assertion above.
  const slug = 'declarative-fresh-form-wide'
  await openGallery(page, { surface: slug })
  await expect(page.getByTestId('widget-rowTable-empty')).toBeVisible()
  await page.getByTestId('widget-addRow').click()
  await expect(
    page.getByTestId('widget-rowTable-grid'),
    'adding a row did not bring the grid back',
  ).toBeVisible()
  await expect(page.getByTestId('widget-rowTable-empty')).toHaveCount(0)
})

test('a POPULATED table still renders its grid (the empty state is not a new default)', async ({
  page,
}) => {
  await openGallery(page, { surface: 'declarative-criteria-table-dock-default' })
  await expect(page.getByTestId('widget-criteriaTable-grid')).toBeVisible()
  await expect(page.getByTestId('widget-criteriaTable-empty')).toHaveCount(0)
})

test('the RUN action sits in a muted footer, aligned to the end — and nothing else does', async ({
  page,
}) => {
  for (const slug of FRESH_SLUGS) {
    await openGallery(page, { surface: slug })
    const body = page.locator(`[data-testid="declarative-region-body-gallery-${slug}"]`).first()
    await expect(body).toBeVisible()

    const footer = page.getByTestId('widget-runBtn-footer')
    await expect(footer, `${slug}: the run action has no footer`).toBeVisible()
    // The run control is INSIDE it, and the peer control that appends a row is NOT — the
    // derivation is from what the ACTION does, so a form that footered everything (or nothing)
    // fails here rather than passing as "a footer exists".
    await expect(footer.getByTestId('widget-runBtn')).toHaveCount(1)
    await expect(
      page.getByTestId('widget-addRow-footer'),
      `${slug}: a control that appends a row was given the run footer`,
    ).toHaveCount(0)

    const shape = await footer.evaluate((el, sel) => {
      const region = document.querySelector(sel)!
      const btn = el.querySelector('button')!
      const cs = getComputedStyle(el)
      const f = el.getBoundingClientRect()
      const b = btn.getBoundingClientRect()
      const r = region.getBoundingClientRect()
      return {
        bg: cs.backgroundColor,
        regionBg: getComputedStyle(region).backgroundColor,
        padRight: parseFloat(cs.paddingRight),
        footerWidth: f.width,
        regionInner: r.width - parseFloat(getComputedStyle(region).paddingLeft) - parseFloat(getComputedStyle(region).paddingRight),
        gapAfter: f.right - b.right,
        gapBefore: b.left - f.left,
        btnWidth: b.width,
      }
    }, `[data-testid="declarative-region-body-gallery-${slug}"]`)

    // MUTED: a real, non-transparent fill of its own, different from the surface behind it.
    // (`transparent` / `rgba(…, 0)` is what "no footer treatment" looks like.)
    expect(shape.bg, `${slug}: the footer has no fill of its own`).not.toBe('rgba(0, 0, 0, 0)')
    expect(shape.bg, `${slug}: the footer's fill is the page's own`).not.toBe(shape.regionBg)

    // A BAR: it spans the form column rather than shrinking to its content.
    expect(
      shape.footerWidth,
      `${slug}: the footer is content-sized (${shape.footerWidth}px of ${shape.regionInner}px)`,
    ).toBeGreaterThan(shape.regionInner - 2)

    // ALIGNED TO THE END: the action is flush against the footer's end padding, with the free
    // space BEFORE it. Measured as a relation between the two gaps, so it holds at any width.
    expect(
      Math.abs(shape.gapAfter - shape.padRight),
      `${slug}: the action is not flush with the footer's end (gap ${shape.gapAfter}, padding ${shape.padRight})`,
    ).toBeLessThan(2)
    expect(
      shape.gapBefore,
      `${slug}: there is no free space before the action — it is start-aligned or stretched`,
    ).toBeGreaterThan(shape.gapAfter + 8)
    // …and the action is still CONTENT-sized inside the bar, not a full-bleed button.
    expect(shape.btnWidth / shape.footerWidth, `${slug}: the action spans the footer`).toBeLessThan(
      MAX_BUTTON_WIDTH_RATIO,
    )
  }
})

test('the footer STATES what the disabled action is waiting for, above the action', async ({
  page,
}) => {
  // A muted bar holding a greyed button and no explanation is the "disabled with no stated
  // cause" defect wearing a nicer background. The requirement the form declares has to be
  // inside the bar, and above the control it is about.
  const slug = 'declarative-fresh-form-wide'
  await openGallery(page, { surface: slug })
  const footer = page.getByTestId('widget-runBtn-footer')
  const run = page.getByTestId('widget-runBtn')
  await expect(run).toBeDisabled()
  const summary = footer.getByTestId('widget-runBtn-requirements')
  await expect(summary, 'the disabled run action states no reason').toBeVisible()
  const summaryBox = (await summary.boundingBox())!
  const runBox = (await run.boundingBox())!
  expect(
    summaryBox.y + summaryBox.height,
    'the reason renders BELOW the action it explains — it is read after the control it is about',
  ).toBeLessThanOrEqual(runBox.y + 1)
})
