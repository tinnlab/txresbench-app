// eps.ts — Encapsulated PostScript export (ITEM-1). PLOS accepts only TIFF/EPS, so EPS is mandatory
// alongside SVG/PDF. Consumes the SAME `VectorScene` the SVG serializer does (import, don't redefine), so
// the chrome + text + marks are byte-faithful across formats. Text is LIVE PostScript `show` (never
// outlined) in Helvetica (ITEM-2), so it stays editable/selectable in the production workflow.
//
// Coordinate space: SVG/scene space is TOP-left origin, y-down; PostScript is BOTTOM-left, y-up. We flip
// PER-COORDINATE (y → H − y) rather than a global `scale 1 -1`, so `show` text renders UPRIGHT (a global
// flip would mirror the glyphs). The dense raster layer (a `VectorImage` mark) is embedded via `colorimage`
// from RAW pixels the caller passes in (the export canvas) — avoiding an in-EPS PNG decoder.

import type { VectorScene, VectorMark } from './vector'

/** Parse a CSS color string (`#rgb` / `#rrggbb` / `rgb(r,g,b)` / a few names) → PostScript 0..1 rgb. */
export function parseColor(css: string | undefined): [number, number, number] {
  if (!css) return [0, 0, 0]
  const s = css.trim().toLowerCase()
  if (s === 'none' || s === 'transparent') return [0, 0, 0]
  if (s === 'white') return [1, 1, 1]
  if (s === 'black') return [0, 0, 0]
  if (s[0] === '#') {
    const h = s.slice(1)
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
    const n = parseInt(full.slice(0, 6), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const [r, g, b] = m[1].split(',').map(v => parseFloat(v))
    return [(r || 0) / 255, (g || 0) / 255, (b || 0) / 255]
  }
  return [0, 0, 0]
}

/** Escape a PostScript string literal (parentheses + backslash). */
function psStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString()
const rgb = (c: [number, number, number]) => `${f(c[0])} ${f(c[1])} ${f(c[2])} setrgbcolor`

/** ASCII85-encode bytes (with the `~>` EOD marker) for `/ASCII85Decode filter`. */
export function ascii85(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 4) {
    let n = 0
    const rem = Math.min(4, bytes.length - i)
    for (let j = 0; j < 4; j++) n = (n * 256 + (j < rem ? bytes[i + j] : 0)) >>> 0
    if (rem === 4 && n === 0) { out += 'z'; continue }
    const c = [0, 0, 0, 0, 0]
    for (let j = 4; j >= 0; j--) { c[j] = (n % 85) + 33; n = Math.floor(n / 85) }
    out += String.fromCharCode(...c.slice(0, rem + 1))
  }
  return out + '~>'
}

export interface EpsRaster { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number }

/** Serialize a VectorScene to EPS. `raster` (optional) supplies raw pixels for the dense `VectorImage`
 *  layer (the caller passes the export canvas' pixels); without it, image marks are skipped. */
