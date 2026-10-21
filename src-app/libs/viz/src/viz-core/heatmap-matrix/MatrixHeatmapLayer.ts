// MatrixHeatmapLayer.ts — a `BitmapLayer` subclass that renders one pyramid LEVEL of a big
// numeric matrix as a GPU heatmap IMAGE (value → colormap in-shader), with empty-bin
// transparency and free hover→cell picking. Same shape as `spatial/LabelMaskLayer.ts`
// (a custom fragment + a LUT texture bound by name + a data texture on the `bitmap` module's
// `bitmapTexture` slot + texel-encoded picking + texture disposal), but the data texture is
// an **RG8 value+coverage** raster (see matrixLevelTexture.ts) instead of an id label mask.
//
// FRAGMENT PIPELINE (per texel):
//   • sample the RG8 data texture: `value = R*255`, `coverage = G` (G === 0 ⟺ EMPTY bin).
//   • EMPTY (coverage 0) → `discard` (fully transparent — the authoritative empty-bin rule).
//   • BASE-LEVEL FILTER (level 0 only, `filterActive == 1`): the pyramid's base level carries
//     the RAW per-cell values (the filter is NOT baked into the base), so a cell whose value
//     ∉ `[filterLo, filterHi]` is discarded here, per-cell, in-shader. At AGGREGATED levels
//     `filterActive == 0`: the level was already recomputed filter-aware on the CPU
//     (out-of-filter population dropped → those coarse cells are empty → already discarded
//     above), so no per-cell test is applied.
//   • else colorize: `t = (value - domainLo)/(domainHi - domainLo)` (clamped) →
//     `texture(valueColorLut, vec2(t, 0.5))` — a continuous colormap LUT (gpu/colormapLut).
//   • sampling is NEAREST on the data texture: crisp cell blocks, never blurred.
//
// PICKING: the fragment encodes the texel's LINEAR row-major index into the picking color
// (`enc = texelY*texWidth + texelX`, packed into rgb — supports >256 rows); `getPickingInfo`
// decodes it via `decodePickTexel(color, texWidth)` and reads
// the cell's value+coverage straight out of the uploaded RG bytes — a single array read, no
// CPU hit-test. It reports `{ row, col, value, coverage }` (col in the level's coordinates,
// via `decodePickedCell` + the window's `tileColStart`).

import { BitmapLayer } from '@deck.gl/layers'
import type { Texture } from '@luma.gl/core'
import type { ShaderModule } from '@luma.gl/shadertools'
import { decodePickedCell, decodePickTexel } from './matrixLevelTexture'

/** Runtime props of the `matrixHeatmap` shader module: the colormap LUT + scalar UBO. */
export type MatrixHeatmapModuleProps = {
  /** bound by name to `uniform sampler2D valueColorLut` (NOT in uniformTypes). */
  valueColorLut: Texture
  /** bound by name to `uniform sampler2D maskTexture` — a 1-row R8 per-column "lit" mask
   *  (width == data-texture width). Sampled by column to decide dim vs full (see the
   *  fragment). Only read when `selectionActive > 0.5`; a 1×1 lit sentinel otherwise. */
  maskTexture: Texture
  /** (width, height) of the uploaded data texture — for the picking texel decode. */
  texDims: [number, number]
  /** value-domain lo/hi mapped to LUT coords 0..1 (`t = (value-lo)/(hi-lo)`). */
  domainLo: number
  domainHi: number
  /** 1 = apply the per-cell base filter (base level only); 0 = no per-cell test. */
  filterActive: number
  /** inclusive base value-range filter `[lo, hi]` (value units 0..255). */
  filterLo: number
  filterHi: number
  /** 1 = a cross-plot selection is active → dim un-lit columns to `dimOpacity`; 0 = skip
   *  the dim entirely (the mask texture is ignored / may be the 1×1 sentinel). */
  selectionActive: number
  /** opacity un-lit (unselected) columns render at while a selection is active (0.12). */
  dimOpacity: number
}

/** The `matrixHeatmap` module: the `valueColorLut` + `maskTexture` samplers + a std140 UBO
 *  of scalars. UBO field order MUST match `uniformTypes` order below. */
