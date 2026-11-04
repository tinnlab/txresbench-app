/**
 * TEST-UL-2 — txrlist selection semantics (PROV-UI-LIST-2/4, INV-1).
 *
 * The ONE rule set the three boards share, as pure functions: a row is
 * selectable iff `!run.disabled`; the "Select all that can run" and the
 * screen-I section select-all are toggles (all when not all selected, none
 * when all are selected) over the non-disabled keys only; a disabled row's
 * key is never added by ANY helper and is never counted. The pinned
 * scenarios are the plan's examples:
 *
 * - EXAMPLE-UL-4: "CRC cohort, day 56" (11 rowKeys, 2 disabled) → the
 *   section select-all checks exactly the 9 eligible; "Lung pilot, day 42"
 *   (2 rowKeys, 1 disabled) checks exactly 1; each section's checkbox
 *   never touches the other section's rows.
 * - EXAMPLE-UL-8: 38 rows, 5 `cannot` → "Select all that can run" checks
 *   33 of 38; unchecking the last row leaves the empty selection (count 0,
 *   and the host's estimate hook shows "…" and issues no request — the
 *   selection being empty is this suite's pin; the hook is TEST-UL-7's).
 *
 * The helpers never mutate their input (every change returns a fresh set;
 * a no-op returns the same reference), and keys of rows currently filtered
 * out of the view stay in the selection — the run is the selection, not
 * the view (DEC-9; filters are host-owned and never prune it here).
 */
import { describe, expect, it } from 'vitest'
import {
  countSelected,
  toggle,
  toggleAll,
  toggleAllCanRun,
  toggleSection,
  type TxrSelectableRow,
} from './selection'

/** A row in the minimal selectable shape: `key` + the verdict's disabled flag. */
const row = (key: string, disabled = false): TxrSelectableRow => ({
  key,
  run: { disabled },
})

/** 38 E-screen rows, 5 `cannot` — the EXAMPLE-UL-8 shape. */
const example8 = [
  ...Array.from({ length: 33 }, (_, i) => row(`m${i + 1}`)),
  ...Array.from({ length: 5 }, (_, i) => row(`x${i + 1}`, true)),
]

/** The EXAMPLE-UL-4 two-section shape (11 with 2 disabled, 2 with 1 disabled). */
const crcRows = [
  ...Array.from({ length: 9 }, (_, i) => row(`crc${i + 1}`)),
  row('crc-d1', true),
  row('crc-d2', true),
]
const lungRows = [row('lung1'), row('lung-d1', true)]
const sections = [
  { key: 'run-crc', rowKeys: crcRows.map(r => r.key) },
  { key: 'run-lung', rowKeys: lungRows.map(r => r.key) },
]

describe('toggle', () => {
  it('adds an unchecked key and removes a checked one', () => {
    let sel = toggle(new Set(), row('a'))
    expect(sel).toEqual(new Set(['a']))
    sel = toggle(sel, row('b'))
    expect(sel).toEqual(new Set(['a', 'b']))
    sel = toggle(sel, row('a'))
    expect(sel).toEqual(new Set(['b']))
  })

  it('never adds a disabled row key and leaves the set untouched', () => {
    const sel = new Set(['keep'])
    const result = toggle(sel, row('x', true))
    expect(result).toBe(sel)
    expect(sel).toEqual(new Set(['keep']))
    expect(toggle(result, row('x', true)).has('x')).toBe(false)
  })

  it('returns a fresh set without mutating the input', () => {
    const input = new Set<string>()
    const result = toggle(input, row('a'))
    expect(result).not.toBe(input)
    expect(input).toEqual(new Set())
  })
})

describe('toggleAll (the shared engine)', () => {
  it('checks exactly the target keys that belong to non-disabled rows', () => {
    const rows = [row('a'), row('b', true), row('c')]
    const result = toggleAll(new Set(), ['a', 'b', 'c', 'ghost'], rows)
    expect(result).toEqual(new Set(['a', 'c']))
  })

  it('unchecks only the selected eligible keys and keeps everything else', () => {
    const rows = [row('a'), row('b'), row('c')]
    const all = new Set(['a', 'b', 'c', 'outside'])
    const result = toggleAll(all, ['a', 'b'], rows)
    expect(result).toEqual(new Set(['c', 'outside']))
  })

  it('toggles to ALL when only some of the targets are selected', () => {
    const rows = [row('a'), row('b'), row('c')]
    const result = toggleAll(new Set(['a']), ['a', 'b', 'c'], rows)
    expect(result).toEqual(new Set(['a', 'b', 'c']))
  })

  it('leaves the selection alone when no target is selectable', () => {
    const rows = [row('a', true), row('b', true)]
    const sel = new Set(['keep'])
    expect(toggleAll(sel, ['a', 'b'], rows)).toBe(sel)
    expect(toggleAll(new Set(), [], rows)).toEqual(new Set())
  })

  it('does not mutate the input', () => {
    const input = new Set(['a'])
    const result = toggleAll(input, ['a'], [row('a')])
    expect(result).not.toBe(input)
    expect(input).toEqual(new Set(['a']))
  })
})

