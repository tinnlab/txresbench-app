// @vitest-environment jsdom
/**
 * TEST-INT-11 — screen A (`pages/StartPage.tsx`, ITEM-4; predict-card merge
 * round 1): the TWO path cards (board Start.dc.html, DEC-13 copy) — learn
 * and predict — with the counts-gated states (state A vs state B: "some
 * model exists" vs "no model anywhere and all three counts known"),
 * the learn card's LIVE runnable count (CONS-UI-INTAKE-3) with its
 * number-free degradation, the intent navigation (predict →
 * `/predict-files`, train → `/files`), the "Recommended to start" badge
 * rule (lab > 0 → predict, else learn — also while loading or failed), the
 * banner's study link, "Use example" on each card (the registered
 * `flow.useExample` action — qa-fixes3 ITEM-4's one-click example flow),
 * "Open a model file" (the registered `models.openModelFile` — the picker
 * opens in place, a successful import lands on the Models page), and the
 * web-URL notice (DEC-12: `http:` dev/web only).
 *
 * The ApiClient is mocked (the txrlist/Datasets-store precedent); the
 * example-data path runs the REAL PROV-FV-7 decode against inline CSV
 * fixtures, and the REAL TxrIntake store is asserted for the intent/file
 * side effects. Navigation is read through a location probe inside the
 * `MemoryRouter` the page renders in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import '@/core/actions/builtin/stepActions'
import '@/core/actions/builtin/modelFileActions'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { StartPage } from './StartPage'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { __resetFetchCacheForTests } from '../data/fetchCache'
import { seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import { DEMO_START_HINT, DEMO_START_PRIMARY } from '@/modules/demo/copy'
import type { LoadedFile } from '../types'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  example: vi.fn(),
  exampleSet: vi.fn(),
  pretrained: vi.fn(),
  saved: vi.fn(),
  importModel: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      list: api.list,
    },
    Pretrained: {
      listModels: api.pretrained,
    },
    FileValidation: {
      example: api.example,
    },
    Models: {
      exampleSet: api.exampleSet,
      listModels: api.saved,
      importModel: api.importModel,
    },
  },
}))

/** The committed synthetic example shape (PROV-FV-4: ids J0000../P0001..). */
const PATIENTS_CSV = [
  'patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage',
  'P0001,560,0,560,0,72,F,IV',
  'P0002,230,1,231,1,64,M,III',
].join('\n')

const MEASUREMENTS_CSV = [
  'patient_id,day,marker,value,unit',
  'P0001,0,ldh,210,U/L',
  'P0001,14,LDH,260,U/L',
  'P0001,28,cea,3.1,ng/mL',
].join('\n')

const PREDICT_CSV = [
  'patient_id,day,marker,value,unit',
  'J1000,0,M1,1.2,a.u.',
].join('\n')

/** The live runnable-set size the mocked list response reports. */
const RUNNABLE_COUNT = 359