const matrixHeatmapUniformBlock = /* glsl */ `\
uniform sampler2D valueColorLut;
uniform sampler2D maskTexture;
layout(std140) uniform matrixHeatmapUniforms {
  vec2 texDims;
  float domainLo;
  float domainHi;
  float filterActive;
  float filterLo;
  float filterHi;
  float selectionActive;
  float dimOpacity;
} mh;
`

export const matrixHeatmapModule = {
  name: 'matrixHeatmap',
  fs: matrixHeatmapUniformBlock,
  uniformTypes: {
    texDims: 'vec2<f32>',
    domainLo: 'f32',
    domainHi: 'f32',
    filterActive: 'f32',
    filterLo: 'f32',
    filterHi: 'f32',
    selectionActive: 'f32',
    dimOpacity: 'f32',
  },
} as const satisfies ShaderModule<MatrixHeatmapModuleProps>

/**
 * Custom fragment shader. Reuses the base BitmapLayer vertex shader (sets `vTexCoord`) + the
 * `bitmap` module's `bitmapTexture` binding (here the RG8 value+coverage texture). Kept
 * shape-compatible with the base fragment so deck's assembler wraps it identically.
 */
export const MATRIX_HEATMAP_FRAGMENT = /* glsl */ `\
#version 300 es
#define SHADER_NAME matrix-heatmap-layer-fragment-shader

#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D bitmapTexture; // RG8: R = value/255, G = coverage (0 ⟺ empty) (NEAREST)

in vec2 vTexCoord;

out vec4 fragColor;

void main(void) {
  vec2 uv = vTexCoord;
  vec2 rg = texture(bitmapTexture, uv).rg;
  float value = rg.r * 255.0;    // decode uint8 value
  float coverage = rg.g;          // 0 ⟺ empty bin

  // EMPTY bin (no in-range population under this cell) → fully transparent + unpickable.
  if (coverage < 0.001) discard;

  // BASE-LEVEL per-cell filter (aggregated levels pass filterActive=0 — already filtered).
  if (mh.filterActive > 0.5) {
    if (value < mh.filterLo - 0.5 || value > mh.filterHi + 0.5) discard;
  }

  // value → colormap LUT (continuous). NEAREST data sampling keeps cell blocks crisp; the
  // LUT itself is sampled LINEAR for a smooth color ramp.
  float denom = max(mh.domainHi - mh.domainLo, 1e-6);
  float t = clamp((value - mh.domainLo) / denom, 0.0, 1.0);
  vec4 color = texture(valueColorLut, vec2(t, 0.5));

  // CROSS-PLOT SELECTION DIM (coordination): when a selection is active, columns NOT lit in
  // the per-column mask render at mh.dimOpacity; lit columns render full. maskTexture is a
  // 1-row R8 whose width == the data-texture width, so uv.x samples the SAME column as this
  // fragment (NEAREST => the column's texel). Skipped entirely when selectionActive == 0 (the
  // mask may be the 1x1 lit sentinel then). A UNIFORM/texture path: no per-cell CPU recolor,
  // no data-texture re-upload -- only the tiny 1xcols mask changes per selection.
  float alpha = color.a;
  if (mh.selectionActive > 0.5) {
    float lit = texture(maskTexture, vec2(uv.x, 0.5)).r;
    if (lit < 0.5) alpha *= mh.dimOpacity;
  }

  fragColor = vec4(color.rgb, alpha * layer.opacity);

  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);

  if (bool(picking.isActive) && !bool(picking.isAttribute)) {
    // hover → cell: encode the texel's LINEAR row-major index into the picking color's rgb.
    // enc = texelY*texWidth + texelX (NOT texelX*256+texelY -- that broke for >256 rows).
    // texWidth <= 32768 and enc < 2^24 fits the 24-bit rgb (~16.7M texels). deck writes this
    // layer's index into alpha. The JS decoder decodePickTexel(color, texWidth) MIRRORS this.
    float texelX = floor(uv.x * mh.texDims.x);
    float texelY = floor(uv.y * mh.texDims.y);
    float enc = texelY * mh.texDims.x + texelX;
    float b = floor(enc / 65536.0);
    float g = floor((enc - b * 65536.0) / 256.0);
    float r = enc - b * 65536.0 - g * 256.0;
    fragColor.rgb = vec3(r, g, b) / 255.0;
  }
}
`

