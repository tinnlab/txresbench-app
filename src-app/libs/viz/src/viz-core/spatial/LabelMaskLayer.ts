// LabelMaskLayer.ts — a `BitmapLayer` subclass that renders a GPU LABEL-MASK
// (bitmask) overlay. Each texel of the label raster IS an integer label id; the
// fragment shader samples the id, looks it up in an id→category→color LUT texture,
// paints the fill, and (with the `stroked` uniform on) draws region boundaries
// in-shader — instead of CPU-tessellating millions of polygons. This mirrors the
// Vitessce/Viv bitmask approach and the shader-injection pattern of
// `gpu/ColormapScatterLayer.ts` (custom shader + a LUT texture bound by name), but for
// a raster instead of a point cloud.
//
// WHY A BITMASK (research): pixel value = label id ⇒ (a) color-by-category is a texture
// lookup IN-SHADER (recolor = rebuild the tiny id→color LUT, never re-tessellate),
// (b) the boundary/stroke is free (a pixel whose 4-neighbours differ in id is an edge),
// (c) hover→label id is free (the sampled id is encoded into the picking color).
//
// HOW IT WORKS (deck.gl v9 / luma.gl v9):
//   • The label mask is uploaded as an RGBA texture with the id packed into rgb bytes
//     (`labelMaskColor.encodeLabelMaskRGBA`), sampled NEAREST, bound as the base
//     layer's `bitmapTexture`. The id→RGBA color LUT (`buildIdColorLut`) is a second
//     NEAREST texture bound by name as `idColorLut` via the `labelMask` module.
//   • A CUSTOM fragment shader (`LABEL_MASK_FRAGMENT`) replaces the base BitmapLayer
//     fragment: decode id → `discard` if 0 (background: transparent AND unpickable) →
//     sample the fill color → if `stroked`, flag boundary pixels (4-neighbour id
//     differs) and paint them `strokeColor` → apply `fillOpacity` + `layer.opacity`.
//   • Picking: in the pick pass the shader encodes the sampled id into the picking
//     color's rgb (deck's constant-blend writes THIS layer's index into alpha, so the
//     pick still attributes to this layer); `getPickingInfo` decodes rgb → the exact
//     label id. So hover returns the label id with no CPU raster scan.
//
// TILE-EDGE CAVEAT: the boundary test samples 4 neighbours within THIS texture only, so
// if a label mask were split across multiple tiles the stroke would be under-drawn at
// tile seams (fill is unaffected — it needs no neighbours). For our single-texture demo
// this is moot; a tiled deployment would overlap-sample or stitch at the seam.

import { BitmapLayer } from '@deck.gl/layers'
import type { Texture } from '@luma.gl/core'
import type { ShaderModule } from '@luma.gl/shadertools'
import {
  buildIdColorLut,
  encodeLabelMaskRGBA,
  packIdToRGB,
  CATEGORICAL_PALETTE_DEFAULT,
  type LabelMask,
  type Palette,
} from './labelMaskColor'

/**
 * A dirty rectangle in pixel space: `[minX, minY, maxX, maxY]`, INCLUSIVE on all four bounds
 * (the same shape `annotate/maskEdit.ts` returns). `maxX < minX` ⇒ EMPTY (nothing changed).
 * Declared locally (structurally identical) so the spatial layer never imports from `annotate/`
 * (keeps the module graph a DAG — annotate depends on spatial, never the reverse).
 */
export type DirtyRect = readonly [minX: number, minY: number, maxX: number, maxY: number]

/** True iff a dirty-rect encloses no pixels. */
function dirtyRectIsEmpty(rect: DirtyRect): boolean {
  return rect[2] < rect[0] || rect[3] < rect[1]
}