/** A store row with a provenance (the counts hook filters by it). */
function modelRow(id: string, provenance: 'run' | 'imported' | 'pretrained') {
  return { id, provenance }
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderStart() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      {/* The card buttons run the registered flow.startPath / flow.useExample
          / models.openModelFile (their navigation goes through the router
          bridge, as in the app). */}
      <RouterBridge />
      <StartPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const routeAt = () => screen.getByTestId('route-location').textContent
const store = () => useTxrIntakeStore.getState()

/** Set the hidden picker input's files and fire its change (jsdom files). */
function pickModelFile(testid: string, file: File): void {
  const input = screen.getByTestId(testid) as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  api.list.mockReset()
  api.example.mockReset()
  api.exampleSet.mockReset()
  api.pretrained.mockReset()
  api.saved.mockReset()
  api.importModel.mockReset()
  api.list.mockResolvedValue({ methods: [], total: RUNNABLE_COUNT })
  // One released ready-made model: lab > 0, state A, the badge on predict.
  api.pretrained.mockResolvedValue({ models: [{ id: 'relchange-threshold' }], origin: 'embedded' })
  // No store models (the counts hook filters by provenance; none means zero).
  api.saved.mockResolvedValue({ models: [], total: 0 })
  // The example set answers ready (the poll settles in one round).
  api.exampleSet.mockResolvedValue({
    state: 'ready',
    set_id: 'set-1',
    methods: ['kelim'],
    run_id: undefined,
    run_status: undefined,
    error: undefined,
  })
  api.importModel.mockResolvedValue({ models: [], set_id: undefined })
  api.example.mockImplementation(({ kind }: { kind: 'patients' | 'measurements' | 'predict-measurements' }) =>
    Promise.resolve(
      kind === 'patients' ? PATIENTS_CSV : kind === 'measurements' ? MEASUREMENTS_CSV : PREDICT_CSV,
    ),
  )
  // The human picker path's user-activation flag (the agent path has none).
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive: true },
  })
  window.localStorage.clear()
  store().reset()
  // ITEM-10: the count hook's module-level cache is one per-session key —
  // a settled value must not leak into the failure tests below.
  __resetFetchCacheForTests()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('StartPage (TEST-INT-11, ITEM-4, predict-card merge round 1)', () => {
  it('renders the two path cards with the state-A board copy', async () => {
    renderStart()
    const predict = screen.getByTestId('txr-intake-start-card-predict')
    // The counts settle asynchronously — the state-A eyebrow IS the settled
    // mark (the loading state shows skeletons instead).
    expect(await within(predict).findByText('Uses a trained model')).toBeTruthy()
    expect(within(predict).getByText('Predict new patients')).toBeTruthy()
    expect(
      within(predict).getByText(
        'Add the blood measurements of the patients you want predictions for, then pick any models that can run on them: ready-made models from the lab, models you saved, or models opened from a file.',
      ),
    ).toBeTruthy()
    expect(await within(predict).findByText('Recommended to start')).toBeTruthy()
    expect(within(predict).getByText('Works with a small cohort, and with no outcomes')).toBeTruthy()
    expect(
      within(predict).getByText('The app checks your file and shows which models can run'),
    ).toBeTruthy()
    expect(within(predict).getByText('Mix a lab model and your own in the same run')).toBeTruthy()
    expect(screen.getByText('Most flexible')).toBeTruthy()
    expect(screen.getByText('Learn from my data')).toBeTruthy()
    // The old cards are gone — never a hidden second predict surface.
    expect(screen.queryByTestId('txr-intake-start-card-pretrained')).toBeNull()
    expect(screen.queryByTestId('txr-intake-start-card-reuse')).toBeNull()
    // The two cards carry no count clause (OWNER-7) — the board's model
    // counts are design examples (DEC-13).
    expect(screen.queryByText(/^\d+ models/)).toBeNull()
  })

  it('renders the live runnable method count on the learn card', async () => {
    renderStart()
    await waitFor(() => {
      expect(screen.getByText(`${RUNNABLE_COUNT} methods, with the time each will take`)).toBeTruthy()
    })
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.list).toHaveBeenCalledWith({ runnable: true })
  })

  it('degrades to the number-free line when the count fetch fails', async () => {
    api.list.mockRejectedValueOnce(new Error('catalogue down'))
    renderStart()
    await waitFor(() => {
      expect(screen.getByText('Methods, with the time each will take')).toBeTruthy()
    })
    expect(screen.queryByText(new RegExp(`${RUNNABLE_COUNT} methods`))).toBeNull()
  })

  it('sets the intent and navigates from each card button', () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-intake-start-card-predict-cta'))
    expect(routeAt()).toBe('/predict-files')
    expect(store().intent).toBe('predict')
    expect(store().mode).toBe('predict')
    // The unified card's button pins no source (round 1's bridge then goes
    // to the saved-models list; round 2's /choose-models reads it).
    expect(store().predictSource).toBeNull()

    fireEvent.click(screen.getByTestId('txr-intake-start-card-train-cta'))
    // The learn path starts with its files (the study questions come after).
    expect(routeAt()).toBe('/files')
    expect(store().intent).toBe('train')
    expect(store().mode).toBe('study')
  })

  it('spaces each card\'s button from its Use example button, on one row', () => {
    renderStart()
    for (const path of ['predict', 'train']) {
      const row = screen.getByTestId(`txr-intake-start-card-${path}-cta`).parentElement!
      expect(within(row).getByTestId(`txr-use-example-${path}`)).toBeTruthy()
      expect(row.style.gap, path).toBe('10px')
      expect(row.style.flexWrap, path).not.toBe('wrap')
    }
  })

  it('links the banner clause to the study screen', () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-intake-start-unsure'))
    expect(routeAt()).toBe('/study')
  })

  it('Use example — learn: train intent + both example files + the filled answers, then /files', async () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-train'))

    await waitFor(() => {
      expect(routeAt()).toBe('/files')
    })
    expect(api.example).toHaveBeenCalledTimes(2)
    expect(api.example).toHaveBeenCalledWith({ kind: 'patients' })
    expect(api.example).toHaveBeenCalledWith({ kind: 'measurements' })
    expect(store().intent).toBe('train')
    expect(store().mode).toBe('study')
    // Every study answer is filled consistently with the example family —
    // the disease and the treatment questions stay UNANSWERED (the example
    // has no real disease or drug; an unanswered filter question is omitted
    // from the requests, never a guessed id).
    expect(store().study.disease).toBeNull()
    expect(store().study.treatments).toBeNull()
    expect(store().study.lastDrawDay).toBe(56)
    expect(store().parameters.decision_day).toBe(56)

    const patients = store().patients
    expect(patients?.source.name).toBe('patients_example.csv')
    expect(patients?.table.columns).toEqual([
      'patient_id',
      'pfs_days',
      'pfs_event',
      'os_days',
      'os_event',
      'age',
      'sex',
      'stage',
    ])
    expect(patients?.table.rows).toHaveLength(2)
    expect(patients?.table.rows[1]?.[0]).toBe('P0002')

    const measurements = store().measurements
    expect(measurements?.source.name).toBe('measurements_example.csv')
    expect(measurements?.table.rows).toHaveLength(3)
    expect(measurements?.table.rows[2]?.[2]).toBe('cea')
    // The C screen's banner fact + the per-slot badges.
    expect(store().exampleLoaded).toBe(true)
    expect(store().exampleSlots.patients).toBe(true)
    expect(store().exampleSlots.measurements).toBe(true)
  })

  it('Use example — predict (state A): predict intent + the example predict table + the example set, then /predict-files', async () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-predict'))

    await waitFor(() => {
      expect(routeAt()).toBe('/predict-files')
    })
    expect(api.example).toHaveBeenCalledTimes(1)
    expect(api.example).toHaveBeenCalledWith({ kind: 'predict-measurements' })
    expect(api.exampleSet).toHaveBeenCalledTimes(1)
    expect(store().intent).toBe('predict')
    expect(store().predictSource).toBe('saved')
    expect(store().mode).toBe('predict')
    expect(store().predictMeasurements?.source.name).toBe('predict-measurements_example.csv')
    expect(store().predictMeasurements?.table.rows[0]?.[0]).toBe('J1000')
    expect(store().exampleSlots.predictMeasurements).toBe(true)
    expect(store().pendingExampleSetId).toBe('set-1')
  })

  it('renders the web-URL notice only on a http: server context (DEC-12)', () => {
    renderStart()
    expect(screen.getByTestId('txr-intake-web-url')).toBeTruthy()
    expect(screen.getByText(/This app is also available at/)).toBeTruthy()
    cleanup()

    // The desktop shell's scheme (and a file:// context) renders nothing.
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...original, protocol: 'txr:', origin: 'txr://app' },
    })
    try {
      renderStart()
      expect(screen.queryByTestId('txr-intake-web-url')).toBeNull()
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  })
})

