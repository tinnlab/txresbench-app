import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * TEST-QF-7 (phone + dark arms) — every txr surface at 390 px, and the dark
 * palette's "no light-only colour" byte, driven through the gallery harness
 * (backend-free: the module cassettes answer the real pages).
 *
 *  · 390 arm (X2/RES-26/anywhere): each txr page/seeded/overlay surface is
 *    rendered at the board's mobile width; the surface's own content must fit
 *    its frame (a page that needs sideways scroll grows the frame's
 *    scrollWidth — the frame's `overflow-hidden` clips it visually, which is
 *    exactly the defect class; an internal scroll box like the heatmap's does
 *    NOT grow the frame). The shell header gets its own story
 *    (`txr-shell-narrow-390`, the only surface that can mount the shell — the
 *    page frames mount page components without the app router's layout).
 *  · dark arm (X3/CM-5/RP-11/RES-25): `?theme=dark` drives the REAL app
 *    ThemeProvider (`.dark` on <html>); then no element of a txr surface may
 *    carry a computed colour from the theme's LIGHT-only set (parsed from
 *    `src/assets/txr-theme.css` — the one file where the light bytes live).
 *    The chance-cell ramp is asserted through its light base as well. Tokens
 *    that are deliberately theme-neutral (white text on saturated cells, the
 *    danger button's white label) are equal in both blocks, so the list never
 *    contains them.
 *
 * Run (own port on a shared box — the config derives one per worktree):
 *   npx playwright test -c playwright.gallery.config.ts \
 *     tests/gallery-e2e/txr-theme-phone.spec.ts
 */
const GALLERY = '/gallery.html'
const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The gallery's module graph is transformed ON DEMAND by Vite: the first
// render on a freshly booted server pays the whole graph's transform —
// minutes on a loaded box. This backend-free spec opts into its own budget
// rather than inheriting the config's 120 s fast-loop cap.
test.setTimeout(900_000)

/** The :root / .dark token blocks of the app's theme file. */
function tokenBlock(css: string, selector: string): Map<string, string> {
  const re = new RegExp(`${selector}\\s*\\{([^}]*)\\}`)
  const body = re.exec(css)?.[1] ?? ''
  const out = new Map<string, string>()
  for (const m of body.matchAll(/(--txr-[a-z-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

/**
 * The light-only serialized colours: a theme token whose value does NOT
 * also appear in the dark block. The equality is by VALUE, not per-token:
 * `--txr-surface` is #ffffff in light while `--txr-on-chance` /
 * `--txr-on-danger` are #ffffff in BOTH blocks, so a computed white in dark
 * is the legitimate text of a saturated chance/danger cell — a per-token
 * check would flag every heatmap cell. A value present somewhere in the
 * dark block is theme-settled either way, so only values with no dark
 * occurrence are light-only.
 */
function lightOnlyColors(): { rgb: Set<string>; chanceBase: string } {
  const css = readFileSync(resolve(UI, 'src', 'assets', 'txr-theme.css'), 'utf8')
  const light = tokenBlock(css, ':root')
  const dark = tokenBlock(css, '\\.dark')
  const darkValues = new Set(dark.values())
  const rgb = new Set<string>()
  for (const [token, value] of light) {
    if (darkValues.has(value)) continue
    const m = /^#([0-9a-f]{6})$/i.exec(value)
    if (!m) continue
    const full = m[1]
    rgb.add(
      `rgb(${[0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).join(', ')})`,
    )
  }
  return { rgb, chanceBase: light.get('--txr-chance-rgb') ?? '' }
}

/** Enumerate the txr surfaces of all four classes (the gallery's own registry). */
async function txrSurfaces(page: Page): Promise<Array<{ slug: string; cls: string }>> {
  await page.goto(GALLERY, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  const classes = await page.evaluate(() => {
    const fn = (window as unknown as { __GALLERY_LIST_ALL_SURFACES__?: () => unknown }).__GALLERY_LIST_ALL_SURFACES__
    if (typeof fn === 'function') {
      const r = fn() as Record<string, string[]>
      return r
    }
    return { pages: [], overlays: [], deep: [], seeded: [] }
  })
  const out: Array<{ slug: string; cls: string }> = []
  for (const [cls, list] of Object.entries(classes)) {
    // The `interactions` class entries are recipe objects, not slug strings —
    // the four surface classes above carry every surface.
    if (cls === 'interactions') continue
    for (const slug of list ?? []) if (slug.startsWith('txr-')) out.push({ slug, cls })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/** The per-surface URL (state only for data-state pages / open overlays). */
function surfaceUrl(slug: string, cls: string, dark: boolean): string {
  const p = new URLSearchParams({ surface: slug })
  if (cls === 'page') p.set('state', 'loaded')
  else if (cls === 'overlay') p.set('state', 'open')
  if (dark) p.set('theme', 'dark')
  return `${GALLERY}?${p.toString()}`
}

/** The settle delay (seeded/deep run a mount-time store seed). */
function settleOf(cls: string): number {
  return cls === 'seeded' || cls === 'deep' ? 2600 : 900
}

test.describe('txr surfaces at 390 px (TEST-QF-7, X2/RES-26)', () => {
  test('no page surface forces horizontal scroll at the board\'s phone width', async ({ page }) => {
    const surfaces = await txrSurfaces(page)
    expect(surfaces.length).toBeGreaterThan(20)
    await page.setViewportSize({ width: 390, height: 844 })
    const failures: string[] = []
    for (const { slug, cls } of surfaces) {
      await page.goto(surfaceUrl(slug, cls, false), { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(settleOf(cls))
      const overflow = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('[data-gallery-frame]')
        if (!frame) return null
        return frame.scrollWidth - frame.clientWidth
      })
      if (overflow === null || overflow > 1) failures.push(`${slug}: ${overflow ?? 'no frame'}px`)
    }
    expect(failures, 'txr surfaces overflowing their 390 px frame').toEqual([])
  })

  test('the shell header keeps every destination reachable at 390 px (X2, single row)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(surfaceUrl('txr-shell-narrow-390', 'seeded', false), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForTimeout(2600)
    const narrow = page.getByTestId('txr-shell-narrow')
    await expect(narrow).toBeVisible()
    const overflow = await narrow.evaluate(el => el.scrollWidth - el.clientWidth)
    expect(overflow, 'the 390 px shell frame').toBeLessThanOrEqual(1)
    // The tagline yields (the longest byte, the least-needed one).
    const tagline = await page
      .locator('.txr-shell-tagline')
      .evaluate(el => getComputedStyle(el).display)
    expect(tagline).toBe('none')
    // ONE header row (ITEM-6 c): the brand, the nav and the theme switch
    // share one centre line, in a single 56 px row — never the wrapped
    // second line the old stack produced.
    const m = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.txr-shell-header')!
      const brand = header.querySelector<HTMLElement>('.txr-shell-brand')!
      const nav = document.querySelector<HTMLElement>('.txr-shell-nav')!
      const toggle = document.querySelector<HTMLElement>('[data-testid="txr-theme-toggle"]')!
      const r = (el: Element) => el.getBoundingClientRect()
      return {
        headerHeight: r(header).height,
        brand: r(brand),
        nav: r(nav),
        toggle: r(toggle),
      }
    })
    expect(m.headerHeight).toBeLessThanOrEqual(60)
    const centres = [m.brand, m.nav, m.toggle].map(box => box.y + box.height / 2)
    for (const centre of centres) {
      expect(Math.abs(centre - centres[0]), 'one header row').toBeLessThanOrEqual(4)
    }
    // The nav strip scrolls (not every destination is on-screen at once) and
    // each destination is REACHABLE: focusing it scrolls the strip to it.
    for (const label of ['New analysis', 'Models', 'History', 'Help']) {
      const link = page.locator('.txr-shell a', { hasText: label }).first()
      await link.focus()
      const box = await link.boundingBox()
      expect(box, `${label} must be reachable`).not.toBeNull()
      expect(box!.x, `${label} starts inside`).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width, `${label} ends inside`).toBeLessThanOrEqual(390 + 1)
    }
    // The theme switch (qa-fixes2 ITEM-1) stays on-screen; its label
    // collapses and the icon alone carries the state — the same yield rule
    // as the tagline.
    const toggle = page.getByTestId('txr-theme-toggle')
    await expect(toggle).toBeVisible()
    const toggleBox = await toggle.boundingBox()
    expect(toggleBox, 'the theme switch must be on-screen').not.toBeNull()
    expect(toggleBox!.x, 'starts inside').toBeGreaterThanOrEqual(0)
    expect(toggleBox!.x + toggleBox!.width, 'ends inside').toBeLessThanOrEqual(390 + 1)
    await expect(
      page.locator('.txr-theme-toggle .txr-theme-toggle-label').evaluate(
        el => getComputedStyle(el).display,
      ),
    ).resolves.toBe('none')
    await expect(toggle.locator('svg')).toBeVisible()
  })

  test('the header is one row from 360 to 768 px, no wrapping, no overflow (ITEM-6 c)', async ({ page }) => {
    for (const width of [360, 390, 414, 768]) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`${surfaceUrl('txr-shell-narrow-390', 'seeded', false)}&w=${width}`, {
        waitUntil: 'domcontentloaded',
      })
      await page.waitForTimeout(2600)
      const narrow = page.getByTestId('txr-shell-narrow')
      await expect(narrow).toBeVisible()
      const frameWidth = Math.round(
        await narrow.evaluate(el => el.getBoundingClientRect().width),
      )
      // The story never renders WIDER than the requested width (the gallery
      // frame is the host's, and it leaves ~82 px of chrome on this host —
      // measured: 276/306/330/684 at 360/390/414/768 — so the equal-width
      // pin would be a pin on the HOST, not the shell). What the browser
      // tier drives is the viewport: the media rules the header follows are
      // the window's, which page.setViewportSize sets to `width` above.
      expect(frameWidth, `the shell box at ${width} px`).toBeGreaterThan(0)
      expect(frameWidth, `the shell box never exceeds ${width} px`).toBeLessThanOrEqual(width)
      const m = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>('.txr-shell-header')!
        const brand = header.querySelector<HTMLElement>('.txr-shell-brand')!
        const nav = document.querySelector<HTMLElement>('.txr-shell-nav')!
        const toggle = document.querySelector<HTMLElement>('[data-testid="txr-theme-toggle"]')!
        const r = (el: Element) => el.getBoundingClientRect()
        return {
          headerHeight: r(header).height,
          brand: r(brand),
          nav: r(nav),
          toggle: r(toggle),
          tagline: getComputedStyle(header.querySelector<HTMLElement>('.txr-shell-tagline')!)
            .display,
          narrowOverflow: (() => {
            const frame = document.querySelector<HTMLElement>('[data-testid="txr-shell-narrow"]')!
            return frame.scrollWidth - frame.clientWidth
          })(),
          frameOverflow: (() => {
            const frame = document.querySelector<HTMLElement>('[data-gallery-frame]')!
            return frame.scrollWidth - frame.clientWidth
          })(),
        }
      })
      // ONE row at every width: the header carries its 56 px byte and the
      // three clusters share one centre line; the tagline yielded below 900.
      expect(m.headerHeight, `header one row at ${width}`).toBeLessThanOrEqual(60)
      const centres = [m.brand, m.nav, m.toggle].map(box => box.y + box.height / 2)
      for (const centre of centres) {
        expect(Math.abs(centre - centres[0]), `one row at ${width}`).toBeLessThanOrEqual(4)
      }
      expect(m.tagline).toBe('none')
      // Never a shell or frame overflow at any of the four widths.
      expect(m.narrowOverflow, `no shell overflow at ${width}`).toBeLessThanOrEqual(1)
      expect(m.frameOverflow, `no frame overflow at ${width}`).toBeLessThanOrEqual(1)
      // Every destination is REACHABLE: the strip scrolls to the focused
      // link. The gallery host clamps the story's box to viewport − 84 px
      // (measured 276/306/330/684 at 360/390/414/768), so at the narrow
      // widths the box is narrower than the widest link (107 px) and the
      // browser's focus scroll (which scrolls only an element that is
      // fully out of view) leaves the leftmost link intersecting — the
      // honest byte is intersection, plus the strip's real scroll: the
      // last destination needs a scroll (> 0) where the content outgrows
      // the box, and none at 768 where everything fits. At the REAL
      // widths the strip is ≥ 154 px (flex math: box − 206 px) and the
      // full-containment byte belongs to the real-app tier (X2).
      const navBox = await page.locator('.txr-shell-nav').boundingBox()
      expect(navBox).not.toBeNull()
      let scrolledToLast = false
      for (const label of ['New analysis', 'Models', 'History', 'Help']) {
        const link = page.locator('.txr-shell a', { hasText: label }).first()
        await link.focus()
        const box = await link.boundingBox()
        expect(box, `${label} reachable at ${width}`).not.toBeNull()
        expect(box!.x + box!.width, `${label} visible in the strip at ${width}`).toBeGreaterThan(
          navBox!.x,
        )
        expect(box!.x, `${label} visible in the strip at ${width}`).toBeLessThan(
          navBox!.x + navBox!.width,
        )
        if (label === 'Help') {
          scrolledToLast =
            (await page.locator('.txr-shell-nav').evaluate(el => el.scrollLeft)) > 0
        }
      }
      // The strip really scrolls where the content outgrows it — a keyboard
      // user must be able to reach the last destination.
      expect(scrolledToLast, `the strip scrolls to the last item at ${width}`).toBe(
        width <= 640,
      )
      // The theme switch: on-screen; below 640 its label collapses to the
      // icon (above, the label is part of the single row).
      const toggle = page.getByTestId('txr-theme-toggle')
      const toggleBox = await toggle.boundingBox()
      expect(toggleBox).not.toBeNull()
      expect(toggleBox!.x + toggleBox!.width, `toggle inside at ${width}`).toBeLessThanOrEqual(
        width + 1,
      )
      const labelDisplay = await page
        .locator('.txr-theme-toggle .txr-theme-toggle-label')
        .evaluate(el => getComputedStyle(el).display)
      // Below 640 the switch is icon-only (the strip's row byte); at 768 the
      // label is part of the single row.
      expect(labelDisplay === 'none', `toggle label at ${width}`).toBe(width <= 640)
    }
  })
})

test.describe('the dark palette (TEST-QF-7, X3/CM-5/RES-25)', () => {
  test('no txr surface keeps a light-only colour under the dark theme', async ({ page }) => {
    const { rgb: lightRgb, chanceBase } = lightOnlyColors()
    expect(lightRgb.size).toBeGreaterThan(18)
    const surfaces = await txrSurfaces(page)
    expect(surfaces.length).toBeGreaterThan(20)
    const failures: string[] = []
    for (const { slug, cls } of surfaces) {
      await page.goto(surfaceUrl(slug, cls, true), { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(settleOf(cls))
      const hit = await page.evaluate(
        ({ lightRgb, chanceBase }) => {
          const isDark = document.documentElement.classList.contains('dark')
          if (!isDark) return ['theme not applied']
          const scope = new Set<Element>()
          for (const el of document.querySelectorAll('[data-testid^="txr-"], .txr-shell')) {
            scope.add(el)
            for (const d of el.querySelectorAll('*')) scope.add(d)
          }
          const props = [
            'color',
            'backgroundColor',
            'borderTopColor',
            'borderBottomColor',
            'borderLeftColor',
            'borderRightColor',
            'outlineColor',
          ] as const
          const out: string[] = []
          for (const el of scope) {
            const cs = getComputedStyle(el)
            for (const prop of props) {
              const v = cs[prop]
              if (lightRgb.includes(v)) out.push(`${el.tagName}.${el.className} ${prop}=${v}`)
              else if (chanceBase && v.startsWith(`rgba(${chanceBase},`))
                out.push(`${el.tagName}.${el.className} ${prop}=${v} (light chance base)`)
            }
          }
          return out.slice(0, 6)
        },
        { lightRgb: [...lightRgb], chanceBase },
      )
      if (hit.length > 0) failures.push(`${slug}: ${hit.join(' | ')}`)
    }
    expect(failures, 'light-only colours under the dark theme').toEqual([])
  })
})
