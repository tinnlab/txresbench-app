// ColormapScatterLayer.ts — a `ScatterplotLayer` subclass that colors each point
// FROM A PER-INSTANCE VALUE ATTRIBUTE IN THE SHADER (DEC-4 / ITEM-26), instead of a
// precomputed CPU RGBA buffer. This removes the O(N) JS color loop from the render path:
// recolor = swap the `getColorValue` Float32 attribute + change a domain uniform (and,
// for color-by-column, swap the colormap LUT texture). At 10M points that's a buffer
// re-upload + a uniform, never a per-point JS pass.
//
// HOW IT WORKS (deck.gl v9 / luma.gl v9 custom-layer shader injection):
//   • a per-instance `instanceColorValue` Float32 attribute (accessor `getColorValue`),
//     added in initializeState via the attribute manager (binary-attribute compatible),
//   • a `colormap` shader MODULE providing a std140 UBO ({colorDomain, categorical,
//     paletteSize}) + a `colormapTexture` sampler (bound by name — luma.gl routes any
//     non-uniform Texture prop passed to `shaderInputs.setProps` to the matching sampler,
//     see split-uniforms-and-bindings),
//   • an INJECT that (vs:#decl) declares the attribute and (vs:#main-end) computes
//         t = clamp((value - min) / (max - min), 0, 1)     // continuous
//         t = (code + 0.5) / paletteSize                    // categorical (NEAREST)
//     and overrides the point color = texture(colormapLut, vec2(t, 0.5)).
//
// The colormap LUT texture is built lazily on-device in updateState from the raw
// `colormapLut` bytes (from gpu/colormapLut.ts). There is NO JS fallback INSIDE this
// layer — the shader path is the primary and only path here; the CPU-precompute
// fallback lives at the call site (DeckScatterCanvas's existing `colors` prop).
//
// SELECTION EMPHASIS (DEC-25 / ITEM-25, single-layer path). Emphasising a selected subset
// is ALSO an in-shader per-point operation here: a per-instance `instanceSelected` (0/1)
// attribute + a `selection` UBO ({selectionActive, dimOpacity}). When a selection is live,
// the shader dims UNselected points' alpha in place — so a selection change re-uploads only
// the tiny 1-float/point `getSelected` attribute and toggles a uniform, with NO second
// overlay layer (which re-uploaded a full copy of positions) and NO positions re-upload.
// The same `selection` module + inject is shared with `SelectableScatterLayer` so the
// CPU-precompute (`colors`) path gets identical single-layer emphasis.

// OVERDRAW-BOUNDING / DENSE-POINTS REGIME (research item #5). The size/alpha/blend-by-density
// treatment needs NO shader change here: it flows entirely through base-ScatterplotLayer props the
// canvas already sets per density —
//   • point SIZE   → `getRadius` (+ `radiusScale`/`radiusMinPixels`) — a global scale, since
//                    on-screen density is a view property (no per-instance size attribute needed);
//   • per-point ALPHA → the standard deck `opacity` prop, surfaced as the `layer.opacity` uniform,
//                    which the colormap inject already multiplies into `vFillColor.a`
//                    (`cm_color.a * layer.opacity`) for BOTH the continuous and categorical branches;
//   • additive BLEND → the base layer's `parameters` (built by `buildScatterProps({additive})`),
//                    with `antialiasing` off under accumulation.
// So this subclass is unchanged for the dense regime — the alpha it emits is simply scaled by
// `layer.opacity`, and under additive blend the low alpha becomes the per-point density weight.

import { ScatterplotLayer } from '@deck.gl/layers'
import type { Texture } from '@luma.gl/core'
import type { ShaderModule } from '@luma.gl/shadertools'

/** The shader module's runtime props: the sampler binding + the scalar UBO uniforms. */
export type ColormapModuleProps = {
  /** bound by name to `uniform sampler2D colormapTexture` (NOT in uniformTypes). */
  colormapTexture: Texture
  colorDomain: [number, number]
  /** 1 = categorical (index by code), 0 = continuous (normalize by domain). */
  categorical: number
  /** texture width used for categorical index math (= LUT_SIZE, 256). */
  paletteSize: number
}

/** The selection-emphasis module's runtime props (shared by both scatter subclasses). */
export type SelectionModuleProps = {
  /** 1 = a selection is live → dim the UNselected points; 0 = draw everything full. */
  selectionActive: number
  /** alpha multiplier applied to unselected points while a selection is live. */
  dimOpacity: number
}

