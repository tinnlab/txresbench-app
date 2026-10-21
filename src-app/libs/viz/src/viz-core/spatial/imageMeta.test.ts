import { describe, it, expect } from 'vitest'
import {
  parseMultiscales,
  pixelSizeAffine,
  composeAffine2,
  imageModelMatrix,
  type NgffImage,
} from './imageMeta'
import { applyAffine, composeAffine, type Affine } from '../data/image'

// Apply a flat COLUMN-MAJOR 4×4 matrix to a homogeneous point (x, y, 0, 1) → (x', y').
// This is exactly the per-vertex op deck.gl runs on the GPU, so agreement with the
// CPU affine proves the modelMatrix reproduces the intended placement.
function applyMat4(m: number[], x: number, y: number): [number, number] {
  const xp = m[0] * x + m[4] * y + m[12]
  const yp = m[1] * x + m[5] * y + m[13]
  return [xp, yp]
}

// A 3-channel, 3-level pyramid: 256 → 128 → 64, physical scale 0.5 → 1 → 2 µm/px
// (axes c,y,x). Level 0 also carries a translation to prove translation parsing.
function makeNgff(): NgffImage {
  return {
    multiscales: [
      {
        version: '0.4',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [
          {
            path: '0',
            coordinateTransformations: [
              { type: 'scale', scale: [1, 0.5, 0.5] },
              { type: 'translation', translation: [0, 10, 20] },
            ],
          },
          { path: '1', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] },
          { path: '2', coordinateTransformations: [{ type: 'scale', scale: [1, 2, 2] }] },
        ],
      },
    ],
    omero: {
      channels: [
        { label: 'DAPI', color: '0000FF', window: { start: 0, end: 200 } },
        { label: 'GFP', color: '00FF00', window: { start: 5, end: 255 } },
        { label: 'RFP', color: 'FF0000', window: { start: 0, end: 128 } },
      ],
    },
    arrays: {
      '0': { shape: [3, 256, 256], dtype: 'Uint8' },
      '1': { shape: [3, 128, 128], dtype: 'Uint8' },
      '2': { shape: [3, 64, 64], dtype: 'Uint8' },
    },
  }
}

describe('parseMultiscales — level pyramid', () => {
  it('extracts per-level width/height from array shapes (highest-res first)', () => {
    const meta = parseMultiscales(makeNgff())
    expect(meta.levels.map(l => [l.width, l.height])).toEqual([
      [256, 256],
      [128, 128],
      [64, 64],
    ])
    expect(meta.levels.map(l => l.path)).toEqual(['0', '1', '2'])
  })

  it('computes integer downsample factors relative to level 0', () => {
    const meta = parseMultiscales(makeNgff())
    expect(meta.levels.map(l => l.downsample)).toEqual([1, 2, 4])
  })

  it('reads the per-level physical scale (units/pixel) at the y/x axes', () => {
    const meta = parseMultiscales(makeNgff())
    expect(meta.levels.map(l => l.scale)).toEqual([
      [0.5, 0.5],
      [1, 1],
      [2, 2],
    ])
  })

  it('reads the level-0 translation from the NGFF transform (x,y order)', () => {
    const meta = parseMultiscales(makeNgff())
    // translation array is [c=0, y=10, x=20] → [tx, ty] = [20, 10]
    expect(meta.levels[0].translation).toEqual([20, 10])
    expect(meta.levels[1].translation).toEqual([0, 0])
  })

  it('composes a shared multiscale-level scale with the per-dataset scale', () => {
    const ngff = makeNgff()
    ngff.multiscales[0].coordinateTransformations = [{ type: 'scale', scale: [1, 10, 10] }]
    const meta = parseMultiscales(ngff)
    // level0 0.5 * shared 10 = 5
    expect(meta.levels[0].scale).toEqual([5, 5])
    expect(meta.levels[2].scale).toEqual([20, 20])
  })

  it('records dtype and the t/c/z/y/x axis index', () => {
    const meta = parseMultiscales(makeNgff())
    expect(meta.dtype).toBe('Uint8')
    expect(meta.axisIndex).toEqual({ t: undefined, c: 0, z: undefined, y: 1, x: 2 })
  })
})

