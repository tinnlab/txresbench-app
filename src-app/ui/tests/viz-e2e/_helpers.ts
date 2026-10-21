import { type Page, expect } from '@playwright/test'

/** Open the Showcase and select a story by its registered id. */
export async function openStory(page: Page, storyId: string) {
  await page.goto('/viz-showcase.html', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="showcase-sidebar"]', { timeout: 20_000 })
  await page.click(`[data-testid="showcase-story-${storyId}"]`)
  // give deck.gl a couple frames to mount + draw
  await page.waitForTimeout(2500)
}

/** Toggle the showcase light/dark theme. */
export async function toggleTheme(page: Page) {
  await page.click('[data-testid="showcase-theme-toggle"]')
  await page.waitForTimeout(600)
}

/** Count non-blank pixels on the Nth canvas (0-based) — a render smoke check. */
export async function canvasNonBlank(page: Page, nth = 0): Promise<number> {
  return page.evaluate((n) => {
    const c = document.querySelectorAll('canvas')[n] as HTMLCanvasElement | undefined
    if (!c) return -1
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')!
    try {
      ctx.drawImage(c, 0, 0)
    } catch {
      return -2
    }
    const { data } = ctx.getImageData(0, 0, off.width, off.height)
    let n2 = 0
    for (let i = 0; i < data.length; i += 4 * 197) if (data[i + 3] > 10) n2++
    return n2
  }, nth)
}

/**
 * Downsampled pixel DIGEST of a WebGL canvas — for asserting the rendered IMAGE
 * actually CHANGED after an interaction (recolor / opacity / overlay toggle /
 * cluster reorder), not merely that a control's value flipped. Select the canvas
 * either by 0-based index (`nth`, default 0) or by a CSS selector matching the
 * canvas (or a container whose first descendant canvas is used).
 *
 * The digest is a deterministic rolling checksum over strided pixels PLUS a coarse
 * color histogram: identical renders yield an identical string; any changed pixel
 * (a recolor, an added overlay edge, a reordered row) perturbs it. So
 * `expect(before).not.toBe(after)` FAILS on a no-op toggle (an inert feature) and
 * PASSES only when the interaction really moved pixels.
 */
export async function canvasPixelSignature(
  page: Page,
  target: number | string = 0,
): Promise<string> {
  return page.evaluate((t) => {
    let c: HTMLCanvasElement | null = null
    if (typeof t === 'number') {
      c = (document.querySelectorAll('canvas')[t] as HTMLCanvasElement | undefined) ?? null
    } else {
      const el = document.querySelector(t)
      c = (el instanceof HTMLCanvasElement ? el : el?.querySelector('canvas') ?? null) as
        | HTMLCanvasElement
        | null
    }
    if (!c) return 'no-canvas'
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')!
    try {
      ctx.drawImage(c, 0, 0)
    } catch {
      return 'tainted'
    }
    const { data } = ctx.getImageData(0, 0, off.width, off.height)
    // 64-bucket (2-bits/channel) opaque-color histogram + a position-weighted checksum.
    const buckets = new Uint32Array(64)
    let checksum = 0
    let opaque = 0
    const step = 4 * 17 // prime stride → ~samples every 17th pixel, avoids alignment moiré
    for (let i = 0; i < data.length; i += step) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (data[i + 3] <= 10) continue
      opaque++
      buckets[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++
      checksum = (checksum + r * 3 + g * 5 + b * 7 + (i % 251)) >>> 0
    }
    return `${opaque}:${checksum.toString(16)}:${Array.from(buckets).join(',')}`
  }, target)
}

/** Assert at least one canvas rendered non-blank content. */
export async function expectSomeCanvasRendered(page: Page) {
  const count = await page.evaluate(() => document.querySelectorAll('canvas').length)
  expect(count, 'a WebGL canvas should be mounted').toBeGreaterThan(0)
  const nb = await canvasNonBlank(page, 0)
  expect(nb, 'the canvas should render non-blank pixels').toBeGreaterThan(0)
}

/** Collect console errors + page errors for the duration of a callback. */
export function trackErrors(page: Page): { errors: string[] } {
  const bag = { errors: [] as string[] }
  page.on('console', (m) => {
    if (m.type() === 'error') bag.errors.push(m.text())
  })
  page.on('pageerror', (e) => bag.errors.push('PAGEERR ' + e.message))
  return bag
}

/** Read a value off the story's `window.__VIZ_TEST__` hook. */
export async function vizTest<T = unknown>(page: Page, key: string): Promise<T> {
  return page.evaluate((k) => (window as unknown as { __VIZ_TEST__?: Record<string, unknown> }).__VIZ_TEST__?.[k] as T, key)
}

