// @vitest-environment jsdom
/**
 * TEST-UL-11 — txrlist `useMethodRows` (PROV-UI-LIST-3; the mocked-ApiClient
 * behaviors of TEST-UL-4 land here — the hook is ITEM-5's fetch half of the
 * adapter, per DRIFT-1 ITEM-4 #4 and the TESTS.md ITEM-4 note; the adapter's
 * pure join is TEST-UL-3).
 *
 * Pinned behaviors:
 *
 * - one `MethodCatalogue.list` + one `MethodCatalogue.eligibility` call for
 *   a stable inventory KEY: the object a host rebuilds on every render (new
 *   identity, identical content) does NOT refetch ("same key → no refetch");
 * - a CONTENT change refetches both endpoints, reports `loading` in between
 *   and rebuilds the rows through `buildMethodRows`;
 * - a first-fetch failure surfaces `loading` → `error` (the thrown message,
 *   or the constant for a non-Error throw — the Datasets-store idiom);
 * - `refetch()` clears the error and retries both endpoints;
 * - unmounting with a request in flight: the cancelled effect never writes
 *   state (no setState-after-unmount warning).
 *
 * The ApiClient is mocked per the `Datasets.store` test precedent; the
 * fixtures are the provider's generated wire types, so a provider regen that
 * reshapes a payload breaks the typecheck here (DEC-11's mechanical move).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type {
  EligibilityResponse,
  InventoryEligibilityRequest,
  MethodEligibility,
  MethodListResponse,
  MethodSummary,
  Timing,
} from '@/api-client/types'
import { stableInventoryKey, useMethodRows } from './useMethodRows'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  eligibility: vi.fn(),
  estimate: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      list: api.list,
      eligibility: api.eligibility,
      estimate: api.estimate,
    },
  },
}))

const TIMING: Timing = { base_seconds_per_fold: 60, benchmarked_units: 2, quality: 'measured' }

/** A catalogue summary fixture; the interesting facts are the overrides. */
function summary(
  over: Partial<MethodSummary> & Pick<MethodSummary, 'id' | 'year' | 'language'>,
): MethodSummary {
  return {
    container: true,
    covariates: 'none',
    embeds_training_data: false,
    frozen_model: false,
    group: 'response-probability',
    group_label: 'Response probability',
    journal: 'J. Methods',
    marker_groups_required: [],
    markers: { kind: 'panel', count: 3 },
    min_draws: 3,
    needs_baseline: true,
    needs_detection_call: false,
    paper_doi: '10.1000/example',
    runnable: true,
    spec_status: 'shipped',
    tasks: ['response-probability'],
    timing: TIMING,
    uses_history: 'landmark',
    ...over,
  }
}

/** A per-method eligibility verdict fixture. */
function verdict(
  over: Partial<MethodEligibility> & Pick<MethodEligibility, 'id' | 'status'>,
): MethodEligibility {
  return {
    coverage: { eligible: 151, total: 151, fraction: 1 },
    estimate_quality: 'measured',
    estimated_seconds: 120,
    min_draws: { required: 3, met: 151, unmet_patients: 0 },
    missing_groups: [],
    missing_markers: [],
    reasons: [],
    ...over,
  }
}

/** The catalogue response the hook joins (one method in the fixture set). */
function listResponse(): MethodListResponse {
  return { methods: [summary({ id: 'direct-on', year: 2021, language: 'R' })], total: 1 }
}

/** The eligibility response for the fixture set (the can-run verdict). */
function eligibilityResponse(): EligibilityResponse {
  return {
    methods: [verdict({ id: 'direct-on', status: 'can_run' })],
    total_cannot: 0,
    total_fit: 1,
    total_some: 0,
    total_no_env: 0,
  }
}

/** A host-shaped analysis inventory (PROV-MC-5's InventoryEligibilityRequest). */
function inventory(
  over: Partial<InventoryEligibilityRequest> = {},
): InventoryEligibilityRequest {
  return {
    baseline_max_day: 0,
    covariates: [],
    decision_day: 56,
    markers: [
      {
        display_name: 'LDH',
        has_detection_companion: false,
        is_detection_call: false,
        key: 'ldh',
        n_patients_with_baseline: 151,
        n_patients_with_ontreatment: 151,
        n_patients_with_value: 151,
        standard_ids: [],
        unit_family: 'none',
      },
    ],
    patients: 151,
    ...over,
  }
}

