// maskReview.test.ts — TEST-10 (ITEM-11): the class hide/solo path is a pure LUT edit.
// `buildIdColorLut` with `hiddenCategories` / `soloCategory` writes alpha 0 for the ids of hidden
// categories and leaves every other id byte-identical to the unfiltered LUT. Pure oracle test (no
// GL), mirroring `labelMaskColor.test.ts`.

import { describe, it, expect } from 'vitest'
import { buildIdColorLut } from './labelMaskColor'
import { CATEGORICAL_PALETTE } from '../data/color'

// ids: 0=bg, 1→cat0, 2→cat1, 3→cat2, 4→cat1, 5→cat2, 6→cat0.
const categoryForId = new Uint16Array([0, 0, 1, 2, 1, 2, 0])

/** The ids whose category is `cat` (skipping background id 0). */
function idsOfCategory(cat: number): number[] {
  const out: number[] = []
  for (let id = 1; id < categoryForId.length; id++) if (categoryForId[id] === cat) out.push(id)
  return out
}

describe('buildIdColorLut hidden/solo — class visibility as a LUT alpha edit (TEST-10)', () => {
  it('hiddenCategories:{2} → every id of category 2 has LUT alpha 0, all others unchanged', () => {
    const base = buildIdColorLut(categoryForId)
    const filtered = buildIdColorLut(categoryForId, { hiddenCategories: new Set([2]) })

    // same packing dims + length (LUT is the same size — only alpha bytes differ).
    expect(filtered.width).toBe(base.width)
    expect(filtered.height).toBe(base.height)
    expect(filtered.data.length).toBe(base.data.length)

    const hiddenIds = new Set(idsOfCategory(2))
    expect(hiddenIds.size).toBeGreaterThan(0)

    for (let id = 1; id < categoryForId.length; id++) {
      const o = id * 4
      const rgba = [filtered.data[o], filtered.data[o + 1], filtered.data[o + 2], filtered.data[o + 3]]
      if (hiddenIds.has(id)) {
        // hidden: alpha 0 (invisible). rgb still carries the (unused) color.
        expect(rgba[3]).toBe(0)
      } else {
        // every other id is byte-for-byte the unfiltered LUT.
        expect(rgba).toEqual([base.data[o], base.data[o + 1], base.data[o + 2], base.data[o + 3]])
        expect(rgba[3]).toBe(255)
      }
    }
  })

  it('background id 0 stays fully transparent regardless of filters', () => {
    const filtered = buildIdColorLut(categoryForId, { hiddenCategories: new Set([0, 1, 2]) })
    expect([filtered.data[0], filtered.data[1], filtered.data[2], filtered.data[3]]).toEqual([0, 0, 0, 0])
  })

  it('soloCategory:1 → only category-1 ids are visible; all others alpha 0', () => {
    const solo = buildIdColorLut(categoryForId, { soloCategory: 1 })
    const shown = new Set(idsOfCategory(1))
    for (let id = 1; id < categoryForId.length; id++) {
      const alpha = solo.data[id * 4 + 3]
      expect(alpha).toBe(shown.has(id) ? 255 : 0)
    }
    // the shown ids keep their category color.
    for (const id of shown) {
      const [r, g, b] = CATEGORICAL_PALETTE[categoryForId[id] % CATEGORICAL_PALETTE.length]
      const o = id * 4
      expect([solo.data[o], solo.data[o + 1], solo.data[o + 2]]).toEqual([r, g, b])
    }
  })

  it('soloCategory overrides hiddenCategories (solo wins)', () => {
    // Solo cat 2 while also "hiding" cat 2 — solo takes precedence, so cat-2 ids are VISIBLE.
    const lut = buildIdColorLut(categoryForId, {
      soloCategory: 2,
      hiddenCategories: new Set([2]),
    })
    for (const id of idsOfCategory(2)) expect(lut.data[id * 4 + 3]).toBe(255)
    for (const id of idsOfCategory(0)) expect(lut.data[id * 4 + 3]).toBe(0)
  })

  it('is fully back-compat: no opts (or {palette} only) leaves every non-bg id opaque', () => {
    const a = buildIdColorLut(categoryForId)
    const b = buildIdColorLut(categoryForId, { palette: CATEGORICAL_PALETTE })
    expect(a.data).toEqual(b.data)
    for (let id = 1; id < categoryForId.length; id++) expect(a.data[id * 4 + 3]).toBe(255)
  })
})