describe('state B — no model anywhere (all three counts KNOWN and 0)', () => {
  beforeEach(() => {
    api.pretrained.mockResolvedValue({ models: [], origin: 'embedded' })
    api.saved.mockResolvedValue({ models: [], total: 0 })
  })

  it('the learn card switches its eyebrow and body to the start-here copy; title, bullets and button stay', async () => {
    renderStart()
    await screen.findByTestId('txr-intake-start-card-predict-note')
    const learn = screen.getByTestId('txr-intake-start-card-train')
    expect(within(learn).getByText('Start here: train your first models')).toBeTruthy()
    expect(
      within(learn).getByText(
        'Train the methods on your patients with known outcomes and save them as models. Then predict new patients with them.',
      ),
    ).toBeTruthy()
    expect(within(learn).getByText('Learn from my data')).toBeTruthy()
    expect(
      within(learn).getByText('Needs patients with outcomes (progression or death times)'),
    ).toBeTruthy()
    expect(within(learn).getByTestId('txr-intake-start-card-train-cta').textContent).toBe(
      'Add my data',
    )
  })

  it('the predict card shows the state-B text, the info note, its one bullet and the two buttons', async () => {
    renderStart()
    const predict = screen.getByTestId('txr-intake-start-card-predict')
    const note = await within(predict).findByTestId('txr-intake-start-card-predict-note')
    expect(note.textContent).toContain(
      'Use example first trains a few example models on the example patients',
    )
    expect(note.textContent).toContain('the first time also downloads the methods')
    // The body's "Learn from my data" is bold — the text is split across the
    // <b>'s child, so the matcher reads the <p>'s own textContent.
    expect(
      within(predict).getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent ===
            'Predicts new patients with a trained model: a ready-made one from the lab, one you saved, or one opened from a file. Models you train and save with Learn from my data appear here.',
      ),
    ).toBeTruthy()
    expect(within(predict).getByText('Or open a model file someone gave you')).toBeTruthy()
    // Use example is the primary; Open a model file is the outline.
    const example = screen.getByTestId('txr-use-example-predict')
    expect(example.textContent).toBe('Use example')
    expect(screen.getByTestId('txr-intake-start-card-predict-open-file').textContent).toBe(
      'Open a model file',
    )
    expect(screen.queryByTestId('txr-intake-start-card-predict-cta')).toBeNull()
  })

  it('Use example in state B still adopts the predict file, ensures the set and opens /predict-files', async () => {
    renderStart()
    await screen.findByTestId('txr-intake-start-card-predict-note')
    fireEvent.click(screen.getByTestId('txr-use-example-predict'))
    await waitFor(() => {
      expect(routeAt()).toBe('/predict-files')
    })
    expect(store().intent).toBe('predict')
    expect(store().predictSource).toBe('saved')
    expect(store().exampleSlots.predictMeasurements).toBe(true)
    expect(store().pendingExampleSetId).toBe('set-1')
  })

  it('Open a model file from the start card lands on the Models page; back on the start page state A', async () => {
    let imported = false
    api.importModel.mockImplementation(() => {
      imported = true
      return Promise.resolve({ models: [modelRow('open-1', 'imported')], set_id: undefined })
    })
    // The Models page (after the import) lists the opened model; the SECOND
    // mount of the Start page counts it.
    api.saved.mockImplementation(() =>
      Promise.resolve({
        models: imported ? [modelRow('open-1', 'imported')] : [],
        total: imported ? 1 : 0,
      }),
    )
    renderStart()
    await screen.findByTestId('txr-intake-start-card-predict-cta')
    // The human path: the click opens the picker (user activation active)…
    fireEvent.click(screen.getByTestId('txr-intake-start-card-predict-open-file'))
    // …the picked `.txr` container posts the multipart import and lands on
    // the Models page with the imported model.
    pickModelFile('txr-intake-start-open-model-file-input', new File(['txr-bytes'], 'panel.txr'))
    await waitFor(() => {
      expect(api.importModel).toHaveBeenCalledTimes(1)
      expect(routeAt()).toBe('/models')
    })
    const form = api.importModel.mock.calls[0][0] as FormData
    expect((form.get('file') as File).name).toBe('panel.txr')
    // Back on the start page (a real second mount re-reads the counts), the
    // imported model counts: state A with the plain predictive CTA.
    cleanup()
    renderStart()
    await screen.findByTestId('txr-intake-start-card-predict-cta')
    expect(screen.queryByTestId('txr-intake-start-card-predict-note')).toBeNull()
    expect(store().intent).toBe('train')
  })
})

