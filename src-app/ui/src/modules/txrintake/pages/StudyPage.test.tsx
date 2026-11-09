// @vitest-environment jsdom
/**
 * ITEM-5 page tests (`pages/StudyPage.tsx`): the question groups render with
 * the board copy (disease/treatment/outcome/marker groups/schedule), every
 * answer change writes the store (and the last-draw answer ALSO writes the
 * engine's decision day — DEC-5), the panel renders the live fit count + the
 * descriptive sentence + the excluded list through the shared formatters,
 * the board clip shows EXCLUDED_LIST_LIMIT rows with the truthful
 * "Show all N", and Continue/Skip navigate the intent-aware way.
 *
 * The eligibility + markers calls are mocked; the store is the real
 * TxrIntake store (reset per test); the reason lines run through the REAL
 * txrlist formatter (the CONS-UI-INTAKE-9 surface). Real timers: the panel's
 * 200 ms debounce is tiny, and `waitFor` reads the settled state.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { EligibilityResponse, MarkerGroup } from '@/api-client/types'
import { StudyPage } from './StudyPage'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { EXCLUDED_LIST_LIMIT } from '../lib/format'
import { __resetFetchCacheForTests } from '../data/fetchCache'

// jsdom has no working PointerEvent constructor; Base UI's controls (the kit
// Checkbox, the Select popover) construct one on pointer interaction, which
// would throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in for the pointer-event interface.
{
  const w = window as unknown as {
    PointerEvent?: new (type: string, init?: MouseEventInit) => MouseEvent
  }
  try {
    void new (w.PointerEvent as new (type: string, init?: MouseEventInit) => MouseEvent)('probe')
  } catch {
    w.PointerEvent = class extends MouseEvent {}
  }
}

const api = vi.hoisted(() => ({
  eligibility: vi.fn(),
  markers: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      eligibility: api.eligibility,
      markers: api.markers,
    },
  },
}))

const GROUPS: MarkerGroup[] = [
  { id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' },
  { id: 'counts', display_name: 'Blood counts (platelets, haemoglobin)' },
  { id: 'ldh', display_name: 'LDH' },
]

const CANNOT = 13
const SOME = 4
const TOTAL = 39
const CAN_RUN = TOTAL - CANNOT - SOME

function eligibilityResponse(): EligibilityResponse {
  const methods: EligibilityResponse['methods'] = [
    {
      id: 'm-fit',
      status: 'can_run',
      reasons: [],
      coverage: { eligible: 1, total: 1, fraction: 1 },
      min_draws: { required: 1, met: 1, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    },
    {
      id: 'dynforest',
      status: 'cannot_run',
      reasons: [{ code: 'MIN_DRAWS_UNMET' }],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      min_draws: { required: 3, met: 0, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    },
    {
      id: 'ki67-two-week-four-group',
      status: 'cannot_run',
      reasons: [{ code: 'REQUIRED_MARKER_MISSING' }],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      min_draws: { required: 1, met: 0, unmet_patients: 0 },
      missing_markers: [
        { id: 'ki67', id_system: 'other', display_name: 'Ki-67', group_id: 'other' },
      ],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    },
  ]
  for (let i = 0; i < CANNOT - 2; i += 1) {
    methods.push({
      id: `left-out-${i}`,
      status: 'cannot_run',
      reasons: [{ code: 'MIN_DRAWS_UNMET' }],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      min_draws: { required: 3, met: 0, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    })
  }
  for (let i = 0; i < SOME; i += 1) {
    methods.push({
      id: `some-${i}`,
      status: 'can_run_some',
      reasons: [],
      coverage: { eligible: 1, total: 1, fraction: 1 },
      min_draws: { required: 1, met: 1, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    })
  }
  for (let i = 0; i < CAN_RUN - 1; i += 1) {
    methods.push({
      id: `fit-${i}`,
      status: 'can_run',
      reasons: [],
      coverage: { eligible: 1, total: 1, fraction: 1 },
      min_draws: { required: 1, met: 1, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    })
  }
  return {
    methods,
    total_fit: CAN_RUN,
    total_some: SOME,
    total_cannot: CANNOT,
    total_no_env: 0,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderStudy() {
  return render(
    <MemoryRouter initialEntries={['/study']}>
      <StudyPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const routeAt = () => screen.getByTestId('route-location').textContent
const store = () => useTxrIntakeStore.getState()

beforeEach(() => {
  api.eligibility.mockReset()
  api.markers.mockReset()
  api.markers.mockResolvedValue({ groups: GROUPS, markers: [] })
  api.eligibility.mockResolvedValue(eligibilityResponse())
  window.localStorage.clear()
  store().reset()
  // ITEM-10: the vocabulary hook's module-level cache is one per-session
  // key — a settled value must not leak into the failure test below.
  __resetFetchCacheForTests()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Answer the page's first question (the group checkbox) so the panel
 *  renders its counts (R2-1: no answer → the invite line, no request). */
