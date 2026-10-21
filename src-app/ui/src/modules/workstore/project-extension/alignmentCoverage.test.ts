// TEST-29 (visualize-pane ITEM-21) — the A3 EXIT METRIC.
//
// What it asserts is mostly about the two ways a progress indicator stops being read: a
// denominator nobody can ever reach (which makes 100% impossible), and a percentage that
// rounds UP to 100% while the marker is still on screen. Both turn a migration signal into
// decoration, which is the failure the metric exists to prevent — so both are pinned.
//
// No domain vocabulary in the fixtures.

import { describe, expect, it } from 'vitest'

import { alignmentCoverage, alignmentCoverageLabel } from './alignmentCoverage'

const onAxis = (alignedTo?: string) => ({
  structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', ...(alignedTo ? { aligned_to: alignedTo } : {}) },
})
/** A KEY artifact — it IS the row space, so the alignment question does not apply to it. */
const keyArtifact = () => ({
  structure: { encoding: 'zarr_v3', kind: 'table', axis: 'entities', key: 'values', key_sequence_digest: 'd' },
  meta: { is_axis_index: true },
})
/** An artifact that sits on no axis at all — an image, a report, a bundle. */
const offAxis = () => ({ structure: { encoding: 'zarr_v3', kind: 'blob' } })

describe('alignmentCoverage', () => {
  it('counts declared over the artifacts the question APPLIES to', () => {
    const got = alignmentCoverage([onAxis('d'), onAxis(), onAxis('d'), onAxis()])
    expect(got).toEqual({ declared: 2, total: 4, ratio: 0.5 })
  })

  it('excludes a KEY artifact — otherwise 100% is unreachable', () => {
    // A key artifact IS the row space; asking it to declare alignment to itself is not a step
    // anybody can take, so counting it would put a permanent floor under the number and the
    // indicator would never reach its own end state.
    const got = alignmentCoverage([keyArtifact(), onAxis('d')])
    expect(got.total).toBe(1)
    expect(got.ratio).toBe(1)
  })

  it('excludes an artifact that sits on no axis', () => {
    expect(alignmentCoverage([offAxis(), onAxis('d')]).total).toBe(1)
  })

  it('is ABSENT, not zero, when the question applies to nothing', () => {
    // A project with nothing on an axis has not failed to migrate anything, and a tile reading
    // "0%" about it would be a reproach for nothing.
    expect(alignmentCoverage([]).ratio).toBeNull()
    expect(alignmentCoverage([offAxis(), keyArtifact()]).ratio).toBeNull()
  })

  it("reads 0% on today's wholly-undeclared project — the state the marker is about", () => {
    // ITEM-20 records that today every project is entirely A3, so this is the reading the
    // indicator has to be able to give, and it must be distinguishable from "not applicable".
    const got = alignmentCoverage([onAxis(), onAxis()])
    expect(got.ratio).toBe(0)
    expect(alignmentCoverageLabel(got)).toBe('0% · 0 of 2')
  })

  it('MOVES when a declaring artifact is added', () => {
    const before = alignmentCoverage([onAxis(), onAxis()])
    const after = alignmentCoverage([onAxis(), onAxis(), onAxis('d')])
    expect(after.ratio!).toBeGreaterThan(before.ratio!)
  })
})

describe('alignmentCoverageLabel', () => {
  it('never rounds UP to 100% while anything is still undeclared', () => {
    // The one rounding error that would matter: claiming the migration is over while the marker
    // is still on screen makes the two surfaces contradict each other.
    const nearly = alignmentCoverage([...Array.from({ length: 999 }, () => onAxis('d')), onAxis()])
    expect(alignmentCoverageLabel(nearly).startsWith('99%')).toBe(true)
  })

  it('reads 100% only when every applicable artifact declares', () => {
    expect(alignmentCoverageLabel(alignmentCoverage([onAxis('d'), onAxis('d')]))).toBe('100% · 2 of 2')
  })

  it('says nothing at all when the metric does not apply', () => {
    expect(alignmentCoverageLabel(alignmentCoverage([]))).toBe('')
  })
})
