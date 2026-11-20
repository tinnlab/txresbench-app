// @vitest-environment jsdom
/**
 * ITEM-5 page tests (`pages/StudyPage.tsx`): the question groups render with
 * the board copy (disease/treatment/outcome/marker groups/schedule), every
 * answer change writes the store (and the last-draw answer ALSO writes the
 * engine's decision day — DEC-5), the panel renders the live fit count + the
 * descriptive sentence + the excluded list through the shared formatters,
 * the board clip shows EXCLUDED_LIST_LIMIT rows with the truthful
 * "Show all N", and Continue/Skip navigate the path-aware way. The learn
 * path's files come before this step: the last-draw field suggests the days
 * of the checked files, takes any typed day, shows the coverage line, and a
 * new day checks the files again before Continue goes on to the methods.
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
import { DAY_NO_FACTS_LINE, RECHECK_LINE, StudyPage } from './StudyPage'
import type { FileTimeline, ValidationResponse } from '@/api-client/types'
import type { LoadedFile } from '../types'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { EXCLUDED_LIST_LIMIT } from '../lib/format'
import { EXAMPLE_STUDY } from '../lib/example'
import { seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import { DEMO_STUDY_NOTE } from '@/modules/demo/copy'
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
  validate: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      eligibility: api.eligibility,
      markers: api.markers,
    },
    FileValidation: {
      validate: api.validate,
    },
  },
}))

// The day field runs the registered `flow.setLastDrawDay` (the module import
// registers it in the app).
import '@/core/actions/builtin/dayActions'

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

/** Day facts of three patients: draws on 21/42, 33/56, 56. */
const DAY_FACTS: FileTimeline = {
  draw_days: [[21, 42], [33, 56], [56]],
  outcomes: [],
  limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10 },
}

/** A checked file of the learn path (inspected; the table content is not read). */
function loadedFile(kind: 'patients' | 'measurements'): LoadedFile {
  return {
    source: { name: `${kind}.csv`, format: 'csv' },
    table: { columns: ['patient_id'], rows: [['P1']], source: { name: `${kind}.csv`, format: 'csv' }, headerRow: 1 },
    inspection: { kind, source_name: `${kind}.csv` } as unknown as LoadedFile['inspection'],
    problems: [],
    prepared: true,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: [],
  } as unknown as LoadedFile
}

