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
import { message } from '@txresbench/kit'
import type { EligibilityResponse, MarkerGroup } from '@/api-client/types'
import { DAY_NO_FACTS_LINE, RECHECK_LINE, StudyPage } from './StudyPage'
import type { FileTimeline, ValidationResponse } from '@/api-client/types'
import type { LoadedFile } from '../types'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { useStepTrailStore } from '../lib/stepTrail'
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
  filterOptions: vi.fn(),
  validate: vi.fn(),
  list: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      eligibility: api.eligibility,
      markers: api.markers,
      filterOptions: api.filterOptions,
      list: api.list,
    },
    FileValidation: {
      validate: api.validate,
    },
  },
}))

// The day field runs the registered `flow.setLastDrawDay` (the module import
// registers it in the app); the disease/treatment/outcome controls run the
// registered `intake.setStudyAnswers`.
import '@/core/actions/builtin/dayActions'
import '@/core/actions/builtin/intakeActions'

const GROUPS: MarkerGroup[] = [
  { id: 'ctdna', display_name: 'Tumour DNA in blood (ctDNA)' },
  { id: 'counts', display_name: 'Blood counts (platelets, haemoglobin)' },
  { id: 'ldh', display_name: 'LDH' },
]

/** The filter-options vocabulary the page's disease/treatment controls read
 *  (step2-filters): ids the server's catalogue knows, with melanoma's real
 *  sub-group and lung cancer's sub-group stand-in (see `fixtures.ts`) for
 *  the nested picker search, and two categories so the "Another disease in
 *  <category> (not listed)" option is category-scoped. */