describe('loading, failed and the badge rule', () => {
  it('loading shows state A\'s title and buttons with skeletons, never the state-B note', () => {
    api.pretrained.mockReturnValue(new Promise(() => {}))
    api.saved.mockReturnValue(new Promise(() => {}))
    renderStart()
    const predict = screen.getByTestId('txr-intake-start-card-predict')
    // State A's title and buttons are there…
    expect(within(predict).getByText('Predict new patients')).toBeTruthy()
    expect(within(predict).getByTestId('txr-intake-start-card-predict-cta')).toBeTruthy()
    // …with skeleton lines where the eyebrow, body and bullets would be.
    expect(within(predict).queryAllByText('Uses a trained model')).toHaveLength(0)
    expect(within(predict).queryByTestId('txr-intake-start-card-predict-note')).toBeNull()
    // The kit's Skeleton stamps `data-slot="skeleton"`.
    expect(predict.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(within(predict).queryAllByText('Works with a small cohort, and with no outcomes')).toHaveLength(0)
  })

  it('loading keeps the learn card in state A (its state-B copy never flashes)', () => {
    api.pretrained.mockReturnValue(new Promise(() => {}))
    api.saved.mockReturnValue(new Promise(() => {}))
    renderStart()
    expect(screen.getByText('Most flexible')).toBeTruthy()
    expect(screen.queryByText('Start here: train your first models')).toBeNull()
  })

  it('a failed count shows state A (never state B)', async () => {
    api.pretrained.mockRejectedValue(new Error('catalogue down'))
    api.saved.mockRejectedValue(new Error('store down'))
    renderStart()
    await waitFor(() => expect(api.pretrained).toHaveBeenCalled())
    await Promise.resolve()
    const predict = screen.getByTestId('txr-intake-start-card-predict')
    expect(within(predict).getByText('Uses a trained model')).toBeTruthy()
    expect(within(predict).getByTestId('txr-intake-start-card-predict-cta')).toBeTruthy()
    expect(within(predict).queryByText('Or open a model file someone gave you')).toBeNull()
    expect(screen.queryByTestId('txr-intake-start-card-predict-note')).toBeNull()
    expect(screen.getByText('Most flexible')).toBeTruthy()
    expect(screen.queryByText('Start here: train your first models')).toBeNull()
  })

  it('a downloaded lab model (provenance pretrained) does not count as saved', async () => {
    api.pretrained.mockResolvedValue({ models: [], origin: 'embedded' })
    api.saved.mockResolvedValue({
      models: [modelRow('downloaded-1', 'pretrained')],
      total: 1,
    })
    renderStart()
    // All three counts are KNOWN and 0 (the downloaded model is neither
    // `run` nor `imported`): state B — it is not a saved model.
    await screen.findByTestId('txr-intake-start-card-predict-note')
    expect(screen.queryByTestId('txr-intake-start-card-predict-cta')).toBeNull()
  })

  it('a run-saved model counts as saved (state A)', async () => {
    api.pretrained.mockResolvedValue({ models: [], origin: 'embedded' })
    api.saved.mockResolvedValue({ models: [modelRow('run-1', 'run')], total: 1 })
    renderStart()
    await screen.findByTestId('txr-intake-start-card-predict-cta')
    expect(screen.queryByTestId('txr-intake-start-card-predict-note')).toBeNull()
  })

  it('an imported model counts as imported (state A)', async () => {
    api.pretrained.mockResolvedValue({ models: [], origin: 'embedded' })
    api.saved.mockResolvedValue({ models: [modelRow('open-1', 'imported')], total: 1 })
    renderStart()
    await screen.findByTestId('txr-intake-start-card-predict-cta')
    expect(screen.queryByTestId('txr-intake-start-card-predict-note')).toBeNull()
  })

  it('the badge is on the predict card when lab > 0, else on learn (also while loading or failed)', async () => {
    // lab > 0: predict.
    renderStart()
    await waitFor(() => {
      expect(
        screen.getByTestId('txr-intake-start-card-predict-badge').textContent,
      ).toBe('Recommended to start')
    })
    expect(screen.queryByTestId('txr-intake-start-card-train-badge')).toBeNull()
    cleanup()

    // No lab model (but saved models exist): learn.
    api.pretrained.mockResolvedValue({ models: [], origin: 'embedded' })
    api.saved.mockResolvedValue({ models: [modelRow('run-1', 'run')], total: 1 })
    renderStart()
    await waitFor(() => {
      expect(screen.getByTestId('txr-intake-start-card-train-badge').textContent).toBe(
        'Recommended to start',
      )
    })
    expect(screen.queryByTestId('txr-intake-start-card-predict-badge')).toBeNull()
    cleanup()

    // Loading (lab unknown): learn.
    api.pretrained.mockReturnValue(new Promise(() => {}))
    api.saved.mockResolvedValue({ models: [], total: 0 })
    renderStart()
    expect(screen.getByTestId('txr-intake-start-card-train-badge')).toBeTruthy()
    cleanup()

    // Failed catalogue read: learn.
    api.pretrained.mockRejectedValue(new Error('catalogue down'))
    renderStart()
    await waitFor(() => expect(api.pretrained).toHaveBeenCalled())
    await Promise.resolve()
    expect(screen.getByTestId('txr-intake-start-card-train-badge')).toBeTruthy()
  })
})

/** A long failure line: the case that broke the card's button row. */
const LONG_ERROR =
  'No method with a published environment can run on the example data on this computer, so the ' +
  'example models could not be prepared. Check the method catalogue and try again.'

const CARD_PATHS = ['predict', 'train'] as const

/** A file the user loaded themselves (no example flag): Use example asks first. */
function ownFile(name = 'mine.csv'): LoadedFile {
  return {
    source: { name, format: 'csv' },
    table: {
      source: { name, format: 'csv' },
      header_row: 1,
      columns: ['patient_id', 'day', 'marker', 'value', 'unit'],
      rows: [['J1000', '0', 'M1', '1.2', 'a.u.']],
    },
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],
    columnOffers: [],
  }
}