async function answerFirst(selector: string) {
  await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
  fireEvent.click(screen.getByTestId(selector))
}

describe('StudyPage (screen B, ITEM-5)', () => {
  it('renders the question groups with the board copy, then the panel from live data', async () => {
    renderStudy()
    expect(screen.getByText('Tell us about your study')).toBeTruthy()
    expect(screen.getByLabelText('Disease')).toBeTruthy()
    expect(screen.getByLabelText('Treatment')).toBeTruthy()
    expect(screen.getByText('Will the treatment work? (yes or no)')).toBeTruthy()
    expect(screen.getByText('Chance of response')).toBeTruthy()
    expect(screen.getByText('Risk of progression or death by a day')).toBeTruthy()
    expect(screen.getByText('Risk over time as new draws arrive')).toBeTruthy()
    expect(screen.getByText('Continue to the files')).toBeTruthy()
    expect(screen.getByText('Skip the questions')).toBeTruthy()

    // The marker groups arrive from the vocabulary fetch (CONS-UI-INTAKE-1).
    expect(await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })).toBeTruthy()
    expect(
      screen.getByRole('checkbox', { name: 'Blood counts (platelets, haemoglobin)' }),
    ).toBeTruthy()
    expect(screen.getByLabelText('Before treatment')).toBeTruthy()
    expect(screen.getByLabelText('Draws during treatment')).toBeTruthy()
    expect(screen.getByLabelText('Last draw you will use')).toBeTruthy()
  })

  it('before ANY answer the panel says what to do, never a count (R2-1)', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    const panel = screen.getByTestId('txr-intake-panel')
    expect(within(panel).queryByTestId('txr-intake-panel-fit-count')).toBeNull()
    expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
      'Answer the questions above to see which methods fit your study.',
    )
    expect(within(panel).getByText('Methods are left out')).toBeTruthy()
    expect(within(panel).queryByTestId('txr-intake-panel-no-env')).toBeNull()
    expect(api.eligibility).not.toHaveBeenCalled()
  })

  it('renders the live panel: fit count, descriptive sentence, excluded reasons', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    await waitFor(() => {
      expect(screen.getByText(`${CAN_RUN + SOME}`)).toBeTruthy()
    })
    expect(screen.getByText(`of ${TOTAL} methods fit`)).toBeTruthy()
    expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    expect(screen.getByText(`${SOME} can run for some patients`)).toBeTruthy()
    const excluded = within(screen.getByTestId('txr-intake-panel-excluded'))
    expect(excluded.getByText('dynforest')).toBeTruthy()
    expect(excluded.getAllByText('needs 3 or more draws').length).toBeGreaterThan(0)
    expect(excluded.getByText('ki67-two-week-four-group')).toBeTruthy()
    expect(excluded.getByText('needs Ki-67, not in your file')).toBeTruthy()
  })

  it('an answer change re-runs the eligibility (debounced) and writes the store', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    api.eligibility.mockClear()

    // A quick burst: three answer changes inside one debounce window.
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    fireEvent.click(screen.getByTestId('txr-intake-study-outcome-progression-by-day'))
    fireEvent.click(screen.getByTestId('txr-intake-study-outcome-binary-response'))
    expect(store().study.markerGroups?.ctdna).toBe(true)
    expect(store().study.outcome).toBe('binary-response')

    await waitFor(() => {
      expect(api.eligibility).toHaveBeenCalledTimes(1)
    })
    expect(api.eligibility).toHaveBeenCalledWith({
      preview: expect.objectContaining({
        marker_groups: expect.objectContaining({ ctdna: true }),
      }),
    })
  })

  it('the last-draw answer also writes the engine decision day (DEC-5)', async () => {
    renderStudy()
    const trigger = screen.getByTestId('txr-intake-study-last-draw')
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)
    const option = await screen.findByTestId('txr-intake-study-last-draw-opt-84')
    // Base UI commits a mouse selection only after a pointerdown on the item
    // (a bare synthetic click is rejected as an invalid mouse click) — the
    // real mouse sequence: pointerdown, then click (detail 1).
    fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' })
    fireEvent.click(option, { detail: 1 })

    await waitFor(() => {
      expect(store().study.lastDrawDay).toBe(84)
    })
    expect(store().parameters.decision_day).toBe(84)
    await waitFor(() => {
      expect(api.eligibility).toHaveBeenCalledWith({
        preview: expect.objectContaining({ last_draw_day: 84 }),
      })
    })
  })

  it('Continue and Skip both take the intent-aware next screen', async () => {
    renderStudy()
    fireEvent.click(screen.getByTestId('txr-intake-study-continue'))
    expect(routeAt()).toBe('/files')
    act(() => store().setIntent('pretrained'))
    fireEvent.click(screen.getByTestId('txr-intake-study-skip'))
    expect(routeAt()).toBe('/predict-files')
  })

  it('See example files goes to the files screen of the current mode', async () => {
    renderStudy()
    fireEvent.click(screen.getByText('See example files'))
    expect(routeAt()).toBe('/files')
    act(() => store().setIntent('reuse'))
    fireEvent.click(screen.getByText('See example files'))
    expect(routeAt()).toBe('/predict-files')
  })

  it('clips the excluded list at the board limit with the truthful Show all N', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    })
    const panel = () => screen.getByTestId('txr-intake-panel-excluded')
    expect(panel().querySelectorAll('li').length).toBe(EXCLUDED_LIST_LIMIT)
    expect(screen.getByText(`Show all ${CANNOT}`)).toBeTruthy()

    fireEvent.click(screen.getByTestId('txr-intake-excluded-show-all'))
    expect(panel().querySelectorAll('li').length).toBe(CANNOT)
    expect(screen.getByText('Show fewer')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-excluded-show-all'))
    expect(panel().querySelectorAll('li').length).toBe(EXCLUDED_LIST_LIMIT)
  })

  it('shows the skeleton until the marker groups land, and a failure line when they do not', async () => {
    let resolveMarkers!: (value: { groups: MarkerGroup[]; markers: unknown[] }) => void
    api.markers.mockImplementationOnce(
      () => new Promise<{ groups: MarkerGroup[]; markers: unknown[] }>(r => (resolveMarkers = r)),
    )
    renderStudy()
    // Still loading: no checkbox yet (the groups fetch is in flight).
    expect(screen.queryByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })).toBeNull()

    resolveMarkers({ groups: GROUPS, markers: [] })
    expect(await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })).toBeTruthy()

    // A failing vocabulary fetch surfaces one honest error line (the panel
    // still renders its own loading state — the two fetches are separate).
    // ITEM-10: within one session the settled vocabulary is served from the
    // stable-key cache (never re-fetched), so the failure arm runs on a
    // fresh key space — the same semantics the hook tests pin.
    cleanup()
    __resetFetchCacheForTests()
    api.markers.mockRejectedValueOnce(new Error('markers down'))
    renderStudy()
    expect(await screen.findByText('markers down')).toBeTruthy()
  })
})


