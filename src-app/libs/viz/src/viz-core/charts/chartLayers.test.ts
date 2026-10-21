import { describe, it, expect } from 'vitest'
import {
  buildViolinProps,
  buildBoxProps,
  buildDotplotProps,
  buildHeatmapProps,
  buildVolcanoProps,
  buildBarProps,
  buildHistogramProps,
  rectRing,
} from './chartLayers'
import type { ViolinGroup } from './aggregate'
import { continuousColors } from '../data/color'

// ── rect helper ──────────────────────────────────────────────────────────────

describe('rectRing', () => {
  it('produces a 4-vertex CCW ring covering the box', () => {
    expect(rectRing(0, 0, 2, 3)).toEqual([
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
    ])
  })
})

// ── 1. violin ─────────────────────────────────────────────────────────────────

describe('buildViolinProps (TEST-18)', () => {
  const groups: ViolinGroup[] = [
    { group: 'A', density: [{ x: 0, density: 0 }, { x: 1, density: 1 }, { x: 2, density: 0 }] },
    { group: 'B', density: [{ x: 0, density: 0 }, { x: 1, density: 0.5 }, { x: 2, density: 0 }] },
  ]

  it('mirrors each KDE into a closed ring (L up, R down) around the group center', () => {
    const { violin, centers } = buildViolinProps(groups, { width: 0.4, spacing: 1 })
    expect(violin.data).toHaveLength(2)
    expect(centers).toEqual([0, 1])
    const ring = violin.getPolygon(violin.data[0])
    // ring length = 2 × density-points (left side + mirrored right side)
    expect(ring).toHaveLength(6)
    // group A center = 0; max density (=1) → half-width 0.4 on the left at x=1
    expect(ring[1]).toEqual([-0.4, 1])
    // right side is the reverse (mirrored to +0.4)
    expect(ring[ring.length - 2]).toEqual([0.4, 1])
    // the two zero-density endpoints sit exactly on the center line
    expect(ring[0]).toEqual([0, 0])
  })

  it('normalizes width across groups (shared max density)', () => {
    const { violin } = buildViolinProps(groups, { width: 0.4 })
    // group B peak density 0.5 vs global max 1 → half that offset (0.2) about center 1
    const ringB = violin.getPolygon(violin.data[1])
    expect(ringB[1][0]).toBeCloseTo(1 - 0.2, 6)
  })

  it('is fully filled / non-SVG polygon props (no jitter unless requested)', () => {
    const res = buildViolinProps(groups)
    expect(res.violin.filled).toBe(true)
    expect(res.violin.extruded).toBe(false)
    expect(res.jitter).toBeUndefined()
  })

  it('emits a deterministic binary jitter ScatterplotLayer when raw values given', () => {
    const res = buildViolinProps(groups, {
      jitter: [
        { group: 'A', values: [0.5, 1.5] },
        { group: 'B', values: [1.0] },
      ],
    })
    expect(res.jitter).toBeDefined()
    const j = res.jitter!
    expect(j.data.length).toBe(3)
    expect(j.data.attributes.getPosition.value).toBeInstanceOf(Float32Array)
    // y coords carry the raw values; group B point y = 1.0
    expect(j.data.attributes.getPosition.value[4 + 1]).toBeCloseTo(1.0, 6)
    // deterministic: same inputs → identical positions
    const again = buildViolinProps(groups, {
      jitter: [
        { group: 'A', values: [0.5, 1.5] },
        { group: 'B', values: [1.0] },
      ],
    })
    expect(Array.from(j.data.attributes.getPosition.value)).toEqual(
      Array.from(again.jitter!.data.attributes.getPosition.value),
    )
  })
})

// ── 2. box ────────────────────────────────────────────────────────────────────

