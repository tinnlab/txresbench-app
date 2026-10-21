import { describe, it, expect } from 'vitest'
import {
  buildIdColorLut,
  boundaryMask,
  encodeLabelMaskRGBA,
  decodeIdFromRGB,
  packIdToRGB,
  LUT_PACK_WIDTH,
} from './labelMaskColor'
import { CATEGORICAL_PALETTE } from '../data/color'
import {
  labelMaskModule,
  LABEL_MASK_FRAGMENT,
  LabelMaskLayer,
} from './LabelMaskLayer'
import { makeLabelMaskFixture } from './labelMaskFixture'

describe('buildIdColorLut — id→category→RGBA lookup (TEST: color-by-category in-shader)', () => {
  it('maps each label id to its category color at full alpha; id 0 = background transparent', () => {
    // ids: 0=bg, 1→category0, 2→category1, 3→category2
    const categoryForId = new Uint16Array([0, 0, 1, 2])
    const lut = buildIdColorLut(categoryForId)

    expect(lut.data).toBeInstanceOf(Uint8Array)
    expect(lut.data.length).toBe(lut.width * lut.height * 4)

    // id 0 background: fully transparent (all channels zero).
    expect([lut.data[0], lut.data[1], lut.data[2], lut.data[3]]).toEqual([0, 0, 0, 0])

    // id 1 → palette[0], id 2 → palette[1], id 3 → palette[2], all opaque.
    for (const id of [1, 2, 3]) {
      const [r, g, b] = CATEGORICAL_PALETTE[categoryForId[id]]
      const o = id * 4
      expect([lut.data[o], lut.data[o + 1], lut.data[o + 2], lut.data[o + 3]]).toEqual([
        r,
        g,
        b,
        255,
      ])
    }
  })

  it('wraps category codes past the palette length (stable color reuse)', () => {
    const n = CATEGORICAL_PALETTE.length
    // id 1 has a category code == palette length → wraps to palette[0].
    const lut = buildIdColorLut(new Uint16Array([0, n]))
    const [r, g, b] = CATEGORICAL_PALETTE[0]
    expect([lut.data[4], lut.data[5], lut.data[6], lut.data[7]]).toEqual([r, g, b, 255])
  })

  it('packs large id ranges onto successive rows (2-D LUT)', () => {
    // 300 labels → wider than one row → height > 1, width = LUT_PACK_WIDTH.
    const categoryForId = new Uint16Array(301)
    const lut = buildIdColorLut(categoryForId)
    expect(lut.width).toBe(LUT_PACK_WIDTH)
    expect(lut.height).toBe(Math.ceil(301 / LUT_PACK_WIDTH))
    expect(lut.data.length).toBe(lut.width * lut.height * 4)
  })
})

describe('packIdToRGB / decodeIdFromRGB — id encoding round-trip (matches the shader)', () => {
  it('round-trips ids across the 24-bit range', () => {
    for (const id of [0, 1, 2, 255, 256, 257, 65535, 65536, 70000, 16777215]) {
      const [r, g, b] = packIdToRGB(id)
      expect(decodeIdFromRGB(r, g, b)).toBe(id)
    }
  })

  it('encodeLabelMaskRGBA packs the id into rgb (decodes back to the original id)', () => {
    // a 2×2 raster with ids spanning the g channel (300 > 255).
    const mask = new Uint16Array([0, 1, 300, 2])
    const rgba = encodeLabelMaskRGBA(mask, 2, 2)
    expect(rgba.length).toBe(2 * 2 * 4)
    for (let i = 0; i < mask.length; i++) {
      const o = i * 4
      expect(decodeIdFromRGB(rgba[o], rgba[o + 1], rgba[o + 2])).toBe(mask[i])
      expect(rgba[o + 3]).toBe(255) // opaque label texel
    }
  })
})