/** A manually resolvable promise (the request stays in flight until told). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  api.list.mockReset()
  api.eligibility.mockReset()
  api.estimate.mockReset()
  api.list.mockResolvedValue(listResponse())
  api.eligibility.mockResolvedValue(eligibilityResponse())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMethodRows (TEST-UL-11)', () => {
  it('fetches list + eligibility once and joins the verdicts into rows', async () => {
    const inv = inventory()
    const { result } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv },
    })
    await act(async () => {})

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    // The full runnable catalogue (no query filters — D33, the shipped set is
    // the runnable one); the inventory is the request's tagged-union body.
    expect(api.list).toHaveBeenCalledWith({})
    expect(api.eligibility).toHaveBeenCalledWith({ inventory: inv })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]).toMatchObject({
      key: 'direct-on',
      name: 'direct-on',
      tag: 'Paper 2021, R',
      run: { status: 'can', headline: 'Can run', detail: 'all 151 patients' },
      timeText: 'about 2 min',
      action: { label: 'About' },
    })
  })

  it('does NOT refetch for a content-identical rebuilt inventory (stable key)', async () => {
    const { result, rerender } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv: inventory() },
    })
    await act(async () => {})
    expect(api.list).toHaveBeenCalledTimes(1)

    const rowsBefore = result.current.rows
    // The host's every-render rebuild: a NEW object, byte-identical content.
    rerender({ inv: inventory() })
    await act(async () => {})

    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    // Same key => the same state slot: no spin through loading, no row rebuild.
    expect(result.current.rows).toBe(rowsBefore)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('refetches both endpoints when the inventory CONTENT changes, loading in between', async () => {
    const { result, rerender } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv: inventory() },
    })
    await act(async () => {})
    expect(api.list).toHaveBeenCalledTimes(1)

    api.list.mockReset()
    api.eligibility.mockReset()
    const listPending = deferred<MethodListResponse>()
    const eligibilityPending = deferred<EligibilityResponse>()
    api.list.mockReturnValueOnce(listPending.promise)
    api.eligibility.mockReturnValueOnce(eligibilityPending.promise)

    rerender({ inv: inventory({ decision_day: 84 }) })

    expect(result.current.loading).toBe(true)
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledWith({ inventory: expect.objectContaining({ decision_day: 84 }) })

    await act(async () => {
      listPending.resolve(listResponse())
      eligibilityPending.resolve(eligibilityResponse())
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.rows).toHaveLength(1)
  })

  it('surfaces a first-fetch failure as error (loading -> error, no rows)', async () => {
    api.eligibility.mockRejectedValueOnce(new Error('eligibility exploded'))
    const { result } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv: inventory() },
    })
    await act(async () => {})

    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe('eligibility exploded')
    expect(result.current.rows).toEqual([])
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.eligibility).toHaveBeenCalledTimes(1)
  })

  it('falls back to the constant error line for a non-Error throw', async () => {
    api.list.mockRejectedValueOnce('nope')
    const { result } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv: inventory() },
    })
    await act(async () => {})

    expect(result.current.error).toBe('Failed to load methods')
    expect(result.current.loading).toBe(false)
  })

  it('refetch() clears the error and retries both endpoints', async () => {
    api.eligibility.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv: inventory() },
    })
    await act(async () => {})
    expect(result.current.error).toBe('boom')

    // The retry's request stays in flight so the loading transition is
    // observable (an instantly-resolved mock would land before the assert).
    const listPending = deferred<MethodListResponse>()
    const eligibilityPending = deferred<EligibilityResponse>()
    api.list.mockReturnValueOnce(listPending.promise)
    api.eligibility.mockReturnValueOnce(eligibilityPending.promise)

    await act(async () => {
      result.current.refetch()
    })
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.eligibility).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeNull()

    await act(async () => {
      listPending.resolve(listResponse())
      eligibilityPending.resolve(eligibilityResponse())
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.rows).toHaveLength(1)
  })

  it('never writes state after unmount with a request in flight', async () => {
    const listPending = deferred<MethodListResponse>()
    const eligibilityPending = deferred<EligibilityResponse>()
    api.list.mockReturnValue(listPending.promise)
    api.eligibility.mockReturnValue(eligibilityPending.promise)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(({ inv }) => useMethodRows(inv), {
      initialProps: { inv: inventory() },
    })
    unmount()

    await act(async () => {
      listPending.resolve(listResponse())
      eligibilityPending.resolve(eligibilityResponse())
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('stableInventoryKey: object key order is ignored, array order is content', () => {
    const inv = inventory()
    // Same content, a different textual key order (what a rebuilt literal can
    // produce); the hash must not change.
    const reordered = {
      patients: inv.patients,
      markers: inv.markers,
      decision_day: inv.decision_day,
      baseline_max_day: inv.baseline_max_day,
      covariates: inv.covariates,
    } as InventoryEligibilityRequest
    expect(stableInventoryKey(reordered)).toBe(stableInventoryKey(inv))

    // Array order is content — a per-patient draw list reordered is a real
    // payload difference (the hash is the refetch discriminator, and the
    // conservative direction is to refetch).
    const withPatientDraws = inventory({
      markers: [
        {
          ...inv.markers[0],
          per_patient: [
            { patient_key: 'p1', baseline_draws: 1, ontreatment_draws: 3 },
            { patient_key: 'p2', baseline_draws: 1, ontreatment_draws: 4 },
          ],
        },
      ],
    })
    const reversed = inventory({
      markers: [
        {
          ...inv.markers[0],
          per_patient: [
            { patient_key: 'p2', baseline_draws: 1, ontreatment_draws: 4 },
            { patient_key: 'p1', baseline_draws: 1, ontreatment_draws: 3 },
          ],
        },
      ],
    })
    expect(stableInventoryKey(withPatientDraws)).not.toBe(stableInventoryKey(reversed))
  })
})
