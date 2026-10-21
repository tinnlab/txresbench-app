/**
 * Layer A — A PANE'S SCROLLBAR BELONGS AT THE PANE'S EDGE, AND IT IS THE KIT'S (part B).
 *
 * ── THE EXPECTED VALUE MOVED; THE CLAIM DID NOT ─────────────────────────────────────────────
 * "At the pane's edge" used to be satisfied by the pane's CONTENT box, because the pane's inset
 * sat outside the scroller and the bar therefore hugged the inset's inner edge. That was the
 * remaining half of the defect: the bar floated 8px inside the pane with a strip of empty pane
 * beside it. The inset is now INSIDE the viewport, on the scrolled content (`PaneScroll`), so
 * the track spans the pane's PADDING box — i.e. everything inside its border. The claim is
 * unchanged, and it is now literal rather than approximate.
 *
 * The reported defect: an analysis pane's scroll bar rendered in the MIDDLE of the pane.
 * `RegionBody`
 * was ONE element carrying three concerns at once —
 *
 *     flex min-h-0 w-full max-w-lg flex-col items-start gap-3 overflow-y-auto p-4
 *
 * — the readable-width cap (`max-w-lg` = 512px), the scroll container (`overflow-y-auto`) and the
 * form padding. So the scroller WAS the capped box, and a scroll container's scrollbar renders at
 * its own right edge: in any pane wider than 512px the bar floated mid-pane, 512px from the left,
 * with empty pane to the right of it.
 *
 * The two assertions below are the two halves of that, and both are MEASURED GEOMETRY rather than
 * class strings — a `max-w-*` re-added to the scroller tomorrow has to fail loudly:
 *
 *   1. the scroll container spans the pane, EDGE TO EDGE (so its bar is at the pane's edge);
 *   2. the width cap still EXISTS — it moved INWARD onto the content, it was not deleted. Without
 *      this half, "delete max-w-lg" passes assertion 1 while regressing the readable column the
 *      cap is there for.
 *
 * …and the third: a pane scrolls through the KIT's `ScrollArea` (overlayscrollbars overlay bars)
 * rather than a native `overflow-*` box. Measured on the DOM state overlayscrollbars actually
 * produces (`data-overlayscrollbars-viewport`), not on a class name.
 *
 * Run standalone (backend-free; use a dedicated port on a shared box):
 *   GALLERY_PORT=1479 npx playwright test -c playwright.visual.config.ts pane-scroll.spec.ts
 */
import { expect, test } from '@playwright/test'
import { openGallery } from './_gallery'

/** The surface rendering the REAL `PaneBody` for every kind in the registry (`gallery.tsx`). */
const PANE_INSET_SURFACE = 'workbench-pane-inset'

/** `RegionBody`'s readable-column cap in px (`max-w-lg`), the same number
 *  `declarative-layout.spec.ts` anchors its wide-case assertions to. */
const FORM_COLUMN_MAX_W = 512

/** The declarative surfaces whose pane is WIDER than the form column's cap — the only widths at
 *  which a mid-pane scrollbar is distinguishable from a correct one. `run-feedback-wide` is the
 *  one whose form genuinely overflows (`declarative-layout.spec.ts` asserts that as a
 *  precondition), so it is the one where a scrollbar actually exists to be misplaced. */
const WIDE_SLUGS = [
  'declarative-run-feedback-wide',
  'declarative-foreach-stress-wide',
  'declarative-loaded-wide',
] as const
/** The scrolling one — a form that does not overflow has no scrollbar to place. */
const OVERFLOWING_SLUG = 'declarative-run-feedback-wide'

const TOL = 1.5

