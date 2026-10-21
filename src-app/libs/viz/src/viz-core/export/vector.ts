// vector.ts — publication-quality VECTOR export (DEC-31 "Vector" family). The app
// renders all-GPU (no in-app SVG), but the SAME geometry can be SERIALIZED offline to a
// vector FILE on demand: vector primitives for the chart chrome + naturally-vector marks
// (axes, gridlines, lines, labels, polygons, points), while dense layers (a million-point
// scatter, the heatmap data-texture) are EMBEDDED as a raster `<image>` tile inside the
// vector doc — the standard publication hybrid. The app stays GPU; this codec runs offline.
//
// Framework-agnostic (viz-core): plain string building + optional DOM/jspdf, no @ziee/*.
// Node-safe: `buildSVG` / `canvasToVectorScene` need no DOM; `svgToPDF` degrades when
// there is no `document` to rasterize against.

import { jsPDF } from 'jspdf'

// ---------------------------------------------------------------------------
// VectorScene — a small declarative description of a view's vector geometry.
// A caller (a ChartFrame, a scatter/heatmap view) produces one of these; the
// serializer turns it into an SVG string. Dense layers arrive pre-rasterized as
// an `image` mark (a data: PNG tile) so the vector doc stays small + printable.
// ---------------------------------------------------------------------------

export interface VectorLine {
  type: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  stroke: string
  width?: number
  /** Marks this a gridline so the "include gridlines" toggle can drop it. */
  role?: 'grid' | 'axis' | 'data'
}

export interface VectorPolyline {
  type: 'polyline'
  points: Array<[number, number]>
  stroke?: string
  fill?: string
  width?: number
  role?: 'grid' | 'axis' | 'data'
}

export interface VectorPolygon {
  type: 'polygon'
  points: Array<[number, number]>
  stroke?: string
  fill?: string
  width?: number
}

export interface VectorCircle {
  type: 'circle'
  cx: number
  cy: number
  r: number
  /** Fill color; omit for a HOLLOW circle (a `filled:false` stroked marker) → `fill="none"`. */
  fill?: string
  stroke?: string
  width?: number
}

export interface VectorText {
  type: 'text'
  x: number
  y: number
  text: string
  fill: string
  size: number
  /** SVG text-anchor. Defaults to 'start'. */
  anchor?: 'start' | 'middle' | 'end'
  /** Degrees, rotated about (x, y). */
  rotate?: number
  /** font-family (free text); omitted ⇒ the document default. */
  fontFamily?: string
  /** font-weight; 'bold' ⇒ 700. */
  weight?: 'normal' | 'bold'
  /** font-style; 'italic' ⇒ italic (ITEM-16 gene-symbol labels). */
  fontStyle?: 'normal' | 'italic'
}

export interface VectorRect {
  type: 'rect'
  x: number
  y: number
  w: number
  h: number
  fill?: string
  stroke?: string
  width?: number
}

export interface VectorImage {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  /** A data: PNG URL — the embedded raster tile for a dense layer / whole-plot fallback. */
  href: string
}

export type VectorMark =
  | VectorLine
  | VectorPolyline
  | VectorPolygon
  | VectorCircle
  | VectorText
  | VectorRect
  | VectorImage

export interface VectorScene {
  width: number
  height: number
  marks: VectorMark[]
  /** Optional solid background fill (omitted → transparent). */
  background?: string
}

export interface BuildSVGOptions {
  /** Drop marks tagged `role: 'grid'` (publication figures often omit gridlines). */
  includeGridlines?: boolean
  /**
   * Override the output `width`/`height` attributes of the `<svg>` (in px). The
   * `viewBox` ALWAYS stays the scene's intrinsic `0 0 width height`, so the marks
   * keep their coordinates and the browser/renderer contain-fits (letterboxes,
   * `preserveAspectRatio` default `xMidYMid meet`) the content into the new box —
   * no distortion. Used for the export "scale" (nominal, resolution-independent)
   * and custom-size controls. Omit → byte-identical to the intrinsic-size SVG.
   */
  outputWidth?: number
  outputHeight?: number
}

// ---------------------------------------------------------------------------
// SVG serialization
// ---------------------------------------------------------------------------

