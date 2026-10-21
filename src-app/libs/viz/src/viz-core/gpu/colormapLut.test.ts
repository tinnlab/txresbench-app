import { describe, it, expect } from 'vitest'
import { buildColormapLUT, buildPaletteLUT, LUT_SIZE } from './colormapLut'
import { continuousColors, DEFAULT_CATEGORICAL_PALETTE } from '../data/color'
import {
  ColormapScatterLayer,
  SelectableScatterLayer,
  colormapModule,
  colormapInject,
  selectionModule,
  selectionDecl,
  selectionApply,
  blendModule,
  blendDecl,
  blendApply,
} from './ColormapScatterLayer'

describe('buildColormapLUT — GPU continuous colormap LUT (TEST: DEC-4/ITEM-26)', () => {
  it('produces a 256×4 RGBA byte array at full alpha', () => {
    const lut = buildColormapLUT('viridis')
    expect(lut).toBeInstanceOf(Uint8Array)
    expect(lut.length).toBe(LUT_SIZE * 4)
    // every texel is opaque
    for (let k = 0; k < LUT_SIZE; k++) expect(lut[k * 4 + 3]).toBe(255)
  })

  it('endpoints equal the CPU colormap at t=0 and t=1 (byte-identical to color.ts)', () => {
    const lut = buildColormapLUT('viridis')
    // color.ts reference over the same identity ramp / domain
    const ramp = new Float32Array(LUT_SIZE)
    for (let k = 0; k < LUT_SIZE; k++) ramp[k] = k / (LUT_SIZE - 1)
    const { colors } = continuousColors(ramp, {
      colormap: 'viridis',
      scale: 'linear',
      domain: [0, 1],
      alpha: 255,
    })
    // endpoint 0
    expect([lut[0], lut[1], lut[2]]).toEqual([colors[0], colors[1], colors[2]])
    // endpoint 255
    const last = (LUT_SIZE - 1) * 4
    expect([lut[last], lut[last + 1], lut[last + 2]]).toEqual([
      colors[last],
      colors[last + 1],
      colors[last + 2],
    ])
    // viridis endpoints are dark-purple → yellow: low end is darker than high end
    expect(lut[0] + lut[1] + lut[2]).toBeLessThan(lut[last] + lut[last + 1] + lut[last + 2])
  })

  it('differs across colormaps (magma ≠ viridis)', () => {
    const v = buildColormapLUT('viridis')
    const m = buildColormapLUT('magma')
    let differs = false
    for (let i = 0; i < v.length; i++) if (v[i] !== m[i]) { differs = true; break }
    expect(differs).toBe(true)
  })
})

describe('buildPaletteLUT — GPU categorical palette LUT', () => {
  it('produces a 256×4 RGBA byte array at full alpha', () => {
    const lut = buildPaletteLUT()
    expect(lut.length).toBe(LUT_SIZE * 4)
    for (let i = 0; i < LUT_SIZE; i++) expect(lut[i * 4 + 3]).toBe(255)
  })

  it('texel i == DEFAULT_CATEGORICAL_PALETTE[i % palette.length] (wraparound baked in)', () => {
    const lut = buildPaletteLUT()
    const n = DEFAULT_CATEGORICAL_PALETTE.length
    for (const i of [0, 1, n - 1, n, n + 3, 255]) {
      const [r, g, b] = DEFAULT_CATEGORICAL_PALETTE[i % n]
      const o = i * 4
      expect([lut[o], lut[o + 1], lut[o + 2]]).toEqual([r, g, b])
    }
  })
})

describe('ColormapScatterLayer — in-shader colormap wiring (TEST: DEC-4/ITEM-26)', () => {
  it('exposes the `colormap` shader module with the scalar UBO uniform types', () => {
    expect(colormapModule.name).toBe('colormap')
    expect(colormapModule.uniformTypes.colorDomain).toBe('vec2<f32>')
    expect(colormapModule.uniformTypes.categorical).toBe('f32')
    expect(colormapModule.uniformTypes.paletteSize).toBe('f32')
    // the sampler is a binding (NOT declared in uniformTypes) — see split-uniforms-and-bindings
    expect('colormapTexture' in colormapModule.uniformTypes).toBe(false)
    // the module declares the sampler + UBO block in the vertex stage
    expect(colormapModule.vs).toContain('sampler2D colormapTexture')
    expect(colormapModule.vs).toContain('colormapUniforms')
  })

  it('injects the value attribute + the in-shader colormap sample', () => {
    // vs:#decl declares the per-instance value attribute
    expect(colormapInject['vs:#decl']).toContain('in float instanceColorValue;')
    // vs:#main-end computes the normalized t and samples the LUT to override the color
    const main = colormapInject['vs:#main-end']
    expect(main).toContain('clamp(')
    expect(main).toContain('colormap.colorDomain')
    expect(main).toContain('colormap.categorical')
    expect(main).toContain('texture(colormapTexture')
    expect(main).toContain('vFillColor =')
  })

  it('constructs as a ScatterplotLayer subclass preserving colormap props', () => {
    const positions = new Float32Array([0, 0, 1, 1, 2, 2])
    const colorValue = new Float32Array([0, 0.5, 1])
    const layer = new ColormapScatterLayer({
      id: 'gpu-scatter',
      data: {
        length: 3,
        attributes: {
          getPosition: { value: positions, size: 2 },
          getColorValue: { value: colorValue, size: 1 },
        },
      },
      colorDomain: [0, 1],
      categorical: false,
      colormapLut: buildColormapLUT('viridis'),
    } as never)
    expect(layer).toBeInstanceOf(ColormapScatterLayer)
    expect(ColormapScatterLayer.layerName).toBe('ColormapScatterLayer')
    expect(layer.props.colorDomain).toEqual([0, 1])
    expect(layer.props.categorical).toBe(false)
    expect(layer.props.colormapLut).toBeInstanceOf(Uint8Array)
  })
})