describe('buildBoxProps (TEST-19)', () => {
  const boxes = [
    { group: 'A', q1: 1, median: 2, q3: 3, lowerFence: 0, upperFence: 4, outliers: [5, -1] },
    { group: 'B', q1: 2, median: 3, q3: 4, lowerFence: 1, upperFence: 5, outliers: [] },
  ]

  it('builds an IQR rect per group from q1..q3', () => {
    const { boxes: box } = buildBoxProps(boxes, { width: 0.3, spacing: 1 })
    expect(box.data).toHaveLength(2)
    // group A rect spans y from q1(1) to q3(3), x = center 0 ± 0.3
    expect(box.getPolygon(box.data[0])).toEqual(rectRing(-0.3, 1, 0.3, 3))
  })

  it('emits whisker + cap + median LineLayer segments', () => {
    const { lines } = buildBoxProps(boxes, { width: 0.3 })
    // 5 segments per group (2 whiskers + 2 caps + 1 median) × 2 groups = 10
    expect(lines.data).toHaveLength(10)
    // a median segment for group A: horizontal at y=2 across the box
    const hasMedian = lines.data.some(
      s => s.source[1] === 2 && s.target[1] === 2 && s.source[0] === -0.3 && s.target[0] === 0.3,
    )
    expect(hasMedian).toBe(true)
    // an upper whisker for group A: from q3(3) up to upperFence(4) at center 0
    const hasWhisker = lines.data.some(
      s => s.source[0] === 0 && s.source[1] === 3 && s.target[1] === 4,
    )
    expect(hasWhisker).toBe(true)
  })

  it('collects outliers into a binary ScatterplotLayer (only when present)', () => {
    const res = buildBoxProps(boxes)
    expect(res.outliers).toBeDefined()
    // group A has 2 outliers, group B has none → 2 points
    expect(res.outliers!.data.length).toBe(2)
    const pos = res.outliers!.data.attributes.getPosition.value
    expect(pos[1]).toBe(5) // first outlier y
    expect(pos[3]).toBe(-1) // second outlier y
  })

  it('omits the outlier layer when no group has outliers', () => {
    const res = buildBoxProps([{ ...boxes[1] }])
    expect(res.outliers).toBeUndefined()
  })
})

// ── 3. dotplot ──────────────────────────────────────────────────────────────

describe('buildDotplotProps (TEST-20)', () => {
  const cells = [
    { row: 'g1', col: 'X', value: 0, fraction: 0.1 },
    { row: 'g1', col: 'Y', value: 10, fraction: 1.0 },
    { row: 'g2', col: 'X', value: 5, fraction: 0.5 },
    { row: 'g2', col: 'Y', value: 2, fraction: 0.25 },
  ]

  it('lays one instance per row×col on a categorical grid', () => {
    const { dots, rows, cols } = buildDotplotProps(cells)
    expect(rows).toEqual(['g1', 'g2'])
    expect(cols).toEqual(['X', 'Y'])
    expect(dots.data.length).toBe(4)
    const pos = dots.data.attributes.getPosition.value
    // cell 0 (g1,X) → [colIndex 0, rowIndex 0]
    expect([pos[0], pos[1]]).toEqual([0, 0])
    // cell 1 (g1,Y) → [colIndex 1, rowIndex 0]
    expect([pos[2], pos[3]]).toEqual([1, 0])
    // cell 2 (g2,X) → [colIndex 0, rowIndex 1]
    expect([pos[4], pos[5]]).toEqual([0, 1])
  })

  it('scales radius proportionally to fraction', () => {
    const { dots } = buildDotplotProps(cells, { maxRadiusPixels: 20 })
    const radii = dots.data.attributes.getRadius!.value
    expect(radii[0]).toBeCloseTo(0.1 * 20, 6)
    expect(radii[1]).toBeCloseTo(1.0 * 20, 6)
    expect(radii[2]).toBeCloseTo(0.5 * 20, 6)
  })

  it('colors dots by value through the colormap (high value → colormap high end)', () => {
    const { dots, domain } = buildDotplotProps(cells, { colormap: 'viridis' })
    const colors = dots.data.attributes.getFillColor.value
    // cell 1 has the max value (10) → should match the colormap high-end color
    const ref = continuousColors(new Float32Array([0, 10]), { colormap: 'viridis' }).colors
    expect([colors[4], colors[5], colors[6]]).toEqual([ref[4], ref[5], ref[6]])
    expect(domain[1]).toBe(10)
  })
})

// ── 4. heatmap ────────────────────────────────────────────────────────────────

