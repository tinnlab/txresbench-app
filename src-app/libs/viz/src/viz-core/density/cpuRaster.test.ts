import { describe, it, expect } from 'vitest'
import { binAndShade, binAndShadePacked, normalizeCounts, toBitmapImage } from './cpuRaster'
import { binDensity, type DensityBounds } from './densityBin'
import { buildColormapLUT } from '../gpu/colormapLut'
import { packPositions } from './quantize'

const UNIT: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

describe('normalizeCounts', () => {
  it('linear: count/max, empty→0', () => {
    const t = normalizeCounts([0, 1, 2, 4], 'linear')
    expect(Array.from(t)).toEqual([0, 0.25, 0.5, 1])
  })

  it('log: log1p ramp, monotonic non-decreasing, densest→1', () => {
    const t = normalizeCounts([0, 1, 3, 9], 'log')
    expect(t[0]).toBe(0)
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1])
    expect(t[t.length - 1]).toBeCloseTo(1, 6)
  })

  it('histeq: CDF over populated cells — monotonic, ties equal, densest→1', () => {
    const t = normalizeCounts([0, 1, 1, 5, 20], 'histeq')
    expect(t[0]).toBe(0) // empty
    expect(t[1]).toBe(t[2]) // ties share a weight
    // strictly non-decreasing across increasing counts
    expect(t[1]).toBeLessThan(t[3])
    expect(t[3]).toBeLessThan(t[4])
    expect(t[4]).toBeCloseTo(1, 6)
  })

  it('all-empty grid → all zeros for every mode', () => {
    for (const m of ['linear', 'log', 'histeq'] as const) {
      expect(Array.from(normalizeCounts([0, 0, 0], m))).toEqual([0, 0, 0])
    }
  })

  it('shade ramp is monotonic in count for a random spread (all modes)', () => {
    const counts = Float32Array.from({ length: 64 }, (_, i) => (i * 7) % 13)
    for (const m of ['linear', 'log', 'histeq'] as const) {
      const t = normalizeCounts(counts, m)
      // pair up by count → weight must be a non-decreasing function of count
      const byCount = new Map<number, number>()
      for (let i = 0; i < counts.length; i++) {
        const c = counts[i]
        const prev = byCount.get(c)
        if (prev != null) expect(t[i]).toBeCloseTo(prev, 6) // same count → same weight
        byCount.set(c, t[i])
      }
      const sorted = Array.from(byCount.entries()).sort((a, b) => a[0] - b[0])
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i][1]).toBeGreaterThanOrEqual(sorted[i - 1][1])
      }
    }
  })
})

describe('binAndShade — counts match the binDensity oracle', () => {
  // A hand-placed set of points across a 2×2 grid over the unit box.
  //  cell layout (row-major, row 0 = minY): [ (0,0)=BL, (0,1)=BR, (1,0)=TL, (1,1)=TR ]
  //  BL gets 3, BR gets 1, TL gets 0, TR gets 2  → total 6 points.
  const pts = new Float32Array([
    // bottom-left (x<0.5, y<0.5) ×3
    0.1, 0.1, 0.2, 0.2, 0.4, 0.05,
    // bottom-right (x>0.5, y<0.5) ×1
    0.8, 0.2,
    // top-right (x>0.5, y>0.5) ×2
    0.9, 0.9, 0.6, 0.7,
  ])

  it('the shaded raster is populated exactly where binDensity has count>0 (flipY:false)', () => {
    const { count } = binDensity(pts, null, UNIT, 2, 2)
    // oracle: [BL=3, BR=1, TL=0, TR=2]
    expect(Array.from(count)).toEqual([3, 1, 0, 2])

    const { rgba, width, height } = binAndShade({
      positions: pts,
      bounds: UNIT,
      width: 2,
      height: 2,
      flipY: false, // natural bin order → row-aligned with the oracle
      normalize: 'linear',
    })
    expect(width).toBe(2)
    expect(height).toBe(2)
    // alpha channel: opaque where count>0, transparent where count==0
    const alpha = [rgba[3], rgba[7], rgba[11], rgba[15]]
    expect(alpha).toEqual([255, 255, 0, 255]) // BL, BR, TL(empty), TR
  })

  it('flipY:true reverses the ROW order (top-first for BitmapLayer)', () => {
    const natural = binAndShade({ positions: pts, bounds: UNIT, width: 2, height: 2, flipY: false })
    const flipped = binAndShade({ positions: pts, bounds: UNIT, width: 2, height: 2, flipY: true })
    // row 0 (natural, minY) === row 1 (flipped) and vice-versa; columns unchanged.
    // natural rows: [r0c0 r0c1 | r1c0 r1c1]; flipped should be [r1c0 r1c1 | r0c0 r0c1]
    const rowBytes = 2 * 4
    const nat0 = Array.from(natural.rgba.slice(0, rowBytes))
    const nat1 = Array.from(natural.rgba.slice(rowBytes, rowBytes * 2))
    const flp0 = Array.from(flipped.rgba.slice(0, rowBytes))
    const flp1 = Array.from(flipped.rgba.slice(rowBytes, rowBytes * 2))
    expect(flp0).toEqual(nat1)
    expect(flp1).toEqual(nat0)
  })

  it('flipY:true places a WORLD top-right cluster at the IMAGE top-right (not mirrored) — M1', () => {
    // Points clustered in the top-right WORLD quadrant (high x, high y). With flipY:true (the
    // BitmapLayer-ready order: image row 0 → bounds.maxY = top), the bright cell MUST land at the
    // image's top-right. If the flip were wrong, it would render bottom-right (vertically mirrored) —
    // the gap the blind audit (M1) flagged and every prior test missed.
    const topRight = Float32Array.from([0.9, 0.9, 0.85, 0.95, 0.95, 0.85])
    const { rgba } = binAndShade({
      positions: topRight,
      bounds: UNIT,
      width: 4,
      height: 4,
      flipY: true,
      normalize: 'linear',
    })
    const alphaAt = (row: number, col: number) => rgba[(row * 4 + col) * 4 + 3]
    expect(alphaAt(0, 3), 'image top-right = world top-right → opaque').toBeGreaterThan(0)
    expect(alphaAt(3, 0), 'image bottom-left = world bottom-left → empty/transparent').toBe(0)
    expect(alphaAt(0, 0), 'image top-left empty').toBe(0)
  })

  it("a populated cell's color is the colormap LUT entry for its (linear) weight", () => {
    // Single dense cell vs single sparse cell, linear normalize → weights 1.0 and 0.25.
    const { rgba } = binAndShade({
      positions: pts,
      bounds: UNIT,
      width: 2,
      height: 2,
      flipY: false,
      normalize: 'linear',
      colormap: 'viridis',
    })
    const lut = buildColormapLUT('viridis')
    // BL: count 3 of max 3 → weight 1 → LUT[255]
    const kBL = 255
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([lut[kBL * 4], lut[kBL * 4 + 1], lut[kBL * 4 + 2]])
    // BR: count 1 of max 3 → weight 1/3 → k = floor(0.3333*255)=85 → LUT[85]
    const kBR = (1 / 3 * 255) | 0
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([lut[kBR * 4], lut[kBR * 4 + 1], lut[kBR * 4 + 2]])
  })

  it('guards degenerate dims to ≥1×1 and returns the right buffer length', () => {
    const r = binAndShade({ positions: pts, bounds: UNIT, width: 0, height: 0 })
    expect(r.width).toBe(1)
    expect(r.height).toBe(1)
    expect(r.rgba.length).toBe(1 * 1 * 4)
  })

  it('an empty positions buffer yields a fully transparent raster', () => {
    const r = binAndShade({ positions: new Float32Array(0), bounds: UNIT, width: 3, height: 3 })
    expect(r.rgba.length).toBe(3 * 3 * 4)
    expect(Array.from(r.rgba).every(v => v === 0)).toBe(true)
  })
})