describe('ITEM-6 S1/S2/S4 — the panel spacing, the id wrapping, the flush Show all link', () => {
  it('the panel headline keeps a space between the number and "of" (S1)', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
        `${CAN_RUN + SOME} of ${TOTAL} methods fit`,
      )
    })
  })

  it('excluded ids break at hyphens, never mid-word (S2)', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    })
    const id = screen.getByText('ki67-two-week-four-group')
    expect(id.style.wordBreak).toBe('normal')
    expect(id.style.overflowWrap).toBe('anywhere')
    expect(id.style.minWidth).toBe('210px')
  })

  it('the Show all link renders flush (no kit padding — S4)', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText(`Show all ${CANNOT}`)).toBeTruthy()
    })
    const showAll = screen.getByTestId('txr-intake-excluded-show-all') as HTMLElement
    expect(showAll.style.padding).toBe('0px')
  })
})

describe('R2-1 — the environment fact separated from the answer causes', () => {
  const ENV = 2
  function eligibilityWithEnv(): EligibilityResponse {
    const base = eligibilityResponse()
    base.total_no_env = ENV
    const envMethods = [
      {
        id: 'asm-best-change-rule',
        status: 'cannot_run' as const,
        reasons: [
          { code: 'ENV_IMAGE_MISSING' as const },
          { code: 'MARKER_GROUP_MISSING' as const },
        ],
        coverage: { eligible: 0, total: 1, fraction: 0 },
        min_draws: { required: 1, met: 0, unmet_patients: 0 },
        missing_markers: [],
        missing_groups: [{ group_id: 'methylation-sequencing', display_name: 'Methylation' }],
        estimated_seconds: 0,
        estimate_quality: 'estimate' as const,
      },
      {
        id: 'env-only-method',
        status: 'cannot_run' as const,
        reasons: [{ code: 'ENV_IMAGE_MISSING' as const }],
        coverage: { eligible: 1, total: 1, fraction: 1 },
        min_draws: { required: 1, met: 1, unmet_patients: 0 },
        missing_markers: [],
        missing_groups: [],
        estimated_seconds: 0,
        estimate_quality: 'estimate' as const,
      },
    ]
    base.methods = [...envMethods, ...base.methods]
    base.total_cannot = CANNOT + ENV
    return base
  }

  it('the count reacts to the answers with the env fact stripped, and the env line counts it', async () => {
    api.eligibility.mockResolvedValue(eligibilityWithEnv())
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      // Env methods answer-fit: 39 base + 2 env methods = 41; the headline
      // is the board's inclusive count (runnable 26 + the 1 env-only answer
      // fitter — the 13 answer left-outs and the 2 env methods are their
      // own lines).
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
        `${TOTAL - CANNOT + 1} of ${TOTAL + ENV} methods fit`,
      )
    })
    // The env sentence is the list's own line (one vocabulary, R2-1's
    // "can't run yet" separation).
    expect(screen.getByTestId('txr-intake-panel-no-env').textContent).toBe(
      `${ENV} of ${TOTAL + ENV} methods have no published environment and can't start.`,
    )
    // "Left out" counts the ANSWER causes only; the env rows are not in the
    // list (their cause is the env line).
    expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    const excluded = within(screen.getByTestId('txr-intake-panel-excluded'))
    expect(excluded.queryByText('asm-best-change-rule')).toBeNull()
    expect(excluded.queryByText('env-only-method')).toBeNull()
    expect(excluded.getAllByText('needs 3 or more draws').length).toBeGreaterThan(0)
  })

  it('ticking a marker group that excludes runnable methods moves the count', async () => {
    // The fixture's answer-caused left-outs drop the count as the answers
    // change (the count reacts to answers, not to the env overlay).
    const first = eligibilityResponse()
    const answered = eligibilityResponse()
    answered.total_fit = CAN_RUN - 2
    answered.total_cannot = CANNOT + 2
    api.eligibility
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(answered)
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toContain(
        `of ${TOTAL} methods fit`,
      )
    })
    expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
      `${TOTAL - CANNOT} of ${TOTAL} methods fit`,
    )
    fireEvent.click(screen.getByTestId('txr-intake-study-outcome-progression-by-day'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
        `${TOTAL - CANNOT - 2} of ${TOTAL} methods fit`,
      )
    })
    expect(screen.getByText(`${CANNOT + 2} methods are left out`)).toBeTruthy()
  })
})