/**
 * The BLEND module's runtime props (BLEND_MODE_PLAN Phase 1). When `enabled`, the base hue
 * (already sampled from the palette LUT via `instanceColorValue` as the CATEGORY code) is
 * modulated by a SECOND per-instance scalar `instanceModValue`: on LIGHTNESS (`channel` 0,
 * default) via an inline RGB→HSL→scale-L→RGB, or on ALPHA (`channel` 1, legacy parity).
 * `enabled = 0` ⇒ the blend snippet is a no-op branch ⇒ byte-identical to the pre-blend draw.
 */
export type BlendModuleProps = {
  /** [min,max] the modulation value normalizes over (per-group ⇒ [0,1]; global ⇒ real). */
  modDomain: [number, number]
  /** 1 = modulate the base hue by `instanceModValue`; 0 = leave the base hue untouched. */
  enabled: number
  /** 0 = lightness (default), 1 = alpha. */
  channel: number
  /** the value at modulation 0 (default 0.1) — low points stay faintly visible. */
  alphaFloor: number
}

/** std140 UBO + the 1D LUT sampler (declared in the vertex stage — we colorize in VS). */
const uniformBlock = /* glsl */ `\
uniform sampler2D colormapTexture;
layout(std140) uniform colormapUniforms {
  vec2 colorDomain;
  float categorical;
  float paletteSize;
} colormap;
`

/** The `colormap` shader module (scalars via uniformTypes; the texture is a binding). */
export const colormapModule = {
  name: 'colormap',
  vs: uniformBlock,
  uniformTypes: {
    colorDomain: 'vec2<f32>',
    categorical: 'f32',
    paletteSize: 'f32',
  },
} as const satisfies ShaderModule<ColormapModuleProps>

/** std140 UBO for the selection emphasis (no texture — pure scalar uniforms). */
const selectionUniformBlock = /* glsl */ `\
layout(std140) uniform selectionUniforms {
  float selectionActive;
  float dimOpacity;
} selection;
`

/** The `selection` shader module — shared by ColormapScatterLayer + SelectableScatterLayer. */
export const selectionModule = {
  name: 'selection',
  vs: selectionUniformBlock,
  uniformTypes: {
    selectionActive: 'f32',
    dimOpacity: 'f32',
  },
} as const satisfies ShaderModule<SelectionModuleProps>

/** GLSL declaring the per-instance selected attribute (prepended to `vs:#decl`). */
export const selectionDecl = /* glsl */ `\
in float instanceSelected;
`

/** std140 UBO + the inline RGB↔HSL helpers for the blend lightness modulation. The helpers
 *  mirror `data/color.ts::rgbToHsl`/`hslToRgb` (only the lightness channel is scaled). */
const blendUniformBlock = /* glsl */ `\
layout(std140) uniform blendUniforms {
  vec2 modDomain;
  float enabled;
  float channel;
  float alphaFloor;
} blend;
vec3 cm_rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-6) return vec3(0.0, 0.0, l);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float cm_hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 cm_hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s < 1e-6) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(cm_hue2rgb(p, q, h + 1.0 / 3.0), cm_hue2rgb(p, q, h), cm_hue2rgb(p, q, h - 1.0 / 3.0));
}
`

/** The `blend` shader module (scalars + vec2 via uniformTypes; no extra texture). */
export const blendModule = {
  name: 'blend',
  vs: blendUniformBlock,
  uniformTypes: {
    modDomain: 'vec2<f32>',
    enabled: 'f32',
    channel: 'f32',
    alphaFloor: 'f32',
  },
} as const satisfies ShaderModule<BlendModuleProps>

/** GLSL declaring the per-instance modulation attribute (prepended to `vs:#decl`). */
export const blendDecl = /* glsl */ `\
in float instanceModValue;
`

/**
 * GLSL applying the blend modulation. Runs AFTER the colormap base hue is set and BEFORE the
 * selection dim, so: base hue (palette) → value modulation → selection emphasis. A no-op
 * branch when `blend.enabled` is off ⇒ byte-identical to the pre-blend draw.
 */
export const blendApply = /* glsl */ `\
if (blend.enabled > 0.5) {
  float bl_span = max(blend.modDomain.y - blend.modDomain.x, 1e-6);
  float bl_m = clamp((instanceModValue - blend.modDomain.x) / bl_span, 0.0, 1.0);
  float bl_f = mix(blend.alphaFloor, 1.0, bl_m);
  if (blend.channel > 0.5) {
    // alpha channel (legacy parity): ramp alpha from the floor to full by the value.
    vFillColor = vec4(vFillColor.rgb, bl_f * layer.opacity);
  } else {
    // lightness channel (default): scale the base hue's HSL lightness by the floor→1 ramp.
    vec3 bl_hsl = cm_rgb2hsl(vFillColor.rgb);
    bl_hsl.z = clamp(bl_hsl.z * bl_f, 0.0, 1.0);
    vFillColor = vec4(cm_hsl2rgb(bl_hsl), vFillColor.a);
  }
}
`