const FILTER_OPTIONS = {
  disease_categories: [
    {
      id: 'Solid tumours',
      diseases: [
        { id: 'colorectal cancer', children: [] },
        { id: 'breast cancer', children: [] },
        { id: 'lung cancer', children: ['lung adenocarcinoma'] },
        { id: 'melanoma', children: ['uveal melanoma'] },
      ],
    },
    {
      id: 'Other diseases',
      diseases: [{ id: 'COVID-19', children: [] }],
    },
  ],
  treatment_classes: [
    { id: 'immune checkpoint inhibitor', label: 'Immune checkpoint inhibitor' },
    { id: 'chemotherapy', label: 'Chemotherapy' },
    { id: 'radiotherapy', label: 'Radiotherapy' },
  ],
}

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
    {
      id: 'disease-not-matched-method',
      status: 'cannot_run',
      reasons: [
        { code: 'DISEASE_NOT_MATCHED', params: { made_for: 'melanoma', answer: 'colorectal cancer' } },
      ],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      min_draws: { required: 1, met: 0, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    },
    {
      id: 'treatment-not-matched-method',
      status: 'cannot_run',
      reasons: [
        {
          code: 'TREATMENT_NOT_MATCHED',
          params: { made_for: 'chemotherapy', answer: 'targeted therapy' },
        },
      ],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      min_draws: { required: 1, met: 0, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    },
    {
      id: 'outcome-not-matched-method',
      status: 'cannot_run',
      reasons: [
        { code: 'OUTCOME_NOT_MATCHED', params: { predicts: 'dynamic-risk', answer: 'static-risk' } },
      ],
      coverage: { eligible: 0, total: 1, fraction: 0 },
      min_draws: { required: 1, met: 0, unmet_patients: 0 },
      missing_markers: [],
      missing_groups: [],
      estimated_seconds: 0,
      estimate_quality: 'estimate',
    },
  ]
  for (let i = 0; i < CANNOT - 5; i += 1) {
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
  limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10, crosscheck_min_patients: 15, crosscheck_min_per_class: 3 },
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
  api.filterOptions.mockReset()
  api.list.mockReset()
  api.list.mockResolvedValue({ methods: [], total: 0 })
  api.markers.mockResolvedValue({ groups: GROUPS, markers: [] })
  api.filterOptions.mockResolvedValue(FILTER_OPTIONS)
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

/** Open one grouped left-out section (view state — no action registered). */
function openExcludedSection(code: string): void {
  fireEvent.click(screen.getByTestId(`txr-intake-excluded-section-${code}`))
}

describe('StudyPage (screen B, ITEM-5)', () => {
  it('renders the question groups with the board copy, then the panel from live data', async () => {
    renderStudy()
    expect(screen.getByText('Tell us about your study')).toBeTruthy()
    expect(screen.getByLabelText('Disease')).toBeTruthy()
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

    // The treatment question is the multi-tick list (brief 5b): one checkbox
    // per base class with the display label, under the Treatment heading.
    expect(await screen.findByRole('checkbox', { name: 'Immune checkpoint inhibitor' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Chemotherapy' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Radiotherapy' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Treatment' })).toBeTruthy()
    expect(screen.getByTestId('txr-intake-study-treatment-hint').textContent).toBe(
      'A combination is several ticks. Tick none to keep every treatment.',
    )
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
    // The list is grouped and collapsed by default: the rows wait inside
    // their sections (brief 5b) — open the three with rows to see them.
    expect(excluded.queryByText('dynforest')).toBeNull()
    expect(excluded.getAllByTestId(/txr-intake-excluded-section-/)).toHaveLength(4)
    openExcludedSection('other')
    expect(excluded.getByText('dynforest')).toBeTruthy()
    expect(excluded.getAllByText('needs 3 or more draws').length).toBeGreaterThan(0)
    expect(excluded.getByText('ki67-two-week-four-group')).toBeTruthy()
    expect(excluded.getByText('needs Ki-67, not in your file')).toBeTruthy()
    openExcludedSection('disease')
    openExcludedSection('treatment')
    openExcludedSection('outcome')
    expect(excluded.getByText('disease-not-matched-method')).toBeTruthy()
    expect(excluded.getByText('Made for melanoma, not your disease')).toBeTruthy()
    expect(excluded.getByText('treatment-not-matched-method')).toBeTruthy()
    expect(excluded.getByText('Made for Chemotherapy, not your treatments')).toBeTruthy()
    expect(excluded.getByText('outcome-not-matched-method')).toBeTruthy()
    expect(excluded.getByText('Predicts risk over time, not what you chose')).toBeTruthy()
  })

  it('an answer change re-runs the eligibility (debounced) and writes the store', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    api.eligibility.mockClear()

    // A quick burst: three answer changes inside one debounce window. The
    // outcome pills run the registered `intake.setStudyAnswers` action
    // (step2-filters), so their store write settles after a microtask — the
    // waitFor absorbs it with the same assertions.
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    fireEvent.click(screen.getByTestId('txr-intake-study-outcome-progression-by-day'))
    fireEvent.click(screen.getByTestId('txr-intake-study-outcome-binary-response'))
    expect(store().study.markerGroups?.ctdna).toBe(true)
    await waitFor(() => expect(store().study.outcome).toBe('binary-response'))

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
    // study-step-ui-tweaks: the "Other values" chip follows the suggestion
    // chips (the box it opens is view state, checked in its own test).
    expect(
      within(field)
        .getAllByRole('button')
        .map(b => b.textContent),
    ).toEqual(['Day 21', 'Day 33', 'Day 42', 'Day 56', 'Other values'])
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
    // The input's aria-describedby names the coverage line shown under it
    // (the box is view state: reopen it to read the input).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-other'))
      await Promise.resolve()
    })
    const input = screen.getByTestId('txr-intake-study-last-draw-input')
    const coverageLine = screen.getByTestId('txr-intake-study-last-draw-coverage')
    expect(input.getAttribute('aria-describedby')).toContain(coverageLine.id)
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
    // The number box is view state (study-step-ui-tweaks): open it first.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-other'))
      await Promise.resolve()
    })
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
    // A suggested day closed the box; open it again for the refused day.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-other'))
      await Promise.resolve()
    })
    const refusedInput = screen.getByTestId('txr-intake-study-last-draw-input')
    await act(async () => {
      fireEvent.change(refusedInput, { target: { value: '0' } })
      fireEvent.blur(refusedInput)
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

  it('a day the action refuses shows the message and the field keeps its value', async () => {
    act(() => {
      useTxrIntakeStore.setState({ dayFacts: DAY_FACTS })
    })
    renderStudy()
    // The registered action refuses a last-draw day away from the study step:
    // the step trail is the action's own gate, cleared here to make the
    // refusal happen (the page catch is what the test drives).
    act(() => {
      useStepTrailStore.setState({ current: null })
    })
    const errorSpy = vi.spyOn(message, 'error')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-42'))
      await Promise.resolve()
    })
    expect(errorSpy).toHaveBeenCalledWith('Open the questions step of a new analysis first.')
    // The action was refused: no day stored, and the field keeps its old
    // value (no day chosen). The box is view state — open it to read the
    // draft it holds (it shows the stored value, still none).
    expect(store().study.lastDrawDay).toBeNull()
    expect(store().parameters.decision_day).toBe(56)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-other'))
      await Promise.resolve()
    })
    expect((screen.getByTestId('txr-intake-study-last-draw-input') as HTMLInputElement).value).toBe(
      '',
    )
  })

  it('Continue does not race the re-check: a click before it resolves stays on the step, then goes on', async () => {
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
    expect(screen.getByTestId('txr-intake-study-continue').textContent).toBe(
      'Continue to the methods',
    )
    // Change the day and click Continue in the same tick, before the re-check
    // resolves (a render-computed gate would navigate on the stale check).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-56'))
      fireEvent.click(screen.getByTestId('txr-intake-study-continue'))
      await Promise.resolve()
    })
    expect(routeAt()).toBe('/study')
    await act(async () => {
      answer({ ...VALIDATION, inventory: { ...VALIDATION.inventory, decision_day: 56 } })
      await Promise.resolve()
    })
    await waitFor(() => expect(store().validation).not.toBeNull())
    const continueButton = screen.getByTestId('txr-intake-study-continue')
    expect(continueButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(continueButton)
    expect(routeAt()).toBe('/choose-methods')
  })

  it('a failed re-check of the old day does not let Continue skip the fresh check after a new day', async () => {
    let calls = 0
    api.validate.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('the files could not be read again'))
      return Promise.resolve({
        ...VALIDATION,
        inventory: { ...VALIDATION.inventory, decision_day: 42 },
      })
    })
    // The absolute call count accumulates across this file's tests (the mock
    // is not reset per test), so the expectations are relative to this point.
    const atStart = api.validate.mock.calls.length
    act(() => {
      useTxrIntakeStore.setState({
        patients: loadedFile('patients'),
        measurements: loadedFile('measurements'),
        validation: VALIDATION,
        dayFacts: DAY_FACTS,
      })
    })
    renderStudy()
    // A new day triggers the re-check, and it FAILS.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-56'))
      await Promise.resolve()
    })
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(atStart + 1))
    expect(screen.getByTestId('txr-intake-study-recheck-error').textContent).toBe(
      'the files could not be read again',
    )
    // The user picks ANOTHER day and clicks Continue at once, before the fresh
    // check's effect runs. The stored failure belongs to the OLD day's key, so
    // Continue must still wait for the new check — not read the stale
    // "failed" flag and go straight to the files step.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-42'))
      fireEvent.click(screen.getByTestId('txr-intake-study-continue'))
      await Promise.resolve()
    })
    expect(routeAt()).toBe('/study')
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(atStart + 2))
    await waitFor(() => expect(store().validation).not.toBeNull())
    expect(store().validation?.inventory.decision_day).toBe(42)
    const continueButton = screen.getByTestId('txr-intake-study-continue')
    fireEvent.click(continueButton)
    expect(routeAt()).toBe('/choose-methods')
  })

  it('a join confirmed after a failed re-check starts a fresh check (joins/mapping are subscriptions)', async () => {
    let calls = 0
    api.validate.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('the files could not be read again'))
      return Promise.resolve({
        ...VALIDATION,
        inventory: { ...VALIDATION.inventory, decision_day: 56 },
      })
    })
    // The absolute call count accumulates across this file's tests (the mock
    // is not reset per test), so the expectations are relative to this point.
    const atStart = api.validate.mock.calls.length
    act(() => {
      useTxrIntakeStore.setState({
        patients: loadedFile('patients'),
        measurements: loadedFile('measurements'),
        validation: VALIDATION,
        dayFacts: DAY_FACTS,
      })
    })
    renderStudy()
    // A new day triggers the re-check, and it FAILS.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-last-draw-suggestion-56'))
      await Promise.resolve()
    })
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(atStart + 1))
    expect(screen.getByTestId('txr-intake-study-recheck-error').textContent).toBe(
      'the files could not be read again',
    )
    // Only a CONFIRMED JOIN changes now (the user went back to the files step
    // and accepted the ldh join): no day change, no file change. The failed
    // check's key no longer matches the current joins/mapping, so pending()
    // is true again — but the effect must re-run (joins and mapping are its
    // dependencies) or no fresh check ever starts and Continue stays stuck.
    // Without the fix the validate call count below stays at atStart + 1 and
    // this test fails there.
    act(() => {
      store().acceptJoin({ variants: ['ldh', 'LDH'], key: 'ldh' })
    })
    await waitFor(() => expect(api.validate).toHaveBeenCalledTimes(atStart + 2))
    await waitFor(() => expect(store().validation).not.toBeNull())
    const continueButton = screen.getByTestId('txr-intake-study-continue')
    await waitFor(() => expect(continueButton.hasAttribute('disabled')).toBe(false))
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

  it('groups the left-out list by reason code: ordered sections, counts and singular wording', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    })
    const excluded = within(screen.getByTestId('txr-intake-panel-excluded'))
    // The numbered sections, in the fixed order (disease, treatment,
    // outcome, then every other code), each with its count; the three
    // answer-caused ones are singular (one row each).
    const headings = excluded
      .getAllByTestId(/txr-intake-excluded-section-/)
      .map(node => node.textContent)
    expect(headings).toEqual([
      '1 made for another disease',
      '1 made for other treatments',
      '1 predicts something else',
      `${CANNOT - 3} do not fit your files or answers`,
    ])
    // Collapsed by default: opening the "other" section shows its rows; the
    // short sections' rows appear with their own section.
    openExcludedSection('other')
    expect(excluded.getByText('dynforest')).toBeTruthy()
    expect(excluded.getByText('ki67-two-week-four-group')).toBeTruthy()
    openExcludedSection('disease')
    expect(excluded.getByText('disease-not-matched-method')).toBeTruthy()
  })

  it('the one method of an "other" bucket reads singular "does not fit" (1 does not fit)', async () => {
    const response = eligibilityResponse()
    // A two-row response (one other-coded row, one disease-coded row) so the
    // singular words are the ones on screen.
    const single = {
      methods: [
        response.methods.find(m => m.id === 'dynforest')!,
        response.methods.find(m => m.id === 'disease-not-matched-method')!,
      ],
      total_fit: 0,
      total_some: 0,
      total_cannot: 2,
      total_no_env: 0,
    } as EligibilityResponse
    api.eligibility.mockResolvedValue(single)
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText('2 methods are left out')).toBeTruthy()
    })
    const excluded = within(screen.getByTestId('txr-intake-panel-excluded'))
    const headings = excluded
      .getAllByTestId(/txr-intake-excluded-section-/)
      .map(node => node.textContent)
    expect(headings).toEqual([
      '1 made for another disease',
      '1 does not fit your files or answers',
    ])
  })

  it('a long section keeps the Show all N inside it, at the board clip', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    })
    const panel = () => screen.getByTestId('txr-intake-panel-excluded')
    // All sections start collapsed: no rows on screen, no Show all yet.
    expect(panel().querySelectorAll('li').length).toBe(0)
    expect(screen.queryByTestId('txr-intake-excluded-show-all-other')).toBeNull()
    // The "other" section is long (10 > the 6-board clip): opening it shows
    // the clip and the section's own truthful "Show all 10".
    openExcludedSection('other')
    expect(panel().querySelectorAll('li').length).toBe(EXCLUDED_LIST_LIMIT)
    const showAll = screen.getByTestId('txr-intake-excluded-show-all-other')
    expect(showAll.textContent).toBe(`Show all ${CANNOT - 3}`)
    fireEvent.click(showAll)
    expect(panel().querySelectorAll('li').length).toBe(CANNOT - 3)
    expect(screen.getByText('Show fewer')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-intake-excluded-show-all-other'))
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

  it('a failing filter-options fetch shows ONE plain line, never the raw error under both controls (5a3)', async () => {
    api.filterOptions.mockRejectedValueOnce(new Error('catalogue down'))
    renderStudy()
    const alert = await screen.findByTestId('txr-intake-filter-options-error')
    // Exactly ONE alert for the failed vocabulary; the raw fetch message is
    // never rendered (neither under Disease nor under Treatment).
    expect(screen.getAllByTestId('txr-intake-filter-options-error')).toHaveLength(1)
    expect(alert.textContent).toBe(
      'The disease and treatment lists could not be loaded. The methods are not filtered by them.',
    )
    expect(screen.queryByText('catalogue down')).toBeNull()
  })
})