describe('parseMultiscales — channels', () => {
  it('parses omero channel name, hex color → RGB, and window', () => {
    const meta = parseMultiscales(makeNgff())
    expect(meta.channels.map(c => c.name)).toEqual(['DAPI', 'GFP', 'RFP'])
    expect(meta.channels[0].color).toEqual([0, 0, 255])
    expect(meta.channels[1].color).toEqual([0, 255, 0])
    expect(meta.channels[2].color).toEqual([255, 0, 0])
    expect(meta.channels[0].window).toEqual([0, 200])
    expect(meta.channels[1].window).toEqual([5, 255])
  })

  it('falls back to the c-axis size when omero is absent', () => {
    const ngff = makeNgff()
    delete ngff.omero
    const meta = parseMultiscales(ngff)
    expect(meta.channels.map(c => c.name)).toEqual(['Channel 0', 'Channel 1', 'Channel 2'])
    expect(meta.channels[0].color).toBeUndefined()
  })

  it('handles a t/c/z/y/x axis ordering', () => {
    const ngff = makeNgff()
    ngff.multiscales[0].axes = [
      { name: 't' },
      { name: 'c' },
      { name: 'z' },
      { name: 'y' },
      { name: 'x' },
    ]
    ngff.multiscales[0].datasets = [
      { path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 0.5, 0.5] }] },
    ]
    ngff.arrays = { '0': { shape: [1, 2, 1, 256, 256], dtype: 'Uint16' } }
    ngff.omero = { channels: [{ label: 'A' }, { label: 'B' }] }
    const meta = parseMultiscales(ngff)
    expect(meta.axisIndex).toEqual({ t: 0, c: 1, z: 2, y: 3, x: 4 })
    expect(meta.levels[0]).toMatchObject({ width: 256, height: 256, scale: [0.5, 0.5] })
    expect(meta.dtype).toBe('Uint16')
  })
})

describe('parseMultiscales — errors', () => {
  it('throws when a dataset has no array metadata', () => {
    const ngff = makeNgff()
    delete ngff.arrays['1']
    expect(() => parseMultiscales(ngff)).toThrow(/no array metadata/)
  })

  it('throws when y/x axes are missing', () => {
    const ngff = makeNgff()
    ngff.multiscales[0].axes = [{ name: 'c' }, { name: 'q' }, { name: 'x' }]
    expect(() => parseMultiscales(ngff)).toThrow(/must include both "y" and "x"/)
  })
})

describe('pixelSizeAffine + imageModelMatrix (element pixel → global microns)', () => {
  it('pixelSizeAffine yields the level-0 scale + translation as a 2×3 affine', () => {
    const meta = parseMultiscales(makeNgff())
    // level0 scale 0.5, translation [20,10]
    expect(pixelSizeAffine(meta)).toEqual([0.5, 0, 20, 0, 0.5, 10])
  })

  it('modelMatrix maps a full-res pixel to global microns (scale + translation)', () => {
    const meta = parseMultiscales(makeNgff())
    const m = imageModelMatrix(meta)
    expect(m).toHaveLength(16)
    // pixel (100, 40) → (0.5*100 + 20, 0.5*40 + 10) = (70, 30)
    expect(applyMat4(m, 100, 40)).toEqual([70, 30])
    // parity with the CPU affine oracle
    const aff = pixelSizeAffine(meta)
    expect(applyMat4(m, 12.5, -7)).toEqual(applyAffine(aff, 12.5, -7))
  })

  it('folds an element→global registration affine over the pixel scale', () => {
    const meta = parseMultiscales(makeNgff())
    // registration: rotate+scale+translate in element-local micron space
    const reg: Affine = composeAffine({ scale: 2, rotation: 0.3, translate: [5, -8] })
    const m = imageModelMatrix(meta, reg)
    const pixToMicron = pixelSizeAffine(meta)
    const composed = composeAffine2(reg, pixToMicron)
    for (const [x, y] of [
      [0, 0],
      [128, 128],
      [255, 0],
      [37.5, -12.25],
    ] as [number, number][]) {
      const [ex, ey] = applyAffine(composed, x, y)
      const [gx, gy] = applyMat4(m, x, y)
      expect(gx).toBeCloseTo(ex, 9)
      expect(gy).toBeCloseTo(ey, 9)
    }
  })
})

describe('composeAffine2 (2×3 affine product, inner applied first)', () => {
  it('agrees with sequential applyAffine for arbitrary affines', () => {
    const outer: Affine = [0.8, -0.3, 40, 0.2, 1.1, -15]
    const inner: Affine = [1.5, 0.4, -3, -0.2, 0.9, 7]
    const composed = composeAffine2(outer, inner)
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [3.5, -2.25],
      [-7, 9],
    ] as [number, number][]) {
      const [ix, iy] = applyAffine(inner, x, y)
      const [ex, ey] = applyAffine(outer, ix, iy)
      const [cx, cy] = applyAffine(composed, x, y)
      expect(cx).toBeCloseTo(ex, 9)
      expect(cy).toBeCloseTo(ey, 9)
    }
  })
})
