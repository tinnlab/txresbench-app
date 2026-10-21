// imageFixture.ts — a SYNTHETIC multiscale, multi-channel image so the Viv spatial
// view renders with no real OME-Zarr/OME-TIFF dataset. Generates a small resolution
// pyramid (default 3 levels: 256 → 128 → 64) of 3 single-channel `Uint8` planes,
// each with a RECOGNIZABLE per-channel pattern (a horizontal ramp, a vertical ramp,
// and concentric rings), wrapped in an in-memory `PixelSource` that satisfies the
// exact Viv loader interface (`getRaster` / `getTile` / `shape` / `dtype` / `labels`
// / `tileSize`). So `RasterImageView` drives the REAL Viv layers against this fixture.
//
// This is its OWN fixture file (NOT viz-core/data/fixtures.ts) so the spatial feature
// stays additive. DEC-28 generic naming: channels are "Channel 0/1/2" here; a caller
// relabels via the omero metadata.

import type {
  PixelSource,
  PixelData,
  RasterSelection,
  TileSelection,
  Labels,
  SupportedDtype,
} from '@vivjs/types'
import { parseMultiscales, type NgffImage, type NormalizedImageMeta } from './imageMeta'

/** A single-channel-selection PixelSource over the label set `['c','y','x']`. */
type Sel = ['c']

/** The typed-array plane kinds this in-memory source stores (matched to its `dtype`). */
export type Plane = Uint8Array | Uint16Array | Float32Array

/**
 * An in-memory `PixelSource` backed by one typed-array plane per channel (row-major,
 * `width*height`). One instance == one pyramid LEVEL; a level's `shape` is
 * `[channels, height, width]` with labels `['c','y','x']`. `tileSize ≥ max(w,h)` so
 * each level is a single tile at (0,0) — but `getTile` still extracts the correct
 * sub-rectangle generally, so a smaller `tileSize` also works.
 *
 * `dtype` defaults to `'Uint8'` (the common fixture) but is caller-supplied so a 16-bit
 * multiplex (`Uint16Array` planes + `'Uint16'`) drives the same Viv layer path.
 */
export class InMemoryPixelSource implements PixelSource<Sel> {
  readonly dtype: SupportedDtype
  readonly labels: Labels<Sel> = ['c', 'y', 'x']
  readonly tileSize: number
  readonly shape: number[]
  readonly width: number
  readonly height: number
  private readonly channels: Plane[]

  constructor(
    width: number,
    height: number,
    channels: Plane[],
    tileSize?: number,
    dtype: SupportedDtype = 'Uint8',
  ) {
    this.width = width
    this.height = height
    this.channels = channels
    this.shape = [channels.length, height, width]
    this.tileSize = tileSize ?? Math.max(width, height)
    this.dtype = dtype
  }

  private plane(c: number): Plane {
    const p = this.channels[c]
    if (!p) throw new Error(`InMemoryPixelSource: no channel ${c} (have ${this.channels.length})`)
    return p
  }

  async getRaster({ selection }: RasterSelection<Sel>): Promise<PixelData> {
    // cast: Viv's SupportedTypedArray is `<ArrayBuffer>`; our planes are plain typed
    // arrays (ArrayBufferLike-backed) — a nominal-only mismatch in recent TS libs.
    return { data: this.plane(selection.c) as PixelData['data'], width: this.width, height: this.height }
  }

  async getTile({ x, y, selection }: TileSelection<Sel>): Promise<PixelData> {
    const plane = this.plane(selection.c)
    const ox = x * this.tileSize
    const oy = y * this.tileSize
    const tw = Math.min(this.tileSize, this.width - ox)
    const th = Math.min(this.tileSize, this.height - oy)
    if (tw <= 0 || th <= 0) {
      const Empty = plane.constructor as { new (n: number): Plane }
      return { data: new Empty(0) as PixelData['data'], width: 0, height: 0 }
    }
    // Fast path: a single tile that IS the whole plane.
    if (ox === 0 && oy === 0 && tw === this.width && th === this.height) {
      return { data: plane as PixelData['data'], width: tw, height: th }
    }
    // Allocate an out buffer of the SAME typed-array kind as the plane (Uint8/Uint16/…).
    const Ctor = plane.constructor as { new (n: number): Plane }
    const out = new Ctor(tw * th)
    for (let row = 0; row < th; row++) {
      const src = (oy + row) * this.width + ox
      out.set(plane.subarray(src, src + tw) as never, row * tw)
    }
    return { data: out as PixelData['data'], width: tw, height: th }
  }

  onTileError(err: Error): void {
    // Surface loader errors the way Viv's own sources do (dev diagnostics only).
    // eslint-disable-next-line no-console
    console.error('InMemoryPixelSource tile error:', err)
  }
}

export interface FixtureChannel {
  name: string
  /** RGB 0-255 for additive compositing. */
  color: [number, number, number]
  /** default contrast window `[begin, end]`. */
  window: [number, number]
}