describe('buildHeatmapProps (TEST-20)', () => {
  const matrix = {
    rows: ['r1', 'r2'],
    cols: ['c1', 'c2', 'c3'],
    values: new Float32Array([0, 5, 10, 1, 2, 3]),
  }

  it('builds an RGBA data-texture of size cols×rows (length rows*cols*4)', () => {
    const props = buildHeatmapProps(matrix)
    expect(props.image.width).toBe(3)
    expect(props.image.height).toBe(2)
    expect(props.image.data).toBeInstanceOf(Uint8Array)
    expect(props.image.data.length).toBe(2 * 3 * 4)
  })

  it('sets bounds [0, rows, cols, 0] and nearest-neighbor sampling', () => {
    const props = buildHeatmapProps(matrix)
    expect(props.bounds).toEqual([0, 2, 3, 0])
    expect(props.textureParameters.minFilter).toBe('nearest')
    expect(props.textureParameters.magFilter).toBe('nearest')
  })

  it('colormaps a high value to the colormap high end', () => {
    const props = buildHeatmapProps(matrix, { colormap: 'viridis' })
    // value 10 is the matrix max, at flat index 2 → texel 2
    const ref = continuousColors(matrix.values, { colormap: 'viridis' }).colors
    const idx = 2 * 4
    expect([props.image.data[idx], props.image.data[idx + 1], props.image.data[idx + 2]]).toEqual([
      ref[idx],
      ref[idx + 1],
      ref[idx + 2],
    ])
    expect(props.domain).toEqual([0, 10])
  })

  it('honors an explicit domain', () => {
    const props = buildHeatmapProps(matrix, { domain: [0, 100] })
    expect(props.domain).toEqual([0, 100])
  })
})

// ── 5. volcano ────────────────────────────────────────────────────────────────

describe('buildVolcanoProps (TEST-21)', () => {
  const points = [
    { label: 'a', x: 2.5, y: 4, direction: 'up' as const },
    { label: 'b', x: -3, y: 5, direction: 'down' as const },
    { label: 'c', x: 0.1, y: 0.2, direction: 'ns' as const },
  ]

  it('positions each point at [x, y]', () => {
    const { points: p } = buildVolcanoProps(points)
    const pos = p.data.attributes.getPosition.value
    expect([pos[0], pos[1]]).toEqual([2.5, 4])
    expect([pos[2], pos[3]]).toEqual([-3, 5])
    expect(pos[4]).toBeCloseTo(0.1, 6)
    expect(pos[5]).toBeCloseTo(0.2, 6)
  })

  it('colors points by direction (up red, down blue, ns gray)', () => {
    const { points: p } = buildVolcanoProps(points)
    const c = p.data.attributes.getFillColor.value
    expect([c[0], c[1], c[2]]).toEqual([214, 39, 40]) // up
    expect([c[4], c[5], c[6]]).toEqual([31, 119, 180]) // down
    expect([c[8], c[9], c[10]]).toEqual([160, 160, 160]) // ns
  })

  it('emits ±fc vertical guides + a horizontal p-threshold guide spanning the data', () => {
    const { guides } = buildVolcanoProps(points, { fcThreshold: 1, pThreshold: 1.3 })
    expect(guides.data).toHaveLength(3)
    const vertRight = guides.data.find(s => s.source[0] === 1 && s.target[0] === 1)
    const vertLeft = guides.data.find(s => s.source[0] === -1 && s.target[0] === -1)
    const horiz = guides.data.find(s => s.source[1] === 1.3 && s.target[1] === 1.3)
    expect(vertRight).toBeDefined()
    expect(vertLeft).toBeDefined()
    expect(horiz).toBeDefined()
    // horizontal guide spans at least the data x-extent
    expect(horiz!.source[0]).toBeLessThanOrEqual(-3)
    expect(horiz!.target[0]).toBeGreaterThanOrEqual(2.5)
  })
})

// ── 6. bar ────────────────────────────────────────────────────────────────────