/** A file check answer (only the parts the step reads). */
const VALIDATION = {
  problems: [],
  markers: [],
  measurements: { rows: 3, patients: 3, distinct_draw_days: [21, 33, 42, 56] },
  inventory: { patients: 3, decision_day: 21, baseline_max_day: 0, markers: [], covariates: [] },
  timeline: DAY_FACTS,
} as unknown as ValidationResponse

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
    expect(screen.getByText(`of ${TOTAL} methods fit your study`)).toBeTruthy()
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

  it('the last-draw field suggests the days of the checked files and writes the decision day too', async () => {
    act(() => {
      useTxrIntakeStore.setState({ dayFacts: DAY_FACTS })
    })
    renderStudy()
    const field = screen.getByTestId('txr-intake-study-last-draw')
    expect(
      within(field)
        .getAllByRole('button')
        .map(b => b.textContent),
    ).toEqual(['Day 21', 'Day 33', 'Day 42', 'Day 56'])
    expect(within(field).queryByTestId('txr-intake-study-last-draw-no-facts')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-42'))
      await Promise.resolve()
    })
    expect(store().study.lastDrawDay).toBe(42)
    expect(store().parameters.decision_day).toBe(42)
    expect(screen.getByTestId('txr-intake-study-last-draw-coverage').textContent).toBe(
      'Day 42: 2 of 3 patients have a draw during treatment by this day',
    )
    await waitFor(() => {
      expect(api.eligibility).toHaveBeenCalledWith({
        preview: expect.objectContaining({ last_draw_day: 42 }),
      })
    })
  })

  it('takes any typed day, and says why a typed day cannot be used', async () => {
    act(() => {
      useTxrIntakeStore.setState({ dayFacts: DAY_FACTS })
    })
    renderStudy()
    const input = screen.getByTestId('txr-intake-study-last-draw-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: '33' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await Promise.resolve()
    })
    expect(store().study.lastDrawDay).toBe(33)
    expect(store().parameters.decision_day).toBe(33)
    expect(screen.getByTestId('txr-intake-study-last-draw-coverage').textContent).toBe(
      'Day 33: 2 of 3 patients have a draw during treatment by this day',
    )
    await act(async () => {
      fireEvent.change(input, { target: { value: '0' } })
      fireEvent.blur(input)
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-intake-study-last-draw-error').textContent).toBe(
      'Choose a whole day from 1 to 729.',
    )
    expect(store().study.lastDrawDay).toBe(33)
  })

  it('with no files in memory the field has no suggestions and says how to get them', () => {
    renderStudy()
    const field = screen.getByTestId('txr-intake-study-last-draw')
    expect(within(field).queryByTestId('txr-intake-study-last-draw-suggestions')).toBeNull()
    expect(screen.getByTestId('txr-intake-study-last-draw-no-facts').textContent).toBe(DAY_NO_FACTS_LINE)
    expect(screen.getByTestId('txr-intake-study-last-draw-input')).toBeTruthy()
  })

  it('a new day checks the files again; Continue waits for it, then goes on to the methods', async () => {
    let answer: (v: ValidationResponse) => void = () => undefined
    api.validate.mockImplementation(
      () =>
        new Promise<ValidationResponse>(resolve => {
          answer = resolve
        }),
    )
    act(() => {
      useTxrIntakeStore.setState({
        patients: loadedFile('patients'),
        measurements: loadedFile('measurements'),
        validation: VALIDATION,
        dayFacts: DAY_FACTS,
      })
    })
    renderStudy()
    expect(screen.getByTestId('txr-intake-study-continue').textContent).toBe('Continue to the methods')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-56'))
      await Promise.resolve()
    })
    expect(store().validation).toBeNull()
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(1))
    expect(api.validate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ mode: 'files', parameters: { decision_day: 56, baseline_max_day: 0 } }),
    )
    expect(screen.getByTestId('txr-intake-study-recheck').textContent).toBe(RECHECK_LINE)
    expect(screen.getByTestId('txr-intake-study-continue').hasAttribute('disabled')).toBe(true)
    // The suggestions stay while the files are checked again.
    expect(screen.getByTestId('txr-intake-study-last-draw-suggestion-21')).toBeTruthy()
    await act(async () => {
      answer({ ...VALIDATION, inventory: { ...VALIDATION.inventory, decision_day: 56 } })
      await Promise.resolve()
    })
    await waitFor(() => expect(store().validation).not.toBeNull())
    expect(store().validation?.inventory.decision_day).toBe(56)
    const continueButton = screen.getByTestId('txr-intake-study-continue')
    expect(continueButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(continueButton)
    expect(routeAt()).toBe('/choose-methods')
  })

  it('Continue and Skip take the path-aware next step', async () => {
    renderStudy()
    // The learn path with no files yet (the Start side trip): the files step.
    expect(screen.getByTestId('txr-intake-study-continue').textContent).toBe('Continue to the files')
    fireEvent.click(screen.getByTestId('txr-intake-study-continue'))
    expect(routeAt()).toBe('/files')
    // The predict side trip goes back to its file step.
    act(() => store().setIntent('pretrained'))
    expect(screen.getByTestId('txr-intake-study-continue').textContent).toBe(
      'Continue to the patients to predict',
    )
    fireEvent.click(screen.getByTestId('txr-intake-study-skip'))
    expect(routeAt()).toBe('/predict-files')
  })

  it('has no upload box and no Use example button (the files come before this step)', () => {
    renderStudy()
    expect(screen.queryByText('What you will upload')).toBeNull()
    expect(screen.queryByText('See example files')).toBeNull()
    expect(screen.queryByText('Use example')).toBeNull()
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


describe('the heading block lines up with the body at every window width', () => {
  it('the step line block starts at the body row\'s left edge: same side padding, never centred', () => {
    renderStudy()
    const page = screen.getByTestId('txr-intake-study')
    const top = page.querySelector('.txr-intake-page-top') as HTMLElement
    const row = page.querySelector('.txr-shell-regions-row') as HTMLElement
    expect(top.textContent).toContain('Step 3 of 4')
    // The body row is full width; a centred (auto-margin) heading drifts right
    // of it once the window is wider than the heading's 1280 px cap (measured
    // in WebKit: at 2000 px the step line sat at x=408 over a body at x=48).
    expect(row.style.maxWidth).toBe('')
    expect(top.style.marginLeft).toBe('0px')
    expect(top.style.marginRight).toBe('0px')
    expect(top.style.paddingLeft).toBe(row.style.paddingLeft)
    expect(top.style.paddingLeft).toBe('48px')
  })
})

describe('ITEM-6 S1/S2/S4 — the panel spacing, the id wrapping, the flush Show all link', () => {
  it('the panel headline keeps a space between the number and "of" (S1)', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
        `${CAN_RUN + SOME} of ${TOTAL} methods fit your study`,
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
        `${TOTAL - CANNOT + 1} of ${TOTAL + ENV} methods fit your study`,
      )
    })
    // The env sentence is the list's own line (one vocabulary, R2-1's
    // "can't run yet" separation): the env-absent subset of the FIT count
    // (only env-only-method fits; the mixed env-method is left out by its
    // answer cause), never a second count over the catalogue (R3-intake-1).
    expect(screen.getByTestId('txr-intake-panel-no-env').textContent).toBe(
      `1 of them cannot run yet`,
    )
    // "Left out" counts EVERY answer cause (the 13 answer-rows plus the
    // mixed env method's marker-group cause — the closed arithmetic with
    // the headline, R3-intake-1); the env-ONLY row is NOT in the list (its
    // cause is the env line).
    expect(screen.getByText(`${CANNOT + 1} methods are left out`)).toBeTruthy()
    const excluded = within(screen.getByTestId('txr-intake-panel-excluded'))
    expect(excluded.getByText('asm-best-change-rule')).toBeTruthy()
    expect(excluded.getByText('needs markers from: Methylation')).toBeTruthy()
    expect(excluded.queryByText('env-only-method')).toBeNull()
    expect(excluded.getAllByText('needs 3 or more draws').length).toBeGreaterThan(0)
  })

  it('ticking a marker group that excludes runnable methods moves the count', async () => {
    // The fixture's answer-caused left-outs drop the count as the answers
    // change (the count reacts to answers, not to the env overlay). The
    // second response flips TWO previously-fitting methods to answer-caused
    // left-outs (the panel derives the split from the per-method reasons —
    // the response's totals are the same classification's aggregate, not a
    // separate source).
    const first = eligibilityResponse()
    const answered = eligibilityResponse()
    answered.total_fit = CAN_RUN - 2
    answered.total_cannot = CANNOT + 2
    for (let i = 0; i < 2; i += 1) {
      const flipper = answered.methods.find(m => m.status === 'can_run')
      if (flipper === undefined) throw new Error('fixture: no runnable method to flip')
      flipper.status = 'cannot_run'
      flipper.reasons = [{ code: 'MIN_DRAWS_UNMET' }]
    }
    api.eligibility
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(answered)
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toContain(
        `of ${TOTAL} methods fit your study`,
      )
    })
    expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
      `${TOTAL - CANNOT} of ${TOTAL} methods fit your study`,
    )
    fireEvent.click(screen.getByTestId('txr-intake-study-outcome-progression-by-day'))
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-panel-fit-count').textContent).toBe(
        `${TOTAL - CANNOT - 2} of ${TOTAL} methods fit your study`,
      )
    })
    expect(screen.getByText(`${CANNOT + 2} methods are left out`)).toBeTruthy()
  })
})

describe('demo mode (ITEM-6) — the panel' + "s example-study note", () => {
  it('answers outside the example setup show the note; the example setup does not', async () => {
    seedDemoMode('demo')
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    expect(await screen.findByTestId('txr-intake-panel-demo-note')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-panel-demo-note').textContent).toBe(DEMO_STUDY_NOTE)
  })

  it('exactly the example answers leave the panel without the note', async () => {
    seedDemoMode('demo')
    store().patchStudy(EXAMPLE_STUDY)
    renderStudy()
    await screen.findByText(/of .* methods fit your study/)
    expect(screen.queryByTestId('txr-intake-panel-demo-note')).toBeNull()
  })

  it('desktop never renders the note', async () => {
    seedDemoMode('desktop')
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    expect(await screen.findByText(/of .* methods fit your study/)).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-panel-demo-note')).toBeNull()
  })
})
