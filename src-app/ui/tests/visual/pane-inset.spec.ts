/**
 * Layer A — THE PANE'S CONTENT INSET IS THE SHELL'S, ONCE (part A of the pane-chrome work).
 *
 * ── THE ELEMENT MOVED; THE CLAIM DID NOT ────────────────────────────────────────────────────
 * The inset was on the pane BODY. The body also owns the header bar and the scroll viewport, and
 * an inset there inset both — a header whose border stopped short of the pane's edges, and a
 * scrollbar drawn 8px inside the pane. It now lives on the pane's CONTENT REGION
 * (`region-pane-content-<id>`, `RegionShell::PaneBody` → `paneInsetStyle`), which is the element
 * these two tests therefore measure. Every word of what they ASSERT is unchanged: the shell
 * supplies the inset, it is ONE value, the full-bleed opt-out is real, and no renderer re-adds a
 * pane-level inset of its own. `pane-chrome.spec.ts` is what pins the move itself.
 *
 * The defect: `RegionShell`'s `PaneBody` applied NO padding — it was layout only — so the inset
 * was a per-renderer decision with no owner, and the renderers disagreed. Counted across the pane
 * renderers and the declarative render surfaces before this: `p-2`×14, `p-4`×6, `p-6`×4, `p-1`×1,
 * plus assorted `px-*`/`py-*`. Every new pane picked a value, so the drift re-created itself by
 * construction.
 *
 * WHY THIS IS MEASURED, NOT ASSERTED ON CLASSES. Tailwind is not compiled in jsdom and no layout
 * is performed there, so a class-string assertion passes for whatever the class happens to mean —
 * and passes just as happily for a class that no longer exists. `p-2` vs `p-4` is a LAYOUT fact.
 *
 * WHY THE COVERAGE IS DERIVED FROM THE REGISTRY. A hand-written kind list is exactly how this
 * drifts again: the next pane kind is added, nobody remembers the list, and the new pane invents
 * its own inset. The kind vocabulary + the full-bleed opt-out are read at RUNTIME off the
 * registry (`window.__workbenchPanes.kinds()` / `.fullBleed()`), and the surface renders one
 * frame per registry kind — so a kind added tomorrow is asserted tomorrow, and a kind the surface
 * failed to render fails the first test rather than being silently uncovered.
 *
 * Run standalone (backend-free; use a dedicated port on a shared box):
 *   GALLERY_PORT=1479 npx playwright test -c playwright.visual.config.ts pane-inset.spec.ts
 */
import { expect, test } from '@playwright/test'
import { openGallery } from './_gallery'

const SURFACE = 'workbench-pane-inset'

/** `paneModel.tsx`'s `PANE_CONTENT_PADDING` (`p-2`) in px. A LITERAL — the spec runs under a
 *  plain node loader that cannot resolve the app's CSS imports, so `src/` is not importable here
 *  (the same reason `declarative-layout.spec.ts` keeps its own literals). Being a literal is also
 *  what makes it a control: re-deriving the expected value from the code under test would assert
 *  nothing about WHICH value was chosen. */
const PANE_PAD_PX = 8

/** The kind the opt-out exists FOR. Asserted as a literal so the full-bleed set cannot silently
 *  empty out and leave every "is it full-bleed?" branch below vacuous. */
const FULL_BLEED_CONTROL = 'canvas'

/** Sub-pixel tolerance for a computed-length comparison. */
const TOL = 0.5

interface PaneInset {
  kind: string
  fullBleed: boolean
  /** The pane CONTENT REGION's own computed padding — the shell's inset. */
  pad: { top: number; right: number; bottom: number; left: number } | null
  /** The renderer's OWN root (the pane body's last element child) padding. A renderer that
   *  re-adds a pane-level inset around its content is the drift this work removes, and it is
   *  invisible to a measurement of the pane body alone. */
  rendererRootPad: { top: number; right: number; bottom: number; left: number } | null
  rendererRootTag: string | null
}

async function readInsets(page: import('@playwright/test').Page): Promise<PaneInset[]> {
  return page.evaluate(() => {
    const seam = (window as unknown as {
      __workbenchPanes?: { kinds?: () => string[]; fullBleed?: (k: string) => boolean }
    }).__workbenchPanes
    const kinds = seam?.kinds?.() ?? []
    const box = (el: Element) => {
      const s = getComputedStyle(el)
      return {
        top: parseFloat(s.paddingTop),
        right: parseFloat(s.paddingRight),
        bottom: parseFloat(s.paddingBottom),
        left: parseFloat(s.paddingLeft),
      }
    }
    return kinds.map(kind => {
      // The pane's CONTENT REGION — the shell's inset lives here (see the header). The renderer's
      // own root is this element's last child; before the move it was the body's, and reading the
      // body's now would return the content region itself and report the shell's inset as a
      // renderer's.
      const body = document.querySelector(`[data-testid="region-pane-content-inset-${kind}"]`)
      const root = body ? (body.lastElementChild as Element | null) : null
      return {
        kind,
        fullBleed: seam?.fullBleed?.(kind) ?? false,
        pad: body ? box(body) : null,
        rendererRootPad: root ? box(root) : null,
        rendererRootTag: root ? root.tagName.toLowerCase() : null,
      }
    })
  })
}

/**
 * Open the surface and wait until every pane has actually MOUNTED ITS RENDERER.
 *
 * Every pane kind is code-split (`panes.tsx::lazyPane`), so "the surface is visible" and "the
 * panes are rendered" are different moments — and the padding of a Suspense placeholder is not
 * the padding of the renderer it stands in for. Waiting for `workbench-pane-loading` to reach 0
 * is NOT sufficient on its own: before the first Suspense boundary suspends, that count is
 * already 0, so a measurement taken then reads the pre-mount tree. So this settles on the
 * MEASUREMENT itself — two consecutive identical readings, with every kind present.
 */