describe('step2-filters brief 5b — the disease picker and the treatment multi-tick', () => {
  /** Open the disease picker popup the way a user does, and wait for its rows. */
  async function openDiseasePicker(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-disease'))
      await Promise.resolve()
    })
    await screen.findByTestId('txr-intake-study-disease-search')
    await act(async () => {
      await Promise.resolve()
    })
  }

  /** Type into the picker's search field (the searchable arm's filter). */
  async function searchDiseases(query: string): Promise<void> {
    await act(async () => {
      fireEvent.change(screen.getByTestId('txr-intake-study-disease-search'), {
        target: { value: query },
      })
      await Promise.resolve()
    })
  }

  /** Pick one offered row (closes the popup and commits the value). */
  async function pickDisease(testid: string): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId(testid))
      await Promise.resolve()
    })
  }

  it('searching finds a disease and its sub-groups, with the parent beside each sub-group', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    await openDiseasePicker()
    // The group headings + every row are offered before the filter. Searching
    // "melanoma" finds the disease row and its sub-group row (a sub-group's
    // label carries its parent in parentheses).
    expect(screen.getByTestId('txr-intake-study-disease-opt-melanoma')).toBeTruthy()
    await searchDiseases('melanoma')
    expect(screen.getByTestId('txr-intake-study-disease-opt-melanoma')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-study-disease-opt-uveal melanoma')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-study-disease-opt-uveal melanoma').textContent).toBe(
      'Uveal melanoma (Melanoma)',
    )
    // Searching "lung" finds the lung disease row AND its sub-group (the
    // blank 5b2 review point: the fixture now carries lung's child — the
    // guard-clean stand-in spelling `lung adenocarcinoma`, see
    // `fixtures.ts`), with the parent beside the sub-group; a non-matching
    // disease is filtered out, and the "Another disease in Solid tumours"
    // row does not carry the query either.
    await searchDiseases('lung')
    expect(screen.getByTestId('txr-intake-study-disease-opt-lung cancer')).toBeTruthy()
    expect(screen.getByTestId('txr-intake-study-disease-opt-lung adenocarcinoma')).toBeTruthy()
    expect(
      screen.getByTestId('txr-intake-study-disease-opt-lung adenocarcinoma').textContent,
    ).toBe('Lung adenocarcinoma (Lung cancer)')
    expect(screen.queryByTestId('txr-intake-study-disease-opt-COVID-19')).toBeNull()
    expect(screen.queryByTestId('txr-intake-study-disease-opt-breast cancer')).toBeNull()
  })

  it('a query matching only a category heading never lists the whole category (5b2)', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    await openDiseasePicker()
    // "solid" matches ONLY the "Solid tumours" category heading; the picker
    // filters by option names, so the whole category must not appear — the
    // only row whose own text carries the word is the category's
    // "(not listed)" option.
    await searchDiseases('solid')
    expect(screen.getByTestId('txr-intake-study-disease-opt-Solid tumours')).toBeTruthy()
    expect(screen.queryByTestId('txr-intake-study-disease-opt-colorectal cancer')).toBeNull()
    expect(screen.queryByTestId('txr-intake-study-disease-opt-lung cancer')).toBeNull()
    expect(screen.queryByTestId('txr-intake-study-disease-opt-melanoma')).toBeNull()
    expect(screen.queryByTestId('txr-intake-study-disease-opt-COVID-19')).toBeNull()
  })

  it('picking a sub-group sends that id; the "not listed" option sends the category id', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    await openDiseasePicker()
    await searchDiseases('uveal')
    await pickDisease('txr-intake-study-disease-opt-uveal melanoma')
    expect(store().study.disease).toBe('uveal melanoma')

    await openDiseasePicker()
    await searchDiseases('not listed')
    // The "Another disease in <category> (not listed)" row carries the
    // category id as its value — the server's category-scope answer.
    expect(
      screen.getByTestId('txr-intake-study-disease-opt-Solid tumours').textContent,
    ).toBe('Another disease in Solid tumours (not listed)')
    await pickDisease('txr-intake-study-disease-opt-Solid tumours')
    expect(store().study.disease).toBe('Solid tumours')
  })

  it('Clear sends null — ONE click empties the box, and picking again works', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    await openDiseasePicker()
    await searchDiseases('lung')
    await pickDisease('txr-intake-study-disease-opt-lung cancer')
    expect(store().study.disease).toBe('lung cancer')
    // One click on the clear button: the trigger returns to the untouched
    // prompt ("Choose a disease…") — the old `value ?? undefined` made the
    // kit's useControllableState treat the box as UNCONTROLLED, so the clear
    // left the old id in its internal state and the trigger kept the cleared
    // disease — the clear button itself hides, and the store's answer is null.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-disease-clear'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.disease).toBeNull())
    expect(screen.getByTestId('txr-intake-study-disease').textContent).toBe('Choose a disease…')
    expect(screen.queryByTestId('txr-intake-study-disease-clear')).toBeNull()
    // Picking again after the clear works: the box is not stuck on the old id.
    await openDiseasePicker()
    await searchDiseases('melanoma')
    await pickDisease('txr-intake-study-disease-opt-melanoma')
    await waitFor(() => expect(store().study.disease).toBe('melanoma'))
    expect(screen.getByTestId('txr-intake-study-disease').textContent).toBe('Melanoma')
  })

  it('a stored disease id BEFORE the vocabulary loads shows as text, never a blank trigger (5b2)', async () => {
    // Hold the vocabulary fetch open for the whole test: the picker mounts
    // with no options but with a stored answer.
    api.filterOptions.mockReturnValue(new Promise(() => undefined))
    act(() => {
      store().patchStudy({ disease: 'made-up cancer' })
    })
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    // The stored id is the trigger's text (the display rule), never the
    // empty-state prompt — with no option for it, the old render showed a
    // blank trigger beside the clear button. (The base-ui arm appends its
    // chevron glyph, so read the value span, not the whole button's text.)
    const trigger = screen.getByTestId('txr-intake-study-disease')
    expect(within(trigger).getByText('Made-up cancer')).toBeTruthy()
    // The clear affordance is still there (the answer is cleared — once the
    // vocabulary is reachable; the validating action refuses before it).
    expect(screen.getByTestId('txr-intake-study-disease-clear')).toBeTruthy()
  })

  it('once the vocabulary loads, an unknown stored id is reconciled to unanswered (5b2)', async () => {
    act(() => {
      store().patchStudy({ disease: 'made-up cancer' })
    })
    renderStudy()
    // The vocabulary's fetch-success + settled-cache branches both reconcile
    // the answers (useFilterOptions): an id the catalogue does not know is
    // dropped to unanswered, so the trigger returns to the empty-state
    // prompt.
    await waitFor(() => expect(store().study.disease).toBeNull())
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    expect(screen.getByTestId('txr-intake-study-disease').textContent).toBe('Choose a disease…')
    expect(screen.queryByTestId('txr-intake-study-disease-clear')).toBeNull()
  })

  it('ticking two treatments writes both in vocabulary order; unticking all returns to unanswered', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Immune checkpoint inhibitor' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-chemotherapy'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.treatments).toEqual(['chemotherapy']))
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-immune checkpoint inhibitor'))
      await Promise.resolve()
    })
    // The whole list is rewritten in vocabulary order (imm. checkpoint
    // inhibitor first — the classes' list order, NOT the click order).
    await waitFor(() =>
      expect(store().study.treatments).toEqual([
        'immune checkpoint inhibitor',
        'chemotherapy',
      ]),
    )
    // Untick both: the empty list is the action's "unanswered" spelling.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-immune checkpoint inhibitor'))
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-chemotherapy'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.treatments).toBeNull())
  })

  it('two ticks in ONE act both stay ticked (the async write never overwrites the first tick)', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Immune checkpoint inhibitor' })
    // Both clicks land before the async `intake.setStudyAnswers` write does:
    // the second click must build from the first click's intended tick, not
    // from the pre-click store value (brief 5b2 ITEM-2 — the old code lost
    // the first tick exactly here).
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-immune checkpoint inhibitor'))
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-chemotherapy'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(store().study.treatments).toEqual([
        'immune checkpoint inhibitor',
        'chemotherapy',
      ]),
    )
  })

  it('a persisted two-item treatment answer shows both ticks (no collapse to one)', async () => {
    act(() => {
      store().patchStudy({ treatments: ['immune checkpoint inhibitor', 'chemotherapy'] })
    })
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Immune checkpoint inhibitor' })
    expect(
      screen.getByRole('checkbox', { name: 'Immune checkpoint inhibitor' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByRole('checkbox', { name: 'Chemotherapy' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByRole('checkbox', { name: 'Radiotherapy' }).getAttribute('aria-checked')).toBe(
      'false',
    )
  })

  it('the panel sentence names every answered filter, in the page order, and changes with an answer', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Immune checkpoint inhibitor' })
    // Nothing answered: the panel's invite line, never a count (R2-1).
    expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
      'Answer the questions above to see which methods fit your study.',
    )
    // One answer at a time: the sentence grows one clause per answered
    // question, in the page's order (disease, treatment, outcome, marker
    // groups, schedule), and each change is visible.
    await openDiseasePicker()
    await searchDiseases('lung')
    await pickDisease('txr-intake-study-disease-opt-lung cancer')
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods for lung cancer. This updates as you answer.',
      ),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-treatment-chemotherapy'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods for lung cancer, given with chemotherapy. This updates as you answer.',
      ),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-outcome-progression-by-day'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods for lung cancer, given with chemotherapy, that predict the risk by a set day. This updates as you answer.',
      ),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods for lung cancer, given with chemotherapy, that predict the risk by a set day, using ctDNA. This updates as you answer.',
      ),
    )
    // The three schedule answers join ONE "with …" clause (the pin's example
    // shape; `patchStudy` writes the same fields the controls do).
    act(() => {
      store().patchStudy({ beforeTreatment: 'always', drawsDuringTreatment: 2, lastDrawDay: 56 })
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods for lung cancer, given with chemotherapy, that predict the risk by a set day, using ctDNA, with a draw before treatment, 2 to 3 draws during treatment and the last draw on day 56. This updates as you answer.',
      ),
    )
  })
})


