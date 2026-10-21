/**
 * Layer A — THE PANE BODY CARRIES NO INSET (the correction to `pane-inset.spec.ts`).
 *
 * ── The defect ───────────────────────────────────────────────────────────────────────────────
 *
 * Making the shell the single owner of the pane's content inset was right; putting that inset on
 * the pane BODY was not. The body owns three boxes at once, and the inset was wrong for all three:
 *
 *   1. the SCROLL VIEWPORT — an overlayscrollbars bar is absolutely positioned against its host's
 *      PADDING box, so an inset host draws the bar 8px short of the pane's right edge, floating
 *      inside the padding with a strip of empty pane beside it. (Reported.)
 *   2. the HEADER BAR — its `border-b` then stopped 8px short at BOTH ends and its `bg-muted/40`
 *      never reached the pane's edges, so a title bar read as a card floating inside the pane
 *      rather than as its header. (Reported.)
 *   3. the BODY had nowhere left to state the gap UNDER the header, so the content started
 *      against the header's border and the title read as fused to it. (Reported.)
 *
 * One rule fixes all three, and that is the point of asserting them in one file: **the pane body
 * carries no inset at all; it is a full-bleed column of [header bar][content region], and the
 * shell's ONE inset is on the CONTENT REGION** — its top side is the header clearance, its other
 * three sides are the pane's content inset, and a pane's own scroll track bleeds back out of the
 * horizontal half (`PaneScroll`) and re-applies it INSIDE the viewport, on the content.
 *
 * ── Why every assertion here is MEASURED GEOMETRY ────────────────────────────────────────────
 *
 * The change this corrects passed its own class assertions — `paneContentClass` was present, on
 * the element the spec looked at — and still shipped every one of the three defects above. A
 * class string cannot tell you where a border ends or where a scrollbar is drawn. So: rects, from
 * a real browser, with tolerances.
 *
 * Coverage is DERIVED FROM THE REGISTRY (`window.__workbenchPanes`), never a hand-written kind
 * list — the same mechanism that stopped the padding drift returning, applied to the same
 * surface. Each of the four arms (scrolling / no scroller / full-bleed / hosted surface) is
 * asserted with a POSITIVE CONTROL so an implementation that empties an arm fails loudly instead
 * of passing it vacuously.
 *
 * Run standalone (backend-free; use a dedicated port on a shared box):
 *   GALLERY_PORT=1479 npx playwright test -c playwright.visual.config.ts pane-chrome.spec.ts
 */
import { expect, test } from '@playwright/test'
import { openGallery } from './_gallery'

const SURFACE = 'workbench-pane-inset'

/** `paneModel.tsx`'s `PANE_CONTENT_INSET` (`0.5rem`) in px. A LITERAL — the spec runs under a
 *  plain node loader that cannot resolve the app's CSS imports, so `src/` is not importable here.
 *  Being a literal is also what makes it a control: re-deriving the expected value from the code
 *  under test would assert nothing about WHICH value was chosen. It is on the design system's 4px
 *  rhythm (2 × 4px). */
const PANE_INSET_PX = 8

/** The kind each opt-out exists FOR, asserted as literals so an empty opt-out set cannot leave
 *  every branch below vacuous. */
const FULL_BLEED_CONTROL = 'canvas'
const HOSTED_SURFACE_CONTROL = 'edit-plot'

const TOL = 0.75