export interface SpatialImageFixture {
  /** raw NGFF-style metadata (feed to `parseMultiscales`). */
  ngff: NgffImage
  /** parsed/normalized metadata. */
  meta: NormalizedImageMeta
  /** resolution pyramid, index 0 = full resolution. */
  loader: InMemoryPixelSource[]
  /** per-channel display defaults (name / color / contrast window). */
  channels: FixtureChannel[]
  dtype: SupportedDtype
}

// Recognizable per-channel patterns at full resolution. `c` is the channel index.
function patternValue(c: number, x: number, y: number, w: number, h: number): number {
  switch (c % 3) {
    case 0: {
      // horizontal ramp (dark left → bright right)
      return Math.round((x / Math.max(1, w - 1)) * 255)
    }
    case 1: {
      // vertical ramp (dark top → bright bottom)
      return Math.round((y / Math.max(1, h - 1)) * 255)
    }
    default: {
      // concentric rings centered on the image
      const dx = x - w / 2
      const dy = y - h / 2
      const r = Math.sqrt(dx * dx + dy * dy)
      const period = Math.max(4, Math.min(w, h) / 8)
      return Math.round((Math.sin((r / period) * Math.PI * 2) * 0.5 + 0.5) * 255)
    }
  }
}

/** Box-average downsample a single-channel plane by 2× (w,h assumed even). */
function downsample2x(src: Uint8Array, w: number, h: number): { data: Uint8Array; w: number; h: number } {
  const dw = Math.max(1, Math.floor(w / 2))
  const dh = Math.max(1, Math.floor(h / 2))
  const out = new Uint8Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = x * 2
      const y0 = y * 2
      const a = src[y0 * w + x0]
      const b = src[y0 * w + Math.min(x0 + 1, w - 1)]
      const c = src[Math.min(y0 + 1, h - 1) * w + x0]
      const d = src[Math.min(y0 + 1, h - 1) * w + Math.min(x0 + 1, w - 1)]
      out[y * dw + x] = Math.round((a + b + c + d) / 4)
    }
  }
  return { data: out, w: dw, h: dh }
}

const DEFAULT_CHANNELS: FixtureChannel[] = [
  { name: 'Channel 0', color: [0, 128, 255], window: [0, 255] }, // horizontal ramp
  { name: 'Channel 1', color: [0, 255, 128], window: [0, 255] }, // vertical ramp
  { name: 'Channel 2', color: [255, 96, 0], window: [0, 255] }, // rings
]

export interface FixtureOptions {
  /** level-0 edge length in pixels (default 256). */
  base?: number
  /** number of channels (default 3; extra channels cycle the 3 patterns). */
  channels?: number
  /** number of pyramid levels (default 3). */
  levels?: number
  /** physical size (units/pixel) at level 0 (default 0.5 µm/px). */
  pixelSize?: number
}

/**
 * Build a synthetic multiscale, multi-channel image fixture. Each pyramid level is an
 * `InMemoryPixelSource`; level 0 is generated from the patterns and each finer→coarser
 * level is a 2× box-average of the one above (so the pyramid is self-consistent — a
 * coarse tile looks like a shrunk fine tile, which is what MultiscaleImageLayer expects).
 */
export function makeSpatialImageFixture(opts: FixtureOptions = {}): SpatialImageFixture {
  const base = opts.base ?? 256
  const nChannels = opts.channels ?? 3
  const nLevels = opts.levels ?? 3
  const pixelSize = opts.pixelSize ?? 0.5

  const channels: FixtureChannel[] = Array.from({ length: nChannels }, (_, i) => {
    const d = DEFAULT_CHANNELS[i % DEFAULT_CHANNELS.length]
    return { name: `Channel ${i}`, color: [...d.color] as [number, number, number], window: [...d.window] as [number, number] }
  })

  // Level 0 planes from the patterns.
  const level0: Uint8Array[] = channels.map((_, c) => {
    const plane = new Uint8Array(base * base)
    for (let y = 0; y < base; y++) {
      for (let x = 0; x < base; x++) {
        plane[y * base + x] = patternValue(c, x, y, base, base)
      }
    }
    return plane
  })

  // Build the pyramid: each level halves the previous.
  const levelPlanes: { planes: Uint8Array[]; w: number; h: number }[] = [{ planes: level0, w: base, h: base }]
  for (let l = 1; l < nLevels; l++) {
    const prev = levelPlanes[l - 1]
    const next: Uint8Array[] = []
    let nw = prev.w
    let nh = prev.h
    for (const p of prev.planes) {
      const ds = downsample2x(p, prev.w, prev.h)
      next.push(ds.data)
      nw = ds.w
      nh = ds.h
    }
    levelPlanes.push({ planes: next, w: nw, h: nh })
  }

  const loader = levelPlanes.map(lv => new InMemoryPixelSource(lv.w, lv.h, lv.planes))

  // NGFF metadata mirroring the generated pyramid (axes c,y,x; scale doubles per level).
  const ngff: NgffImage = {
    multiscales: [
      {
        version: '0.4',
        name: 'synthetic-spatial',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: levelPlanes.map((lv, l) => ({
          path: String(l),
          coordinateTransformations: [
            { type: 'scale', scale: [1, pixelSize * 2 ** l, pixelSize * 2 ** l] },
          ],
        })),
      },
    ],
    omero: {
      channels: channels.map(ch => ({
        label: ch.name,
        color: rgbToHex(ch.color),
        window: { start: ch.window[0], end: ch.window[1] },
      })),
    },
    arrays: Object.fromEntries(
      levelPlanes.map((lv, l) => [String(l), { shape: [nChannels, lv.h, lv.w], dtype: 'Uint8' as const }]),
    ),
  }

  const meta = parseMultiscales(ngff)
  return { ngff, meta, loader, channels, dtype: 'Uint8' }
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `${h(r)}${h(g)}${h(b)}`
}

