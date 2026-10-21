// propagateToLinked.test.ts — (segmentation-scale Track C, TEST-16 / ITEM-14)
// The pure fan-out returns per-cell channel/contrast + palette patches for every OTHER cell in the
// link group; no-ops on cells outside it; scope flags gate what is applied; the source is unchanged.

import { describe, it, expect } from 'vitest'
import {
  propagateToLinked,
  cellHasDisplayOverrides,
  type PropagableCellDisplay,
} from './propagateToLinked'
import type { RasterChannelState } from '../spatial/rasterImageLayers'

function ch(name: string, color: [number, number, number], lo: number, hi: number, visible = true): RasterChannelState {
  return { name, color, contrastLimits: [lo, hi], visible }
}

const SOURCE: PropagableCellDisplay = {
  id: 'src',
  channels: [ch('DAPI', [0, 0, 255], 10, 200), ch('FITC', [0, 255, 0], 5, 150, false)],
  colormap: 'viridis',
}
// two group members with DIFFERENT display, and one non-member.
const TGT_A: PropagableCellDisplay = { id: 'a', channels: [ch('DAPI', [255, 0, 0], 0, 65535), ch('FITC', [255, 255, 0], 0, 65535)] }
const TGT_B: PropagableCellDisplay = { id: 'b', channels: [ch('DAPI', [128, 128, 128], 1, 2), ch('FITC', [9, 9, 9], 3, 4)] }
const OUTSIDER: PropagableCellDisplay = { id: 'z', channels: [ch('DAPI', [1, 1, 1], 0, 1)] }
const CELLS = [SOURCE, TGT_A, TGT_B, OUTSIDER]
const GROUP = ['src', 'a', 'b']

describe('propagateToLinked (TEST-16)', () => {
  it('patches every OTHER group member, never the source, never a non-member', () => {
    const out = propagateToLinked('src', GROUP, CELLS, { channels: true, palette: true })
    const ids = out.map(p => p.cellId).sort()
    expect(ids).toEqual(['a', 'b']) // a + b, NOT src, NOT z
  })

  it('both scope: copies contrast+visibility AND colors+colormap onto targets', () => {
    const out = propagateToLinked('src', GROUP, CELLS, { channels: true, palette: true })
    const a = out.find(p => p.cellId === 'a')!
    expect(a.channels![0].contrastLimits).toEqual([10, 200]) // from source
    expect(a.channels![0].color).toEqual([0, 0, 255]) // from source
    expect(a.channels![1].visible).toBe(false) // source FITC hidden
    expect(a.colormap).toBe('viridis')
  })

  it('channels-only scope: copies contrast+visibility, KEEPS target colors, omits colormap', () => {
    const out = propagateToLinked('src', GROUP, CELLS, { channels: true, palette: false })
    const b = out.find(p => p.cellId === 'b')!
    expect(b.channels![0].contrastLimits).toEqual([10, 200]) // from source
    expect(b.channels![0].color).toEqual([128, 128, 128]) // KEPT (target's own)
    expect('colormap' in b).toBe(false) // colormap untouched under channels-only
  })

  it('palette-only scope: copies colors+colormap, KEEPS target contrast', () => {
    const out = propagateToLinked('src', GROUP, CELLS, { channels: false, palette: true })
    const b = out.find(p => p.cellId === 'b')!
    expect(b.channels![0].color).toEqual([0, 0, 255]) // from source
    expect(b.channels![0].contrastLimits).toEqual([1, 2]) // KEPT (target's own)
    expect(b.colormap).toBe('viridis')
  })

  it('empty scope → no patches; source-not-in-group → no patches', () => {
    expect(propagateToLinked('src', GROUP, CELLS, { channels: false, palette: false })).toEqual([])
    expect(propagateToLinked('z', GROUP, CELLS, { channels: true, palette: true })).toEqual([]) // z not in GROUP
  })

  it('a group id with no live cell is skipped (no-op), not a crash', () => {
    const out = propagateToLinked('src', ['src', 'a', 'ghost'], CELLS, { channels: true, palette: true })
    expect(out.map(p => p.cellId)).toEqual(['a']) // ghost skipped
  })

  it('does not mutate the source or inputs', () => {
    const before = JSON.stringify(CELLS)
    propagateToLinked('src', GROUP, CELLS, { channels: true, palette: true })
    expect(JSON.stringify(CELLS)).toBe(before)
  })

  it('cellHasDisplayOverrides: tuned cell true, bare cell false', () => {
    expect(cellHasDisplayOverrides(TGT_A)).toBe(true) // has channels
    expect(cellHasDisplayOverrides({ id: 'bare' })).toBe(false)
    expect(cellHasDisplayOverrides({ id: 'cm', colormap: 'magma' })).toBe(true)
  })
})

describe('propagateToLinked — empty-channels target (blind-audit L2)', () => {
  it('a target with an explicit empty channels[] still RECEIVES the source channels', () => {
    const src: PropagableCellDisplay = { id: 's', channels: [ch('DAPI', [0, 0, 255], 10, 200)], colormap: 'viridis' }
    const emptyTgt: PropagableCellDisplay = { id: 'e', channels: [] } // defined-but-empty (not undefined)
    const patches = propagateToLinked('s', ['s', 'e'], [src, emptyTgt], { channels: true, palette: true })
    const p = patches.find(x => x.cellId === 'e')
    if (!p) throw new Error('expected a patch for the empty-channels target')
    // the old `?? srcChannels` fallback fired only for undefined, so `[]` produced [] (silent no-op).
    const chans = p.channels ?? []
    expect(chans.length).toBe(1)
    expect(chans[0].contrastLimits).toEqual([10, 200])
  })
})