interface Box {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

interface PaneChrome {
  kind: string
  fullBleed: boolean
  hostedSurface: boolean
  /** The pane BODY's box + its own computed padding (which must be zero on every side). */
  body: Box | null
  bodyPad: { top: number; right: number; bottom: number; left: number } | null
  /** The FULL-BLEED header bar: its box, and the box of its bottom BORDER as painted (the border
   *  runs the element's full border-box width, so the element's own left/right ARE the border's
   *  ends — which is exactly the claim "the rule spans the pane"). */
  header: Box | null
  headerHasCloseButton: boolean
  headerCloseDisabled: boolean
  headerCloseName: string | null
  /** How many elements in this pane carry the pane's TITLE text (the duplicate-title guard). */
  titleTextCount: number
  title: string | null
  /** The CONTENT REGION — the one element the shell's inset is on. */
  content: Box | null
  contentPad: { top: number; right: number; bottom: number; left: number } | null
  /** The pane's OWN scroll track (`PaneScroll`'s host), if this pane has one. */
  track: Box | null
  /** The content element INSIDE that track, whose padding is where the inset re-lands. */
  trackContent: Box | null
  trackContentPad: { left: number; right: number } | null
  /** The ambient `--pane-inset` as it resolves INSIDE the track's content. The track consumed the
   *  inset, so anything below it must see `0px` — that is what makes a nested scroller an ordinary
   *  bounded box instead of a second bleed. */
  trackContentInsetVar: string | null
  /** The renderer's own root (the content region's last element child) padding — a renderer that
   *  re-adds a pane-level inset doubles the shell's, which is the drift this work removes. */
  rendererRootPad: { top: number; right: number; bottom: number; left: number } | null
  rendererRootTag: string | null
}

async function readChrome(page: import('@playwright/test').Page): Promise<PaneChrome[]> {
  return page.evaluate(() => {
    const seam = (window as unknown as {
      __workbenchPanes?: {
        kinds?: () => string[]
        fullBleed?: (k: string) => boolean
        hostedSurface?: (k: string) => boolean
      }
    }).__workbenchPanes
    const kinds = seam?.kinds?.() ?? []
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const pad = (el: Element) => {
      const s = getComputedStyle(el)
      return {
        top: parseFloat(s.paddingTop),
        right: parseFloat(s.paddingRight),
        bottom: parseFloat(s.paddingBottom),
        left: parseFloat(s.paddingLeft),
      }
    }
    return kinds.map(kind => {
      const id = `inset-${kind}`
      const body = document.querySelector(`[data-testid="region-pane-body-${id}"]`)
      const content = document.querySelector(`[data-testid="region-pane-content-${id}"]`)
      const header = document.querySelector(`[data-testid="pane-header-${id}"]`)
      const close = document.querySelector(`[data-testid="pane-header-close-${id}"]`) as HTMLButtonElement | null
      // The pane's OWN track: the outermost `PaneScroll` host inside the content region. A
      // BOUNDED box deeper in (a log console) is not the pane's track and must not be measured
      // as one — `PaneScroll` neutralises itself below the first one, so "outermost" is exactly
      // "the one that bled".
      const tracks = content ? [...content.querySelectorAll('[data-pane-scroll]')] : []
      const track = tracks.find(t => !tracks.some(o => o !== t && o.contains(t))) ?? null
      const trackContent = track ? track.querySelector('[data-pane-scroll-content]') : null
      const titleText = header?.querySelector('span')?.textContent?.trim() ?? null
      // Every element whose OWN text (excluding descendants' element text) equals the pane title.
      let titleTextCount = 0
      if (body && titleText) {
        for (const el of [body, ...Array.from(body.querySelectorAll('*'))]) {
          const own = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent ?? '')
            .join('')
            .trim()
          if (own && own === titleText) titleTextCount += 1
        }
      }
      const rendererRoot = content ? (content.lastElementChild as Element | null) : null
      const cs = track ? getComputedStyle(trackContent ?? track) : null
      return {
        kind,
        fullBleed: seam?.fullBleed?.(kind) ?? false,
        hostedSurface: seam?.hostedSurface?.(kind) ?? false,
        body: body ? rect(body) : null,
        bodyPad: body ? pad(body) : null,
        header: header ? rect(header) : null,
        headerHasCloseButton: !!close,
        // `aria-disabled` OR native `disabled`: the blocked close is the former (a natively
        // disabled button lets no mouse event escape, so its reason-tooltip could never open),
        // and reading only `.disabled` would have made this check blind to the real state.
        headerCloseDisabled: !!close?.disabled || close?.getAttribute('aria-disabled') === 'true',
        headerCloseName: close?.getAttribute('aria-label') ?? null,
        titleTextCount,
        title: titleText,
        content: content ? rect(content) : null,
        contentPad: content ? pad(content) : null,
        track: track ? rect(track) : null,
        trackContent: trackContent ? rect(trackContent) : null,
        trackContentPad: cs
          ? { left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight) }
          : null,
        trackContentInsetVar: cs ? cs.getPropertyValue('--pane-inset').trim() : null,
        rendererRootPad: rendererRoot ? pad(rendererRoot) : null,
        rendererRootTag: rendererRoot ? rendererRoot.tagName.toLowerCase() : null,
      }
    })
  })
}

