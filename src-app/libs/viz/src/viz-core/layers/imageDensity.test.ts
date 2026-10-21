import { describe, it, expect } from 'vitest'
import { transformPositions, imageBounds, applyAffine, type Affine } from '../data/image'
import { buildAggregationProps } from './DensityCanvas'

describe('image underlay geometry (TEST-10 / DEC-13)', () => {
  it('imageBounds returns [0,H,W,0] (top-left origin, y-down)', () => {
    expect(imageBounds(512, 256)).toEqual([0, 256, 512, 0])
    // square case
    expect(imageBounds(100, 100)).toEqual([0, 100, 100, 0])
  })

  it('transformPositions maps points through the affine [a,b,tx,c,d,ty]', () => {
    // x' = a·x + b·y + tx ; y' = c·x + d·y + ty
    const a: Affine = [2, 0, 5, 0, 3, 7]
    const pts = new Float32Array([1, 1, 0, 0])
    const out = transformPositions(pts, a)
    // (1,1) → (2·1+0·1+5, 0·1+3·1+7) = (7, 10)
    expect(out[0]).toBe(7)
    expect(out[1]).toBe(10)
    // (0,0) → (5, 7) (pure translation)
    expect(out[2]).toBe(5)
    expect(out[3]).toBe(7)
    // returns a fresh array of the same length
    expect(out).not.toBe(pts)
    expect(out.length).toBe(pts.length)
  })

  it('transformPositions agrees with applyAffine point-by-point (rotation+scale)', () => {
    const a: Affine = [0, -1, 3, 1, 0, -4] // 90° rotation + translation
    const pts = new Float32Array([2, 5])
    const out = transformPositions(pts, a)
    const [ex, ey] = applyAffine(a, 2, 5)
    expect(out[0]).toBeCloseTo(ex)
    expect(out[1]).toBeCloseTo(ey)
  })
})

describe('density aggregation prop helper (TEST-23 / DEC-22)', () => {
  const positions = new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]) // N = 4

  it('screen-grid count: cellSizePixels = binSize, SUM of unit weight', () => {
    const b = buildAggregationProps({ positions, kind: 'screen-grid', binSize: 24, aggregation: 'count' })
    expect(b.kind).toBe('screen-grid')
    expect(b.aggregation).toBe('SUM')
    expect(b.binSize).toBe(24)
    expect(b.props.cellSizePixels).toBe(24)
    expect(b.props.aggregation).toBe('SUM')
    expect(b.props.getWeight).toBe(1) // count = unit weight
    const data = b.props.data as { length: number; attributes: Record<string, unknown> }
    expect(data.length).toBe(4)
    expect(data.attributes.getPosition).toEqual({ value: positions, size: 2 })
    expect(data.attributes.getWeight).toBeUndefined()
  })

  it('bin size flows straight into the layer prop', () => {
    expect((buildAggregationProps({ positions, kind: 'screen-grid', binSize: 48, aggregation: 'count' }).props.cellSizePixels)).toBe(48)
    expect((buildAggregationProps({ positions, kind: 'hexagon', binSize: 2.5, aggregation: 'count' }).props.radius)).toBe(2.5)
  })

  it('screen-grid mean: MEAN aggregation with a weight attribute', () => {
    const weights = new Float32Array([10, 20, 30, 40])
    const b = buildAggregationProps({ positions, weights, kind: 'screen-grid', binSize: 16, aggregation: 'mean' })
    expect(b.aggregation).toBe('MEAN')
    expect(b.props.aggregation).toBe('MEAN')
    expect(b.props.getWeight).toBeUndefined() // supplied as a binary attribute instead
    const data = b.props.data as { attributes: Record<string, unknown> }
    expect(data.attributes.getWeight).toEqual({ value: weights, size: 1 })
  })

  it('mean WITHOUT weights degrades to count (SUM), never a broken MEAN', () => {
    const b = buildAggregationProps({ positions, kind: 'screen-grid', binSize: 24, aggregation: 'mean' })
    expect(b.aggregation).toBe('SUM')
    expect(b.props.getWeight).toBe(1)
  })

  it('hexagon count: radius = binSize, colorAggregation SUM, unit color weight', () => {
    const b = buildAggregationProps({ positions, kind: 'hexagon', binSize: 1.5, aggregation: 'count' })
    expect(b.kind).toBe('hexagon')
    expect(b.props.radius).toBe(1.5)
    expect(b.props.colorAggregation).toBe('SUM')
    expect(b.props.getColorWeight).toBe(1)
  })

  it('hexagon mean: colorAggregation MEAN with a getColorWeight attribute', () => {
    const weights = new Float32Array([1, 2, 3, 4])
    const b = buildAggregationProps({ positions, weights, kind: 'hexagon', binSize: 1, aggregation: 'mean' })
    expect(b.props.colorAggregation).toBe('MEAN')
    expect(b.props.getColorWeight).toBeUndefined()
    const data = b.props.data as { attributes: Record<string, unknown> }
    expect(data.attributes.getColorWeight).toEqual({ value: weights, size: 1 })
  })

  it('respects a custom layer id', () => {
    expect(buildAggregationProps({ positions, kind: 'screen-grid', binSize: 10, aggregation: 'count', id: 'my-grid' }).props.id).toBe('my-grid')
  })
})