/** Extra props this subclass adds on top of BitmapLayer. */
export type MatrixHeatmapLayerExtraProps = {
  /** RG8 texture bytes for the current window (from `packLevelToRG`); length `texW*texH*2`. */
  rgData?: Uint8Array | null
  /** data texture width (window columns) / height (rows). */
  texWidth?: number
  texHeight?: number
  /** continuous colormap LUT bytes (256×4 RGBA, from `buildColormapLUT`). */
  valueColorLut?: Uint8Array | null
  /** value domain `[lo, hi]` mapped to LUT coords 0..1. */
  valueDomain?: [number, number]
  /** apply the per-cell base filter (base level only). */
  filterActive?: boolean
  /** inclusive base filter range `[lo, hi]` (value units). */
  filterLo?: number
  filterHi?: number
  /** the level-column of the window's first texel (for picking col decode). */
  tileColStart?: number
  /** which pyramid level this layer is drawing (reported in picking info). */
  levelIndex?: number
  /** per-column "lit" mask for the CURRENT window (1 byte/column, `1` = lit / full, `0` =
   *  dimmed), length == `texWidth`. Built by the view from `columnSelectionMaskForLevel`
   *  sliced to the window. `null` when there's no selection (a 1×1 lit sentinel is used). */
  maskData?: Uint8Array | null
  /** width of `maskData` (== `texWidth` when present). */
  maskWidth?: number
  /** whether a cross-plot selection is active (dim un-lit columns). */
  selectionActive?: boolean
  /** opacity un-lit columns render at while a selection is active (default 0.12). */
  dimOpacity?: number
}