/** Escape text for an XML/SVG text node or attribute value. */
export function escapeXML(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Trim trailing-zero float noise so the SVG string stays compact + deterministic. */
function num(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // Round to 3 decimals, then strip trailing zeros / dot.
  return String(Math.round(n * 1000) / 1000)
}

function pointsAttr(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ')
}

function markToSVG(m: VectorMark): string {
  switch (m.type) {
    case 'line':
      return (
        `<line x1="${num(m.x1)}" y1="${num(m.y1)}" x2="${num(m.x2)}" y2="${num(m.y2)}"` +
        ` stroke="${escapeXML(m.stroke)}" stroke-width="${num(m.width ?? 1)}" />`
      )
    case 'polyline':
      return (
        `<polyline points="${pointsAttr(m.points)}"` +
        ` fill="${escapeXML(m.fill ?? 'none')}"` +
        ` stroke="${escapeXML(m.stroke ?? 'none')}" stroke-width="${num(m.width ?? 1)}" />`
      )
    case 'polygon':
      return (
        `<polygon points="${pointsAttr(m.points)}"` +
        ` fill="${escapeXML(m.fill ?? 'none')}"` +
        ` stroke="${escapeXML(m.stroke ?? 'none')}" stroke-width="${num(m.width ?? 1)}" />`
      )
    case 'circle':
      return (
        `<circle cx="${num(m.cx)}" cy="${num(m.cy)}" r="${num(m.r)}"` +
        ` fill="${escapeXML(m.fill ?? 'none')}"` +
        (m.stroke ? ` stroke="${escapeXML(m.stroke)}" stroke-width="${num(m.width ?? 1)}"` : '') +
        ' />'
      )
    case 'text': {
      const anchor = m.anchor ?? 'start'
      const transform = m.rotate
        ? ` transform="rotate(${num(m.rotate)} ${num(m.x)} ${num(m.y)})"`
        : ''
      return (
        `<text x="${num(m.x)}" y="${num(m.y)}" fill="${escapeXML(m.fill)}"` +
        ` font-size="${num(m.size)}"` +
        (m.fontFamily ? ` font-family="${escapeXML(m.fontFamily)}"` : '') +
        (m.weight === 'bold' ? ' font-weight="700"' : '') +
        (m.fontStyle === 'italic' ? ' font-style="italic"' : '') +
        ` text-anchor="${anchor}"${transform}>` +
        `${escapeXML(m.text)}</text>`
      )
    }
    case 'rect':
      return (
        `<rect x="${num(m.x)}" y="${num(m.y)}" width="${num(m.w)}" height="${num(m.h)}"` +
        ` fill="${escapeXML(m.fill ?? 'none')}"` +
        (m.stroke ? ` stroke="${escapeXML(m.stroke)}" stroke-width="${num(m.width ?? 1)}"` : '') +
        ' />'
      )
    case 'image':
      return (
        `<image x="${num(m.x)}" y="${num(m.y)}" width="${num(m.w)}" height="${num(m.h)}"` +
        ` xlink:href="${escapeXML(m.href)}" href="${escapeXML(m.href)}"` +
        ' preserveAspectRatio="none" />'
      )
  }
}

/**
 * Serialize a VectorScene to a well-formed SVG document string. `role:'grid'`
 * marks are dropped unless `includeGridlines` is true.
 */
export function buildSVG(scene: VectorScene, opts: BuildSVGOptions = {}): string {
  const includeGridlines = opts.includeGridlines ?? true
  // viewBox is ALWAYS the scene's intrinsic size (marks keep their coords);
  // the width/height attrs may be overridden so the content contain-fits the box.
  const w = num(scene.width)
  const h = num(scene.height)
  const outW = num(opts.outputWidth != null ? opts.outputWidth : scene.width)
  const outH = num(opts.outputHeight != null ? opts.outputHeight : scene.height)

  const body: string[] = []
  if (scene.background) {
    body.push(
      `<rect x="0" y="0" width="${w}" height="${h}" fill="${escapeXML(scene.background)}" />`,
    )
  }
  for (const m of scene.marks) {
    if (
      !includeGridlines &&
      (m.type === 'line' || m.type === 'polyline') &&
      m.role === 'grid'
    ) {
      continue
    }
    body.push(markToSVG(m))
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` width="${outW}" height="${outH}" viewBox="0 0 ${w} ${h}">\n` +
    body.join('\n') +
    `\n</svg>`
  )
}

// ---------------------------------------------------------------------------
// Canvas → VectorScene fallback
// ---------------------------------------------------------------------------

/**
 * The universal fallback: wrap an entire canvas as ONE embedded raster `image`
 * mark, so any GPU canvas exports to SVG/PDF even without a full vector
 * description of its geometry.
 */
export function canvasToVectorScene(
  canvas: HTMLCanvasElement,
  pngDataUrl?: string,
): VectorScene {
  const href =
    pngDataUrl ??
    (typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : '')
  const width = canvas.width || 1
  const height = canvas.height || 1
  return {
    width,
    height,
    marks: [{ type: 'image', x: 0, y: 0, w: width, h: height, href }],
  }
}

// ---------------------------------------------------------------------------
// SVG → PDF (via jspdf). v1 rasterizes the SVG onto a canvas, then embeds that
// raster into the PDF page (jspdf has no native SVG parser). Needs a DOM to
// rasterize; degrades to null when headless.
// ---------------------------------------------------------------------------

export interface SVGToPDFOptions {
  /** Page pixel width (defaults to the SVG's declared width). */
  width?: number
  /** Page pixel height (defaults to the SVG's declared height). */
  height?: number
  /** Return form: a Blob (default) or a data: URL string. */
  output?: 'blob' | 'datauristring'
}

function parseSvgSize(svg: string): { width: number; height: number } {
  const w = svg.match(/width="([\d.]+)"/)
  const h = svg.match(/height="([\d.]+)"/)
  return {
    width: w ? Number(w[1]) : 800,
    height: h ? Number(h[1]) : 600,
  }
}

/** Build a PDF from an SVG's declared page size + an already-rasterized PNG tile. */
export function pngToPDF(
  pngDataUrl: string,
  width: number,
  height: number,
  output: 'blob' | 'datauristring' = 'blob',
): Blob | string {
  const orientation = width >= height ? 'landscape' : 'portrait'
  const pdf = new jsPDF({ orientation, unit: 'pt', format: [width, height] })
  pdf.addImage(pngDataUrl, 'PNG', 0, 0, width, height)
  return output === 'datauristring' ? pdf.output('datauristring') : pdf.output('blob')
}

/**
 * Rasterize an SVG string onto a canvas and embed it in a one-page PDF. Returns
 * a Promise of a Blob / data: URL, or `null` when there is no DOM to rasterize.
 */
export async function svgToPDF(
  svg: string,
  opts: SVGToPDFOptions = {},
): Promise<Blob | string | null> {
  if (
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function' ||
    typeof Image === 'undefined'
  ) {
    return null
  }
  const size = parseSvgSize(svg)
  const width = opts.width ?? size.width
  const height = opts.height ?? size.height
  const output = opts.output ?? 'blob'

  const pngDataUrl = await new Promise<string>((resolve, reject) => {
    const img = new Image()
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no 2d context'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('svg rasterize failed'))
    img.src = svgUrl
  })

  return pngToPDF(pngDataUrl, width, height, output)
}

/**
 * Rasterize a whole VectorScene (plot image mark + vector chrome + composed legend marks) to a PNG
 * `data:` URL — the path a PNG export takes when it must include legend marks the direct
 * `canvas.toDataURL` can't carry (DEC-2). Reuses the `buildSVG → <img> → canvas` rasterization that
 * `svgToPDF` uses. Flattens onto white (matches `raster.ts`). Returns null when there's no DOM.
 */
export async function sceneToRasterPngDataUrl(
  scene: VectorScene,
  opts: { includeGridlines?: boolean; width?: number; height?: number } = {},
): Promise<string | null> {
  if (
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function' ||
    typeof Image === 'undefined'
  ) {
    return null
  }
  const width = opts.width ?? scene.width
  const height = opts.height ?? scene.height
  const svg = buildSVG(scene, {
    includeGridlines: opts.includeGridlines ?? true,
    ...(opts.width ? { outputWidth: Math.round(width) } : {}),
    ...(opts.height ? { outputHeight: Math.round(height) } : {}),
  })
  return await new Promise<string>((resolve, reject) => {
    const img = new Image()
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no 2d context'))
        return
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('svg rasterize failed'))
    img.src = svgUrl
  })
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

/** Trigger a browser download of a text payload as `filename` under `mime`. */
export function downloadText(content: string, filename: string, mime: string): void {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return
  }
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
