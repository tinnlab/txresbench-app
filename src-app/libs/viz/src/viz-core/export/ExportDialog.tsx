// ExportDialog.tsx — the export panel (DEC-31), built on @txresbench/kit to MATCH the pane EDIT FORM
// (PaneEditForm): the same Section/close-button chrome + kit Select/Input/Switch/Button. Offers a SCOPE
// selector (this pane / whole grid), a FORMAT selector (PNG / SVG / PDF / CSV / JSON), bake-in toggles
// (gridlines / legend / slider), scale + size, a filename field, and an Export button that dispatches to
// the matching exporter and triggers a download. Like PaneEditForm it can be portaled by GridWorkspace
// into a host container (the `exportDialogContainer` resolver) or shown in the internal right panel.
//
// The canvas target may be an element OR a lazy getter (resolved at click time) so a
// caller can hand it a deck.gl canvas that mounts after this dialog.

import { useState } from 'react'
import { Button, Input, Select, Switch } from '@txresbench/kit'
import { X } from 'lucide-react'
import { exportCanvasPNG, downloadDataUrl, resizeCanvasToBox } from './raster'
import { selectionToCSV, tableToCSV } from './data'
import { type WorkspaceSpec } from './spec'
import { buildSVG, canvasToVectorScene, svgToPDF, sceneToRasterPngDataUrl, type VectorScene, type VectorMark } from './vector'
import { buildEPS } from './eps'
import { encodeTIFF } from './tiff'
import { buildFigureBundle } from './bundle'
import { manifestToJSON, type FigureManifest } from './manifest'
import { COLUMN_PRESETS, DPI_TARGETS, DEFAULT_DPI, mmToPx, type ColumnPreset } from './sizePresets'
import { simulateImage, type CvdKind } from '../data/cvd'
import {
  legendToMarks,
  composeLegendIntoScene,
  type LegendExportSpec,
} from './legendMarks'
import { DEFAULT_LEGEND_CORNER, type LegendCorner } from '../controls/legendRender'
import { composeDataZoomIntoScene, type DataZoomExportSpec } from '../controls/dataZoomRender'
import { cropCanvasToRect, effectiveDpr, type Rect } from './cropCanvas'
import type { IndexMask } from '../data/selection'
import type { DataTable } from '../data/wire'

export type CanvasTarget =
  | HTMLCanvasElement
  | null
  | (() => HTMLCanvasElement | null)

export type ExportScope = 'pane' | 'grid'
export type ExportFormat = 'png' | 'svg' | 'pdf' | 'eps' | 'tiff'
/** Output resolution multiplier for the raster export (nominal for vector). */
export type ExportScale = 1 | 2 | 3 | 4
/** Raster color mode (ITEM-19). */
export type ExportColorMode = 'rgb' | 'gray' | 'cmyk'
/** 'current' = the on-screen rect (default, unchanged); 'custom' = explicit W×H. */
export type ExportSizeMode = 'current' | 'custom'