interface ScrollReport {
  /** The measured box, plus two boxes derived from its computed style rather than from literals:
   *  · `padding` — the rect inset by its BORDER only. A pane-wide scroll track fills this: the
   *    pane's inset is inside the viewport now, so the track spans everything within the border.
   *  · `content` — additionally inset by the pane's own padding. Where the pane's inset content
   *    column sits, and what a NON-track box is measured against. */
  frame: {
    left: number
    right: number
    width: number
    padding: { left: number; right: number; width: number }
    content: { left: number; right: number; width: number }
  }
  /** The nearest y-scroll container AT OR ABOVE the form column, i.e. the pane's form scroll
   *  track. "At" matters: the defect is precisely that the column and the scroller were the SAME
   *  element, so a walk that started one box out would report "no scroller" instead of the
   *  mis-sized one that is actually there. */
  track: {
    left: number
    right: number
    width: number
    clientWidth: number
    scrollHeight: number
    clientHeight: number
    /** Is it an overlayscrollbars viewport (the kit `ScrollArea`) rather than a native box? */
    overlay: boolean
    testid: string | null
    tag: string
  } | null
  /** The form column itself — the element the readable-width cap must now live on. */
  column: { left: number; right: number; width: number } | null
  /** Every y-scroll container inside the pane frame, for the "no native scrollers" claim. */
  scrollers: { testid: string | null; tag: string; overlay: boolean; width: number; right: number }[]
}

async function scrollReport(
  page: import('@playwright/test').Page,
  frameSel: string,
  columnSel: string,
): Promise<ScrollReport> {
  return page.evaluate(
    ({ frameSel, columnSel }) => {
      const frameEl = document.querySelector(frameSel)!
      const columnEl = document.querySelector(columnSel)
      const isOverlay = (el: Element): boolean => el.hasAttribute('data-overlayscrollbars-viewport')
      // A VERTICAL scroll track, defined by what it can actually do rather than by one computed
      // property. Two facts force this:
      //   · overlayscrollbars reports `overflow-y: hidden` on its viewport while the content
      //     FITS, so a track located by computed overflow alone vanishes on the surfaces whose
      //     form happens to fit — and the assertions about it silently stop applying.
      //   · setting only `overflow-x` makes `overflow-y` COMPUTE to `auto` (CSS 3.1), so the
      //     kit data grid's horizontal row reads as a y-scroller and would be reported as a
      //     native vertical scrollbar that does not exist.
      const scrollsY = (el: Element): boolean => {
        if (isOverlay(el)) return true
        const oy = getComputedStyle(el).overflowY
        return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
      }
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, width: r.width }
      }

      let track: ScrollReport['track'] = null
      if (columnEl) {
        for (let p: Element | null = columnEl; p && frameEl.contains(p); p = p.parentElement) {
          if (!scrollsY(p)) continue
          const r = p.getBoundingClientRect()
          track = {
            left: r.left,
            right: r.right,
            width: r.width,
            clientWidth: p.clientWidth,
            scrollHeight: p.scrollHeight,
            clientHeight: p.clientHeight,
            overlay: isOverlay(p),
            testid: p.getAttribute('data-testid'),
            tag: p.tagName.toLowerCase(),
          }
          break
        }
      }

      const scrollers: ScrollReport['scrollers'] = []
      for (const el of Array.from(frameEl.querySelectorAll('*'))) {
        if (!scrollsY(el)) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        scrollers.push({
          testid: el.getAttribute('data-testid'),
          tag: el.tagName.toLowerCase(),
          overlay: isOverlay(el),
          width: r.width,
          right: r.right,
        })
      }

      const fr = frameEl.getBoundingClientRect()
      const fs = getComputedStyle(frameEl)
      const inL = parseFloat(fs.borderLeftWidth) + parseFloat(fs.paddingLeft)
      const inR = parseFloat(fs.borderRightWidth) + parseFloat(fs.paddingRight)
      const bL = parseFloat(fs.borderLeftWidth)
      const bR = parseFloat(fs.borderRightWidth)
      return {
        frame: {
          left: fr.left,
          right: fr.right,
          width: fr.width,
          padding: { left: fr.left + bL, right: fr.right - bR, width: fr.width - bL - bR },
          content: { left: fr.left + inL, right: fr.right - inR, width: fr.width - inL - inR },
        },
        track,
        column: columnEl ? rect(columnEl) : null,
        scrollers,
      }
    },
    { frameSel, columnSel },
  )
}

// ── the declarative pane: the reported surface ───────────────────────────────────────────────