/** Open the surface and wait until every pane has actually MOUNTED ITS RENDERER — every pane kind
 *  is code-split, and the chrome of a Suspense placeholder is not the chrome it stands in for.
 *  Settles on the MEASUREMENT (two identical consecutive readings), for the reason
 *  `pane-inset.spec.ts` documents: the loading count is already 0 before the first boundary
 *  suspends, so waiting on it alone reads the pre-mount tree. */
async function openSettled(page: import('@playwright/test').Page): Promise<PaneChrome[]> {
  await openGallery(page, { surface: SURFACE })
  await expect(page.getByTestId('workbench-gallery-frame')).toBeVisible({ timeout: 30_000 })
  let prev = ''
  let last: PaneChrome[] = []
  await expect
    .poll(
      async () => {
        const cur = await readChrome(page)
        const loading = await page.getByTestId('workbench-pane-loading').count()
        const json = JSON.stringify(cur)
        const settled =
          // Settles on the BODY only. Requiring the content region here would turn "the shell
          // does not render one" into a poll timeout, which says nothing about which claim broke;
          // each test asserts its own element and reports its own diagnosis.
          cur.length > 0 && loading === 0 && cur.every(p => p.body) && json === prev
        prev = json
        last = cur
        return settled
      },
      { message: 'the pane frames never settled into a stable rendered state', timeout: 30_000 },
    )
    .toBe(true)
  return last
}