// ── PixelSource pyramid variants (ITEM-1) ──────────────────────────────────────
// These back a `DataSource.imagePixelSource(): Promise<PixelSource[]>` (three shapes the
// grid's dense image cell + `buildRasterImageLayers` must cover): the default multiscale
// pyramid, a 16-bit multiplex pyramid (Uint16 → the same tiled MultiscaleImageLayer path),
// and a single-level RGB source (loader.length === 1 → the ImageLayer path).

/** Box-average downsample a typed-array plane by 2× (w,h assumed even), preserving dtype. */
function downsample2xTyped(src: Plane, w: number, h: number): { data: Plane; w: number; h: number } {
  const dw = Math.max(1, Math.floor(w / 2))
  const dh = Math.max(1, Math.floor(h / 2))
  const Ctor = src.constructor as { new (n: number): Plane }
  const out = new Ctor(dw * dh)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = x * 2
      const y0 = y * 2
      const a = src[y0 * w + x0]
      const b = src[y0 * w + Math.min(x0 + 1, w - 1)]
      const c = src[Math.min(y0 + 1, h - 1) * w + x0]
      const d = src[Math.min(y0 + 1, h - 1) * w + Math.min(x0 + 1, w - 1)]
      out[y * dw + x] = Math.round((a + b + c + d) / 4)
    }
  }
  return { data: out, w: dw, h: dh }
}

/** Build a `nLevels`-deep pyramid of `InMemoryPixelSource` from level-0 planes (each level
 *  is a 2× box-average of the one above — a self-consistent pyramid). */
function buildPyramid(
  level0: Plane[],
  base: number,
  nLevels: number,
  dtype: SupportedDtype,
): InMemoryPixelSource[] {
  const levels: { planes: Plane[]; w: number; h: number }[] = [{ planes: level0, w: base, h: base }]
  for (let l = 1; l < nLevels; l++) {
    const prev = levels[l - 1]
    const next: Plane[] = []
    let nw = prev.w
    let nh = prev.h
    for (const p of prev.planes) {
      const ds = downsample2xTyped(p, prev.w, prev.h)
      next.push(ds.data)
      nw = ds.w
      nh = ds.h
    }
    levels.push({ planes: next, w: nw, h: nh })
  }
  return levels.map(lv => new InMemoryPixelSource(lv.w, lv.h, lv.planes, undefined, dtype))
}

/**
 * The DEFAULT `imagePixelSource()` pyramid: a 3-level, 3-channel `Uint8` pyramid (the
 * multiscale / `MultiscaleImageLayer` path). Convenience alias over
 * `makeSpatialImageFixture(opts).loader`.
 */
export function imagePixelSource(opts: FixtureOptions = {}): InMemoryPixelSource[] {
  return makeSpatialImageFixture(opts).loader
}

/**
 * A 16-BIT MULTIPLEX variant: a multi-channel (default 5) `Uint16` pyramid — proves the
 * tiled MultiscaleImageLayer path with `contrastMax = 65535`. Level-0 values are the same
 * recognizable patterns scaled up into the 16-bit range (`×257`, so 255 → 65535).
 */
export function imagePixelSource16(opts: { base?: number; channels?: number; levels?: number } = {}): InMemoryPixelSource[] {
  const base = opts.base ?? 256
  const nChannels = opts.channels ?? 5
  const nLevels = opts.levels ?? 3
  const level0: Uint16Array[] = Array.from({ length: nChannels }, (_, c) => {
    const plane = new Uint16Array(base * base)
    for (let y = 0; y < base; y++) {
      for (let x = 0; x < base; x++) {
        plane[y * base + x] = patternValue(c, x, y, base, base) * 257 // 0..255 → 0..65535
      }
    }
    return plane
  })
  return buildPyramid(level0, base, nLevels, 'Uint16')
}

/**
 * A SINGLE-LEVEL RGB variant: three `Uint8` channels at one resolution (no pyramid), so
 * `loader.length === 1` → `buildRasterImageLayers` takes the `ImageLayer` path.
 */
export function imagePixelSourceRgb(opts: { base?: number } = {}): InMemoryPixelSource[] {
  const base = opts.base ?? 256
  const level0: Uint8Array[] = Array.from({ length: 3 }, (_, c) => {
    const plane = new Uint8Array(base * base)
    for (let y = 0; y < base; y++) {
      for (let x = 0; x < base; x++) {
        plane[y * base + x] = patternValue(c, x, y, base, base)
      }
    }
    return plane
  })
  return [new InMemoryPixelSource(base, base, level0)]
}
