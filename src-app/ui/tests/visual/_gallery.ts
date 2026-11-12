// Shared helpers for the Layer-A visual specs (declarative-rendering-hardening ITEM-14).
// Adapted from `@txresbench/gallery`'s `playwright/templates/_gallery.template.ts`, with the
// template's fixed sleeps replaced by real readiness CONDITIONS — a spec that loops over 12
// surfaces cannot afford 6s of unconditional waiting per surface (it blew the 60s per-test
// budget), and a condition is more robust than a sleep anyway.
//
// These live under `tests/visual/` (NOT `tests/e2e/visual/`) on purpose: the app's
// `playwright.config.ts` has `testDir: './tests/e2e'` with no ignore, so a spec under
// `tests/e2e/**` would be swept into the FULL backend e2e run (cargo build + Postgres +
// vite preview). These specs are backend-free and must only ever run under
// `playwright.visual.config.ts`.

import { expect, type Page } from '@playwright/test'

/** Standalone gallery URL — override via GALLERY_URL if the app serves it elsewhere. */
export const STANDALONE_PATH = process.env.GALLERY_URL || '/gallery.html'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export interface SurfaceClasses {
  pages: string[]
  overlays: string[]
  deep: string[]
  seeded: string[]
}

/** Build a `?surface=&state=&theme=` gallery URL. */
export function galleryUrl(opts: { surface?: string; state?: string; theme?: Theme } = {}): string {
  const q = new URLSearchParams()
  if (opts.surface) q.set('surface', opts.surface)
  if (opts.state) q.set('state', opts.state)
  if (opts.theme) q.set('theme', opts.theme)
  const s = q.toString()
  return s ? `${STANDALONE_PATH}?${s}` : STANDALONE_PATH
}

function readSurfaces(page: Page): Promise<SurfaceClasses> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __GALLERY_LIST_ALL_SURFACES__?: () => Partial<SurfaceClasses>
    }
    const r = (typeof w.__GALLERY_LIST_ALL_SURFACES__ === 'function'
      ? w.__GALLERY_LIST_ALL_SURFACES__()
      : {}) as Partial<SurfaceClasses>
    return {
      pages: r.pages || [],
      overlays: r.overlays || [],
      deep: r.deep || [],
      seeded: r.seeded || [],
    }
  })
}

/** Navigate to the browse canvas and enumerate every surface class from the SAME runtime
 *  manifest `runtime-health.mjs` / `gate:ui` use — so a spec can never assert against a
 *  surface list the gate does not see. Polls for the manifest instead of sleeping. */
export async function listSurfaces(page: Page): Promise<SurfaceClasses> {
  await page.goto(STANDALONE_PATH, { waitUntil: 'domcontentloaded' })
  await expect
    .poll(async () => (await readSurfaces(page)).seeded.length, {
      message: 'the gallery never published its surface manifest',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  return readSurfaces(page)
}

/**
 * Open one surface and wait for it to actually MOUNT. When a `surface` is given we wait for
 * that surface's own frame (`gallery-page-<slug>`) rather than a fixed delay; otherwise we
 * wait for the gallery root.
 */
export async function openGallery(
  page: Page,
  opts: { surface?: string; state?: string; theme?: Theme } = {},
): Promise<void> {
  await page.goto(galleryUrl(opts), { waitUntil: 'domcontentloaded' })
  const target = opts.surface
    ? page.getByTestId(`gallery-page-${opts.surface}`)
    : page.getByTestId('gallery-root')
  await target.waitFor({ state: 'attached', timeout: 30_000 })
}
