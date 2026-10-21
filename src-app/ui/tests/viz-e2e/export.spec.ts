import { test, expect } from '@playwright/test'
import {
  expectKitSelected,
  expectSomeCanvasRendered,
  openStory,
  selectKitOption,
  trackErrors,
} from './_helpers'
import { readFileSync } from 'node:fs'

/**
 * Read the intrinsic pixel dimensions from a PNG file's IHDR chunk. The PNG layout
 * is: 8-byte signature, then the IHDR chunk (4-byte length + "IHDR" + 4-byte width
 * + 4-byte height …). So width is a big-endian uint32 at byte offset 16, height at
 * offset 20. Used to assert the exported raster's real output resolution.
 */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function exportPng(page: import('@playwright/test').Page) {
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
  await page.click('[data-testid="export-button"]')
  const download = await downloadPromise
  const path = await download.path()
  expect(path, 'download resolved to a saved file path').toBeTruthy()
  return path as string
}

// TEST-63 (covers ITEM-47): the ExportDialog rasters the live deck.gl canvas to a PNG
// and triggers a real browser download. We select scope = "This pane", keep format PNG,
// click Export, capture the download via Playwright, and assert the saved file is
// non-empty. Zero console errors.
test('TEST-63 PNG export (this pane) downloads a non-empty file', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'export-basic')

  await expect(page.locator('[data-testid="viz-export-dialog"]')).toBeVisible()
  await expectSomeCanvasRendered(page)

  // Scope = this pane (exercise the pane vs whole-grid choice); format defaults to PNG.
  await selectKitOption(page, 'export-scope', 'pane')
  await expectKitSelected(page, 'export-format', 'png')

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
  await page.click('[data-testid="export-button"]')

  const download = await downloadPromise
  expect(download.suggestedFilename().toLowerCase()).toMatch(/\.png$/)

  const path = await download.path()
  expect(path, 'download resolved to a saved file path').toBeTruthy()
  const bytes = readFileSync(path as string)
  expect(bytes.byteLength, 'exported PNG is non-empty').toBeGreaterThan(0)

  // Audit F4 (preserveDrawingBuffer / blank-live-deck): verify the PNG has actual NON-blank content,
  // not just a valid empty file — decode it in-browser and count opaque pixels. (Confirms the deck
  // canvas is readable at export time; closes the "file-validity-only" test-adequacy gap.)
  const dataUri = `data:image/png;base64,${bytes.toString('base64')}`
  const opaquePixels = await page.evaluate(async uri => {
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img decode failed'))
      img.src = uri
    })
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    let opaque = 0
    for (let i = 3; i < data.length; i += 400) if (data[i] > 10) opaque++
    return opaque
  }, dataUri)
  expect(opaquePixels, 'exported PNG has non-blank pixel content (deck buffer was readable)').toBeGreaterThan(0)

  // the dialog confirms the pane-scoped export
  await expect(page.locator('[data-testid="export-status"]')).toContainText('PNG')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// TEST-EXPORT-DIM-1: the scale factor. The export-dimensions story mounts a fixed
// 400×300 canvas. Exporting at 1× yields a 400×300 PNG; at 2× yields 800×600 —
// the same aspect ratio at double resolution. We parse each PNG's IHDR to prove the
// backing store actually doubled (not just a larger byte count).
test('TEST-EXPORT-DIM-1 scale factor doubles the raster output resolution', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'export-dimensions')

  await expect(page.locator('[data-testid="viz-export-dialog"]')).toBeVisible()
  await expectKitSelected(page, 'export-format', 'png')
  await expect(page.locator('[data-testid="export-scale"]')).toBeVisible()

  // 1× — the byte-identical current-size default.
  await selectKitOption(page, 'export-scale', '1')
  const oneX = pngSize(await exportPng(page))
  expect(oneX).toEqual({ width: 400, height: 300 })

  // 2× — double both dimensions, aspect ratio preserved.
  await selectKitOption(page, 'export-scale', '2')
  const twoX = pngSize(await exportPng(page))
  expect(twoX).toEqual({ width: 800, height: 600 })
  expect(twoX.width / twoX.height).toBeCloseTo(oneX.width / oneX.height, 6)
  await expect(page.locator('[data-testid="export-status"]')).toContainText('800×600')

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})

// TEST-EXPORT-DIM-2: custom output size (aspect-preserved). Switching Size → Custom
// and entering 250×250 produces a PNG whose backing store is EXACTLY 250×250 — the
// 4:3 source is contain-fitted (letterboxed) inside, never stretched. An empty field
// falls back to the current size.
test('TEST-EXPORT-DIM-2 custom size produces the requested output dimensions', async ({ page }) => {
  const bag = trackErrors(page)
  await openStory(page, 'export-dimensions')

  await expect(page.locator('[data-testid="export-size-mode"]')).toBeVisible()
  await selectKitOption(page, 'export-scale', '1')
  await selectKitOption(page, 'export-size-mode', 'custom')

  await page.locator('[data-testid="export-width"]').fill('250')
  await page.locator('[data-testid="export-height"]').fill('250')

  const custom = pngSize(await exportPng(page))
  expect(custom).toEqual({ width: 250, height: 250 })
  await expect(page.locator('[data-testid="export-status"]')).toContainText('250×250')

  // Robustness: a blank dimension falls back to Current (400×300), not a crash.
  await page.locator('[data-testid="export-width"]').fill('')
  const fallback = pngSize(await exportPng(page))
  expect(fallback).toEqual({ width: 400, height: 300 })

  expect(bag.errors, `no console/page errors: ${bag.errors.slice(0, 3).join(' | ')}`).toHaveLength(0)
})
