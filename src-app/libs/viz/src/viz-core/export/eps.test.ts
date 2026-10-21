import { describe, it, expect } from 'vitest'
import { buildEPS, parseColor, ascii85 } from './eps'
import type { VectorScene } from './vector'

describe('parseColor', () => {
  it('parses hex and rgb() to 0..1', () => {
    expect(parseColor('#ff0000')).toEqual([1, 0, 0])
    expect(parseColor('#fff')).toEqual([1, 1, 1])
    expect(parseColor('rgb(0,128,255)')).toEqual([0, 128 / 255, 1])
  })
})

describe('ascii85', () => {
  it('ends with the ~> EOD marker and encodes zero as z', () => {
    const a = ascii85(new Uint8Array([0, 0, 0, 0]))
    expect(a).toBe('z~>')
  })
})

describe('buildEPS (ITEM-1)', () => {
  const scene: VectorScene = {
    width: 200, height: 100,
    marks: [
      { type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, stroke: '#000000', width: 0.5, role: 'axis' },
      { type: 'rect', x: 10, y: 10, w: 40, h: 20, fill: '#3366cc' },
      { type: 'circle', cx: 100, cy: 50, r: 5, fill: '#ff0000' },
      { type: 'text', x: 20, y: 80, text: 'Gene (A)', fill: '#000000', size: 8 },
    ],
  }

  it('emits a valid EPSF header + integer BoundingBox from the scene dims', () => {
    const eps = buildEPS(scene)
    expect(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0')).toBe(true)
    expect(eps).toContain('%%BoundingBox: 0 0 200 100')
    expect(eps).not.toContain('showpage') // EPS is embedded, never printed
  })
  it('renders text as a LIVE show op (not outlined) with escaped parens', () => {
    const eps = buildEPS(scene)
    expect(eps).toContain('findfont')
    expect(eps).toContain('(Gene \\(A\\)) show')
  })
  it('applies per-coordinate Y-flip (text baseline at H - y)', () => {
    const eps = buildEPS(scene)
    expect(eps).toContain('20 20 translate') // y=80 → 100-80 = 20
  })
  it('draws marks with setrgbcolor + stroke/fill', () => {
    const eps = buildEPS(scene)
    expect(eps).toContain('setrgbcolor')
    expect(eps).toContain('rectfill')
    expect(eps).toContain('arc')
    expect(eps).toContain('0.5 setlinewidth')
  })
  it('embeds a raster image mark via colorimage when raw pixels are supplied', () => {
    const withImg: VectorScene = { width: 4, height: 4, marks: [{ type: 'image', x: 0, y: 0, w: 4, h: 4, href: 'data:image/png;base64,XXX' }] }
    const eps = buildEPS(withImg, { rgba: new Uint8Array(2 * 2 * 4).fill(128), width: 2, height: 2 })
    expect(eps).toContain('colorimage')
    expect(eps).toContain('ASCII85Decode')
  })
  it('skips an image mark when no raster is supplied (vector-only EPS still valid)', () => {
    const withImg: VectorScene = { width: 4, height: 4, marks: [{ type: 'image', x: 0, y: 0, w: 4, h: 4, href: 'data:...' }] }
    expect(buildEPS(withImg)).not.toContain('colorimage')
  })
  it('renders an italic gene label with an oblique font (ITEM-16)', () => {
    const s: VectorScene = { width: 100, height: 20, marks: [{ type: 'text', x: 5, y: 15, text: 'CD3E', fill: '#000', size: 8, fontStyle: 'italic' }] }
    expect(buildEPS(s)).toContain('/Helvetica-Oblique findfont')
  })
  it('emits moveto BEFORE the anchor rmoveto for a middle-anchored label (no nocurrentpoint)', () => {
    const s: VectorScene = { width: 100, height: 20, marks: [{ type: 'text', x: 50, y: 10, text: 'axis', fill: '#000', size: 8, anchor: 'middle' }] }
    const eps = buildEPS(s)
    const moveto = eps.indexOf('0 0 moveto')
    const rmoveto = eps.indexOf('rmoveto')
    expect(moveto).toBeGreaterThan(-1)
    expect(rmoveto).toBeGreaterThan(-1)
    expect(moveto).toBeLessThan(rmoveto) // current point established before the relative anchor shift
    expect(eps).toContain('2 div neg 0 rmoveto') // middle = half the string width
  })
})
