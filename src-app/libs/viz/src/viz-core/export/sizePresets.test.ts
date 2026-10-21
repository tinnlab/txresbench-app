import { describe, it, expect } from 'vitest'
import {
  MM_PER_INCH, COLUMN_PRESETS, MAX_HEIGHT_MM, DPI_TARGETS, DEFAULT_DPI,
  mmToPx, pxToMm, clampHeightMm, scaleForFinalSize, resolveExportSize,
} from './sizePresets'

describe('mm/px/dpi conversion (ITEM-3)', () => {
  it('mmToPx and pxToMm round-trip', () => {
    expect(mmToPx(MM_PER_INCH, 300)).toBeCloseTo(300, 6) // 1 inch at 300dpi = 300px
    expect(pxToMm(300, 300)).toBeCloseTo(MM_PER_INCH, 6)
    expect(pxToMm(mmToPx(88, 600), 600)).toBeCloseTo(88, 6)
  })
  it('exposes the column presets + strict height cap', () => {
    expect(COLUMN_PRESETS.single).toBe(88)
    expect(COLUMN_PRESETS.oneAndHalf).toBe(120)
    expect(COLUMN_PRESETS.double).toBe(180)
    expect(MAX_HEIGHT_MM).toBe(170)
  })
  it('clamps height over the journal max', () => {
    expect(clampHeightMm(150)).toEqual({ mm: 150, clamped: false })
    expect(clampHeightMm(200)).toEqual({ mm: 170, clamped: true })
  })
})

describe('DPI target → scale (ITEM-4)', () => {
  it('default dpi is 600 (combination)', () => {
    expect(DEFAULT_DPI).toBe(600)
    expect(DPI_TARGETS.lineArt).toBe(1200)
    expect(DPI_TARGETS.halftone).toBe(300)
  })
  it('scaleForFinalSize makes a source canvas print at the target mm/dpi', () => {
    // 400px source → print at 88mm, 600dpi. targetPx = 88/25.4*600 ≈ 2078.7 → scale ≈ 5.197
    const s = scaleForFinalSize(400, 88, 600)
    expect(s).toBeCloseTo(mmToPx(88, 600) / 400, 6)
    expect(s).toBeGreaterThan(1)
  })
  it('guards a zero-width source', () => {
    expect(scaleForFinalSize(0, 88, 600)).toBe(1)
  })
})

describe('resolveExportSize (ITEM-3 + ITEM-4 combined)', () => {
  it('an explicit scale overrides the size math (byte-identical escape hatch)', () => {
    const r = resolveExportSize({ sourceWidthPx: 400, sourceHeightPx: 300, scale: 2 })
    expect(r.scale).toBe(2)
  })
  it('a column preset resolves scale from mm+dpi and preserves aspect', () => {
    const r = resolveExportSize({ sourceWidthPx: 400, sourceHeightPx: 300, column: 'single', dpi: 600 })
    expect(r.widthMm).toBe(88)
    expect(r.dpi).toBe(600)
    expect(r.scale).toBeCloseTo(mmToPx(88, 600) / 400, 6)
    expect(r.heightMm).toBeCloseTo(88 * (300 / 400), 6) // aspect kept, under the cap
    expect(r.heightClamped).toBe(false)
  })
  it('flags a too-tall figure', () => {
    const r = resolveExportSize({ sourceWidthPx: 400, sourceHeightPx: 1200, column: 'double', dpi: 600 })
    expect(r.heightClamped).toBe(true)
    expect(r.heightMm).toBe(MAX_HEIGHT_MM)
  })
})