async function openSettled(page: import('@playwright/test').Page): Promise<PaneInset[]> {
  await openGallery(page, { surface: SURFACE })
  await expect(page.getByTestId('workbench-gallery-frame')).toBeVisible({ timeout: 30_000 })
  let prev = ''
  let last: PaneInset[] = []
  await expect
    .poll(
      async () => {
        const cur = await readInsets(page)
        const loading = await page.getByTestId('workbench-pane-loading').count()
        const json = JSON.stringify(cur)
        const settled =
          cur.length > 0 && loading === 0 && cur.every(p => p.pad && p.rendererRootTag) && json === prev
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
test('every pane kind in the REGISTRY is rendered by the inset surface', async ({ page }) => {
  await openGallery(page, { surface: SURFACE })
  const kinds = await page.evaluate(
    () =>
      (window as unknown as { __workbenchPanes?: { kinds?: () => string[] } }).__workbenchPanes?.kinds?.() ??
      [],
  )
  expect(
    kinds.length,
    'the pane-kind registry seam published nothing — every assertion below would be vacuous',
  ).toBeGreaterThan(0)
  expect(kinds, 'the opt-out control kind is not in the registry').toContain(FULL_BLEED_CONTROL)

  for (const kind of kinds) {
    await expect(
      page.getByTestId(`pane-inset-frame-${kind}`),
      `the gallery surface renders no frame for pane kind "${kind}" — it is in the registry and ` +
        'therefore in production, so it must be measured here rather than silently uncovered',
    ).toHaveCount(1)
    await expect(
      page.getByTestId(`region-pane-body-inset-${kind}`),
      `pane kind "${kind}" mounted no pane body`,
    ).toHaveCount(1)
    await expect(
      page.getByTestId(`region-pane-content-inset-${kind}`),
      `pane kind "${kind}" mounted no pane content region — that is where the shell's inset is`,
    ).toHaveCount(1)
  }
})

test.slow()
test('the SHELL supplies the pane content inset — one value, for every kind', async ({ page }) => {
  const insets = await openSettled(page)
  expect(insets.length, 'no pane kinds were measured').toBeGreaterThan(0)

  const offenders: string[] = []
  for (const p of insets) {
    if (!p.pad) {
      offenders.push(`${p.kind}: no pane content region`)
      continue
    }
    const want = p.fullBleed ? 0 : PANE_PAD_PX
    const sides = [p.pad.top, p.pad.right, p.pad.bottom, p.pad.left]
    if (sides.some(v => Math.abs(v - want) > TOL)) {
      offenders.push(
        `${p.kind} (${p.fullBleed ? 'full-bleed' : 'inset'}): padding ` +
          `${sides.map(v => `${v}px`).join('/')}, expected ${want}px on all four sides`,
      )
    }
  }
  expect(
    offenders,
    'the pane content region is where a pane\'s content inset comes from. These panes do not carry ' +
      'it, so ' +
      'their content is inset by whatever their renderer happened to choose (or by nothing):\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)

  // …and it is ONE value, stated as a set rather than implied by the loop above: a future
  // per-kind override would satisfy every line if the expectation were derived per kind.
  const distinct = [...new Set(insets.filter(p => !p.fullBleed).map(p => p.pad!.left))]
  expect(
    distinct,
    `the inset panes carry ${distinct.length} different insets (${distinct.join(', ')}px) — the ` +
      'whole point of moving it to the shell is that there is exactly one',
  ).toEqual([PANE_PAD_PX])
})

test.slow()
test('the full-bleed opt-out is declared per KIND, and it is real', async ({ page }) => {
  const insets = await openSettled(page)

  const declared = insets.filter(p => p.fullBleed).map(p => p.kind)
  // POSITIVE CONTROL. Without it, an implementation that never opts anything out passes every
  // "full-bleed ⇒ 0" clause vacuously — and the canvas grid is the surface the opt-out exists for.
  expect(
    declared,
    'no pane kind declares the full-bleed opt-out, so "the canvas grid must not gain padding" is ' +
      'untested — the opt-out is declared at the RENDERER REGISTRATION (paneModel/panes.tsx)',
  ).toContain(FULL_BLEED_CONTROL)

  const canvas = insets.find(p => p.kind === FULL_BLEED_CONTROL)!
  expect(
    canvas.pad!.left,
    'the canvas pane is declared full-bleed but the shell still insets it',
  ).toBeLessThanOrEqual(TOL)

  // NEGATIVE CONTROL: the opt-out is not a blanket. At least one kind must still be inset, or
  // "full-bleed" would just be "no padding anywhere" wearing a name.
  expect(
    insets.filter(p => !p.fullBleed).length,
    'every pane kind opted out of the inset — that is not an opt-out, it is the old defect',
  ).toBeGreaterThan(0)
})

test.slow()
test('no renderer re-adds a pane-level inset of its own', async ({ page }) => {
  // The half a pane-body measurement cannot see. The shell now supplies the inset; a renderer
  // whose own root ALSO pads doubles it, which is the drift this work removes rather than moves.
  const insets = await openSettled(page)

  const offenders: string[] = []
  for (const p of insets) {
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
          `INSIDE the shell's ${PANE_PAD_PX}px`,
      )
    }
  }
  expect(
    offenders,
    'these renderers still supply their own pane-level inset on top of the shell\'s:\n  ' +
      offenders.join('\n  '),
  ).toHaveLength(0)
})
