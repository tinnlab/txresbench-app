// TEST-W8-preview (ITEM-65) — the HONEST param→outcome preview classifier. A param the
// processor DECLARES to be a cap on an input axis (`capsAxis`), against a known resident
// length for that axis, estimates a REAL kept count (min(cap, available)); everything else
// DEFERS ("computes on run") with an optional direction arrow taken from the field's own
// doc — never a fabricated number.
//
// E4/E5 (DOMAIN_AUDIT): the classifier used to GUESS caps from param NAMES via two regex
// tables of single-cell vocabulary, and label the outcome "cells kept"/"features kept".

import { describe, expect, it } from 'vitest'
import type { ParamField } from '@/modules/workbench/core'
import {
  buildResidentInput,
  directionFromDoc,
  previewParamOutcomes,
  residentInputForSelection,
} from './paramPreview'

const num = (id: string, doc?: string): ParamField => ({ id, type: 'number', doc }) as ParamField
const cap = (id: string, axis: string): ParamField => ({ id, type: 'number', capsAxis: axis }) as ParamField
const enumField = (id: string): ParamField => ({ id, type: 'enum', options: ['a', 'b'] }) as ParamField

describe('directionFromDoc — author-sourced hint (no invention)', () => {
  it('reads a monotone comparative from the doc', () => {
    expect(directionFromDoc('higher = finer clusters')).toBe('up')
    expect(directionFromDoc('lower keeps fewer cells')).toBe('down')
  })
  it('returns undefined when the doc states no relationship', () => {
    expect(directionFromDoc('the clustering resolution')).toBeUndefined()
    expect(directionFromDoc(undefined)).toBeUndefined()
  })
})

describe('previewParamOutcomes — estimate vs deferred (TEST-W8-preview)', () => {
  it('ESTIMATES a real kept count for a DECLARED cap against its axis length', () => {
    const out = previewParamOutcomes([cap('max_rows', 'rows')], { max_rows: 3000 }, { rows: 5000 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ field: 'max_rows', metric: 'rows kept', kind: 'estimate', value: 3000 })
  })

  it('labels the outcome with the PROCESSOR’s axis name, whatever it is (E4)', () => {
    const out = previewParamOutcomes([cap('tile_cap', 'tiles')], { tile_cap: 4000 }, { tiles: 2000 })
    expect(out[0]).toMatchObject({ metric: 'tiles kept', kind: 'estimate', value: 2000 })
  })

  it('DEFERS a declared cap whose axis length is unknown (no fake number)', () => {
    const out = previewParamOutcomes([cap('max_rows', 'rows')], { max_rows: 3000 }, {})
    expect(out[0]).toMatchObject({ field: 'max_rows', kind: 'deferred', reason: 'computes on run' })
  })

  it('DEFERS an UNDECLARED param even when its NAME looks like a cap (E4)', () => {
    const out = previewParamOutcomes([num('max_cells')], { max_cells: 3000 }, { cells: 5000 })
    expect(out[0]).toMatchObject({ field: 'max_cells', metric: 'max_cells', kind: 'deferred' })
  })

  it('DEFERS a non-cap numeric param (resolution → clusters needs compute) with a doc direction', () => {
    const out = previewParamOutcomes([num('resolution', 'higher = finer clusters')], { resolution: 0.8 }, { rows: 5000 })
    expect(out[0]).toEqual({ field: 'resolution', metric: 'resolution', kind: 'deferred', reason: 'computes on run', direction: 'up' })
  })

  it('ignores non-number fields and unset params', () => {
    const out = previewParamOutcomes([enumField('method'), num('resolution')], { method: 'wilcoxon' })
    expect(out).toEqual([]) // enum skipped; resolution unset → skipped
  })
})