describe('aoc1 — the Any outcome pill (the unanswered state)', () => {
  const anyPill = () => screen.getByTestId('txr-intake-study-outcome-any')
  const groupPill = (value: string) => screen.getByTestId(`txr-intake-study-outcome-${value}`)

  it('Any is pressed (and FIRST) when no outcome is chosen, and clicking it changes nothing', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    const pills = screen.getByRole('group', { name: 'What you want to predict' })
    // The row order: Any first, then the four board pills unchanged.
    expect(
      within(pills)
        .getAllByRole('button')
        .map(b => b.getAttribute('data-testid')),
    ).toEqual([
      'txr-intake-study-outcome-any',
      'txr-intake-study-outcome-binary-response',
      'txr-intake-study-outcome-response-probability',
      'txr-intake-study-outcome-progression-by-day',
      'txr-intake-study-outcome-dynamic-risk',
    ])
    expect(anyPill().textContent).toBe('Any')
    expect(anyPill().getAttribute('aria-pressed')).toBe('true')
    for (const value of [
      'binary-response',
      'response-probability',
      'progression-by-day',
      'dynamic-risk',
    ]) {
      expect(groupPill(value).getAttribute('aria-pressed')).toBe('false')
    }
    // Clicking Any while it is already selected: the outcome stays null.
    await act(async () => {
      fireEvent.click(anyPill())
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBeNull())
    expect(anyPill().getAttribute('aria-pressed')).toBe('true')
  })

  it('picking a group deselects Any and presses the group', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    expect(anyPill().getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      fireEvent.click(groupPill('binary-response'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBe('binary-response'))
    expect(anyPill().getAttribute('aria-pressed')).toBe('false')
    expect(groupPill('binary-response').getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking Any clears a chosen outcome (and the group pill is no longer pressed)', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    await act(async () => {
      fireEvent.click(groupPill('progression-by-day'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBe('progression-by-day'))
    expect(groupPill('progression-by-day').getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      fireEvent.click(anyPill())
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBeNull())
    expect(groupPill('progression-by-day').getAttribute('aria-pressed')).toBe('false')
    expect(anyPill().getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking the selected group pill clears it and Any is pressed again', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    await act(async () => {
      fireEvent.click(groupPill('dynamic-risk'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBe('dynamic-risk'))
    expect(anyPill().getAttribute('aria-pressed')).toBe('false')
    // The second click is the clearing one (today's behaviour): Any again.
    await act(async () => {
      fireEvent.click(groupPill('dynamic-risk'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBeNull())
    expect(groupPill('dynamic-risk').getAttribute('aria-pressed')).toBe('false')
    expect(anyPill().getAttribute('aria-pressed')).toBe('true')
  })

  it('with Any the preview request carries no method_group', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    api.eligibility.mockClear()
    // Answer a marker group + an outcome: the request then carries the task.
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    await act(async () => {
      fireEvent.click(groupPill('binary-response'))
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBe('binary-response'))
    await waitFor(() => {
      expect(
        api.eligibility.mock.calls.some(
          call =>
            (call[0] as { preview?: Record<string, unknown> }).preview?.method_group ===
            'response-call',
        ),
      ).toBe(true)
    })
    // Clear to Any: the request omits the task filter entirely (the
    // marker-group answer still rides).
    await act(async () => {
      fireEvent.click(anyPill())
      await Promise.resolve()
    })
    await waitFor(() => expect(store().study.outcome).toBeNull())
    await waitFor(() => {
      const last = api.eligibility.mock.calls.at(-1)?.[0] as {
        preview?: Record<string, unknown>
      }
      expect(last.preview).toBeDefined()
      expect(last.preview?.method_group).toBeUndefined()
      expect(last.preview?.marker_groups).toEqual(expect.objectContaining({ ctdna: true }))
    })
  })

  it('with Any the sentence has no "that predict" clause', async () => {
    renderStudy()
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    // A marker group + an outcome: the outcome clause appears with it.
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
    await act(async () => {
      fireEvent.click(groupPill('progression-by-day'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods that predict the risk by a set day, using ctDNA. This updates as you answer.',
      ),
    )
    await act(async () => {
      fireEvent.click(anyPill())
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('txr-intake-panel-sentence').textContent).toBe(
        'Methods using ctDNA. This updates as you answer.',
      ),
    )
    expect(screen.getByTestId('txr-intake-panel-sentence').textContent).not.toContain('that predict')
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
    // The row lives in the "other" section; open it to read the id's bytes.
    openExcludedSection('other')
    const id = screen.getByText('ki67-two-week-four-group')
    expect(id.style.wordBreak).toBe('normal')
    expect(id.style.overflowWrap).toBe('anywhere')
    expect(id.style.minWidth).toBe('210px')
  })

  it('the Show all link renders flush (no kit padding — S4)', async () => {
    renderStudy()
    await answerFirst('txr-intake-study-group-ctdna')
    await waitFor(() => {
      expect(screen.getByText(`${CANNOT} methods are left out`)).toBeTruthy()
    })
    openExcludedSection('other')
    const showAll = screen.getByTestId('txr-intake-excluded-show-all-other') as HTMLElement
    expect(showAll.textContent).toBe(`Show all ${CANNOT - 3}`)
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
    // The rows wait inside their sections; the mixed env method's answer
    // cause (a marker group) buckets it into "other".
    openExcludedSection('other')
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

describe('StudyPage single-marker-choice round 2', () => {
  const MAIN_MARKERS = [
    {
      key: 'ctdna_mm',
      display_name: 'ctDNA',
      n_patients_with_value: 6,
      n_patients_with_baseline: 6,
      n_patients_with_ontreatment: 6,
      is_detection_call: false,
      has_detection_companion: false,
      standard_ids: [],
      unit_family: 'ratio',
    },
    {
      key: 'ldh',
      display_name: 'LDH',
      n_patients_with_value: 8,
      n_patients_with_baseline: 8,
      n_patients_with_ontreatment: 8,
      is_detection_call: false,
      has_detection_companion: false,
      standard_ids: [],
      unit_family: 'percent',
    },
  ]

  /** A runnable catalogue summary with the marker facts the step-3 facts read. */
  function summaryOf(
    id: string,
    kind: 'single' | 'multi' | 'any' | 'panel',
    count: number,
  ): unknown {
    return {
      id,
      container: true,
      covariates: 'none',
      disease: { scope: 'any-solid-tumour', groups: [] },
      treatment: { classes: ['chemotherapy'], confidence: 'stated' },
      embeds_training_data: false,
      frozen_model: false,
      group: 'response-probability',
      group_label: 'Response probability',
      title: id,
      summary: `Summary of ${id}.`,
      paper_title: 'The fixture paper',
      journal: 'Fixture Journal',
      marker_groups_required: [],
      markers: { kind, count },
      min_draws: 1,
      needs_baseline: false,
      needs_detection_call: false,
      paper_doi: '10.0000/fixture',
      runnable: true,
      spec_status: 'stable',
      tasks: ['response'],
      timing: { base_seconds_per_fold: 60, benchmarked_units: 2, quality: 'measured' },
      uses_history: 'landmark',
      required_markers: null,
    }
  }

  function seedStudyFile(markers: unknown[] = MAIN_MARKERS): void {
    useTxrIntakeStore.setState({
      validation: {
        ...VALIDATION,
        // The file's validated summary says 8 patients (the markers' counts
        // 6 of 8 / 8 of 8 are the "{a} of {b} patients" select labels; the
        // base VALIDATION's 3-patient inventory is the older describes').
        inventory: { ...VALIDATION.inventory, patients: 8, markers },
      } as never,
      measurements: loadedFile('measurements'),
    })
  }

  async function answerOneGroup(): Promise<void> {
    await screen.findByRole('checkbox', { name: 'Tumour DNA in blood (ctDNA)' })
    fireEvent.click(screen.getByTestId('txr-intake-study-group-ctdna'))
  }

  it('shows the group when the file is in, a fitting single no-list method exists and the file has more than one main marker', async () => {
    api.list.mockResolvedValue({
      methods: [summaryOf('m-fit', 'single', 1)],
      total: 1,
    } as never)
    seedStudyFile()
    renderStudy()
    await answerOneGroup()

    const group = await screen.findByTestId('txr-intake-study-single-marker')
    expect(group.textContent).toContain('Methods that pick markers from your file')
    expect(group.textContent).toContain(
      '1 of the methods that fit takes one marker, and your file has 2 markers. Which should it use?',
    )
    expect(screen.getByTestId('txr-intake-single-marker-recommended').textContent).toBe(
      'Recommended',
    )
    // The select offers the file's main markers with the patient counts.
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-single-marker-select'))
    })
    expect(screen.getByTestId('txr-intake-single-marker-select-opt-ctdna_mm').textContent).toBe(
      'ctDNA (6 of 8 patients)',
    )
    expect(screen.getByTestId('txr-intake-single-marker-select-opt-ldh').textContent).toBe(
      'LDH (8 of 8 patients)',
    )
    // The ranked default is pressed.
    expect(
      screen.getByTestId('txr-intake-single-marker-ranked').getAttribute('aria-checked'),
    ).toBe('true')
    // The preview request carries the validated inventory; the ranked choice
    // sends NO plan (step 4 is the ranking authority).
    const preview = api.eligibility.mock.calls.at(-1)![0].preview
    expect(preview.inventory.markers.map((m: { key: string }) => m.key)).toEqual([
      'ctdna_mm',
      'ldh',
    ])
    expect(preview.marker_plan).toBeUndefined()
  })

  it('the select picks the marker through the registered action; the preview then carries the chosen plan', async () => {
    api.list.mockResolvedValue({ methods: [summaryOf('m-fit', 'single', 1)], total: 1 } as never)
    seedStudyFile()
    renderStudy()
    await answerOneGroup()
    await screen.findByTestId('txr-intake-study-single-marker')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-single-marker-select'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-single-marker-select-opt-ctdna_mm'))
    })
    expect(store().singleMarkerChoice).toEqual({ mode: 'chosen', marker: 'ctdna_mm' })
    expect(
      screen.getByTestId('txr-intake-single-marker-chosen').getAttribute('aria-checked'),
    ).toBe('true')
    // The preview is re-issued with the plan (the request content changed).
    await waitFor(() => {
      const preview = api.eligibility.mock.calls.at(-1)![0].preview
      expect(preview.marker_plan).toEqual({ mode: 'chosen', marker: 'ctdna_mm' })
    })
  })

  it('the leave-out radio runs the registered action and the preview carries the leave_out plan', async () => {
    api.list.mockResolvedValue({ methods: [summaryOf('m-fit', 'single', 1)], total: 1 } as never)
    seedStudyFile()
    renderStudy()
    await answerOneGroup()
    await screen.findByTestId('txr-intake-study-single-marker')

    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-intake-single-marker-leave-out'))
    })
    expect(store().singleMarkerChoice).toEqual({ mode: 'leave_out' })
    await waitFor(() => {
      const preview = api.eligibility.mock.calls.at(-1)![0].preview
      expect(preview.marker_plan).toEqual({ mode: 'leave_out' })
    })
    expect(
      screen.getByTestId('txr-intake-single-marker-leave-out').getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('a multi no-list method names "a set number of markers" in the n = 1 question', async () => {
    api.list.mockResolvedValue({ methods: [summaryOf('m-fit', 'multi', 2)], total: 1 } as never)
    seedStudyFile()
    renderStudy()
    await answerOneGroup()
    const group = await screen.findByTestId('txr-intake-study-single-marker')
    expect(group.textContent).toContain(
      '1 of the methods that fit takes a set number of markers, and your file has 2 markers. Which should it use?',
    )
  })

  it('is hidden when the file has one main marker', async () => {
    api.list.mockResolvedValue({ methods: [summaryOf('m-fit', 'single', 1)], total: 1 } as never)
    seedStudyFile([MAIN_MARKERS[0]])
    renderStudy()
    await answerOneGroup()
    expect(screen.queryByTestId('txr-intake-study-single-marker')).toBeNull()
  })

  it('is hidden when no fitting method takes one marker or a set number (any/panel or a fixed list)', async () => {
    api.list.mockResolvedValue({ methods: [summaryOf('m-fit', 'any', 2)], total: 1 } as never)
    seedStudyFile()
    renderStudy()
    await answerOneGroup()
    expect(screen.queryByTestId('txr-intake-study-single-marker')).toBeNull()
  })

  it('is hidden when there is no checked file', async () => {
    api.list.mockResolvedValue({ methods: [summaryOf('m-fit', 'single', 1)], total: 1 } as never)
    renderStudy()
    await answerOneGroup()
    expect(screen.queryByTestId('txr-intake-study-single-marker')).toBeNull()
  })
})