describe('buildBarProps (TEST-19)', () => {
  const series = [
    { category: 'P', values: [3, 1] },
    { category: 'Q', values: [2, 2] },
  ]

  it('grouped: side-by-side bars from y=0, x offset within the group width', () => {
    const props = buildBarProps(series, { mode: 'grouped', groupWidth: 0.8 })
    expect(props.mode).toBe('grouped')
    expect(props.data).toHaveLength(4)
    // category P (index 0), 2 series, barW = 0.4
    const r0 = props.data[0]
    const r1 = props.data[1]
    expect(r0.y0).toBe(0)
    expect(r0.y1).toBe(3)
    expect(r0.x0).toBeCloseTo(-0.4, 6)
    expect(r0.x1).toBeCloseTo(0, 6)
    expect(r1.x0).toBeCloseTo(0, 6)
    expect(r1.x1).toBeCloseTo(0.4, 6)
  })

  it('stacked: cumulative y (each bar starts where the previous ended)', () => {
    const props = buildBarProps(series, { mode: 'stacked' })
    // category P: [3, 1] → bar0 y[0..3], bar1 y[3..4]
    const p = props.data.filter(d => d.category === 'P')
    expect([p[0].y0, p[0].y1]).toEqual([0, 3])
    expect([p[1].y0, p[1].y1]).toEqual([3, 4])
  })

  it('percent: each category normalized so its stack sums to 1', () => {
    const props = buildBarProps(series, { mode: 'percent' })
    const p = props.data.filter(d => d.category === 'P') // total 4
    expect(p[0].y0).toBeCloseTo(0, 6)
    expect(p[0].y1).toBeCloseTo(0.75, 6)
    expect(p[1].y0).toBeCloseTo(0.75, 6)
    expect(p[1].y1).toBeCloseTo(1.0, 6)
    // final cumulative of every category === 1
    const q = props.data.filter(d => d.category === 'Q')
    expect(q[q.length - 1].y1).toBeCloseTo(1.0, 6)
  })

  it('each rect polygon matches its x/y extents', () => {
    const props = buildBarProps(series, { mode: 'stacked' })
    const d = props.data[0]
    expect(props.getPolygon(d)).toEqual(rectRing(d.x0, d.y0, d.x1, d.y1))
  })

  it('single-value-per-category series color PER CATEGORY (ci), honoring opts.colors', () => {
    // the real categorical-bar shape (one value per category) → each bar a distinct hue.
    const cats = [{ category: 'A', values: [2] }, { category: 'B', values: [1] }, { category: 'C', values: [4] }]
    const palette: [number, number, number][] = [[10, 20, 30], [40, 50, 60], [70, 80, 90]]
    const props = buildBarProps(cats, { mode: 'grouped', colors: palette })
    expect(props.data.map(d => [d.fillColor[0], d.fillColor[1], d.fillColor[2]])).toEqual(palette)
    // no colors ⇒ built-in per-category palette (NOT all the same hue like the old categoryColor(0) bug)
    const dflt = buildBarProps(cats, { mode: 'grouped' })
    const hues = dflt.data.map(d => `${d.fillColor[0]},${d.fillColor[1]},${d.fillColor[2]}`)
    expect(new Set(hues).size).toBe(3) // three DISTINCT category colors
  })
})

// ── 7. histogram ──────────────────────────────────────────────────────────────

describe('buildHistogramProps (TEST-19)', () => {
  it('builds one rect per bin spanning [edge_i, edge_{i+1}] × [0, count_i]', () => {
    const props = buildHistogramProps([0, 1, 2, 3], [5, 8, 2])
    expect(props.data).toHaveLength(3)
    expect(props.data[0]).toMatchObject({ x0: 0, x1: 1, y0: 0, y1: 5 })
    expect(props.data[1]).toMatchObject({ x0: 1, x1: 2, y0: 0, y1: 8 })
    expect(props.getPolygon(props.data[2])).toEqual(rectRing(2, 0, 3, 2))
  })

  it('clamps to the shorter of counts vs edges-1', () => {
    const props = buildHistogramProps([0, 1, 2, 3], [5, 8]) // 3 edges usable but 2 counts
    expect(props.data).toHaveLength(2)
  })

  it('is a filled non-extruded polygon prop object (all-GPU, no SVG)', () => {
    const props = buildHistogramProps([0, 1], [4])
    expect(props.filled).toBe(true)
    expect(props.extruded).toBe(false)
  })
})