/** Parse a custom dimension field to a positive integer, or null if empty/invalid. */
function parseDim(s: string): number | null {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export interface ExportDialogProps {
  /** The canvas to raster, or a getter resolving it lazily at export time. */
  canvas: CanvasTarget
  /**
   * Optional vector description of the current view (DEC-31). When present, SVG/PDF
   * export serializes real vector marks; when absent, it falls back to embedding the
   * canvas PNG as a single `<image>`. A getter so it's resolved at export time.
   */
  vectorScene?: () => VectorScene | null
  /**
   * Optional legend to BAKE INTO the export (DEC-1). A getter resolving the current pane's legend
   * spec at export time (from the cell's `colorBy` → `computeColoring().{legend|colorbar|blend}`).
   * When present + the "Include legend" toggle is on, SVG/PDF append its vector marks and PNG
   * rasterizes the composed scene — so the exported figure carries its legend. Absent ⇒ no legend,
   * byte-identical to before. NOTE: this getter is invoked during RENDER (to decide whether to show
   * the legend controls) as well as at export time, so keep it cheap (a memoized-spec read, not a
   * recompute). Like the sibling `svgToPDF` path, the async PNG branch may `setStatus` after a
   * keyed remount — harmless (a dev-only warning), not a leak.
   */
  legend?: () => LegendExportSpec | null
  /** Which corner the legend sits in (from the cell's `legendCorner`) — drives export placement so it
   *  matches the on-screen position (WYSIWYG). Absent ⇒ top-right. */
  legendCorner?: LegendCorner
  /** Legend layout mode from the cell: `true` = beside the plot (in a gutter — the plot raster/vector is
   *  already shrunk), `false` = overlay over the plot. Absent ⇒ overlay. */
  legendBeside?: boolean
  /**
   * Optional dataZoom slider(s) to BAKE INTO the export (WYSIWYG). A getter resolving the current
   * pane's [loFrac,hiFrac] window(s) at export time (from `axisWindow.windowToFraction`). When
   * present + the "Include slider" toggle is on, the rail is appended BELOW (x) / BESIDE (y) the
   * plot — matching the on-screen `AxisDataZoom` layout — so the exported figure carries its
   * range-zoom slider. Absent ⇒ no slider, byte-identical to before. Invoked during RENDER too
   * (to decide whether to show the toggle), so keep it cheap.
   */
  dataZoom?: () => DataZoomExportSpec | null
  /**
   * Optional cell-divider LINE marks to BAKE INTO a WHOLE-grid export (WYSIWYG). The grid's panel
   * dividers are DOM hairlines, never painted on the shared deck canvas, so a whole-grid export
   * loses them without this. A getter (resolved at export time) returning the marks in the scene's
   * device-pixel space — see `gridDividerMarks`. Composed ONLY when the export scope is the whole
   * grid (a pane crop has no interior dividers). Absent ⇒ byte-identical to before.
   */
  gridDividers?: () => readonly VectorMark[] | null
  /** Optional tabular data — the CSV source when no selection mask is present. */
  table?: DataTable
  /** Optional selection mask — the CSV source (selected point indices). */
  mask?: IndexMask
  /** Optional workspace spec — the JSON source. */
  spec?: WorkspaceSpec
  /** Optional figure provenance manifest (ITEM-6). A getter resolved at export time; when present the
   *  "Bundle" toggle emits image + source-data.csv + manifest.json as one .zip (ITEM-8). */
  manifest?: () => FigureManifest | null
  /**
   * Optional getter for the CURRENT pane's rect in CSS pixels, relative to the
   * exported `canvas` (ITEM-47). Supplied by the caller (GridWorkspace). When
   * `scope === 'pane'` and this returns a rect, PNG/SVG/PDF export crops to just
   * that pane; otherwise the whole canvas is exported. A getter so it's resolved
   * at export time (the pane may be resized/moved before the click).
   */
  paneRect?: () => Rect | null
  /**
   * Output device-pixel scale for raster export (default `window.devicePixelRatio
   * || 1`). Ensures a CSS-sized pane crop isn't downscaled below display density.
   */
  dpr?: number
  /** Default filename stem (no extension). */
  filename?: string
  /** Close affordance (X button, mirrors PaneEditForm). Omitted ⇒ no close button. */
  onClose?: () => void
  /**
   * Optional id used to keep testids unique when several export dialogs are open (portaled per pane).
   *
   * It reaches the DOM and NOTHING ELSE (`tid` below is its only reader), so a grid caller passes the
   * id a READER addresses the pane by — `cellTestId(cell)` — not the composing host's grid key. The
   * name is kept for its existing public callers; the CONTRACT is "the id this dialog is addressed
   * by". Anything that has to invert back to a store key (the per-pane export CROP does) reads
   * `data-viz-cell` instead, which is the grid's own key on purpose.
   */
  cellId?: string
  /** Initial scope (default 'pane'); a whole-grid form opens with 'grid'. */
  initialScope?: ExportScope
  /**
   * Show the in-dialog Scope selector (pane / grid). Default true (standalone consumers). The
   * GridWorkspace-OWNED per-target dialogs pass FALSE — each form's scope is fixed by WHICH form the user
   * opened (a pane dialog crops to its pane; the grid dialog exports the whole grid).
   */
  showScopeSelector?: boolean
  /** The plot/target name shown in the header so the user knows WHAT they're exporting (e.g. the pane's
   *  plot title, or "Whole grid"). */
  title?: string
}

/** Section wrapper matching PaneEditForm (an uppercase muted heading + a gap-2 column). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function resolveCanvas(t: CanvasTarget): HTMLCanvasElement | null {
  return typeof t === 'function' ? t() : t
}

function ensureExt(name: string, ext: string): string {
  const trimmed = name.trim() || 'export'
  return trimmed.toLowerCase().endsWith(`.${ext}`) ? trimmed : `${trimmed}.${ext}`
}

function downloadText(text: string, filename: string, mime: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  downloadDataUrl(url, filename)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([bytes as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  downloadDataUrl(url, filename)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Decode a PNG data URL to raw RGBA (for the TIFF encoder / EPS raster embed). Needs a DOM; null headless. */
async function pngDataUrlToRGBA(url: string): Promise<{ rgba: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null
  const img = await new Promise<HTMLImageElement | null>(res => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => res(null)
    im.src = url
  })
  if (!img) return null
  const cv = document.createElement('canvas')
  cv.width = img.naturalWidth
  cv.height = img.naturalHeight
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, cv.width, cv.height)
  return { rgba: d.data, width: cv.width, height: cv.height }
}