/** The data-testids of an element's children, in order. */
const childIds = (el: Element) => Array.from(el.children).map(child => child.getAttribute('data-testid'))

describe('the Use example message sits under the card\'s button row, across the card', () => {
  it('a failure on each card: the error is the card\'s last row, after the buttons, never in the row', async () => {
    api.example.mockRejectedValue(new Error(LONG_ERROR))
    renderStart()
    for (const path of CARD_PATHS) fireEvent.click(screen.getByTestId(`txr-use-example-${path}`))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))

    for (const path of CARD_PATHS) {
      const card = screen.getByTestId(`txr-intake-start-card-${path}`)
      const actions = screen.getByTestId(`txr-intake-start-card-${path}-actions`)
      const row = screen.getByTestId(`txr-intake-start-card-${path}-buttons`)
      const message = screen.getByTestId(`txr-use-example-message-${path}`)
      const error = screen.getByTestId(`txr-use-example-error-${path}`)

      // The actions block is the card's last child: the buttons row, then the message.
      expect(card.lastElementChild, path).toBe(actions)
      expect(actions.style.flexDirection, path).toBe('column')
      expect(childIds(actions), path).toEqual([
        `txr-intake-start-card-${path}-buttons`,
        `txr-use-example-message-${path}`,
      ])
      // The message stretches with the column (no own width or alignment).
      expect(message.style.alignSelf, path).toBe('')
      expect(message.style.width, path).toBe('')
      expect(message.contains(error), path).toBe(true)
      expect(error.getAttribute('role'), path).toBe('alert')
      expect(error.textContent, path).toBe(LONG_ERROR)
      // The row holds the buttons only.
      expect(row.contains(error), path).toBe(false)
      expect(screen.getByTestId(`txr-use-example-${path}`).textContent, path).toBe('Try again')
    }
  })

  it('with no message the card ends with the buttons row alone', () => {
    renderStart()
    for (const path of CARD_PATHS) {
      expect(childIds(screen.getByTestId(`txr-intake-start-card-${path}-actions`)), path).toEqual([
        `txr-intake-start-card-${path}-buttons`,
      ])
    }
  })

  it('the confirm question and its two answers sit under the row, which keeps only the card\'s button', () => {
    store().adoptFile('predictMeasurements', ownFile())
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-predict'))

    const actions = screen.getByTestId('txr-intake-start-card-predict-actions')
    const row = screen.getByTestId('txr-intake-start-card-predict-buttons')
    expect(childIds(row)).toEqual(['txr-intake-start-card-predict-cta'])
    expect(childIds(actions)).toEqual([
      'txr-intake-start-card-predict-buttons',
      'txr-use-example-message-predict',
    ])
    const message = screen.getByTestId('txr-use-example-message-predict')
    expect(within(message).getByTestId('txr-use-example-confirm')).toBeTruthy()
    expect(within(message).getByTestId('txr-use-example-confirm-yes')).toBeTruthy()
    expect(within(message).getByTestId('txr-use-example-confirm-no')).toBeTruthy()

    // "Keep my files" closes the question; the row gets its Use example back.
    fireEvent.click(screen.getByTestId('txr-use-example-confirm-no'))
    expect(screen.queryByTestId('txr-use-example-message-predict')).toBeNull()
    expect(childIds(row)).toEqual([
      'txr-intake-start-card-predict-cta',
      'txr-use-example-predict',
    ])
    expect(store().predictMeasurements?.source.name).toBe('mine.csv')
  })
})