// ── driving a kit `<Select>` ────────────────────────────────────────────────────
//
// A kit `<Select>` is NOT a native `<select>` on either of its two arms: under
// `SELECT_SEARCH_THRESHOLD` options it is a Base-UI select (a `<button role="combobox">`
// + a PORTALED popup), at or over it a searchable popover (again a button). So
// `.selectOption()` and `.toHaveValue()` — which only work on `<select>`/`<input>` — fail
// on BOTH arms at ANY option count, and a spec written against them has not been
// exercising the control it names since the control stopped being native. These helpers
// exist so a spec drives the control the way a user does, and so the next threshold move
// changes nothing here: both arms stamp the same contract.
//
//   trigger    `[data-testid="<id>"]`             — a button carrying `aria-expanded`
//   popup      `[data-testid="<id>-popup"]`       — portaled to the body
//   option row `[data-testid="<id>-opt-<value>"]` — `role="option"`, with `aria-selected`
//
// Everything below keys on the option's VALUE, never its label: a label is copy and would
// couple these specs to wording they are not testing.

/** Open a kit `<Select>`'s popup (idempotent) and wait until it really is open. */
async function openKitSelect(page: Page, testid: string) {
  const trigger = page.getByTestId(testid)
  await trigger.waitFor({ state: 'visible', timeout: 20_000 })
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(trigger, `the ${testid} popup should open`).toHaveAttribute('aria-expanded', 'true')
  return trigger
}

/**
 * Choose `value` in a kit `<Select>` — the replacement for `.selectOption(value)`.
 *
 * Waits for the popup to close again, so a following assertion or a control that only
 * RENDERS once this choice commits (export's width/height inputs) cannot race it.
 */
export async function selectKitOption(page: Page, testid: string, value: string) {
  const trigger = await openKitSelect(page, testid)
  await page.getByTestId(`${testid}-opt-${value}`).click()
  await expect(trigger, `the ${testid} popup should close after choosing`).toHaveAttribute(
    'aria-expanded',
    'false',
  )
}

/**
 * Assert which option is CHOSEN — the replacement for `.toHaveValue(value)`.
 *
 * Read off the option row's `aria-selected` rather than the trigger's text: the trigger
 * displays the option's LABEL, so a text assertion would pin display copy instead of the
 * value under test. The popup is opened to read it and closed again, leaving the control
 * as it was found.
 */
export async function expectKitSelected(page: Page, testid: string, value: string) {
  const trigger = await openKitSelect(page, testid)
  await expect(
    page.getByTestId(`${testid}-opt-${value}`),
    `${testid} should have "${value}" chosen`,
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
}

/**
 * Which options a kit `<Select>` OFFERS, by value — the replacement for reading
 * `<option>` elements out of it.
 *
 * Its rows are portaled `div[role="option"]`, so a descendant `… option` query matched
 * NOTHING and returned `[]`, which made every `toContain` on it fail and — worse — made
 * every `not.toContain` pass vacuously: the negative half of a coverage assertion was
 * being satisfied by the absence of the whole control.
 */
export async function kitSelectOptionValues(page: Page, testid: string): Promise<string[]> {
  const trigger = await openKitSelect(page, testid)
  const prefix = `${testid}-opt-`
  const values = await page
    .locator(`[role="option"][data-testid^="${prefix}"]`)
    .evaluateAll((els, p) => els.map(e => e.getAttribute('data-testid')!.slice(p.length)), prefix)
  await page.keyboard.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  return values
}

/**
 * Read a set of ATTRIBUTES off every element matching `selector`, in document order.
 *
 * Generic on purpose: the attribute names a viz surface publishes its model on are the
 * SPEC's vocabulary, not this module's, so they are passed in. Specs used to recover the
 * same facts by reading `.value` off a control — which stopped being a native `<select>`
 * and became a `<button>`, so every read silently returned `undefined` and every
 * `rows.find(...)` on it silently found nothing. An element's own published attributes are
 * the model value, and cannot lie about which control renders them.
 */
export async function readAttrs(
  page: Page,
  selector: string,
  attrs: readonly string[],
): Promise<Record<string, string | null>[]> {
  return page.$$eval(
    selector,
    (els, names) =>
      els.map(e => Object.fromEntries(names.map(n => [n, e.getAttribute(n)]))),
    attrs as string[],
  )
}

/**
 * Click a testid that may be FOLDED behind an overflow control.
 *
 * A toolbar hides its low-rank actions in an overflow popover once it is too narrow to
 * hold them, and a folded action is not in the DOM until that popover opens — so clicking
 * it directly asserts a WIDTH, not a behaviour: it passes on a wide seed and times out on
 * a narrow one for reasons unrelated to what is under test. The folded row carries the
 * same testid, so the click is the same click either way.
 *
 * The click is DISPATCHED rather than driven by the mouse: on a narrow surface a
 * neighbour's chrome can overlap the button and intercept a real pointer press, which
 * would fail on a cosmetic overlap rather than on the handler under test.
 */
export async function clickPossiblyFolded(
  page: Page,
  testid: string,
  overflow: { trigger: string; panel: string },
) {
  const button = page.getByTestId(testid)
  if ((await button.count()) === 0) {
    await page.getByTestId(overflow.trigger).click()
    await expect(
      page.getByTestId(overflow.panel),
      `the overflow panel should open to reach "${testid}"`,
    ).toBeVisible()
  }
  await expect(button, `"${testid}" is offered`).toBeAttached()
  await button.evaluate(el => (el as HTMLElement).click())
}