export function buildEPS(scene: VectorScene, raster?: EpsRaster): string {
  const H = scene.height
  const W = scene.width
  const fy = (y: number) => H - y // per-coordinate y-flip
  const L: string[] = []
  L.push('%!PS-Adobe-3.0 EPSF-3.0')
  L.push(`%%BoundingBox: 0 0 ${Math.ceil(W)} ${Math.ceil(H)}`)
  L.push(`%%HiResBoundingBox: 0 0 ${f(W)} ${f(H)}`)
  L.push('%%Creator: ziee-viz')
  L.push('%%EndComments')
  L.push('1 setlinejoin 1 setlinecap')

  if (scene.background) {
    L.push('gsave', rgb(parseColor(scene.background)), `0 0 ${f(W)} ${f(H)} rectfill`, 'grestore')
  }

  const strokePath = (m: Extract<VectorMark, { type: 'line' | 'polyline' | 'polygon' }>, closed: boolean) => {
    const pts = m.type === 'line' ? [[m.x1, m.y1], [m.x2, m.y2]] : m.points
    if (!pts.length) return
    if ('fill' in m && m.fill) {
      L.push('newpath', `${f(pts[0][0])} ${f(fy(pts[0][1]))} moveto`)
      for (let i = 1; i < pts.length; i++) L.push(`${f(pts[i][0])} ${f(fy(pts[i][1]))} lineto`)
      L.push('closepath', rgb(parseColor(m.fill)), 'fill')
    }
    const stroke = ('stroke' in m ? m.stroke : undefined)
    if (stroke) {
      L.push('newpath', `${f(pts[0][0])} ${f(fy(pts[0][1]))} moveto`)
      for (let i = 1; i < pts.length; i++) L.push(`${f(pts[i][0])} ${f(fy(pts[i][1]))} lineto`)
      if (closed) L.push('closepath')
      L.push(`${f(m.width ?? 1)} setlinewidth`, rgb(parseColor(stroke)), 'stroke')
    }
  }

  for (const m of scene.marks) {
    switch (m.type) {
      case 'line': strokePath(m, false); break
      case 'polyline': strokePath(m, false); break
      case 'polygon': strokePath(m, true); break
      case 'rect': {
        const y = fy(m.y + m.h)
        if (m.fill) L.push(rgb(parseColor(m.fill)), `${f(m.x)} ${f(y)} ${f(m.w)} ${f(m.h)} rectfill`)
        if (m.stroke) L.push(`${f(m.width ?? 1)} setlinewidth`, rgb(parseColor(m.stroke)), `${f(m.x)} ${f(y)} ${f(m.w)} ${f(m.h)} rectstroke`)
        break
      }
      case 'circle': {
        const y = fy(m.cy)
        if (m.fill) L.push(rgb(parseColor(m.fill)), 'newpath', `${f(m.cx)} ${f(y)} ${f(m.r)} 0 360 arc`, 'fill')
        if (m.stroke) L.push(`${f(m.width ?? 1)} setlinewidth`, rgb(parseColor(m.stroke)), 'newpath', `${f(m.cx)} ${f(y)} ${f(m.r)} 0 360 arc`, 'stroke')
        break
      }
      case 'text': {
        const size = m.size
        const italic = m.fontStyle === 'italic'
        const font = (m.fontFamily && /serif/i.test(m.fontFamily))
          ? (italic ? 'Times-Italic' : 'Times-Roman')
          : m.weight === 'bold'
            ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold')
            : (italic ? 'Helvetica-Oblique' : 'Helvetica')
        L.push(`/${font} findfont ${f(size)} scalefont setfont`, rgb(parseColor(m.fill)))
        // Approximate anchor via stringwidth (start = no shift).
        const anchor = m.anchor ?? 'start'
        L.push('gsave', `${f(m.x)} ${f(fy(m.y))} translate`)
        if (m.rotate) L.push(`${f(-m.rotate)} rotate`)
        // Establish the current point at the origin FIRST, THEN apply the anchor shift relative to it, THEN
        // show. (Emitting `rmoveto` before `moveto` both discards the shift and errors `nocurrentpoint`.)
        L.push('0 0 moveto')
        if (anchor !== 'start') {
          L.push(`(${psStr(m.text)}) stringwidth pop ${anchor === 'middle' ? '2 div ' : ''}neg 0 rmoveto`)
        }
        L.push(`(${psStr(m.text)}) show`, 'grestore')
        break
      }
      case 'image': {
        if (!raster) break
        const y = fy(m.y + m.h)
        const rw = raster.width, rh = raster.height
        const rgbBytes = new Uint8Array(rw * rh * 3)
        for (let i = 0; i < rw * rh; i++) { rgbBytes[i * 3] = raster.rgba[i * 4]; rgbBytes[i * 3 + 1] = raster.rgba[i * 4 + 1]; rgbBytes[i * 3 + 2] = raster.rgba[i * 4 + 2] }
        // colorimage with a FILE data source: the `currentfile /ASCII85Decode filter` object is passed
        // DIRECTLY (no `{}` — braces would make it a procedure returning a file, which colorimage rejects).
        L.push('gsave', `${f(m.x)} ${f(y)} translate`, `${f(m.w)} ${f(m.h)} scale`)
        L.push(`${rw} ${rh} 8 [${rw} 0 0 -${rh} 0 ${rh}]`)
        L.push('currentfile /ASCII85Decode filter false 3 colorimage')
        L.push(ascii85(rgbBytes))
        L.push('grestore')
        break
      }
    }
  }
  // EPS is EMBEDDED, not printed → no `showpage`.
  L.push('%%EOF')
  return L.join('\n')
}