describe('demo mode (ITEM-6) — the card example actions are the primary', () => {
  it('the two card CTAs read "Use the example data"; the plain path buttons and Open a model file are gone', () => {
    seedDemoMode('demo')
    renderStart()
    for (const path of ['train', 'predict']) {
      expect(screen.getByTestId(`txr-use-example-${path}`).textContent).toBe(DEMO_START_PRIMARY)
      expect(screen.getByTestId(`txr-use-example-${path}`).getAttribute('aria-label')).toMatch(/Use example data/)
    }
    // The plain CTAs are replaced, not hidden twice: their testids are gone.
    expect(screen.queryByTestId('txr-intake-start-card-train-cta')).toBeNull()
    expect(screen.queryByTestId('txr-intake-start-card-predict-cta')).toBeNull()
    expect(screen.queryByTestId('txr-intake-start-card-predict-open-file')).toBeNull()
    expect(screen.getByTestId('txr-intake-start-example-hint').textContent).toBe(DEMO_START_HINT)
  })

  it('the demo predict card is state A (the demo has its recorded lab models), with the badge on predict', async () => {
    seedDemoMode('demo')
    renderStart()
    const predict = screen.getByTestId('txr-intake-start-card-predict')
    expect(within(predict).getByText('Uses a trained model')).toBeTruthy()
    expect(await within(predict).findByText('Recommended to start')).toBeTruthy()
    expect(within(predict).queryByTestId('txr-intake-start-card-predict-note')).toBeNull()
  })

  it("the demo primary action fills the flow and lands on the path's file step", async () => {
    seedDemoMode('demo')
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => {
      expect(routeAt()).toBe('/files')
    })
    expect(store().intent).toBe('train')
    expect(store().exampleLoaded).toBe(true)
    expect(store().exampleSlots.patients).toBe(true)
  })

  it('desktop renders the plain CTAs and the old banner hint (untouched byte)', () => {
    seedDemoMode('desktop')
    renderStart()
    expect(screen.getByTestId('txr-intake-start-card-train-cta').textContent).toBe('Add my data')
    expect(screen.getByTestId('txr-intake-start-card-predict-cta').textContent).toBe(
      'Add the patients to predict',
    )
    expect(screen.getByText(/Prefer to try it first/)).toBeTruthy()
  })
})

