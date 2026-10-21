import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * native-controls (RENDERED-DOM half) — every control in the live DOM is a KIT control.
 *
 * ── WHY A SECOND HALF ─────────────────────────────────────────────────────────
 * `scripts/lint-native-controls.mjs` is the cheap half: a regex over first-party JSX.
 * It cannot see `React.createElement('button')`, a control produced by a dependency,
 * an element built from a variable tag, or anything rendered rather than written. This
 * repo has twice paid for guards that read SOURCE TEXT and lost — the activity rail's
 * static analyser (20 audit rounds, never converged) and `gate-ui`'s port guard — so
 * the rule is ALSO asserted on state: what is actually in the document after a render.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────────
 * Every kit control stamps `data-slot` on the element it renders (`data-slot="button"`,
 * `"input"`, …). So: for every gallery surface, every `button`/`input`/`select`/
 * `textarea` in the rendered DOM carries a `data-slot`. A hand-rolled control carries
 * none — regardless of how it was written.
 *
 * Two allowances, both narrow and both about elements NOBODY interacts with:
 *   - `aria-hidden="true"` — the form shims the kit itself renders (shadcn's Select
 *     emits a hidden native `<select>` so a plain form POST still works) and the
 *     invisible menu anchors this app uses to position a context menu.
 *   - `type="hidden"` inputs — never focusable, never styled, not a control.
 *
 * ── SHRINK-ONLY, like its source twin ─────────────────────────────────────────
 * Known offenders live in `native-controls-dom-baseline.json` keyed
 * `<surface>|<tag>`. A NEW unstamped control fails. A STALE entry fails too, so the
 * ledger cannot rot into decoration. Regenerate after a genuine fix:
 *   NATIVE_CONTROLS_DOM_WRITE=1 npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/native-controls.spec.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASELINE = path.join(__dirname, 'native-controls-dom-baseline.json')

interface Unstamped {
  tag: string
  id: string
  cls: string
  text: string
}

/** Surfaces the gallery's own registry knows about, read from the browse canvas. */
async function allSurfaces(page: import('@playwright/test').Page): Promise<string[]> {
  await page.goto('/gallery.html')
  await page.waitForFunction(() => typeof (window as never as Record<string, unknown>).__GALLERY_LIST_ALL_SURFACES__ === 'function', null, { timeout: 60_000 })
  // The page list is read from the browse DOM, so give the router store a beat to fill it.
  await expect
    .poll(
      async () =>
        page.evaluate(() => document.querySelectorAll('[data-testid^="gallery-page-"]').length),
      { timeout: 60_000, message: 'the gallery browse canvas never listed a page surface' },
    )
    .toBeGreaterThan(0)
  const classes = await page.evaluate(() =>
    (
      window as never as {
        __GALLERY_LIST_ALL_SURFACES__: () => {
          pages: string[]
          overlays: string[]
          deep: string[]
          seeded: string[]
        }
      }
    ).__GALLERY_LIST_ALL_SURFACES__(),
  )
  return [...new Set([...classes.pages, ...classes.overlays, ...classes.deep, ...classes.seeded])]
}

/**
 * Native controls in the document: how many there are IN TOTAL, and which of them carry
 * no `data-slot` (minus the allowances). The total is returned because "0 unstamped" is
 * only meaningful next to "and it looked at N controls" — a selector that matched nothing
 * would otherwise report a perfect score forever.
 */
async function scanControls(
  page: import('@playwright/test').Page,
): Promise<{ total: number; unstamped: Unstamped[] }> {
  return page.$$eval('button, input, select, textarea', els => ({
    total: els.length,
    unstamped: els
      .filter(el => !el.hasAttribute('data-slot'))
      .filter(el => el.getAttribute('aria-hidden') !== 'true')
      .filter(el => (el as HTMLInputElement).type !== 'hidden')
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute('data-testid') ?? '',
        cls: (el.getAttribute('class') ?? '').slice(0, 80),
        text: (el.textContent ?? '').trim().slice(0, 60),
      })),
  }))
}

/**
 * The floor that makes a clean sweep mean something. Measured on this tree: the sweep
 * sees well over a thousand controls across 94 surfaces. If a refactor makes the query
 * match (almost) nothing, this fails instead of reporting a flawless run.
 */
const MIN_CONTROLS_SEEN = 300

