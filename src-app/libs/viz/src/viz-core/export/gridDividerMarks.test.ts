import { describe, it, expect } from 'vitest'
import { gridDividerMarks } from './gridDividerMarks'

// Mock just the DOM surface the helper touches: getBoundingClientRect + querySelectorAll.
function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }
}
function sep(left: number, top: number, width: number, height: number) {
  return { getBoundingClientRect: () => rect(left, top, width, height) } as unknown as HTMLElement
}
function mockCanvas(w: number, h: number) {
  return { width: w, height: h, getBoundingClientRect: () => rect(0, 0, w, h) } as unknown as HTMLCanvasElement
}
function mockRoot(seps: HTMLElement[]) {
  return { querySelectorAll: (_s: string) => seps } as unknown as HTMLElement
}

describe('gridDividerMarks — re-derive DOM cell dividers as export line marks', () => {
  it('turns a vertical separator into a vertical hairline at its center (matching the on-screen line)', () => {
    // Two cells [0..567][573..1140] with a 6px separator handle at 567..573 → line at x=570.
    const marks = gridDividerMarks(mockRoot([sep(567, 0, 6, 864)]), mockCanvas(1140, 864), 1)
    expect(marks).toHaveLength(1)
    const m = marks[0]
    expect(m.type).toBe('line')
    if (m.type === 'line') {
      expect(m.x1).toBe(570)
      expect(m.x2).toBe(570)
      expect(m.y1).toBe(0)
      expect(m.y2).toBe(864)
      expect(m.stroke).toBe('rgba(128,128,128,0.4)')
    }
  })

  it('turns a horizontal separator into a horizontal hairline at its center', () => {
    const marks = gridDividerMarks(mockRoot([sep(0, 430, 1140, 6)]), mockCanvas(1140, 864), 1)
    expect(marks).toHaveLength(1)
    const m = marks[0]
    if (m.type === 'line') {
      expect(m.y1).toBe(433)
      expect(m.y2).toBe(433)
      expect(m.x1).toBe(0)
      expect(m.x2).toBe(1140)
    }
  })

  it('scales into DEVICE pixels by dpr (scene space is canvas.width = CSS×dpr)', () => {
    const marks = gridDividerMarks(mockRoot([sep(567, 0, 6, 864)]), mockCanvas(2280, 1728), 2)
    const m = marks[0]
    if (m.type === 'line') {
      expect(m.x1).toBe(1140) // 570 × 2
      expect(m.y2).toBe(1728) // 864 × 2
      expect(m.width).toBe(2) // 1 CSS px hairline → dpr device px
    }
  })

  it('returns [] with no separators (a single cell has no interior divider)', () => {
    expect(gridDividerMarks(mockRoot([]), mockCanvas(1140, 864), 1)).toEqual([])
  })

  it('returns [] when root or canvas is missing', () => {
    expect(gridDividerMarks(null, mockCanvas(100, 100), 1)).toEqual([])
    expect(gridDividerMarks(mockRoot([sep(50, 0, 6, 100)]), null, 1)).toEqual([])
  })

  it('clamps a separator taller than the canvas to the canvas box', () => {
    // Separator spans y −20..884 (chrome above the deck); clamp to 0..864.
    const marks = gridDividerMarks(mockRoot([sep(567, -20, 6, 904)]), mockCanvas(1140, 864), 1)
    const m = marks[0]
    if (m.type === 'line') {
      expect(m.y1).toBe(0)
      expect(m.y2).toBe(864)
    }
  })
})