/** The cards in page order, by their path. */
const cardOrder = () =>
  screen
    .getAllByTestId(/^txr-intake-start-card-(train|predict)$/)
    .map(el => el.getAttribute('data-testid')!.replace('txr-intake-start-card-', ''))

/** Every "Recommended to start" badge on the page, by its card. */
const badgeCards = () =>
  screen
    .queryAllByText('Recommended to start')
    .map(el => el.closest('section')!.getAttribute('data-testid')!.replace('txr-intake-start-card-', ''))

describe('the card layout (the user, 2026-11-19)', () => {
  it('orders the cards: learn from my data, then predict new patients', () => {
    renderStart()
    expect(cardOrder()).toEqual(['train', 'predict'])
  })

  it('highlights no card: both share one 1 px border', () => {
    renderStart()
    const borders = ['train', 'predict'].map(
      path => screen.getByTestId(`txr-intake-start-card-${path}`).style.border,
    )
    expect(new Set(borders).size).toBe(1)
    expect(borders[0]).toBe('1px solid var(--txr-border)')
  })

  it('gives the two main buttons the same filled look', () => {
    renderStart()
    const looks = ['train', 'predict'].map(path => {
      const { background, color, fontWeight } = screen.getByTestId(`txr-intake-start-card-${path}-cta`).style
      return { background, color, fontWeight }
    })
    for (const look of looks) {
      expect(look).toEqual({ background: 'var(--txr-brand)', color: 'var(--txr-on-brand)', fontWeight: '700' })
    }
  })

  it('labels the cards: most flexible, uses a trained model — the old card labels are gone', async () => {
    renderStart()
    expect(within(screen.getByTestId('txr-intake-start-card-train')).getByText('Most flexible')).toBeTruthy()
    expect(
      await within(screen.getByTestId('txr-intake-start-card-predict')).findByText('Uses a trained model'),
    ).toBeTruthy()
    expect(screen.queryByText('No training needed')).toBeNull()
    expect(screen.queryByText('Repeat a past analysis')).toBeNull()
    expect(screen.queryByText('Quickest')).toBeNull()
  })
})