test.describe('every rendered control is a kit control', () => {
  /**
   * POSITIVE CONTROL — the sweep below reports zero, so the FIRST thing that has to be
   * true is that the detector can report anything at all. A guard whose clean result has
   * never been shown to differ from its dirty result is not evidence.
   *
   * This also pins the two allowances, which is where a silent hole would open: widen
   * `aria-hidden`/`type=hidden` into "anything hidden" and the guard stops seeing a
   * `className="hidden"` hand-rolled button.
   */
  test('the detector reports a hand-rolled control and honours exactly two allowances', async ({
    page,
  }) => {
    await page.goto('/gallery.html')
    await page.evaluate(() => {
      const mk = (html: string) => {
        const d = document.createElement('div')
        d.innerHTML = html
        document.body.appendChild(d.firstElementChild as Element)
      }
      mk('<button type="button" data-testid="probe-raw-button">raw</button>')
      mk('<input data-testid="probe-raw-input" />')
      mk('<button type="button" data-slot="button" data-testid="probe-kit-button">kit</button>')
      mk('<button type="button" aria-hidden="true" data-testid="probe-aria-hidden">anchor</button>')
      mk('<input type="hidden" data-testid="probe-hidden-input" />')
      // A hand-rolled control that merely LOOKS hidden must still be reported — this is
      // the allowance-widening mistake, pinned.
      mk('<button type="button" class="hidden" data-testid="probe-class-hidden">sneaky</button>')
    })

    const { total, unstamped } = await scanControls(page)
    expect(total, 'the probes were not even in the document').toBeGreaterThanOrEqual(6)
    const ids = unstamped.map(u => u.id)
    expect(ids).toContain('probe-raw-button')
    expect(ids).toContain('probe-raw-input')
    expect(ids).toContain('probe-class-hidden')
    expect(ids).not.toContain('probe-kit-button')
    expect(ids).not.toContain('probe-aria-hidden')
    expect(ids).not.toContain('probe-hidden-input')
  })

  test('no gallery surface renders a native control without `data-slot`', async ({ page }) => {
    test.setTimeout(15 * 60_000)

    const surfaces = await allSurfaces(page)
    expect(
      surfaces.length,
      'the surface enumeration collapsed — a sweep over nothing is not a pass',
    ).toBeGreaterThan(20)

    /** `<surface>|<tag>` → count. */
    const observed: Record<string, number> = {}
    const detail: Record<string, Unstamped[]> = {}
    let controlsSeen = 0

    for (const slug of surfaces) {
      await page.goto(`/gallery.html?surface=${slug}`)
      // The surface frame is the render signal; a surface that never mounts contributes
      // nothing and must not silently read as clean.
      await page
        .waitForSelector(`[data-testid="gallery-page-${slug}"]`, { timeout: 30_000 })
        .catch(() => null)
      const { total, unstamped } = await scanControls(page)
      controlsSeen += total
      for (const h of unstamped) {
        const key = `${slug}|${h.tag}`
        observed[key] = (observed[key] ?? 0) + 1
        ;(detail[key] ??= []).push(h)
      }
    }
    console.log(
      `native-controls(DOM): ${surfaces.length} surface(s), ${controlsSeen} control(s) inspected, ` +
        `${Object.values(observed).reduce((a, b) => a + b, 0)} unstamped`,
    )
    expect(
      controlsSeen,
      `the sweep inspected only ${controlsSeen} control(s) (< ${MIN_CONTROLS_SEEN}) — a query that ` +
        'matches nothing reports a flawless run forever',
    ).toBeGreaterThanOrEqual(MIN_CONTROLS_SEEN)

    if (process.env.NATIVE_CONTROLS_DOM_WRITE) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(
        BASELINE,
        `${JSON.stringify(
          {
            $comment:
              'Native controls rendered WITHOUT a kit `data-slot`, per gallery surface. ' +
              'SHRINK-ONLY: a new one fails, a stale entry fails. Regenerate with ' +
              'NATIVE_CONTROLS_DOM_WRITE=1 after a genuine fix — never to make a red run green.',
            surfaces: surfaces.length,
            total: Object.values(observed).reduce((a, b) => a + b, 0),
            entries: Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b))),
          },
          null,
          2,
        )}\n`,
      )
      return
    }

    let committed: Record<string, number> = {}
    try {
      committed = JSON.parse(readFileSync(BASELINE, 'utf8')).entries ?? {}
    } catch {
      committed = {}
    }

    const added = Object.entries(observed)
      .filter(([k, n]) => n > (committed[k] ?? 0))
      .map(([k, n]) => `NEW   ${k}  (${n}, ledger allows ${committed[k] ?? 0})  ${JSON.stringify(detail[k]?.slice(0, 3))}`)
    const stale = Object.entries(committed)
      .filter(([k, n]) => (observed[k] ?? 0) < n)
      .map(([k, n]) => `STALE ${k}  (ledger says ${n}, only ${observed[k] ?? 0} remain)`)

    expect(
      [...added, ...stale].join('\n'),
      'A control rendered without a kit `data-slot` is a hand-rolled control: no tokens, no ' +
        'focus ring, no disabled/invalid states, and nothing for the e2e/visual tiers to select ' +
        'on. Use the kit control. After a genuine fix, re-derive the ledger with ' +
        'NATIVE_CONTROLS_DOM_WRITE=1.',
    ).toBe('')
  })
})