/**
 * GLSL applying the emphasis: dim UNselected points' alpha when a selection is live.
 * Appended AFTER `vFillColor` is set (works for both the colormap + CPU-color paths).
 */
export const selectionApply = /* glsl */ `\
if (selection.selectionActive > 0.5 && instanceSelected < 0.5) {
  vFillColor.a *= selection.dimOpacity;
}
`

/** The GLSL injected into the base ScatterplotLayer vertex shader (colormap coloring). */
export const colormapInject = {
  // Declare the per-instance value attribute before main().
  'vs:#decl': /* glsl */ `\
in float instanceColorValue;
`,
  // After the base shader set vFillColor, override it from the sampled LUT.
  'vs:#main-end': /* glsl */ `\
{
  float cm_t;
  if (colormap.categorical > 0.5) {
    // categorical: index the palette texture by code (NEAREST); wraparound is baked in.
    cm_t = (instanceColorValue + 0.5) / colormap.paletteSize;
  } else {
    // continuous: normalize the value into [0,1] over the color domain.
    float cm_span = max(colormap.colorDomain.y - colormap.colorDomain.x, 1e-6);
    cm_t = clamp((instanceColorValue - colormap.colorDomain.x) / cm_span, 0.0, 1.0);
  }
  vec4 cm_color = texture(colormapTexture, vec2(cm_t, 0.5));
  vFillColor = vec4(cm_color.rgb, cm_color.a * layer.opacity);
}
`,
} as const

/** Extra props both scatter subclasses share for selection emphasis. */
export type SelectionExtraProps = {
  /** per-point 0/1 selected accessor (in binary mode: `data.attributes.getSelected`). */
  getSelected?: unknown
  /** 1/true = a selection is live → dim the unselected points in shader. */
  selectionActive?: boolean
  /** alpha multiplier for unselected points while a selection is live. */
  dimOpacity?: number
}

/** Extra props for the blend-mode modulation (BLEND_MODE_PLAN Phase 1). */
export type BlendExtraProps = {
  /** per-point modulation accessor (in binary mode: `data.attributes.getModValue`). */
  getModValue?: unknown
  /** 1/true = modulate the base hue by `getModValue`; default off ⇒ byte-identical draw. */
  blendEnabled?: boolean
  /** which channel the value modulates. */
  blendChannel?: 'lightness' | 'alpha'
  /** [min,max] the modulation value normalizes over (per-group ⇒ [0,1]). */
  modDomain?: [number, number]
  /** the value at modulation 0 (default 0.1). */
  alphaFloor?: number
}

/** Extra props this subclass adds on top of ScatterplotLayer. */
export type ColormapScatterExtraProps = SelectionExtraProps &
  BlendExtraProps & {
    /** per-point value accessor (in binary mode: `data.attributes.getColorValue`). */
    getColorValue?: unknown
    /** [min, max] the continuous value normalizes over (ignored in categorical mode). */
    colorDomain?: [number, number]
    /** color-by-category: value = code, sampled from the palette LUT. */
    categorical?: boolean
    /** LUT texture width for categorical index math (default 256). */
    paletteSize?: number
    /** the 256×4 RGBA LUT bytes (build via gpu/colormapLut.ts). */
    colormapLut?: Uint8Array | null
  }

const SELECTION_DEFAULT_PROPS = {
  getSelected: { type: 'accessor', value: 0 },
  selectionActive: false,
  dimOpacity: { type: 'number', value: 0.12 },
} as const

const BLEND_DEFAULT_PROPS = {
  getModValue: { type: 'accessor', value: 0 },
  blendEnabled: false,
  blendChannel: 'lightness',
  modDomain: { type: 'array', value: [0, 1], compare: true },
  alphaFloor: { type: 'number', value: 0.1 },
} as const

