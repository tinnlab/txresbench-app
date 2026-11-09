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

  test('the shell header keeps every destination on-screen at 390 px (X2)', async ({ page }) => {
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
    // Every destination stays inside the viewport (X2's "History and Help
    // fall off-screen" bug).
    for (const label of ['New analysis', 'Models', 'History', 'Help']) {
      const link = page.locator('.txr-shell a', { hasText: label }).first()
      const box = await link.boundingBox()
      expect(box, `${label} must be on-screen`).not.toBeNull()
      expect(box!.x, `${label} starts inside`).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width, `${label} ends inside`).toBeLessThanOrEqual(390 + 1)
    }
    // The theme switch (qa-fixes2 ITEM-1) joins the stacked header row: it
    // stays on-screen, its label collapses and the icon alone carries the
    // state — the same yield rule as the tagline.
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