const NEAREST_SAMPLER = {
  minFilter: 'nearest',
  magFilter: 'nearest',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const

const LUT_SAMPLER = {
  minFilter: 'linear',
  magFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const

/**
 * A `BitmapLayer` that renders one matrix pyramid level as a colormapped heatmap image with
 * empty-bin transparency, an optional base-level per-cell value filter, and hover→cell
 * picking. Feed it `rgData` (+ `texWidth`/`texHeight`) from `packLevelToRG`, a `valueColorLut`
 * from `buildColormapLUT`, `valueDomain`, and `bounds`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class MatrixHeatmapLayer extends BitmapLayer<MatrixHeatmapLayerExtraProps> {
  static layerName = 'MatrixHeatmapLayer'
  static defaultProps = {
    ...BitmapLayer.defaultProps,
    rgData: { type: 'object', value: null },
    texWidth: { type: 'number', value: 0 },
    texHeight: { type: 'number', value: 0 },
    valueColorLut: { type: 'object', value: null },
    valueDomain: { type: 'array', value: [0, 255], compare: true },
    filterActive: false,
    filterLo: { type: 'number', value: 0 },
    filterHi: { type: 'number', value: 255 },
    tileColStart: { type: 'number', value: 0 },
    levelIndex: { type: 'number', value: 0 },
    maskData: { type: 'object', value: null },
    maskWidth: { type: 'number', value: 0 },
    selectionActive: false,
    dimOpacity: { type: 'number', value: 0.12 },
  }

  getShaders() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaders = super.getShaders() as any
    shaders.fs = MATRIX_HEATMAP_FRAGMENT
    shaders.modules = [...(shaders.modules ?? []), matrixHeatmapModule]
    return shaders
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateState(params: any) {
    super.updateState(params) // builds the quad mesh from `bounds` + the model
    const { props, oldProps } = params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any

    // (Re)build the RG8 data texture whenever the window bytes/size change.
    if (
      props.rgData &&
      props.texWidth > 0 &&
      props.texHeight > 0 &&
      (props.rgData !== oldProps.rgData ||
        props.texWidth !== oldProps.texWidth ||
        props.texHeight !== oldProps.texHeight)
    ) {
      state.dataTexture?.destroy?.()
      const dataTexture = this.context.device.createTexture({
        format: 'rg8unorm',
        width: props.texWidth,
        height: props.texHeight,
        data: props.rgData,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sampler: NEAREST_SAMPLER as any,
      })
      this.setState({ dataTexture })
    }

    // (Re)build the 1-row R8 per-column MASK texture (drives the selection dim). A 1×1 lit
    // sentinel (value 255) is created when there's no windowed mask, so the `maskTexture`
    // sampler is ALWAYS bound (the shader only reads it when selectionActive == 1).
    if (
      props.maskData &&
      props.maskWidth > 0 &&
      (props.maskData !== oldProps.maskData || props.maskWidth !== oldProps.maskWidth)
    ) {
      state.maskTexture?.destroy?.()
      const maskTexture = this.context.device.createTexture({
        format: 'r8unorm',
        width: props.maskWidth,
        height: 1,
        data: props.maskData,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sampler: NEAREST_SAMPLER as any,
      })
      this.setState({ maskTexture })
    } else if (!state.maskTexture) {
      const maskTexture = this.context.device.createTexture({
        format: 'r8unorm',
        width: 1,
        height: 1,
        data: new Uint8Array([255]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sampler: NEAREST_SAMPLER as any,
      })
      this.setState({ maskTexture })
    }

    // (Re)build the colormap LUT texture (256×1 RGBA, LINEAR) when the palette changes.
    if (props.valueColorLut && props.valueColorLut !== oldProps.valueColorLut) {
      state.lutTexture?.destroy?.()
      const w = props.valueColorLut.length / 4
      const lutTexture = this.context.device.createTexture({
        format: 'rgba8unorm',
        width: w,
        height: 1,
        data: props.valueColorLut,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sampler: LUT_SAMPLER as any,
      })
      this.setState({ lutTexture })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    const { model, dataTexture, lutTexture, maskTexture, bounds, coordinateConversion, disablePicking } =
      state
    if (opts?.shaderModuleProps?.picking?.isActive && disablePicking) return
    if (!model || !dataTexture || !lutTexture || !maskTexture) return // nothing uploaded yet

    const domain = (this.props.valueDomain as [number, number]) ?? [0, 255]
    model.shaderInputs.setProps({
      bitmap: {
        bitmapTexture: dataTexture,
        bounds,
        coordinateConversion: coordinateConversion ?? 0,
        desaturate: 0,
        tintColor: [0, 0, 0],
        transparentColor: [0, 0, 0, 0],
      },
      matrixHeatmap: {
        valueColorLut: lutTexture,
        maskTexture,
        texDims: [this.props.texWidth ?? 0, this.props.texHeight ?? 0],
        domainLo: domain[0],
        domainHi: domain[1],
        filterActive: this.props.filterActive ? 1 : 0,
        filterLo: this.props.filterLo ?? 0,
        filterHi: this.props.filterHi ?? 255,
        selectionActive: this.props.selectionActive ? 1 : 0,
        dimOpacity: this.props.dimOpacity ?? 0.12,
      } satisfies MatrixHeatmapModuleProps,
    })
    model.draw(this.context.renderPass)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPickingInfo(params: any) {
    const info = params.info
    const color: Uint8Array | null = info?.color ?? null
    const rgData = this.props.rgData as Uint8Array | null
    const texW = this.props.texWidth ?? 0
    const texH = this.props.texHeight ?? 0
    if (!color || !rgData || texW <= 0 || texH <= 0) {
      info.object = null
      info.id = null
      return info
    }
    // Decode the texel we encoded in the pick pass: enc = texelX*256 + texelY.
    // MIRRORS the shader's linear encode `enc = texelY*texWidth + texelX` (see the pick block).
    const { texelX, texelY } = decodePickTexel(color, texW)
    if (texelX >= texW || texelY >= texH) {
      info.object = null
      info.id = null
      return info
    }
    const cell = decodePickedCell(
      this.props.levelIndex ?? 0,
      this.props.tileColStart ?? 0,
      texelX,
      texelY,
    )
    const o = (texelY * texW + texelX) * 2
    const value = rgData[o]
    const coverage = rgData[o + 1]
    info.index = texelY * texW + texelX
    info.object = { row: cell.row, col: cell.col, value, coverage }
    return info
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalizeState(context: any) {
    super.finalizeState(context)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    state.dataTexture?.destroy?.()
    state.lutTexture?.destroy?.()
    state.maskTexture?.destroy?.()
  }
}