/**
 * ScatterplotLayer that colors points in-shader from a value attribute + a colormap LUT,
 * with in-shader selection emphasis. Feed it BINARY attributes exactly like the base
 * layer, adding `data.attributes.getColorValue = { value: Float32Array, size: 1 }`
 * (+ optionally `getSelected = { value: Float32Array(0/1), size: 1 }`), plus `colorDomain`
 * (+ `categorical`) and the `colormapLut` bytes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class ColormapScatterLayer extends ScatterplotLayer<any, ColormapScatterExtraProps> {
  static layerName = 'ColormapScatterLayer'
  static defaultProps = {
    ...ScatterplotLayer.defaultProps,
    ...SELECTION_DEFAULT_PROPS,
    ...BLEND_DEFAULT_PROPS,
    getColorValue: { type: 'accessor', value: 0 },
    colorDomain: { type: 'array', value: [0, 1], compare: true },
    categorical: false,
    paletteSize: { type: 'number', value: 256 },
    colormapLut: { type: 'object', value: null },
  }

  getShaders() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaders = super.getShaders() as any
    shaders.modules = [...(shaders.modules ?? []), colormapModule, blendModule, selectionModule]
    // Merge the colormap inject with the blend + shared selection decl/apply into ONE hook
    // value each. ORDER at `vs:#main-end`: base hue (colormap) → value modulation (blend) →
    // selection dim — so each stage operates on the prior stage's `vFillColor`.
    shaders.inject = {
      ...(shaders.inject ?? {}),
      'vs:#decl': colormapInject['vs:#decl'] + blendDecl + selectionDecl,
      'vs:#main-end': colormapInject['vs:#main-end'] + blendApply + selectionApply,
    }
    return shaders
  }

  initializeState() {
    super.initializeState()
    this.getAttributeManager()!.addInstanced({
      instanceColorValue: {
        size: 1,
        type: 'float32',
        accessor: 'getColorValue',
        defaultValue: 0,
      },
      instanceModValue: {
        size: 1,
        type: 'float32',
        accessor: 'getModValue',
        defaultValue: 0,
      },
      instanceSelected: {
        size: 1,
        type: 'float32',
        accessor: 'getSelected',
        defaultValue: 0,
      },
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateState(params: any) {
    super.updateState(params)
    const { props, oldProps } = params
    if (props.colormapLut && props.colormapLut !== oldProps.colormapLut) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this.state as any).colormapTexture?.destroy?.()
      const filter = props.categorical ? 'nearest' : 'linear'
      const lut: Uint8Array = props.colormapLut
      const texture = this.context.device.createTexture({
        format: 'rgba8unorm',
        sampler: {
          minFilter: filter,
          magFilter: filter,
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        },
        data: lut,
        width: lut.length / 4,
        height: 1,
      })
      this.setState({ colormapTexture: texture })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    const colormapTexture: Texture | undefined = state.colormapTexture
    if (colormapTexture && state.model) {
      state.model.shaderInputs.setProps({
        colormap: {
          colormapTexture,
          colorDomain: this.props.colorDomain ?? [0, 1],
          categorical: this.props.categorical ? 1 : 0,
          paletteSize: this.props.paletteSize ?? 256,
        } satisfies ColormapModuleProps,
        blend: {
          modDomain: this.props.modDomain ?? [0, 1],
          enabled: this.props.blendEnabled ? 1 : 0,
          channel: this.props.blendChannel === 'alpha' ? 1 : 0,
          alphaFloor: this.props.alphaFloor ?? 0.1,
        } satisfies BlendModuleProps,
        selection: {
          selectionActive: this.props.selectionActive ? 1 : 0,
          dimOpacity: this.props.dimOpacity ?? 0.12,
        } satisfies SelectionModuleProps,
      })
    }
    super.draw(opts)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalizeState(context: any) {
    super.finalizeState(context)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this.state as any).colormapTexture?.destroy?.()
  }
}

/** Extra props for the CPU-precompute selectable scatter (selection only). */
export type SelectableScatterExtraProps = SelectionExtraProps

/**
 * ScatterplotLayer with the SAME in-shader selection emphasis as ColormapScatterLayer,
 * for the CPU-precompute (`getFillColor`) color path. Lets the selection overlay be a
 * single-layer per-point attribute swap (no second layer, no positions re-upload) on the
 * back-compat color path too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class SelectableScatterLayer extends ScatterplotLayer<any, SelectableScatterExtraProps> {
  static layerName = 'SelectableScatterLayer'
  static defaultProps = {
    ...ScatterplotLayer.defaultProps,
    ...SELECTION_DEFAULT_PROPS,
  }

  getShaders() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaders = super.getShaders() as any
    shaders.modules = [...(shaders.modules ?? []), selectionModule]
    shaders.inject = {
      ...(shaders.inject ?? {}),
      'vs:#decl': ((shaders.inject ?? {})['vs:#decl'] ?? '') + selectionDecl,
      'vs:#main-end': ((shaders.inject ?? {})['vs:#main-end'] ?? '') + selectionApply,
    }
    return shaders
  }

  initializeState() {
    super.initializeState()
    this.getAttributeManager()!.addInstanced({
      instanceSelected: {
        size: 1,
        type: 'float32',
        accessor: 'getSelected',
        defaultValue: 0,
      },
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    if (state.model) {
      state.model.shaderInputs.setProps({
        selection: {
          selectionActive: this.props.selectionActive ? 1 : 0,
          dimOpacity: this.props.dimOpacity ?? 0.12,
        } satisfies SelectionModuleProps,
      })
    }
    super.draw(opts)
  }
}
