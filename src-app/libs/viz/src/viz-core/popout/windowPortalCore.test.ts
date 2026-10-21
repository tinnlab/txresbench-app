import { describe, it, expect } from 'vitest'
import { buildPopupFeatures, centeredGeometry, popoutWindowName } from './windowPortalCore'

describe('buildPopupFeatures', () => {
  it('emits a popup features string with rounded, floored dimensions', () => {
    expect(buildPopupFeatures({ width: 900, height: 700 })).toBe('popup=yes,width=900,height=700')
    expect(buildPopupFeatures({ width: 899.6, height: 700.4 })).toBe('popup=yes,width=900,height=700')
  })
  it('includes left/top when finite, clamped to >=0', () => {
    expect(buildPopupFeatures({ width: 100, height: 100, left: 40, top: 20 })).toBe(
      'popup=yes,width=100,height=100,left=40,top=20',
    )
    expect(buildPopupFeatures({ width: 100, height: 100, left: -5, top: -9 })).toBe(
      'popup=yes,width=100,height=100,left=0,top=0',
    )
  })
  it('omits left/top when absent or non-finite', () => {
    expect(buildPopupFeatures({ width: 100, height: 100, left: NaN })).toBe(
      'popup=yes,width=100,height=100',
    )
  })
  it('floors sub-1 dimensions to 1', () => {
    expect(buildPopupFeatures({ width: 0, height: 0 })).toBe('popup=yes,width=1,height=1')
  })
})

describe('centeredGeometry', () => {
  it('centers on the screen', () => {
    expect(centeredGeometry(800, 600, 1400, 900)).toEqual({ width: 800, height: 600, left: 300, top: 150 })
  })
  it('clamps to top-left when the popup is larger than the screen', () => {
    const g = centeredGeometry(2000, 2000, 1000, 800)
    expect(g.left).toBe(0)
    expect(g.top).toBe(0)
  })
})

describe('popoutWindowName', () => {
  it('is stable + id-scoped (reusing focuses the same window)', () => {
    expect(popoutWindowName('cell-1')).toBe('viz-portal-cell-1')
    expect(popoutWindowName('cell-1')).toBe(popoutWindowName('cell-1'))
    expect(popoutWindowName('a')).not.toBe(popoutWindowName('b'))
  })
})