/** A sub-region texture upload: the encoded RGBA bytes for `[x, y, width, height]`. */
export interface SubImageUpload {
  readonly data: Uint8Array
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Encode ONLY the pixels inside `rect` of a label raster into a packed RGBA sub-image (id → rgb,
 * alpha 255), ready for a luma.gl v9 `texture.copyImageData({data, x, y, width, height})` upload.
 * Cost is O(area of rect), NOT O(w·h) — this is the dirty-rect path that replaces a full
 * `encodeLabelMaskRGBA` rebuild on an in-place mask correction (ITEM-12, the gigapixel-safety
 * invariant). `maskWidth` is the FULL raster stride.
 */
export function encodeLabelMaskSubRect(
  mask: LabelMask,
  maskWidth: number,
  rect: DirtyRect,
): SubImageUpload {
  const x0 = rect[0]
  const y0 = rect[1]
  const rw = rect[2] - x0 + 1
  const rh = rect[3] - y0 + 1
  const data = new Uint8Array(rw * rh * 4)
  for (let ry = 0; ry < rh; ry++) {
    const srcRow = (y0 + ry) * maskWidth + x0
    const dstRow = ry * rw
    for (let rx = 0; rx < rw; rx++) {
      const [r, g, b] = packIdToRGB(mask[srcRow + rx])
      const o = (dstRow + rx) * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return { data, x: x0, y: y0, width: rw, height: rh }
}

/** Runtime props of the `labelMask` shader module: the LUT sampler + scalar UBO. */
export type LabelMaskModuleProps = {
  /** bound by name to `uniform sampler2D idColorLut` (NOT in uniformTypes). */
  idColorLut: Texture
  /** (1/width, 1/height) of the label texture — the neighbour-sample step. */
  texel: [number, number]
  /** (width, height) of the packed id→color LUT texture, for the id→uv math. */
  lutSize: [number, number]
  /** boundary stroke color, normalized rgba in [0,1]. */
  strokeColor: [number, number, number, number]
  /** 1 = paint region boundaries in `strokeColor`; 0 = fill only. */
  stroked: number
  /** neighbour-sample distance in texels (thicker stroke = larger). */
  strokeWidth: number
  /** multiplier on the fill alpha (0 = outline-only when `stroked`). */
  fillOpacity: number
  /** highlight this label id (0 = none): its fill is brightened toward white (ITEM-11 select). */
  selectedId: number
}

/** The `labelMask` module: the `idColorLut` sampler + a std140 UBO of scalars. */
const labelMaskUniformBlock = /* glsl */ `\
uniform sampler2D idColorLut;
layout(std140) uniform labelMaskUniforms {
  vec2 texel;
  vec2 lutSize;
  vec4 strokeColor;
  float stroked;
  float strokeWidth;
  float fillOpacity;
  float selectedId;
} lm;
`

export const labelMaskModule = {
  name: 'labelMask',
  fs: labelMaskUniformBlock,
  uniformTypes: {
    texel: 'vec2<f32>',
    lutSize: 'vec2<f32>',
    strokeColor: 'vec4<f32>',
    stroked: 'f32',
    strokeWidth: 'f32',
    fillOpacity: 'f32',
    selectedId: 'f32',
  },
} as const satisfies ShaderModule<LabelMaskModuleProps>

/**
 * The custom fragment shader. Reuses the base BitmapLayer vertex shader (which sets
 * `vTexCoord`) + the `bitmap` module's `bitmapTexture` binding (the label mask). Kept
 * shape-compatible with the base fragment so deck's shader assembler (geometry struct,
 * `DECKGL_FILTER_COLOR`, picking module) wraps it identically.
 */
export const LABEL_MASK_FRAGMENT = /* glsl */ `\
#version 300 es
#define SHADER_NAME label-mask-layer-fragment-shader

#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D bitmapTexture; // label mask: label id packed into rgb bytes (NEAREST)

in vec2 vTexCoord;

out vec4 fragColor;

// Decode the integer label id from a packed rgb texel (id = r + g*256 + b*65536).
float lm_decodeId(vec4 c) {
  return floor(c.r * 255.0 + 0.5)
       + floor(c.g * 255.0 + 0.5) * 256.0
       + floor(c.b * 255.0 + 0.5) * 65536.0;
}

// Look up label \`id\`'s fill color in the packed 2-D id->RGBA LUT (NEAREST).
vec4 lm_lutColor(float id) {
  float w = lm.lutSize.x;
  float h = lm.lutSize.y;
  float col = mod(id, w);
  float row = floor(id / w);
  return texture(idColorLut, vec2((col + 0.5) / w, (row + 0.5) / h));
}

void main(void) {
  vec2 uv = vTexCoord;
  float id = lm_decodeId(texture(bitmapTexture, uv));

  // background (id 0): nothing to paint AND nothing to pick — carve it out.
  if (id < 0.5) discard;

  vec4 fill = lm_lutColor(id);

  bool boundary = false;
  if (lm.stroked > 0.5) {
    // in-shader boundary: a pixel whose 4-neighbour id differs is on a region edge.
    // clamp-to-edge sampling means image-border neighbours read the same id (no edge).
    vec2 t = lm.texel * lm.strokeWidth;
    float nl = lm_decodeId(texture(bitmapTexture, uv + vec2(-t.x, 0.0)));
    float nr = lm_decodeId(texture(bitmapTexture, uv + vec2( t.x, 0.0)));
    float nu = lm_decodeId(texture(bitmapTexture, uv + vec2(0.0, -t.y)));
    float nd = lm_decodeId(texture(bitmapTexture, uv + vec2(0.0,  t.y)));
    boundary = (nl != id) || (nr != id) || (nu != id) || (nd != id);
  }

  vec4 color;
  if (lm.stroked > 0.5 && boundary) {
    color = lm.strokeColor;
  } else {
    color = vec4(fill.rgb, fill.a * lm.fillOpacity);
  }

  // ITEM-11 selection highlight: brighten the selected region toward white + force it opaque so
  // it reads as picked even in outline mode. Uses the same decoded id — no extra sampling.
  if (lm.selectedId > 0.5 && abs(id - lm.selectedId) < 0.5) {
    color = vec4(mix(color.rgb, vec3(1.0), 0.55), max(color.a, 0.85));
  }

  fragColor = vec4(color.rgb, color.a * layer.opacity);

  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);

  if (bool(picking.isActive) && !bool(picking.isAttribute)) {
    // hover -> label id: encode the sampled id into the picking color's rgb. deck's
    // constant-blend writes this layer's index into alpha (so the pick attributes to
    // THIS layer); getPickingInfo decodes the rgb back to the exact label id.
    float b = floor(id / 65536.0);
    float g = floor((id - b * 65536.0) / 256.0);
    float r = id - b * 65536.0 - g * 256.0;
    fragColor.rgb = vec3(r, g, b) / 255.0;
  }
}
`

/** Extra props this subclass adds on top of BitmapLayer. */
export type LabelMaskLayerExtraProps = {
  /** integer label raster, row-major, id per pixel (0 = background). */
  labelMask?: LabelMask | null
  /** label raster width in pixels. */
  width?: number
  /** label raster height in pixels. */
  height?: number
  /** id→category code (index 0 = background); drives the id→color LUT. */
  categoryForId?: Uint16Array | null
  /** categorical palette for the categories (default the shared categorical palette). */
  palette?: Palette
  /** draw region boundaries in `strokeColor`. */
  stroked?: boolean
  /** boundary stroke width in texels. */
  strokeWidth?: number
  /** boundary stroke color, `[r,g,b,a]` bytes (0–255). */
  strokeColor?: [number, number, number, number]
  /** fill alpha multiplier (set 0 with `stroked` for outline-only). */
  fillOpacity?: number
  /**
   * ITEM-11 — categories to HIDE (their ids get LUT alpha 0). A LUT rebuild, never a pixel
   * re-upload. Changing this Set (by identity) rebuilds the id→color LUT.
   */
  hiddenCategories?: Set<number> | null
  /** ITEM-11 — solo one category (only it is visible); overrides `hiddenCategories`. */
  soloCategory?: number | null
  /** ITEM-11 — highlight this label id in-shader (0/null = none). */
  selectedId?: number | null
  /**
   * ITEM-12 — the bounding box `[minX,minY,maxX,maxY]` (inclusive) of an IN-PLACE mask edit. When
   * this prop changes to a new (non-empty) rect AND `labelMask` is the SAME reference (mutated in
   * place), the layer re-encodes + sub-uploads ONLY that rect via the luma.gl texture
   * `copyImageData` — instead of the full `encodeLabelMaskRGBA` rebuild. Pass a NEW mask
   * reference (or change width/height) to force the full rebuild for a genuinely new mask identity.
   */
  dirtyRect?: DirtyRect | null
}

const NEAREST_SAMPLER = {
  minFilter: 'nearest',
  magFilter: 'nearest',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const

/**
 * A `BitmapLayer` that renders an integer label mask as a color-by-category overlay
 * with an in-shader boundary stroke and label-id hover picking. Feed it
 * `labelMask` (+ `width`/`height`), `categoryForId`, and (usually) `bounds`
 * `[0, height, width, 0]`; toggle `stroked` / set `fillOpacity: 0` for outline-only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class LabelMaskLayer extends BitmapLayer<LabelMaskLayerExtraProps> {
  static layerName = 'LabelMaskLayer'
  static defaultProps = {
    ...BitmapLayer.defaultProps,
    labelMask: { type: 'object', value: null },
    width: { type: 'number', value: 0 },
    height: { type: 'number', value: 0 },
    categoryForId: { type: 'object', value: null },
    palette: { type: 'object', value: CATEGORICAL_PALETTE_DEFAULT },
    stroked: false,
    strokeWidth: { type: 'number', value: 1 },
    strokeColor: { type: 'color', value: [255, 255, 255, 235] },
    fillOpacity: { type: 'number', value: 1 },
    hiddenCategories: { type: 'object', value: null },
    soloCategory: { type: 'object', value: null },
    selectedId: { type: 'object', value: null },
    dirtyRect: { type: 'object', value: null },
  }

  getShaders() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shaders = super.getShaders() as any
    // Replace the base BitmapLayer fragment with the label-mask shader; keep the
    // base vertex shader + modules (project / picking / bitmap) and add `labelMask`.
    shaders.fs = LABEL_MASK_FRAGMENT
    shaders.modules = [...(shaders.modules ?? []), labelMaskModule]
    return shaders
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateState(params: any) {
    super.updateState(params) // builds the quad mesh from `bounds` + the model
    const { props, oldProps } = params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any

    // (Re)build the label texture: id packed into rgb, sampled NEAREST.
    if (
      props.labelMask &&
      props.width > 0 &&
      props.height > 0 &&
      (props.labelMask !== oldProps.labelMask ||
        props.width !== oldProps.width ||
        props.height !== oldProps.height)
    ) {
      state.labelTexture?.destroy?.()
      const data = encodeLabelMaskRGBA(props.labelMask, props.width, props.height)
      const labelTexture = this.context.device.createTexture({
        format: 'rgba8unorm',
        width: props.width,
        height: props.height,
        data,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sampler: NEAREST_SAMPLER as any,
      })
      this.setState({ labelTexture, texel: [1 / props.width, 1 / props.height] })
    }

    // (Re)build the id→color LUT texture whenever the category assignment, palette, or the
    // ITEM-11 class-visibility filters (hiddenCategories / soloCategory) change. This is the
    // hide/solo path: an O(numLabels) LUT rebuild, NEVER a pixel re-upload.
    if (
      props.categoryForId &&
      (props.categoryForId !== oldProps.categoryForId ||
        props.palette !== oldProps.palette ||
        props.hiddenCategories !== oldProps.hiddenCategories ||
        props.soloCategory !== oldProps.soloCategory)
    ) {
      state.lutTexture?.destroy?.()
      const lut = buildIdColorLut(props.categoryForId, {
        palette: props.palette,
        hiddenCategories: props.hiddenCategories,
        soloCategory: props.soloCategory,
      })
      const lutTexture = this.context.device.createTexture({
        format: 'rgba8unorm',
        width: lut.width,
        height: lut.height,
        data: lut.data,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sampler: NEAREST_SAMPLER as any,
      })
      this.setState({ lutTexture, lutSize: [lut.width, lut.height] })
    }

    // ITEM-12 dirty-rect sub-upload: a new (non-empty) `dirtyRect` with the SAME mask reference
    // (an in-place edit) re-encodes + uploads ONLY that rect — no full re-encode. A changed mask
    // identity / width / height took the full-rebuild path above instead, so guard on same-ref.
    if (
      props.dirtyRect &&
      props.dirtyRect !== oldProps.dirtyRect &&
      props.labelMask === oldProps.labelMask &&
      props.width === oldProps.width &&
      props.height === oldProps.height &&
      state.labelTexture &&
      !dirtyRectIsEmpty(props.dirtyRect)
    ) {
      this.updateSubRegion(props.dirtyRect, props.labelMask)
    }
  }

  /**
   * Re-encode ONLY `rect` of the (in-place-edited) label raster and sub-upload it to the existing
   * label texture via luma.gl v9 `texture.copyImageData({data, x, y, width, height})` — the
   * dirty-rect path that keeps a mask correction O(edit), not O(image) (ITEM-12). No-op when the
   * texture isn't built yet or the rect is empty. Returns the sub-image uploaded (or null).
   *
   * `texture` defaults to the layer's live label texture (`this.state.labelTexture`); it's an
   * explicit param only as a testability seam (node has no GL device to build a real texture).
   */
  updateSubRegion(
    rect: DirtyRect,
    mask?: LabelMask | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    texture?: { copyImageData: (opts: any) => void } | null,
  ): SubImageUpload | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    const labelTexture = texture ?? state?.labelTexture
    const raster = mask ?? this.props.labelMask
    const width = this.props.width ?? 0
    if (!labelTexture || !raster || width <= 0 || dirtyRectIsEmpty(rect)) return null
    const sub = encodeLabelMaskSubRect(raster, width, rect)
    labelTexture.copyImageData({ data: sub.data, x: sub.x, y: sub.y, width: sub.width, height: sub.height })
    return sub
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    const { model, labelTexture, lutTexture, bounds, coordinateConversion, disablePicking } = state
    if (opts?.shaderModuleProps?.picking?.isActive && disablePicking) return
    if (!model || !labelTexture || !lutTexture) return // nothing uploaded yet

    const sc = this.props.strokeColor ?? [255, 255, 255, 235]
    model.shaderInputs.setProps({
      // Reuse the `bitmap` module's `bitmapTexture` binding for the label texture; the
      // custom fs ignores the other bitmap uniforms (no coordinate conversion here).
      bitmap: {
        bitmapTexture: labelTexture,
        bounds,
        coordinateConversion: coordinateConversion ?? 0,
        desaturate: 0,
        tintColor: [0, 0, 0],
        transparentColor: [0, 0, 0, 0],
      },
      labelMask: {
        idColorLut: lutTexture,
        texel: state.texel,
        lutSize: state.lutSize,
        strokeColor: [sc[0] / 255, sc[1] / 255, sc[2] / 255, sc[3] / 255],
        stroked: this.props.stroked ? 1 : 0,
        strokeWidth: this.props.strokeWidth ?? 1,
        fillOpacity: this.props.fillOpacity ?? 1,
        selectedId: this.props.selectedId ?? 0,
      } satisfies LabelMaskModuleProps,
    })
    model.draw(this.context.renderPass)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPickingInfo(params: any) {
    const info = params.info
    const color: Uint8Array | null = info?.color ?? null
    if (!color) {
      info.object = null
      info.id = null
      return info
    }
    // The rgb we encoded in the pick pass IS the decoded label id (id = r + g*256 + b*65536).
    const id = color[0] + color[1] * 256 + color[2] * 65536
    info.index = id
    info.id = id > 0 ? id : null
    info.object = id > 0 ? { id } : null
    return info
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalizeState(context: any) {
    super.finalizeState(context)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.state as any
    state.labelTexture?.destroy?.()
    state.lutTexture?.destroy?.()
  }
}