test.slow()
test('the form scroll track spans the pane — its scrollbar is at the pane edge, not mid-pane', async ({
  page,
}) => {
  const offenders: string[] = []
  for (const slug of WIDE_SLUGS) {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()
    const r = await scrollReport(
      page,
      `[data-testid="declarative-fixture-frame-${slug}"]`,
      `[data-testid="declarative-region-body-gallery-${slug}"]`,
    )

    // PRECONDITION: the pane really is wider than the form column's cap. At any narrower width a
    // capped scroller and a pane-wide one are the same box, and this measures nothing.
    expect(
      r.frame.width,
      `${slug}: the fixture frame (${Math.round(r.frame.width)}px) is not wider than the form ` +
        `column cap (${FORM_COLUMN_MAX_W}px), so a mid-pane scrollbar is indistinguishable here`,
    ).toBeGreaterThan(FORM_COLUMN_MAX_W + 100)

    if (!r.track) {
      offenders.push(`${slug}: the form column has NO y-scroll container above it at all`)
      continue
    }
    const want = r.frame.padding.width
    if (Math.abs(r.track.width - want) > TOL) {
      offenders.push(
        `${slug}: the scroll track <${r.track.tag} ${r.track.testid ?? 'no-testid'}> is ` +
          `${Math.round(r.track.width)}px wide inside a ${Math.round(r.frame.width)}px pane ` +
          `(expected ${Math.round(want)}px = the pane, edge to edge), so its scrollbar renders ` +
          `at x=${Math.round(r.track.right)} instead of x=${Math.round(r.frame.padding.right)}`,
      )
    }
  }
  expect(
    offenders,
    'the scroll container is the box whose right edge the scrollbar is drawn on. These panes ' +
      'scroll a box narrower than themselves, so the bar floats in the middle of the pane:\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)
})

test.slow()
test('the readable-width cap MOVED inward — it was not deleted', async ({ page }) => {
  // The other half. "Delete max-w-lg" satisfies every assertion in the test above while undoing
  // the readable column the cap exists for, so the cap is asserted on the CONTENT, separately.
  for (const slug of WIDE_SLUGS) {
    await openGallery(page, { surface: slug })
    await expect(page.getByTestId(`declarative-fixture-frame-${slug}`)).toBeVisible()
    const r = await scrollReport(
      page,
      `[data-testid="declarative-fixture-frame-${slug}"]`,
      `[data-testid="declarative-region-body-gallery-${slug}"]`,
    )
    expect(r.column, `${slug}: no form column`).not.toBeNull()
    expect(
      r.column!.width,
      `${slug}: the form column stretched to ${Math.round(r.column!.width)}px of a ` +
        `${Math.round(r.frame.width)}px pane — the readable cap is gone`,
    ).toBeLessThanOrEqual(FORM_COLUMN_MAX_W + TOL)
    // …and it is strictly INSIDE the track, which is what "the cap moved to an inner wrapper"
    // means geometrically.
    expect(
      r.track!.width - r.column!.width,
      `${slug}: the form column is as wide as its scroll track — the cap and the scroller are ` +
        'still the same box',
    ).toBeGreaterThan(TOL)
    // …and the column still starts at the pane's INSET content edge: the track bled out of the
    // inset, and the inset was re-applied to the content inside it, so the readable column did
    // not move by a pixel. Without this, "delete the inset" passes every clause above.
    expect(
      r.column!.left,
      `${slug}: the form column starts at x=${Math.round(r.column!.left)} but the pane's inset ` +
        `content edge is x=${Math.round(r.frame.content.left)} — the inset was deleted, not moved`,
    ).toBeCloseTo(r.frame.content.left, 0)
  }
})

test('a pane scrolls through the kit ScrollArea, not a native overflow box', async ({ page }) => {
  // The mechanism half, measured on the DOM overlayscrollbars actually produces. Restricted to
  // the Y axis: a data grid's own horizontal scroller is kit-internal and not a pane scroll track.
  await openGallery(page, { surface: OVERFLOWING_SLUG })
  await expect(page.getByTestId(`declarative-fixture-frame-${OVERFLOWING_SLUG}`)).toBeVisible()
  const r = await scrollReport(
    page,
    `[data-testid="declarative-fixture-frame-${OVERFLOWING_SLUG}"]`,
    `[data-testid="declarative-region-body-gallery-${OVERFLOWING_SLUG}"]`,
  )

  expect(r.track, 'the form has no scroll track').not.toBeNull()
  // PRECONDITION: this form genuinely overflows, so the track really is scrolling something.
  expect(
    r.track!.scrollHeight,
    `${OVERFLOWING_SLUG}: the form fits its track (${r.track!.scrollHeight} of ` +
      `${r.track!.clientHeight}px) — there is no scrollbar here to place`,
  ).toBeGreaterThan(r.track!.clientHeight)
  expect(
    r.track!.overlay,
    `the form's scroll track is a NATIVE overflow box (<${r.track!.tag}>), not the kit ScrollArea ` +
      '— native bars take layout space and ignore the app\'s scrollbar styling',
  ).toBe(true)

  const native = r.scrollers.filter(s => !s.overlay)
  expect(
    native,
    'these y-scroll containers inside the pane are native rather than the kit ScrollArea:\n  ' +
      native.map(s => `<${s.tag}> ${s.testid ?? '(no testid)'}`).join('\n  '),
  ).toHaveLength(0)
})

// ── every pane kind, from the registry ───────────────────────────────────────────────────────

test.slow()
test('no pane kind scrolls a box narrower than itself', async ({ page }) => {
  // The pattern, not the one line: a width cap on a scroll container puts that pane's bar in the
  // middle of that pane, whichever pane it is. Derived from the registry for the same reason the
  // inset spec is.
  await openGallery(page, { surface: PANE_INSET_SURFACE })
  await expect(page.getByTestId('workbench-gallery-frame')).toBeVisible({ timeout: 30_000 })
  const kinds = await page.evaluate(
    () =>
      (window as unknown as { __workbenchPanes?: { kinds?: () => string[] } }).__workbenchPanes?.kinds?.() ??
      [],
  )
  expect(kinds.length, 'the pane-kind registry seam published nothing').toBeGreaterThan(0)

  // Every pane kind is code-split, so wait until each frame has mounted its renderer before
  // measuring — a Suspense placeholder has no scroll track and would pass vacuously.
  for (const kind of kinds) {
    await expect(page.getByTestId(`pane-inset-frame-${kind}`)).toBeVisible({ timeout: 30_000 })
  }
  await expect(page.getByTestId('workbench-pane-loading')).toHaveCount(0, { timeout: 30_000 })

  const offenders: string[] = []
  for (const kind of kinds) {
    // Measured on the PANE BODY, so the pane's content box comes from the shell's own computed
    // inset rather than from a literal — the claim is "spans its pane", at whatever the inset is.
    const r = await scrollReport(
      page,
      `[data-testid="region-pane-body-inset-${kind}"]`,
      '#no-such-column',
    )
    const content = r.frame.content.width
    for (const s of r.scrollers) {
      // A scroller nested inside a width-capped CONTENT column is legitimate (a log box, a
      // bounded list). What is not is a scroller that is the pane's own track and yet narrower
      // than the pane: that is the mid-pane-bar shape. Measured as "reaches the pane's right
      // content edge" rather than "is exactly the pane's width", so a nested inner box is only
      // flagged when it claims to be the pane's own scroller and is not.
      const reachesEdge = Math.abs(s.right - r.frame.content.right) <= TOL
      if (!reachesEdge && s.width >= content - TOL) {
        offenders.push(
          `${kind}: <${s.tag}> ${s.testid ?? '(no testid)'} is ${Math.round(s.width)}px wide but ` +
            `ends at x=${Math.round(s.right)}, short of the pane's content edge ` +
            `${Math.round(r.frame.content.right)}`,
        )
      }
    }
  }
  expect(offenders, `mis-placed pane scroll tracks:\n  ${offenders.join('\n  ')}`).toHaveLength(0)
})