describe('binAndShadePacked (16-bit packed path)', () => {
  const bounds: DensityBounds = { minX: 0, minY: 0, maxX: 80, maxY: 80 }
  // Edge-safe cell-centre points (see densityBin.test) so the packed count grid is byte-identical
  // to the Float32 one → the shaded rasters must be byte-identical too.
  const pts: number[] = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const mult = ((r * 8 + c) % 3) + 1
      for (let k = 0; k < mult; k++) pts.push(c * 10 + 5, r * 10 + 5)
    }
  }
  const positions = new Float32Array(pts)
  const packed = packPositions(positions)

  it('is byte-identical to binAndShade for edge-safe points', () => {
    const a = binAndShade({ positions, bounds, width: 8, height: 8, normalize: 'log' })
    const b = binAndShadePacked({ packed: packed.packed, meta: packed, bounds, width: 8, height: 8, normalize: 'log' })
    expect(b.width).toBe(a.width)
    expect(b.height).toBe(a.height)
    expect(Array.from(b.rgba)).toEqual(Array.from(a.rgba))
  })

  it('guards degenerate dims and empty input', () => {
    const r = binAndShadePacked({ packed: new Uint16Array(0), meta: packed, bounds, width: 0, height: 0 })
    expect(r.width).toBe(1)
    expect(r.height).toBe(1)
    expect(Array.from(r.rgba).every(v => v === 0)).toBe(true)
  })
})

describe('toBitmapImage (BUG #15 — progressive raster black square)', () => {
  const image = { rgba: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 128]), width: 2, height: 1 }

  it('wraps the RGBA in an ImageData (RGBA-texture upload) when ImageData exists', () => {
    // Stub the browser `ImageData` (the vitest env is `node`, where it is undefined). This asserts
    // the deck.gl fix: the layer receives an ImageData, NOT the raw `{data,width,height}` object that
    // uploads as a black quad (RGB dropped). The exact viridis bytes + dims must survive verbatim.
    class FakeImageData {
      readonly data: Uint8ClampedArray
      readonly width: number
      readonly height: number
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data
        this.width = width
        this.height = height
      }
    }
    const g = globalThis as unknown as { ImageData?: unknown }
    const prev = g.ImageData
    g.ImageData = FakeImageData
    try {
      const out = toBitmapImage(image)
      expect(out).toBeInstanceOf(FakeImageData)
      expect(out.width).toBe(2)
      expect(out.height).toBe(1)
      expect(Array.from(out.data)).toEqual([1, 2, 3, 255, 4, 5, 6, 128])
    } finally {
      if (prev === undefined) delete g.ImageData
      else g.ImageData = prev
    }
  })

  it('falls back to the raw {data,width,height} object under SSR/node (never rendered)', () => {
    const g = globalThis as unknown as { ImageData?: unknown }
    expect(g.ImageData).toBeUndefined() // sanity: the vitest env has no ImageData
    const out = toBitmapImage(image)
    expect(out).toEqual({ data: image.rgba, width: 2, height: 1 })
  })
})