// ── INV-3 at the run panel's resident-axis derivation ──────────────────────────────────
//
// An axis IS its key artifact; the NAME is a label, never a key. The DISCRIMINATING fixture
// is TWO AXES SHARING A LABEL with different lengths — a project whose labels happen to be
// unique produces the same output whether the derivation keys on identity or on the name,
// which is why the `Math.max` fold survived the wire and the server-side derivation both
// being fixed.
//
// `residentInputForSelection` is the panel's whole derivation, so a `Math.max` reintroduced
// at that site fails here.
describe('residentInputForSelection — no arithmetic fold across axes (INV-3)', () => {
  interface Row {
    id: string
    datatype: string
    length: number
  }
  const row = (id: string, datatype: string, length: number): Row => ({ id, datatype, length })

  /** Two inputs, each declaring an axis LABELLED `entries` at dim 0, with DIFFERENT lengths.
   *  A length difference PROVES the two are different axes (identity fixes cardinality), so
   *  `max(10, 20)` is a number neither axis has. */
  function selection(rows: Record<string, Row[]>, params: Record<string, unknown>) {
    return {
      fields: [{ id: 'a' }, { id: 'b' }],
      params,
      rowsByField: rows,
      axesOf: (datatype: string) => (datatype === 'two-dim' ? [{ name: 'entries' }, { name: 'targets' }] : [{ name: 'entries' }]),
      dimsOf: (r: Row) => (r.datatype === 'two-dim' ? [r.length, 4] : [r.length]),
    }
  }

  it('REFUSES a label two selected inputs disagree about, instead of folding with max', () => {
    const resident = residentInputForSelection(
      selection({ a: [row('r1', 'table', 10)], b: [row('r2', 'table', 20)] }, { a: 'r1', b: 'r2' }),
    )
    // The fabrication: `Math.max` answers 20 — the cardinality of ONE of two unrelated axes,
    // reported as the resident length of a label that names both.
    expect(resident.entries).toBeUndefined()
    expect(resident.entries).not.toBe(20)
    // PRESENT-but-unknown, so a refusal is distinguishable from an axis nothing mentioned.
    expect('entries' in resident).toBe(true)
    expect('targets' in resident).toBe(false)
  })

  it('makes the cap preview DEFER on that refusal rather than estimate against an invented length', () => {
    const resident = residentInputForSelection(
      selection({ a: [row('r1', 'table', 10)], b: [row('r2', 'table', 20)] }, { a: 'r1', b: 'r2' }),
    )
    const out = previewParamOutcomes([cap('max_entries', 'entries')], { max_entries: 15 }, resident)
    expect(out[0]).toMatchObject({ field: 'max_entries', kind: 'deferred', reason: 'computes on run' })
    // …and specifically NOT the number the fold produced (min(15, 20) = 15).
    expect(out[0]).not.toHaveProperty('value')
  })

  it('reports the length when the selected inputs AGREE (one axis, one number)', () => {
    const resident = residentInputForSelection(
      selection({ a: [row('r1', 'table', 10)], b: [row('r2', 'table', 10)] }, { a: 'r1', b: 'r2' }),
    )
    expect(resident.entries).toBe(10)
    const out = previewParamOutcomes([cap('max_entries', 'entries')], { max_entries: 4 }, resident)
    expect(out[0]).toMatchObject({ kind: 'estimate', value: 4, metric: 'entries kept' })
  })

  it('keys by the DECLARED label per dim POSITION, and skips a position declaring no axis', () => {
    const resident = residentInputForSelection(
      selection({ a: [row('r1', 'two-dim', 30)], b: [] }, { a: 'r1' }),
    )
    expect(resident).toEqual({ entries: 30, targets: 4 })
    // A datatype declaring fewer axes than the row has dims contributes only what it declares.
    const partial = residentInputForSelection({
      fields: [{ id: 'a' }],
      params: { a: 'r1' },
      rowsByField: { a: [row('r1', 'table', 12)] },
      axesOf: () => [],
      dimsOf: () => [12, 5],
    })
    expect(partial).toEqual({})
  })

  it('ignores a field with no selection and a selection resolving to no row', () => {
    expect(
      residentInputForSelection(selection({ a: [row('r1', 'table', 10)], b: [] }, { a: 'nope' })),
    ).toEqual({})
    expect(residentInputForSelection(selection({}, {}))).toEqual({})
  })
})

describe('buildResidentInput — the fold itself', () => {
  it('agreeing contributions collapse to their one length; disagreeing ones refuse', () => {
    expect(buildResidentInput([{ axis: 'x', length: 7 }, { axis: 'x', length: 7 }])).toEqual({ x: 7 })
    const refused = buildResidentInput([{ axis: 'x', length: 7 }, { axis: 'x', length: 9 }])
    expect(refused.x).toBeUndefined()
    expect('x' in refused).toBe(true)
  })

  it('never reports a value no contribution declared (no max, no sum, no count)', () => {
    const three = buildResidentInput([
      { axis: 'x', length: 1 },
      { axis: 'x', length: 2 },
      { axis: 'x', length: 3 },
    ])
    expect(three.x).toBeUndefined()
    // one axis's own declared length, or nothing — the same rule `derive_axes` holds to.
    expect(buildResidentInput([{ axis: 'y', length: 5 }])).toEqual({ y: 5 })
  })
})