describe('toggleAllCanRun (the boards\' "Select all that can run")', () => {
  it('checks exactly the 33 non-disabled of 38 rows (EXAMPLE-UL-8)', () => {
    const result = toggleAllCanRun(new Set(), example8)
    expect(result.size).toBe(33)
    for (const r of example8) {
      expect(result.has(r.key)).toBe(!r.run.disabled)
    }
  })

  it('unchecks all non-disabled rows when they are all selected', () => {
    const all = new Set(example8.filter(r => !r.run.disabled).map(r => r.key))
    const result = toggleAllCanRun(all, example8)
    expect(result).toEqual(new Set())
  })

  it('never removes a stale disabled key either (a host-held key is not this helper\'s)', () => {
    const all = new Set(example8.map(r => r.key))
    const result = toggleAllCanRun(all, example8)
    expect(result).toEqual(new Set(example8.filter(r => r.run.disabled).map(r => r.key)))
  })

  it('checks all when only a partial selection is present', () => {
    const result = toggleAllCanRun(new Set(['m1', 'm2']), example8)
    expect(result.size).toBe(33)
    expect(result.has('m1')).toBe(true)
    expect(result.has('x1')).toBe(false)
  })

  it('keeps keys of rows filtered out of the passed list (the view never prunes the run)', () => {
    const visible = example8.slice(0, 10)
    const result = toggleAllCanRun(new Set(['hidden-1']), visible)
    expect(result.has('hidden-1')).toBe(true)
    expect(result.has('hidden-2')).toBe(false)
  })
})

describe('toggleSection (the screen-I run-group select-all)', () => {
  it('checks exactly the 9 eligible of the first section (EXAMPLE-UL-4)', () => {
    const result = toggleSection(new Set(), sections[0], [...crcRows, ...lungRows])
    expect(result).toEqual(new Set(crcRows.filter(r => !r.run.disabled).map(r => r.key)))
  })

  it('checks exactly the 1 eligible of the second section, leaving the first untouched', () => {
    const alreadyCrc = new Set(crcRows.filter(r => !r.run.disabled).map(r => r.key))
    const result = toggleSection(alreadyCrc, sections[1], [...crcRows, ...lungRows])
    expect(result).toEqual(new Set([...alreadyCrc, 'lung1']))
  })

  it('removes the section\'s eligible rows when they are all selected', () => {
    const all = new Set(crcRows.map(r => r.key))
    const result = toggleSection(all, sections[0], crcRows)
    expect(result).toEqual(new Set(['crc-d1', 'crc-d2']))
  })

  it('never selects the section\'s disabled rows and ignores keys without a row', () => {
    const result = toggleSection(new Set(), { rowKeys: ['crc-d1', 'ghost'] }, crcRows)
    expect(result).toEqual(new Set())
  })

  it('does not mutate the input', () => {
    const input = new Set<string>()
    const result = toggleSection(input, sections[0], [...crcRows, ...lungRows])
    expect(result).not.toBe(input)
    expect(input).toEqual(new Set())
  })
})

describe('countSelected', () => {
  it('counts only non-disabled selected rows', () => {
    expect(countSelected(new Set(['m1', 'm2']), example8)).toBe(2)
    expect(countSelected(new Set(['m1', 'x1']), example8)).toBe(1)
    expect(countSelected(new Set(['x1', 'x2']), example8)).toBe(0)
  })

  it('ignores keys with no row in the passed list', () => {
    expect(countSelected(new Set(['m1', 'gone']), example8)).toBe(1)
  })

  it('reads 0 for the empty selection (EXAMPLE-UL-8: "0 methods selected")', () => {
    expect(countSelected(new Set(), example8)).toBe(0)
  })
})

describe('the disabled-key invariant (TEST-UL-2: never added by ANY helper)', () => {
  it('holds for every helper over the example shapes', () => {
    const allRows = [...crcRows, ...lungRows]
    const disabled = new Set(allRows.filter(r => r.run.disabled).map(r => r.key))
    const scenarios: ReadonlySet<string>[] = [
      toggle(new Set(['m1']), allRows[0]),
      toggle(new Set(), row('d', true)),
      toggleAll(new Set(), allRows.map(r => r.key), allRows),
      toggleAllCanRun(new Set(), allRows),
      toggleSection(new Set(), { rowKeys: allRows.map(r => r.key) }, allRows),
      toggleSection(new Set(['lung1']), sections[0], allRows),
    ]
    for (const sel of scenarios) {
      for (const key of disabled) {
        expect(sel.has(key)).toBe(false)
      }
    }
  })
})