describe('boundaryMask — CPU oracle for the in-shader stroke (2-region mask)', () => {
  it('flags the shared border between two adjacent regions; interior + background clear', () => {
    // 4×3 raster: cols 0–1 = label 1, cols 2–3 = label 2 (two regions filling the image,
    // sharing the vertical border between x=1 and x=2). No background.
    const w = 4
    const h = 3
    const mask = new Uint16Array(w * h)
    for (let y = 0; y < h; y++) {
      mask[y * w + 0] = 1
      mask[y * w + 1] = 1
      mask[y * w + 2] = 2
      mask[y * w + 3] = 2
    }
    const b = boundaryMask(mask, w, h)
    for (let y = 0; y < h; y++) {
      // the two columns either side of the shared border are boundaries…
      expect(b[y * w + 1]).toBe(1)
      expect(b[y * w + 2]).toBe(1)
      // …the outer columns (image-edge, clamp → same id) are not.
      expect(b[y * w + 0]).toBe(0)
      expect(b[y * w + 3]).toBe(0)
    }
  })

  it('background pixels are never boundaries; a region↔background edge IS a boundary', () => {
    // 3×3: a single center region (id 5) surrounded by background.
    const w = 3
    const h = 3
    const mask = new Uint16Array(w * h)
    mask[1 * w + 1] = 5 // only the center is a region
    const b = boundaryMask(mask, w, h)
    // the lone region pixel borders background on all 4 sides → boundary.
    expect(b[1 * w + 1]).toBe(1)
    // every background pixel stays 0.
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) expect(b[i]).toBe(0)
    }
  })

  it('a single region filling the whole image has no boundary (clamp-to-edge)', () => {
    const w = 4
    const h = 4
    const mask = new Uint16Array(w * h).fill(3)
    const b = boundaryMask(mask, w, h)
    expect([...b].every(v => v === 0)).toBe(true)
  })
})

describe('LabelMaskLayer — shader wiring + construction', () => {
  it('exposes the `labelMask` shader module with the scalar UBO uniform types', () => {
    expect(labelMaskModule.name).toBe('labelMask')
    expect(labelMaskModule.uniformTypes.texel).toBe('vec2<f32>')
    expect(labelMaskModule.uniformTypes.lutSize).toBe('vec2<f32>')
    expect(labelMaskModule.uniformTypes.strokeColor).toBe('vec4<f32>')
    expect(labelMaskModule.uniformTypes.stroked).toBe('f32')
    // the LUT sampler is a binding (NOT in uniformTypes).
    expect('idColorLut' in labelMaskModule.uniformTypes).toBe(false)
    expect(labelMaskModule.fs).toContain('sampler2D idColorLut')
    expect(labelMaskModule.fs).toContain('labelMaskUniforms')
  })

  it('the fragment decodes the id, discards background, samples the LUT + encodes id for picking', () => {
    const fs = LABEL_MASK_FRAGMENT
    expect(fs).toContain('lm_decodeId')
    expect(fs).toContain('sampler2D bitmapTexture') // the label texture
    expect(fs).toContain('if (id < 0.5) discard;') // background → transparent + unpickable
    expect(fs).toContain('lm_lutColor(id)') // id→color LUT lookup (color-by-category)
    expect(fs).toContain('lm.stroked') // boundary stroke toggle
    expect(fs).toContain('boundary =') // in-shader 4-neighbour boundary test
    expect(fs).toContain('lm.strokeColor')
    expect(fs).toContain('picking.isActive') // id encoded into the picking color
  })

  it('constructs as a BitmapLayer subclass preserving the label-mask props', () => {
    const f = makeLabelMaskFixture({ seed: 1, width: 32, height: 32, labelCount: 8 })
    const layer = new LabelMaskLayer({
      id: 'lm',
      labelMask: f.labelMask,
      width: f.width,
      height: f.height,
      categoryForId: f.categoryForId,
      bounds: [0, f.height, f.width, 0],
      stroked: true,
      fillOpacity: 0,
      strokeWidth: 2,
      pickable: true,
    } as never)
    expect(layer).toBeInstanceOf(LabelMaskLayer)
    expect(LabelMaskLayer.layerName).toBe('LabelMaskLayer')
    expect(layer.props.width).toBe(f.width)
    expect(layer.props.stroked).toBe(true)
    expect(layer.props.fillOpacity).toBe(0)
    expect(layer.props.categoryForId).toBe(f.categoryForId)
  })
})

describe('makeLabelMaskFixture — synthetic label mask', () => {
  it('produces a distinctly-labelled raster + an id→category map, deterministically', () => {
    const a = makeLabelMaskFixture({ seed: 42 })
    const b = makeLabelMaskFixture({ seed: 42 })
    expect(a.labelMask.length).toBe(a.width * a.height)
    expect(a.categoryForId.length).toBe(a.labelCount + 1)
    // same seed → identical raster (deterministic).
    expect(a.labelMask).toEqual(b.labelMask)

    // has background AND labelled regions; every non-zero id is within 1..labelCount.
    let hasBg = false
    let hasLabel = false
    let maxId = 0
    for (const id of a.labelMask) {
      if (id === 0) hasBg = true
      else {
        hasLabel = true
        if (id > maxId) maxId = id
      }
    }
    expect(hasBg).toBe(true)
    expect(hasLabel).toBe(true)
    expect(maxId).toBeLessThanOrEqual(a.labelCount)

    // every assigned category code is a valid category (0..categoryCount-1).
    for (let id = 1; id <= a.labelCount; id++) {
      expect(a.categoryForId[id]).toBeLessThan(a.categoryCount)
    }
  })
})