describe('blend mode — hue × value modulation wiring (TEST: BLEND_MODE_PLAN Phase 1)', () => {
  it('exposes the `blend` shader module with the scalar UBO uniform types', () => {
    expect(blendModule.name).toBe('blend')
    expect(blendModule.uniformTypes.modDomain).toBe('vec2<f32>')
    expect(blendModule.uniformTypes.enabled).toBe('f32')
    expect(blendModule.uniformTypes.channel).toBe('f32')
    expect(blendModule.uniformTypes.alphaFloor).toBe('f32')
    // the module declares the UBO block + the inline RGB↔HSL helpers in the vertex stage
    expect(blendModule.vs).toContain('blendUniforms')
    expect(blendModule.vs).toContain('cm_rgb2hsl')
    expect(blendModule.vs).toContain('cm_hsl2rgb')
  })

  it('declares the per-instance modulation attribute + a guarded, no-op-when-off apply', () => {
    expect(blendDecl).toContain('in float instanceModValue;')
    // the apply is a no-op branch unless enabled (byte-identical single-channel draw)
    expect(blendApply).toContain('blend.enabled > 0.5')
    // both channels: alpha ramp + lightness (HSL) scaling
    expect(blendApply).toContain('mix(blend.alphaFloor, 1.0')
    expect(blendApply).toContain('cm_rgb2hsl(vFillColor.rgb)')
    expect(blendApply).toContain('vFillColor =')
  })

  it('ColormapScatterLayer carries the blend props (getModValue / blendEnabled / channel / modDomain)', () => {
    const positions = new Float32Array([0, 0, 1, 1, 2, 2])
    const codes = new Float32Array([0, 1, 2])
    const modValue = new Float32Array([0, 0.5, 1])
    const layer = new ColormapScatterLayer({
      id: 'gpu-scatter-blend',
      data: {
        length: 3,
        attributes: {
          getPosition: { value: positions, size: 2 },
          getColorValue: { value: codes, size: 1 },
          getModValue: { value: modValue, size: 1 },
        },
      },
      categorical: true,
      colormapLut: buildPaletteLUT(),
      blendEnabled: true,
      blendChannel: 'lightness',
      modDomain: [0, 1],
      alphaFloor: 0.12,
    } as never)
    expect(layer.props.blendEnabled).toBe(true)
    expect(layer.props.blendChannel).toBe('lightness')
    expect(layer.props.modDomain).toEqual([0, 1])
    expect(layer.props.alphaFloor).toBe(0.12)
  })

  it('defaults blend OFF (byte-identical single-channel draw when unset)', () => {
    expect(ColormapScatterLayer.defaultProps.blendEnabled).toBe(false)
    expect(ColormapScatterLayer.defaultProps.blendChannel).toBe('lightness')
  })
})

describe('selection emphasis — single-layer in-shader dim (TEST: DEC-25/ITEM-25)', () => {
  it('exposes the `selection` shader module with scalar UBO uniform types', () => {
    expect(selectionModule.name).toBe('selection')
    expect(selectionModule.uniformTypes.selectionActive).toBe('f32')
    expect(selectionModule.uniformTypes.dimOpacity).toBe('f32')
    // no texture binding in this module
    expect(selectionModule.vs).toContain('selectionUniforms')
    expect(selectionModule.vs).toContain('selectionActive')
    expect(selectionModule.vs).toContain('dimOpacity')
  })

  it('declares the per-instance selected attribute + a dim-unselected apply snippet', () => {
    expect(selectionDecl).toContain('in float instanceSelected;')
    // apply dims ONLY unselected points (instanceSelected < 0.5) while a selection is live
    expect(selectionApply).toContain('selection.selectionActive > 0.5')
    expect(selectionApply).toContain('instanceSelected < 0.5')
    expect(selectionApply).toContain('vFillColor.a *= selection.dimOpacity')
  })

  it('ColormapScatterLayer carries the selection props (getSelected / selectionActive / dimOpacity)', () => {
    const positions = new Float32Array([0, 0, 1, 1, 2, 2])
    const colorValue = new Float32Array([0, 0.5, 1])
    const selected = new Float32Array([1, 0, 1])
    const layer = new ColormapScatterLayer({
      id: 'gpu-scatter-sel',
      data: {
        length: 3,
        attributes: {
          getPosition: { value: positions, size: 2 },
          getColorValue: { value: colorValue, size: 1 },
          getSelected: { value: selected, size: 1 },
        },
      },
      colorDomain: [0, 1],
      colormapLut: buildColormapLUT('viridis'),
      selectionActive: true,
      dimOpacity: 0.12,
    } as never)
    expect(layer.props.selectionActive).toBe(true)
    expect(layer.props.dimOpacity).toBe(0.12)
  })

  it('SelectableScatterLayer (CPU-color path) constructs with selection props', () => {
    const positions = new Float32Array([0, 0, 1, 1])
    const colors = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])
    const selected = new Float32Array([0, 1])
    const layer = new SelectableScatterLayer({
      id: 'cpu-scatter-sel',
      data: {
        length: 2,
        attributes: {
          getPosition: { value: positions, size: 2 },
          getFillColor: { value: colors, size: 4, normalized: true },
          getSelected: { value: selected, size: 1 },
        },
      },
      selectionActive: true,
      dimOpacity: 0.2,
    } as never)
    expect(layer).toBeInstanceOf(SelectableScatterLayer)
    expect(SelectableScatterLayer.layerName).toBe('SelectableScatterLayer')
    expect(layer.props.selectionActive).toBe(true)
    expect(layer.props.dimOpacity).toBe(0.2)
  })
})
