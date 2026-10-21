import { describe, it, expect } from 'vitest'
import {
  buildSVG,
  escapeXML,
  canvasToVectorScene,
  type VectorScene,
  type VectorMark,
} from './vector'

describe('buildSVG', () => {
  it('emits a well-formed <svg> root with the scene dimensions', () => {
    const svg = buildSVG({ width: 320, height: 240, marks: [] })
    expect(svg.startsWith('<?xml')).toBe(true)
    expect(svg).toContain('<svg')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="320"')
    expect(svg).toContain('height="240"')
    expect(svg).toContain('viewBox="0 0 320 240"')
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('keeps intrinsic width/height when no output-size override is given (default unchanged)', () => {
    const svg = buildSVG({ width: 320, height: 240, marks: [] })
    // width/height attrs == viewBox size — byte-identical to the pre-scale export.
    expect(svg).toContain('width="320" height="240" viewBox="0 0 320 240"')
  })

  it('overrides output width/height while keeping the intrinsic viewBox (scale / custom size — content letterboxes, no distortion)', () => {
    // 2× nominal scale: svg box grows, viewBox stays intrinsic so marks keep coords.
    const scaled = buildSVG({ width: 320, height: 240, marks: [] }, {
      outputWidth: 640,
      outputHeight: 480,
    })
    expect(scaled).toContain('width="640" height="480" viewBox="0 0 320 240"')

    // Custom box with a DIFFERENT aspect: viewBox is still intrinsic, so the
    // default preserveAspectRatio (meet) contain-fits the content — never stretches.
    const custom = buildSVG({ width: 320, height: 240, marks: [] }, {
      outputWidth: 800,
      outputHeight: 400,
    })
    expect(custom).toContain('width="800" height="400" viewBox="0 0 320 240"')
  })

  it('serializes a line mark', () => {
    const svg = buildSVG({
      width: 10,
      height: 10,
      marks: [{ type: 'line', x1: 0, y1: 1, x2: 9, y2: 8, stroke: '#333', width: 2 }],
    })
    expect(svg).toContain('<line x1="0" y1="1" x2="9" y2="8"')
    expect(svg).toContain('stroke="#333"')
    expect(svg).toContain('stroke-width="2"')
  })

  it('serializes polyline + polygon with points', () => {
    const marks: VectorMark[] = [
      { type: 'polyline', points: [[0, 0], [1, 2], [3, 4]], stroke: '#111' },
      { type: 'polygon', points: [[0, 0], [4, 0], [2, 4]], fill: '#eee', stroke: '#000' },
    ]
    const svg = buildSVG({ width: 10, height: 10, marks })
    expect(svg).toContain('<polyline points="0,0 1,2 3,4"')
    expect(svg).toContain('<polygon points="0,0 4,0 2,4"')
    expect(svg).toContain('fill="#eee"')
  })

  it('serializes a circle mark', () => {
    const svg = buildSVG({
      width: 10,
      height: 10,
      marks: [{ type: 'circle', cx: 5, cy: 5, r: 2, fill: '#f00' }],
    })
    expect(svg).toContain('<circle cx="5" cy="5" r="2"')
    expect(svg).toContain('fill="#f00"')
  })

  it('serializes text with anchor + rotation', () => {
    const svg = buildSVG({
      width: 100,
      height: 100,
      marks: [
        {
          type: 'text',
          x: 10,
          y: 50,
          text: 'Y axis',
          fill: '#000',
          size: 12,
          anchor: 'middle',
          rotate: -90,
        },
      ],
    })
    expect(svg).toContain('<text x="10" y="50"')
    expect(svg).toContain('text-anchor="middle"')
    expect(svg).toContain('transform="rotate(-90 10 50)"')
    expect(svg).toContain('>Y axis</text>')
  })

  it('serializes rect + embedded image', () => {
    const svg = buildSVG({
      width: 10,
      height: 10,
      marks: [
        { type: 'rect', x: 1, y: 1, w: 8, h: 8, fill: '#fff', stroke: '#000' },
        { type: 'image', x: 0, y: 0, w: 10, h: 10, href: 'data:image/png;base64,AAAA' },
      ],
    })
    expect(svg).toContain('<rect x="1" y="1" width="8" height="8"')
    expect(svg).toContain('<image x="0" y="0" width="10" height="10"')
    expect(svg).toContain('href="data:image/png;base64,AAAA"')
  })

  it('paints a background rect when background is set', () => {
    const svg = buildSVG({ width: 4, height: 4, marks: [], background: '#ffffff' })
    expect(svg).toContain('<rect x="0" y="0" width="4" height="4" fill="#ffffff" />')
  })

  it('drops grid-role marks when includeGridlines is false, keeps data marks', () => {
    const scene: VectorScene = {
      width: 10,
      height: 10,
      marks: [
        { type: 'line', x1: 0, y1: 5, x2: 10, y2: 5, stroke: '#ddd', role: 'grid' },
        { type: 'line', x1: 0, y1: 0, x2: 0, y2: 10, stroke: '#000', role: 'axis' },
        { type: 'polyline', points: [[0, 0], [5, 5]], stroke: '#999', role: 'grid' },
        { type: 'circle', cx: 5, cy: 5, r: 1, fill: '#f00' },
      ],
    }
    const withGrid = buildSVG(scene, { includeGridlines: true })
    expect((withGrid.match(/<line/g) || []).length).toBe(2)
    expect((withGrid.match(/<polyline/g) || []).length).toBe(1)

    const noGrid = buildSVG(scene, { includeGridlines: false })
    // grid line dropped, axis line kept
    expect((noGrid.match(/<line/g) || []).length).toBe(1)
    expect(noGrid).toContain('stroke="#000"')
    expect(noGrid).not.toContain('stroke="#ddd"')
    // grid polyline dropped
    expect(noGrid).not.toContain('<polyline')
    // data circle always kept
    expect(noGrid).toContain('<circle')
  })
})

describe('escapeXML', () => {
  it('escapes the five XML special characters', () => {
    expect(escapeXML(`<a> & "b" 'c'`)).toBe('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;')
  })

  it('escapes text embedded in a scene', () => {
    const svg = buildSVG({
      width: 10,
      height: 10,
      marks: [{ type: 'text', x: 0, y: 0, text: 'p < 0.05 & "sig"', fill: '#000', size: 10 }],
    })
    expect(svg).toContain('p &lt; 0.05 &amp; &quot;sig&quot;')
    expect(svg).not.toContain('p < 0.05')
  })
})

describe('canvasToVectorScene', () => {
  it('wraps a canvas as a single embedded image mark (fallback)', () => {
    const stub = {
      width: 64,
      height: 48,
      toDataURL: (type: string) => `data:${type};base64,ZZZ`,
    } as unknown as HTMLCanvasElement
    const scene = canvasToVectorScene(stub)
    expect(scene.width).toBe(64)
    expect(scene.height).toBe(48)
    expect(scene.marks).toHaveLength(1)
    const mark = scene.marks[0]
    expect(mark.type).toBe('image')
    if (mark.type === 'image') {
      expect(mark.href).toBe('data:image/png;base64,ZZZ')
      expect(mark.w).toBe(64)
      expect(mark.h).toBe(48)
    }
    // and it serializes to a valid SVG containing the image
    const svg = buildSVG(scene)
    expect(svg).toContain('<image')
    expect(svg).toContain('data:image/png;base64,ZZZ')
  })

  it('accepts an explicit pre-rasterized PNG url', () => {
    const stub = { width: 2, height: 2 } as unknown as HTMLCanvasElement
    const scene = canvasToVectorScene(stub, 'data:image/png;base64,PRE')
    const mark = scene.marks[0]
    expect(mark.type).toBe('image')
    if (mark.type === 'image') expect(mark.href).toBe('data:image/png;base64,PRE')
  })
})