/** Composite RGBA over an opaque WHITE background. Publication rasters are white, not transparent — a TIFF
 *  (and any format that drops alpha) renders transparent pixels BLACK, so flatten before encoding. */
function flattenOnWhite(rgba: Uint8Array | Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255
    out[i] = Math.round(rgba[i] * a + 255 * (1 - a))
    out[i + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a))
    out[i + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a))
    out[i + 3] = 255
  }
  return out
}

export function ExportDialog({
  canvas,
  vectorScene,
  legend,
  legendCorner,
  legendBeside,
  dataZoom,
  gridDividers,
  table,
  mask,
  spec,
  manifest,
  paneRect,
  dpr,
  filename = 'export',
  onClose,
  cellId,
  initialScope = 'pane',
  showScopeSelector = true,
  title,
}: ExportDialogProps) {
  const tid = (base: string) => (cellId ? `${base}-${cellId}` : base)
  const [scope, setScope] = useState<ExportScope>(initialScope)
  const [format, setFormat] = useState<ExportFormat>('png')
  const [name, setName] = useState(filename)
  const [includeGridlines, setIncludeGridlines] = useState(true)
  const [includeSlider, setIncludeSlider] = useState(true) // dataZoom slider, default on when present
  const [scale, setScale] = useState<ExportScale>(1)
  const [sizeMode, setSizeMode] = useState<ExportSizeMode>('current')
  const [customW, setCustomW] = useState('')
  const [customH, setCustomH] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  // Publication print-size (ITEM-3/4): a column preset + DPI target that resolve to the raster scale.
  const [column, setColumn] = useState<ColumnPreset | 'none'>('none')
  const [dpi, setDpi] = useState<number>(DEFAULT_DPI)
  const [colorMode, setColorMode] = useState<ExportColorMode>('rgb') // ITEM-19
  const [bundle, setBundle] = useState(false) // ITEM-8
  const [cvd, setCvd] = useState<CvdKind | 'none'>('none') // ITEM-9 CVD/grayscale simulation check

  const isVector = format === 'svg' || format === 'pdf' || format === 'eps'
  // PNG/TIFF + vector are dimensioned; CSV/JSON are dimensionless (size controls hidden).
  const isRaster = format === 'png' || format === 'tiff'
  const isDimensioned = isRaster || isVector

  /**
   * The resolved custom output box in px (`{ width, height }`), or null when NOT in
   * custom mode or the fields are empty/invalid — in which case the export falls
   * back to CURRENT size. Robust: a blank or non-positive field disables custom.
   */
  const customBox = (): { width: number; height: number } | null => {
    if (sizeMode !== 'custom') return null
    const w = parseDim(customW)
    const h = parseDim(customH)
    return w && h ? { width: w, height: h } : null
  }

  /**
   * The active per-pane crop rect for THIS export, or null when exporting the whole
   * grid (scope 'grid') or when the caller supplied no pane rect. Resolved fresh at
   * each export so a resize between opens is reflected.
   */
  const activePaneRect = (): Rect | null =>
    scope === 'pane' ? paneRect?.() ?? null : null

  /** Human label for the status line reflecting what actually got exported. */
  const scopeLabel = (): string => (activePaneRect() ? 'pane' : 'whole')

  /**
   * Resolve the scene to serialize. When a pane crop is active, embed ONLY the
   * cropped raster (the pane), ignoring any full-canvas vector description; else use
   * the caller-supplied vector description, or the whole-canvas raster fallback.
   */
  const resolveScene = (): VectorScene | null => {
    const c = resolveCanvas(canvas)
    const rect = activePaneRect()
    // Prefer a caller-supplied VECTOR description (sharp, resolution-independent — a scatter pane's
    // per-point circles) over the raster crop, for BOTH pane and whole-grid scope. It returns null when
    // unavailable / too dense, and we fall back to the raster crop. A vector scene is in CSS px; a raster
    // crop/whole-canvas is in DEVICE px — tracked as `sceneScale` so decorations compose at the right size.
    const vs = vectorScene?.()
    const usedVector = !!vs
    let scene: VectorScene | null
    if (vs) scene = vs
    else if (rect && c) scene = canvasToVectorScene(cropCanvasToRect(c, rect, dpr))
    else scene = c ? canvasToVectorScene(c) : null
    if (!scene) return null
    const sceneScale = usedVector ? 1 : effectiveDpr(dpr)
    // Cell dividers (WHOLE-grid only): the panel separators are DOM hairlines, never on the shared
    // deck canvas, so a whole-grid export must redraw them or the grid reads as one seamless plot.
    // A pane crop (`rect`) has no interior dividers, so skip it there.
    if (!rect && gridDividers) {
      const dm = gridDividers()
      if (dm && dm.length) scene = { ...scene, marks: [...scene.marks, ...dm] }
    }
    // Append the dataZoom rail FIRST (below/beside the plot), so a legend `overlay` still lands over
    // the plot area rather than over the rail. Scale it to the scene's coordinate space.
    const dzSpec = includeSlider ? dataZoom?.() : null
    if (dzSpec) scene = composeDataZoomIntoScene(scene, dzSpec, undefined, sceneScale)
    // Append the legend as vector marks (SVG/PDF get it directly; PNG-with-legend reuses this scene). A
    // vector scene shares the legend's CSS-px space, so the legend lands proportional to the plot (WYSIWYG).
    // The legend is baked in whenever it's shown on screen (the getter returns null when the cell's
    // "show legend" is off) — WYSIWYG, no separate export toggle. Placement (corner + overlay/beside)
    // comes from the cell (edited in the pane form), so the exported legend sits where it does on screen.
    const legendSpec = legend?.()
    if (legendSpec)
      scene = composeLegendIntoScene(scene, legendToMarks(legendSpec), {
        corner: legendCorner ?? DEFAULT_LEGEND_CORNER,
        beside: legendBeside ?? false,
      })
    return scene
  }
  /** True when a legend will be baked in (drives the PNG scene-raster path + the toggle UI). */
  const legendActive = (): boolean => !!legend?.()
  /** True when a dataZoom slider will be baked in (drives the PNG scene-raster path). */
  const sliderActive = (): boolean => includeSlider && !!dataZoom?.()
  /** True when whole-grid cell dividers will be baked in (drives the PNG scene-raster path). */
  const dividersActive = (): boolean => !activePaneRect() && !!(gridDividers?.() ?? []).length

  /**
   * Vector (SVG/PDF) output sizing. Vector is resolution-INDEPENDENT, so scale +
   * custom size only set the NOMINAL `<svg>` width/height (the viewBox stays the
   * scene's intrinsic size, so marks keep their coords and content contain-fits —
   * no distortion). Returns the display dims `w`/`h` (for status) plus the
   * `buildSVG` opts. At scale 1 + current size, `opts` is empty → byte-identical.
   */
  const vectorOutputSize = (
    scene: VectorScene,
  ): { w: number; h: number; opts: { outputWidth?: number; outputHeight?: number } } => {
    // Publication final-size (ITEM-3/4): a column preset pins the output to a printed mm width at the chosen
    // DPI (e.g. single column 88 mm @ 600 dpi), preserving the scene aspect. Takes precedence over scale/custom.
    if (column !== 'none') {
      const w = Math.round(mmToPx(COLUMN_PRESETS[column], dpi))
      const h = Math.round(w * (scene.height / Math.max(1, scene.width)))
      return { w, h, opts: { outputWidth: w, outputHeight: h } }
    }
    const box = customBox()
    if (box) {
      const w = Math.round(box.width * scale)
      const h = Math.round(box.height * scale)
      return { w, h, opts: { outputWidth: w, outputHeight: h } }
    }
    if (scale !== 1) {
      const w = Math.round(scene.width * scale)
      const h = Math.round(scene.height * scale)
      return { w, h, opts: { outputWidth: w, outputHeight: h } }
    }
    return { w: Math.round(scene.width), h: Math.round(scene.height), opts: {} }
  }

  const doExport = () => {
    try {
      doExportInner()
    } catch {
      // A cross-origin-TAINTED canvas throws SecurityError from toDataURL (PNG / SVG-raster / whole).
      // Surface it instead of an uncaught exception that leaves the status stuck.
      setStatus('Export failed — the canvas is cross-origin tainted')
    }
  }
  const sourceCsv = (): string => (mask ? selectionToCSV(mask) : table ? tableToCSV(table) : '')

  const doExportInner = () => {
    // BUNDLE (ITEM-8): a reproducible-figure PACKAGE — a PNG figure + its source-data.csv + its provenance
    // manifest.json, zipped. Independent of the format selector (the bundle is a distinct deliverable). Needs
    // a manifest getter; the toggle is hidden otherwise.
    if (bundle && manifest?.()) {
      const scene = resolveScene()
      const c = resolveCanvas(canvas)
      const size = scene ? vectorOutputSize(scene) : { opts: {} }
      setStatus('Building bundle…')
      const pngPromise = scene
        ? sceneToRasterPngDataUrl(scene, { includeGridlines, width: (size.opts as { outputWidth?: number }).outputWidth, height: (size.opts as { outputHeight?: number }).outputHeight })
        : Promise.resolve(c ? c.toDataURL('image/png') : null)
      void pngPromise
        .then(url => {
          if (!url) { setStatus('Bundle unavailable — no figure'); return }
          const b64 = url.split(',')[1] ?? ''
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const zip = buildFigureBundle({ image: { name: 'figure.png', bytes }, sourceCsv: sourceCsv(), manifestJson: manifestToJSON(manifest()!) })
          downloadBytes(zip, ensureExt(name, 'zip'), 'application/zip')
          setStatus('Exported bundle (figure + source-data + manifest)')
        })
        .catch(() => setStatus('Bundle failed'))
      return
    }
    if (format === 'eps') {
      const scene = resolveScene()
      if (!scene) { setStatus('No view to export'); return }
      // Hybrid EPS: live Helvetica text + vector chrome (axes/gridlines/legend) PLUS the dense data layer
      // embedded as a raster. `buildEPS` skips an `image` mark unless given its raw pixels, so decode the
      // scene's raster tile (a data:PNG) here and pass it — otherwise the plot exports with axes but NO data.
      const imgMark = scene.marks.find(m => m.type === 'image') as { href: string } | undefined
      setStatus('Rendering EPS…')
      void (async () => {
        let raster: { rgba: Uint8ClampedArray; width: number; height: number } | undefined
        if (imgMark) {
          const px = await pngDataUrlToRGBA(imgMark.href)
          if (px) raster = { rgba: flattenOnWhite(px.rgba) as Uint8ClampedArray, width: px.width, height: px.height }
        }
        downloadText(buildEPS(scene, raster), ensureExt(name, 'eps'), 'application/postscript')
        setStatus(`Exported EPS (${scopeLabel()}${raster ? ' + data raster' : ''})`)
      })().catch(() => setStatus('EPS export failed'))
      return
    }
    if (format === 'tiff') {
      const scene = resolveScene()
      if (!scene) { setStatus('No view to export'); return }
      const size = vectorOutputSize(scene)
      setStatus('Rendering TIFF…')
      void sceneToRasterPngDataUrl(scene, { includeGridlines, width: size.opts.outputWidth, height: size.opts.outputHeight })
        .then(async url => {
          if (!url) { setStatus('TIFF export unavailable'); return }
          const px = await pngDataUrlToRGBA(url)
          if (!px) { setStatus('TIFF export unavailable'); return }
          // Flatten onto WHITE first — a raster figure is white-backed, and TIFF drops alpha (a transparent
          // background would otherwise render BLACK). Then apply the optional CVD/grayscale simulation check.
          const flat = flattenOnWhite(px.rgba)
          const pixels = cvd !== 'none' ? simulateImage(flat, cvd) : flat
          // Uncompressed baseline TIFF — always spec-valid + opens in every viewer. (The LZW codec is
          // not yet libtiff-compatible; `compression: 'none'` avoids it. Figure rasters are modest.)
          const bytes = encodeTIFF(pixels, px.width, px.height, { colorMode, dpi, compression: 'none' })
          downloadBytes(bytes, ensureExt(name, 'tiff'), 'image/tiff')
          setStatus(`Exported TIFF (${colorMode.toUpperCase()} ${px.width}×${px.height})`)
        })
        .catch(() => setStatus('TIFF export failed'))
      return
    }
    if (format === 'png') {
      const c = resolveCanvas(canvas)
      if (!c) {
        setStatus('No canvas to export')
        return
      }
      // Sharp scene path: rasterize the COMPOSED vector scene (via buildSVG→img→canvas) at the target
      // size when there's either a decoration to bake in (legend/slider/dividers — the direct
      // canvas.toDataURL can't carry marks) OR a VECTOR scene available (a scatter pane's per-point
      // circles → crisp at any DPI, fixing the blurry high-DPI raster). Otherwise the fast direct
      // canvas-crop path below (raster-only, byte-identical to before).
      if (legendActive() || sliderActive() || dividersActive() || !!vectorScene?.()) {
        const scene = resolveScene()
        if (!scene) {
          setStatus('No view to export')
          return
        }
        const size = vectorOutputSize(scene)
        const extras = [legendActive() && 'legend', sliderActive() && 'slider', dividersActive() && 'dividers'].filter(Boolean).join('+')
        setStatus('Rendering PNG…')
        void sceneToRasterPngDataUrl(scene, { includeGridlines, width: size.opts.outputWidth, height: size.opts.outputHeight })
          .then(url => {
            if (!url) {
              setStatus('PNG export unavailable')
              return
            }
            downloadDataUrl(url, ensureExt(name, 'png'))
            setStatus(`Exported PNG (${scopeLabel()}${extras ? ` + ${extras}` : ''} ${size.w}×${size.h})`)
          })
          .catch(() => setStatus('PNG export failed'))
        return
      }
      const rect = activePaneRect()
      const box = customBox()
      const label = rect ? 'pane' : 'whole'

      if (box) {
        // Custom size: contain-fit the (cropped-pane or whole) source into the
        // target box × scale, preserving aspect ratio (letterbox, no distortion).
        const src = rect ? cropCanvasToRect(c, rect, effectiveDpr(dpr)) : c
        const out = resizeCanvasToBox(src, box.width * scale, box.height * scale)
        downloadDataUrl(out.toDataURL('image/png'), ensureExt(name, 'png'))
        setStatus(`Exported PNG (${label} ${out.width}×${out.height})`)
      } else if (rect) {
        // Current size, pane crop: output resolution = base dpr × scale. At
        // scale 1 this is byte-identical to the pre-scale export (same call).
        const cropped = cropCanvasToRect(c, rect, scale === 1 ? dpr : effectiveDpr(dpr) * scale)
        downloadDataUrl(cropped.toDataURL('image/png'), ensureExt(name, 'png'))
        setStatus(`Exported PNG (pane ${cropped.width}×${cropped.height})`)
      } else {
        // Current size, whole canvas: scale composites a larger offscreen. At
        // scale 1, `{ scale: 1 }` computes identically to today's `{}`.
        downloadDataUrl(exportCanvasPNG(c, scale === 1 ? {} : { scale }), ensureExt(name, 'png'))
        const w = Math.max(1, Math.round(c.width * scale))
        const h = Math.max(1, Math.round(c.height * scale))
        setStatus(`Exported PNG (whole ${w}×${h})`)
      }
      return
    }
    if (format === 'svg') {
      const scene = resolveScene()
      if (!scene) {
        setStatus('No view to export')
        return
      }
      const size = vectorOutputSize(scene)
      const svg = buildSVG(scene, { includeGridlines, ...size.opts })
      downloadText(svg, ensureExt(name, 'svg'), 'image/svg+xml')
      setStatus(`Exported SVG (${scopeLabel()} ${size.w}×${size.h})`)
      return
    }
    if (format === 'pdf') {
      const scene = resolveScene()
      if (!scene) {
        setStatus('No view to export')
        return
      }
      const size = vectorOutputSize(scene)
      // buildSVG stamps the target width/height; svgToPDF reads them → page size.
      const svg = buildSVG(scene, { includeGridlines, ...size.opts })
      setStatus('Rendering PDF…')
      void svgToPDF(svg, { output: 'datauristring' })
        .then(out => {
          if (!out || typeof out !== 'string') {
            setStatus('PDF export unavailable')
            return
          }
          downloadDataUrl(out, ensureExt(name, 'pdf'))
          setStatus(`Exported PDF (${scopeLabel()} ${size.w}×${size.h})`)
        })
        .catch(() => setStatus('PDF export failed'))
      return
    }
  }

  const toggleRow = (testid: string, label: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Switch aria-label={label} data-testid={tid(testid)} checked={checked} onCheckedChange={onChange} />
    </div>
  )

  return (
    <div
      data-testid={tid('viz-export-dialog')}
      className="flex h-full w-full min-w-64 flex-col gap-4 overflow-auto border-s border-border bg-background p-3 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Export</h2>
          {/* Which plot is being exported (the pane's plot title, or "Whole grid"). */}
          <p className="truncate text-xs text-muted-foreground" data-testid={tid('export-target-title')}>
            {title || (scope === 'grid' ? 'Whole grid' : 'This plot')}
          </p>
        </div>
        {onClose && (
          <Button size="icon" variant="ghost" tooltip="Close" data-testid={tid('viz-export-close')} onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <Section title={showScopeSelector ? 'Scope & format' : 'Format'}>
        {showScopeSelector && (
          <>
            <label className="text-xs text-muted-foreground">Scope</label>
            <Select
              size="sm"
              aria-label="Export scope"
              data-testid={tid('export-scope')}
              value={scope}
              onValueChange={v => setScope(v as ExportScope)}
              options={[
                { value: 'pane', label: 'This pane' },
                { value: 'grid', label: 'Whole grid' },
              ]}
            />
          </>
        )}
        <label className="text-xs text-muted-foreground">Format</label>
        <Select
          size="sm"
          aria-label="Export format"
          data-testid={tid('export-format')}
          value={format}
          onValueChange={v => setFormat(v as ExportFormat)}
          options={[
            { value: 'png', label: 'PNG (raster)' },
            { value: 'tiff', label: 'TIFF (raster, print)' },
            { value: 'svg', label: 'SVG (vector)' },
            { value: 'pdf', label: 'PDF (vector)' },
            { value: 'eps', label: 'EPS (vector)' },
          ]}
        />
      </Section>

      {(isVector || (isDimensioned && !!dataZoom?.())) && (
        <Section title="Include">
          {isVector && toggleRow('export-gridlines', 'Gridlines', includeGridlines, setIncludeGridlines)}
          {isDimensioned && dataZoom?.() && toggleRow('export-slider', 'Zoom slider', includeSlider, setIncludeSlider)}
        </Section>
      )}

      {isDimensioned && (
        <Section title="Output">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">Scale{isVector ? ' (nom.)' : ''}</span>
            <Select
              size="sm"
              aria-label="Export scale"
              className="min-w-0 flex-1"
              data-testid={tid('export-scale')}
              value={String(scale)}
              onValueChange={v => setScale(Number(v) as ExportScale)}
              options={[
                { value: '1', label: '1× (current)' },
                { value: '2', label: '2×' },
                { value: '3', label: '3×' },
                { value: '4', label: '4×' },
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">Size</span>
            <Select
              size="sm"
              aria-label="Export size"
              className="min-w-0 flex-1"
              data-testid={tid('export-size-mode')}
              value={sizeMode}
              onValueChange={v => setSizeMode(v as ExportSizeMode)}
              options={[
                { value: 'current', label: 'Current' },
                { value: 'custom', label: 'Custom…' },
              ]}
            />
          </div>
          {sizeMode === 'custom' && (
            <div className="flex items-center gap-2">
              <Input size="sm" type="number" min={1} className="w-24" aria-label="Width" data-testid={tid('export-width')} value={customW} placeholder="width px" onChange={e => setCustomW(e.target.value)} />
              <span className="text-muted-foreground">×</span>
              <Input size="sm" type="number" min={1} className="w-24" aria-label="Height" data-testid={tid('export-height')} value={customH} placeholder="height px" onChange={e => setCustomH(e.target.value)} />
            </div>
          )}
        </Section>
      )}

      {isDimensioned && (
        <Section title="Print size">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">Column</span>
            <Select
              size="sm"
              aria-label="Column width"
              className="min-w-0 flex-1"
              data-testid={tid('export-column')}
              value={column}
              onValueChange={v => setColumn(v as ColumnPreset | 'none')}
              options={[
                { value: 'none', label: 'On-screen size' },
                { value: 'single', label: `Single column (${COLUMN_PRESETS.single} mm)` },
                { value: 'oneAndHalf', label: `1.5 column (${COLUMN_PRESETS.oneAndHalf} mm)` },
                { value: 'double', label: `Double column (${COLUMN_PRESETS.double} mm)` },
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-muted-foreground">DPI</span>
            <Select
              size="sm"
              aria-label="Export DPI"
              className="min-w-0 flex-1"
              data-testid={tid('export-dpi')}
              value={String(dpi)}
              onValueChange={v => setDpi(Number(v))}
              options={[
                { value: String(DPI_TARGETS.halftone), label: '300 (halftone/photo)' },
                { value: String(DPI_TARGETS.combination), label: '600 (combination)' },
                { value: String(DPI_TARGETS.lineArt), label: '1200 (line art)' },
              ]}
            />
          </div>
          {format === 'tiff' && (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">Color</span>
              <Select
                size="sm"
                aria-label="Color mode"
                className="min-w-0 flex-1"
                data-testid={tid('export-color-mode')}
                value={colorMode}
                onValueChange={v => setColorMode(v as ExportColorMode)}
                options={[
                  { value: 'rgb', label: 'RGB' },
                  { value: 'cmyk', label: 'CMYK (print)' },
                  { value: 'gray', label: 'Grayscale' },
                ]}
              />
            </div>
          )}
          {format === 'tiff' && (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">Check</span>
              <Select
                size="sm"
                aria-label="Color-vision check"
                className="min-w-0 flex-1"
                data-testid={tid('export-cvd')}
                value={cvd}
                onValueChange={v => setCvd(v as CvdKind | 'none')}
                options={[
                  { value: 'none', label: 'No simulation' },
                  { value: 'deuteranopia', label: 'Deuteranopia (red-green)' },
                  { value: 'protanopia', label: 'Protanopia (red-green)' },
                  { value: 'tritanopia', label: 'Tritanopia (blue-yellow)' },
                  { value: 'grayscale', label: 'Grayscale' },
                ]}
              />
            </div>
          )}
        </Section>
      )}

      <Section title="File">
        {manifest?.() && toggleRow('export-bundle', 'Bundle (figure + data + provenance)', bundle, setBundle)}
        <label className="text-xs text-muted-foreground" htmlFor={tid(`export-filename`)}>Filename</label>
        <Input
          id={tid('export-filename')}
          size="sm"
          data-testid={tid('export-filename')}
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <Button className="mt-1" data-testid={tid('export-button')} onClick={doExport}>
          Export
        </Button>
        {status && (
          <span data-testid={tid('export-status')} role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {status}
          </span>
        )}
      </Section>
    </div>
  )
}