test.slow()
test('the pane BODY carries no inset — it is a full-bleed column', async ({ page }) => {
  const panes = await openSettled(page)
  expect(panes.length, 'the pane-kind registry seam published nothing').toBeGreaterThan(0)

  const offenders: string[] = []
  for (const p of panes) {
    if (!p.bodyPad) {
      offenders.push(`${p.kind}: no pane body`)
      continue
    }
    const sides = [p.bodyPad.top, p.bodyPad.right, p.bodyPad.bottom, p.bodyPad.left]
    if (sides.some(v => v > TOL)) {
      offenders.push(`${p.kind}: body pads ${sides.map(v => `${v}px`).join('/')}`)
    }
  }
  expect(
    offenders,
    'the pane body owns the header bar AND the scroll viewport, so an inset on it insets both — ' +
      'a header that cannot reach the pane edges and a scrollbar drawn inside the padding:\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)
})

test.slow()
test('the HEADER BAR is full-bleed — its border spans the pane, left edge AND right edge', async ({
  page,
}) => {
  const panes = await openSettled(page)

  // POSITIVE CONTROL: headers exist at all. Without it, "no header anywhere" passes every clause.
  const titled = panes.filter(p => p.header)
  expect(
    titled.map(p => p.kind),
    'not one pane kind rendered a header, so every claim about the header bar below is vacuous',
  ).not.toHaveLength(0)
  expect(
    titled.map(p => p.kind),
    'the hosted-surface control renders no header — it now uses the SHELL header like every ' +
      'other pane (viz renders the surface headerless underneath it)',
  ).toContain(HOSTED_SURFACE_CONTROL)

  const offenders: string[] = []
  for (const p of titled) {
    const h = p.header!
    const b = p.body!
    if (Math.abs(h.left - b.left) > TOL || Math.abs(h.right - b.right) > TOL) {
      offenders.push(
        `${p.kind}: header spans x=${Math.round(h.left)}..${Math.round(h.right)} inside a pane ` +
          `spanning x=${Math.round(b.left)}..${Math.round(b.right)} — its border-b stops ` +
          `${Math.round(h.left - b.left)}px short at the start and ${Math.round(b.right - h.right)}px ` +
          'short at the end',
      )
    }
    // …and it is the pane's TOP edge, not floating below one.
    if (Math.abs(h.top - b.top) > TOL) {
      offenders.push(`${p.kind}: header top y=${Math.round(h.top)} vs pane top y=${Math.round(b.top)}`)
    }
  }
  expect(
    offenders,
    'a title bar inset from the pane is a card floating inside it, not the pane\'s header:\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)
})

test.slow()
test('the CONTENT REGION carries the shell inset — one value, on all four sides, for every kind', async ({
  page,
}) => {
  const panes = await openSettled(page)

  const offenders: string[] = []
  for (const p of panes) {
    if (!p.contentPad) {
      offenders.push(
        `${p.kind}: NO content region — the shell's inset has nowhere to live except the pane ` +
          `body, which also owns the header bar and the scroll viewport (body pads ` +
          `${p.bodyPad ? [p.bodyPad.top, p.bodyPad.right, p.bodyPad.bottom, p.bodyPad.left].join('/') : '?'})`,
      )
      continue
    }
    const want = p.fullBleed ? 0 : PANE_INSET_PX
    const sides = [p.contentPad.top, p.contentPad.right, p.contentPad.bottom, p.contentPad.left]
    if (sides.some(v => Math.abs(v - want) > TOL)) {
      offenders.push(
        `${p.kind} (${p.fullBleed ? 'full-bleed' : 'inset'}): ${sides.map(v => `${v}px`).join('/')}, ` +
          `expected ${want}px on all four sides`,
      )
    }
  }
  expect(offenders, `the pane content inset is wrong here:\n  ${offenders.join('\n  ')}`).toHaveLength(0)

  // ONE value, stated as a set — a per-kind override would satisfy every line above if the
  // expectation were derived per kind.
  const distinct = [...new Set(panes.filter(p => !p.fullBleed).map(p => p.contentPad!.left))]
  expect(
    distinct,
    `the inset panes carry ${distinct.length} different insets (${distinct.join(', ')}px) — the ` +
      'whole point of the shell owning it is that there is exactly one',
  ).toEqual([PANE_INSET_PX])

  // NEGATIVE CONTROL for the full-bleed opt-out (it is an opt-OUT, not "no padding anywhere").
  expect(
    panes.filter(p => p.fullBleed).map(p => p.kind),
    'no pane kind declares the full-bleed opt-out, so every "full-bleed ⇒ 0" clause is vacuous',
  ).toContain(FULL_BLEED_CONTROL)
  expect(
    panes.filter(p => !p.fullBleed).length,
    'every pane kind opted out of the inset — that is not an opt-out, it is the old defect',
  ).toBeGreaterThan(0)
})

test.slow()
test('the BODY is cleared of the header by exactly the shell inset', async ({ page }) => {
  // The third report, and it must fall out of the SAME inset rather than a bespoke margin: a
  // margin under a bordered bar would put the gap on the wrong side of the border and leave the
  // bar's background floating. So the claim is a distance between two measured edges.
  const panes = await openSettled(page)
  const titled = panes.filter(p => p.header && p.content)
  expect(
    titled.length,
    'no pane rendered BOTH a header and a content region, so the gap between them does not exist ' +
      'as a measurable thing — which is the state in which the body starts against the border',
  ).toBeGreaterThan(0)

  const offenders: string[] = []
  for (const p of titled) {
    const want = p.fullBleed ? 0 : PANE_INSET_PX
    // The content region's box starts AT the header's bottom border; the clearance is its own top
    // padding, i.e. where its first child begins.
    const gap = p.content!.top - p.header!.bottom + p.contentPad!.top
    if (Math.abs(gap - want) > TOL) {
      offenders.push(
        `${p.kind}: content starts ${Math.round(gap)}px below the header's border, expected ${want}px`,
      )
    }
  }
  expect(
    offenders,
    'the pane body must be clear of its title bar, by the shell\'s one inset:\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)
})

test.slow()
test('a pane\'s SCROLL TRACK is flush with the pane edge and its content is still inset', async ({
  page,
}) => {
  // The reported defect, measured as the two halves that together define "correct":
  //   · the track's RIGHT edge coincides with the pane's right edge (so its overlay bar is drawn
  //     at the pane's edge, not 8px inside it), and
  //   · the content INSIDE the track is still inset by the same one value (so nothing moved
  //     except the bar — "delete the padding" must not pass this).
  const panes = await openSettled(page)

  // POSITIVE CONTROL: the scrolling arm is non-empty.
  const scrolling = panes.filter(p => p.track)
  expect(
    scrolling.map(p => p.kind),
    'not one pane kind rendered a pane-level scroll track, so the whole scrolling arm is vacuous',
  ).not.toHaveLength(0)

  const offenders: string[] = []
  for (const p of scrolling) {
    const b = p.body!
    const t = p.track!
    if (Math.abs(t.right - b.right) > TOL) {
      offenders.push(
        `${p.kind}: scroll track ends at x=${Math.round(t.right)}, the pane at ` +
          `x=${Math.round(b.right)} — its bar floats ${Math.round(b.right - t.right)}px inside the pane`,
      )
    }
    if (Math.abs(t.left - b.left) > TOL) {
      offenders.push(
        `${p.kind}: scroll track starts at x=${Math.round(t.left)}, the pane at x=${Math.round(b.left)}`,
      )
    }
    const want = p.fullBleed ? 0 : PANE_INSET_PX
    const cp = p.trackContentPad
    if (!cp) {
      offenders.push(`${p.kind}: the scroll track has no content element to carry the inset`)
      continue
    }
    if (Math.abs(cp.left - want) > TOL || Math.abs(cp.right - want) > TOL) {
      offenders.push(
        `${p.kind}: the track's content pads ${cp.left}/${cp.right}px, expected ${want}px — the ` +
          'inset was deleted rather than moved inside the viewport',
      )
    }
    // THE INSET IS CONSUMED EXACTLY ONCE. Below the track it must resolve to zero, or a scroller
    // nested inside this content (a log console, a bounded list) would bleed a SECOND time — out
    // of a box that has no inset left to bleed out of, i.e. straight through the pane's edge.
    if (p.trackContentInsetVar && parseFloat(p.trackContentInsetVar) !== 0) {
      offenders.push(
        `${p.kind}: inside the track, --pane-inset is still ${p.trackContentInsetVar} — a nested ` +
          'scroll track would bleed a second time',
      )
    }
    // …and the visible content therefore sits exactly where the region's own inset would have
    // put it: nothing moved but the bar.
    const tc = p.trackContent!
    const wantLeft = p.content!.left + p.contentPad!.left
    if (Math.abs(tc.left + cp.left - wantLeft) > TOL) {
      offenders.push(
        `${p.kind}: the scrolled content starts at x=${Math.round(tc.left + cp.left)} but the ` +
          `pane's inset content column is at x=${Math.round(wantLeft)}`,
      )
    }
  }
  expect(
    offenders,
    'a scroll container\'s bar is drawn on its OWN edge, so a track inset from the pane puts the ' +
      'bar inside the padding:\n  ' + offenders.join('\n  '),
  ).toHaveLength(0)
})

test.slow()
test('a pane with NO scroll track keeps the inset on the region itself', async ({ page }) => {
  // The second arm. Without it, "put the inset on the scroller" could be implemented by moving it
  // off the region entirely — correct for the panes that scroll, and no inset at all for those
  // that do not.
  const panes = await openSettled(page)
  expect(
    panes.filter(p => p.content).length,
    'no pane rendered a content region at all',
  ).toBeGreaterThan(0)
  const plain = panes.filter(p => !p.track && !p.fullBleed && p.content)
  expect(
    plain.map(p => p.kind),
    'every pane kind rendered a scroll track, so the no-scroller arm is untested — the surface ' +
      'must render at least one pane whose body does not scroll',
  ).not.toHaveLength(0)

  for (const p of plain) {
    expect(
      p.contentPad!.left,
      `${p.kind}: no scroll track, so the inset must be on the content region itself`,
    ).toBeCloseTo(PANE_INSET_PX, 0)
    // …and the region spans the pane, so its inset IS the pane's.
    expect(p.content!.right, `${p.kind}: content region does not span the pane`).toBeCloseTo(
      p.body!.right,
      0,
    )
  }
})

test.slow()
test('a FULL-BLEED pane is inset nowhere — region, track or otherwise', async ({ page }) => {
  const panes = await openSettled(page)
  const full = panes.filter(p => p.fullBleed)
  expect(full.map(p => p.kind), 'the full-bleed opt-out is empty').toContain(FULL_BLEED_CONTROL)

  for (const p of full) {
    expect(p.contentPad, `${p.kind}: no content region`).not.toBeNull()
    expect(p.contentPad!.left, `${p.kind}: full-bleed but the region insets it`).toBeLessThanOrEqual(TOL)
    expect(p.contentPad!.top, `${p.kind}: full-bleed but the region insets it`).toBeLessThanOrEqual(TOL)
    if (p.trackContentPad) {
      expect(
        p.trackContentPad.left,
        `${p.kind}: full-bleed but its scroll track re-applies an inset inside the viewport`,
      ).toBeLessThanOrEqual(TOL)
    }
  }
})

test.slow()
test('every pane title carries a close, and a HOSTED SURFACE shows exactly one title', async ({
  page,
}) => {
  const panes = await openSettled(page)
  const titled = panes.filter(p => p.header)
  expect(titled.length, 'no pane rendered a header').toBeGreaterThan(0)

  const missing = titled.filter(p => !p.headerHasCloseButton).map(p => p.kind)
  expect(
    missing,
    'these pane kinds draw a title with no way to close the pane from it:\n  ' + missing.join('\n  '),
  ).toHaveLength(0)

  // The close is keyboard-reachable and NAMED (it is a real <button>, and the name says which
  // pane) — an icon-only control with no accessible name is unusable by name.
  const unnamed = titled.filter(p => !p.headerCloseName?.startsWith('Close ')).map(p => p.kind)
  expect(unnamed, `these closes have no accessible name: ${unnamed.join(', ')}`).toHaveLength(0)

  // The gallery mounts every kind at once, so no pane is "the last one" — none may be disabled
  // here. (The disabled-with-a-reason state is the last-pane case, exercised in the unit tier.)
  const disabled = titled.filter(p => p.headerCloseDisabled).map(p => p.kind)
  expect(disabled, `these closes are disabled with panes to spare: ${disabled.join(', ')}`).toHaveLength(0)

  // DUPLICATE TITLE: a hosted surface used to bring its own header. It now renders headerless
  // under the shell's, so the title appears once — in the DOM, and therefore in the a11y tree.
  const hosted = panes.filter(p => p.hostedSurface)
  expect(
    hosted.map(p => p.kind),
    'the hosted-surface declaration is empty, so this claim is vacuous',
  ).toContain(HOSTED_SURFACE_CONTROL)
  for (const p of hosted) {
    expect(p.header, `${p.kind}: a hosted surface must use the shell's pane header`).not.toBeNull()
    expect(
      p.titleTextCount,
      `${p.kind}: the title "${p.title}" appears on ${p.titleTextCount} elements in the pane — a ` +
        'hosted surface must render headerless under the shell header, not beside it',
    ).toBe(1)
  }
})

test.slow()
test('no renderer re-adds a pane-level inset of its own', async ({ page }) => {
  // Carried from `pane-inset.spec.ts` with the element it measures MOVED (body → content region),
  // because the shell's inset moved there. The CLAIM is identical: the shell supplies the inset,
  // and a renderer whose own root also pads doubles it.
  const panes = await openSettled(page)
  const offenders: string[] = []
  for (const p of panes) {
    if (p.fullBleed || !p.rendererRootPad) continue
    const sides = [
      p.rendererRootPad.top,
      p.rendererRootPad.right,
      p.rendererRootPad.bottom,
      p.rendererRootPad.left,
    ]
    if (sides.some(v => v > TOL)) {
      offenders.push(
        `${p.kind}: its <${p.rendererRootTag}> root pads ${sides.map(v => `${v}px`).join('/')} ` +
          `INSIDE the shell's ${PANE_INSET_PX}px`,
      )
    }
  }
  expect(
    offenders,
    'these renderers supply their own pane-level inset on top of the shell\'s:\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)
})
