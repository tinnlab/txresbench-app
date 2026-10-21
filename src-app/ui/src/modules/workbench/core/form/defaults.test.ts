// W6 unit test — data-driven param defaults + the MAD helper (ITEM-64, TEST-534). The
// resolver derives a field default from a robust `DataSummary` of the selected input
// (additive to the params contract). Runs under node:test over the real stats + the real
// column resolver (a fixture ctx), no mocking of the boundary under test.
//
// ITEM-39 removed this file's fifth case (live threshold feedback → a `summarize`-derived
// affected count): it exercised the multi-group `summarize` evaluator, which is deleted
// with the dimension primitives that were its only consumer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFixtureCtx } from '../columns/fixtureCtx.ts'
import {
  statsOf,
  columnStats,
  buildDataSummary,
  madThreshold,
  madResolver,
  resolveDataDrivenDefault,
} from './defaults.ts'

test('TEST-534: statsOf computes median + MAD; empty → NaN', () => {
  const s = statsOf([1, 2, 3, 4, 5])
  assert.equal(s.n, 5)
  assert.equal(s.median, 3)
  // |dev| = [2,1,0,1,2] → sorted [0,1,1,2,2] → median 1.
  assert.equal(s.mad, 1)
  assert.equal(statsOf([]).n, 0)
  assert.ok(Number.isNaN(statsOf([]).median))
})

test('TEST-534: madThreshold is median ± nMads·MAD (the sc-best-practices QC rule)', () => {
  const stats = { n: 5, median: 100, mad: 10 }
  assert.equal(madThreshold(stats, 3, 'lower'), 70)
  assert.equal(madThreshold(stats, 5, 'upper'), 150)
  assert.ok(Number.isNaN(madThreshold({ n: 0, median: Number.NaN, mad: Number.NaN }, 3, 'lower')))
})

test('TEST-534: columnStats over a ctx skips NA/non-finite cells', () => {
  const ctx = makeFixtureCtx({
    n: 6,
    positionAnnotations: { n_genes: { values: [10, 20, 30, 40, 50, 0], na: [false, false, false, false, false, true] } },
  })
  const s = columnStats(ctx, { col: 'n_genes' })
  assert.equal(s.n, 5) // the NA cell dropped
  assert.equal(s.median, 30)
})

test('TEST-534: a data-driven default resolver derives a field default from the summary', () => {
  const ctx = makeFixtureCtx({
    n: 5,
    positionAnnotations: { n_genes_by_counts: { values: [100, 200, 300, 400, 500] } },
  })
  const summary = buildDataSummary(ctx, [{ key: 'n_genes', ref: { col: 'n_genes_by_counts' } }])
  // median 300, MAD 100 → 3 MADs lower = 0 (clamped ≥ 0), rounded.
  const lower = madResolver('n_genes', 3, 'lower', { round: true, clampMin: 0 })
  assert.equal(resolveDataDrivenDefault(lower, summary), 0)
  // 1 MAD lower = 200.
  const oneMad = madResolver('n_genes', 1, 'lower', { round: true })
  assert.equal(resolveDataDrivenDefault(oneMad, summary), 200)
  // a resolver over an ABSENT column declines → undefined (falls back to static default).
  assert.equal(resolveDataDrivenDefault(madResolver('missing', 3, 'lower'), summary), undefined)
})
