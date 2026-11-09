/**
 * txrresults view-model type pins (PROV-UR-3; ITEM-2) — the exact shapes
 * `lib/heatmap.ts` (ITEM-4), the results store (ITEM-5) and the components
 * (ITEM-6..9) derive from. Type-level (`expectTypeOf`): there is no runtime
 * surface in `types.ts` — the file is a pure types module, and a shape drift
 * fails this file at compile time.
 *
 * The provider-alignment block is the consumer side of the frozen engine
 * contract: the GENERATED `Txr*` wire types (provider-owned regen,
 * `execution-engine`) must keep assigning into the view model — in
 * particular `TxrTask` must stay exactly `TxrOutcomeKey` (CONS-UR-8's
 * enumerated vocabulary, resolved by the engine grow), so a regen drift
 * surfaces here instead of at a render site.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type {
  TxrCoverage,
  TxrPredictionMethod,
  TxrProbSource,
  TxrTask,
} from '@/api-client/types'
import type {
  TxrCompareReport,
  TxrHeatmapColumn,
  TxrHeatmapRow,
  TxrHeatmapView,
  TxrOutcomeKey,
  TxrSortKey,
} from './types'

describe('txrresults view-model types (PROV-UR-3)', () => {
  it('pins the outcome and sort key unions (DEC-4 / DEC-6)', () => {
    expectTypeOf<TxrOutcomeKey>().toEqualTypeOf<'pfs' | 'os' | 'response'>()
    expectTypeOf<TxrSortKey>().toEqualTypeOf<'average-desc' | 'disagree' | 'patient'>()
  })

  it('pins the heatmap column shape', () => {
    expectTypeOf<TxrHeatmapColumn>().toEqualTypeOf<{
      methodId: string
      label: string
      group: string
      groupLabel: string
      task: TxrOutcomeKey
      probSource: 'native' | 'recalibrated' | null
      coverage: { scored: number; eligible: number; fraction: number } | null
      values: (number | null)[]
      notes: (string | null)[]
      constantValue: number | null
    }>()
  })

  it('pins the heatmap row shape', () => {
    expectTypeOf<TxrHeatmapRow>().toEqualTypeOf<{
      patientId: string
      cells: (number | null)[]
      notes: (string | null)[]
      average: number | null
      spread: number | null
    }>()
  })

  it('pins the view model shape (the filtered/sorted projection + averageBy)', () => {
    expectTypeOf<TxrHeatmapView>().toEqualTypeOf<{
      columns: TxrHeatmapColumn[]
      rows: TxrHeatmapRow[]
      shownCount: number
      totalCount: number
      averageBy: 'provider' | 'recomputed'
    }>()
  })

  it('pins the compare-report shape (the board card numbers, DEC-7)', () => {
    expectTypeOf<TxrCompareReport>().toEqualTypeOf<{
      sharedTop: { patientId: string; value: number }[]
      mostDiffering: {
        patientId: string
        a: number | null
        b: number | null
        diffPercent: number
      }[]
      divergentCount: number
    }>()
  })

  it('binds the generated engine wire types into the view model (the contract check)', () => {
    // CONS-UR-8, resolved: the engine's task enum IS the view model's outcome
    // keys — a regen that changes the enum breaks this pin.
    expectTypeOf<TxrTask>().toEqualTypeOf<TxrOutcomeKey>()
    // The provider's per-method row assigns into the column shape
    // (prob_source 'none' maps to null in buildColumns — ITEM-4).
    expectTypeOf<TxrCoverage>().toMatchTypeOf<NonNullable<TxrHeatmapColumn['coverage']>>()
    expectTypeOf<Exclude<TxrProbSource, 'none'>>().toEqualTypeOf<
      NonNullable<TxrHeatmapColumn['probSource']>
    >()
    // `probabilities: number | null[]` / `notes: string | null[]` is the
    // SAME openapi-generator array-union artifact txrintake records at
    // DRIFT-1 ITEM-3 #3 (a `Vec<Option<T>>` emitted without parentheses);
    // the wire bytes are correct arrays. The view model declares the
    // intended `(T | null)[]` and the pin below asserts the generated
    // ARRAY arm assigns into it (the bare-number arm is the artifact the
    // provider regen owns; the type-level bridge lives in buildColumns,
    // ITEM-4 — same shape as txrintake's `toEngineTable` bridge).
    expectTypeOf<Extract<TxrPredictionMethod['probabilities'], null[]>>().toMatchTypeOf<
      TxrHeatmapColumn['values']
    >()
    expectTypeOf<Extract<TxrPredictionMethod['notes'], null[]>>().toMatchTypeOf<
      TxrHeatmapColumn['notes']
    >()
  })
})
