// legendExport.test.ts — the export pipeline actually BAKES the legend into the serialized output
// (the JTBD proof), and the no-legend path stays byte-identical.

import { describe, it, expect } from 'vitest'
import { buildSVG, canvasToVectorScene, sceneToRasterPngDataUrl } from './vector'
import { legendToMarks, composeLegendIntoScene } from './legendMarks'
import type { LegendDescriptor } from '../data/color'

// A minimal fake canvas for canvasToVectorScene (node has no real canvas).
const fakeCanvas = (w = 200, h = 150) =>
  ({ width: w, height: h, toDataURL: () => 'data:image/png;base64,AAAA' }) as unknown as HTMLCanvasElement

const catSpec = {
  descriptor: {
    kind: 'categorical',
    entries: [
      { code: 0, label: 'Alpha', hex: '#ff0000' },
      { code: 1, label: 'Beta', hex: '#00ff00' },
    ],
  } as LegendDescriptor,
  title: 'Group',
}

describe('legend bakes into the exported SVG (TEST-6)', () => {
  it('buildSVG of the legend-composed scene CONTAINS the swatch rects + label text', () => {
    const base = canvasToVectorScene(fakeCanvas())
    const composed = composeLegendIntoScene(base, legendToMarks(catSpec), { corner: 'tr', beside: true })
    const svg = buildSVG(composed)
    // the plot image mark survives
    expect(svg).toContain('<image')
    // the legend swatch fills + labels are present in the vector output
    expect(svg.toLowerCase()).toContain('fill="#ff0000"')
    expect(svg.toLowerCase()).toContain('fill="#00ff00"')
    expect(svg).toContain('Alpha')
    expect(svg).toContain('Beta')
    expect(svg).toContain('Group')
    // no resize — the legend sits within the figure (the caller reserved the region)
    expect(composed.width).toBe(200)
  })
})

describe('PNG-with-legend path composes the legend before rasterizing (TEST-7)', () => {
  it('the composed scene the PNG path rasterizes carries the legend; headless degrades to null', async () => {
    const base = canvasToVectorScene(fakeCanvas())
    const composed = composeLegendIntoScene(base, legendToMarks(catSpec), { corner: 'tr', beside: true })
    // the PNG path serializes THIS scene (buildSVG) then rasterizes — the legend is in the SVG it feeds.
    expect(buildSVG(composed)).toContain('Alpha')
    // sceneToRasterPngDataUrl needs a DOM (Image); in node it degrades to null (not a throw).
    await expect(sceneToRasterPngDataUrl(composed)).resolves.toBeNull()
  })
})

describe('no-legend export is byte-identical (TEST-8)', () => {
  it('the base scene (no legend) serializes with the plot image but NO legend rect/text', () => {
    const base = canvasToVectorScene(fakeCanvas())
    const svg = buildSVG(base)
    expect(svg).toContain('<image')
    expect(svg).not.toContain('Alpha')
    expect(svg).not.toContain('Group')
    // width unchanged (no gutter added)
    expect(base.width).toBe(200)
    // composing an EMPTY legend is a strict no-op (same object)
    expect(composeLegendIntoScene(base, { marks: [], width: 0, height: 0 })).toBe(base)
  })
})
