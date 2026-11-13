// @vitest-environment jsdom
/**
 * TEST-INT-11 — screen A (`pages/StartPage.tsx`, ITEM-4): the three path
 * cards (board Start.dc.html, DEC-13 copy), the learn card's LIVE runnable
 * count (CONS-UI-INTAKE-3) with its number-free degradation, the intent
 * navigation (pretrained/reuse → `/predict-files`, train → `/study`), the
 * banner's study link, "Use example" on each card (qa-fixes3 ITEM-4: one
 * click fills the path's intent + example files + answers and lands on the
 * path's file step), and the web-URL notice (DEC-12: `http:` dev/web only).
 *
 * The ApiClient is mocked (the txrlist/Datasets-store precedent); the
 * example-data path runs the REAL PROV-FV-7 decode against inline CSV
 * fixtures, and the REAL TxrIntake store is asserted for the intent/file
 * side effects. Navigation is read through a location probe inside the
 * `MemoryRouter` the page renders in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { StartPage } from './StartPage'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { __resetFetchCacheForTests } from '../data/fetchCache'
import type { LoadedFile } from '../types'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  example: vi.fn(),
  exampleSet: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    MethodCatalogue: {
      list: api.list,
    },
    FileValidation: {
      example: api.example,
    },
    Models: {
      exampleSet: api.exampleSet,
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

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="route-location">{location.pathname}</div>
}

function renderStart() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <StartPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

const routeAt = () => screen.getByTestId('route-location').textContent
const store = () => useTxrIntakeStore.getState()

beforeEach(() => {
  api.list.mockReset()
  api.example.mockReset()
  api.exampleSet.mockReset()
  api.list.mockResolvedValue({ methods: [], total: RUNNABLE_COUNT })
  api.example.mockImplementation(({ kind }: { kind: 'patients' | 'measurements' | 'predict-measurements' }) =>
    Promise.resolve(
      kind === 'patients' ? PATIENTS_CSV : kind === 'measurements' ? MEASUREMENTS_CSV : PREDICT_CSV,
    ),
  )
  api.exampleSet.mockResolvedValue({
    state: 'ready',
    set_id: 'set-1',
    methods: ['kelim'],
    run_id: undefined,
    run_status: undefined,
    error: undefined,
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

describe('StartPage (TEST-INT-11, ITEM-4)', () => {
  it('renders the three path cards with the board copy', () => {
    renderStart()
    const pretrained = screen.getByTestId('txr-intake-start-card-pretrained')
    expect(within(pretrained).getByText('Quickest')).toBeTruthy()
    expect(within(pretrained).getByText(/Predict with a pretrained model/)).toBeTruthy()
    expect(within(pretrained).getByText('Recommended to start')).toBeTruthy()
    expect(screen.getByText('Most flexible')).toBeTruthy()
    expect(screen.getByText('Learn from my data')).toBeTruthy()
    expect(screen.getByText('Repeat a past analysis')).toBeTruthy()
    expect(screen.getByText('Use a model I saved')).toBeTruthy()
    // The pretrained + saved cards carry no count clause (OWNER-7) — the
    // board's model counts are design examples (DEC-13).
    expect(screen.queryByText(/^\d+ models/)).toBeNull()
    expect(screen.getByText('The app checks your file and shows which models can run')).toBeTruthy()
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
    fireEvent.click(screen.getByTestId('txr-intake-start-card-pretrained-cta'))
    expect(routeAt()).toBe('/predict-files')
    expect(store().intent).toBe('pretrained')
    expect(store().mode).toBe('predict')

    fireEvent.click(screen.getByTestId('txr-intake-start-card-train-cta'))
    expect(routeAt()).toBe('/study')
    expect(store().intent).toBe('train')
    expect(store().mode).toBe('study')

    fireEvent.click(screen.getByTestId('txr-intake-start-card-reuse-cta'))
    expect(routeAt()).toBe('/predict-files')
    expect(store().intent).toBe('reuse')
    expect(store().mode).toBe('predict')
  })

  it('spaces each card\'s button from its Use example button, on one row', () => {
    renderStart()
    for (const path of ['pretrained', 'train', 'reuse']) {
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
    // Every study answer is filled consistently with the example family.
    expect(store().study.disease).toBe('other')
    expect(store().study.treatment).toBe('other-mixed')
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

  it('Use example — predict: pretrained intent + the example predict table, then /predict-files', async () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-pretrained'))

    await waitFor(() => {
      expect(routeAt()).toBe('/predict-files')
    })
    expect(api.example).toHaveBeenCalledTimes(1)
    expect(api.example).toHaveBeenCalledWith({ kind: 'predict-measurements' })
    expect(store().intent).toBe('pretrained')
    expect(store().mode).toBe('predict')
    expect(store().predictMeasurements?.source.name).toBe('predict-measurements_example.csv')
    expect(store().predictMeasurements?.table.rows[0]?.[0]).toBe('J1000')
    expect(store().exampleSlots.predictMeasurements).toBe(true)
  })

  it('Use example — reuse: ensure the example set, tick it later, then /predict-files', async () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-reuse'))

    await waitFor(() => {
      expect(routeAt()).toBe('/predict-files')
    })
    expect(api.exampleSet).toHaveBeenCalledTimes(1)
    expect(store().intent).toBe('reuse')
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


describe('ITEM-6 L1/L2/L3 — the banner link, the board dots, the distinct saved-model CTA', () => {
  it('the three path cards keep the board dots and the CTA bodies (L2, L3)', () => {
    renderStart()
    const bullets = screen.getByText('Works with a small cohort, and with no outcomes').closest('ul') as HTMLElement
    expect(bullets.style.listStyle).toBe('disc')
    const reuse = screen.getByTestId('txr-intake-start-card-reuse-cta')
    expect(reuse.textContent).toBe('Predict with a model I saved')
    // Only ONE card carries the board's "Add the patients to predict" label
    // with a different action — the two flows are distinguishable (L3).
    expect(screen.getAllByText('Add the patients to predict')).toHaveLength(1)
  })

  it('qa-fixes3 ITEM-4: one Use example button per card, the accessible names naming the paths, and the banner points at them', () => {
    renderStart()
    expect(screen.getByTestId('txr-use-example-train')).toBeTruthy()
    expect(screen.getByTestId('txr-use-example-pretrained')).toBeTruthy()
    expect(screen.getByTestId('txr-use-example-reuse')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Use example data: predict with a pretrained model' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Use example data: learn from my data' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Use example data: use a model I saved' }),
    ).toBeTruthy()
    expect(screen.getByTestId('txr-intake-start-example-hint').textContent).toContain(
      'Use example',
    )
    expect(screen.queryByTestId('txr-intake-start-example')).toBeNull()
  })

  it('Use example records the per-slot example fact; a user adoption clears only that slot (F6)', async () => {
    renderStart()
    fireEvent.click(screen.getByTestId('txr-use-example-train'))
    await waitFor(() => {
      expect(routeAt()).toBe('/files')
    })
    expect(store().exampleLoaded).toBe(true)
    // An adoption of the user's OWN file clears that slot and the
    // aggregate (the badge + banner announce only the example that is
    // still loaded — the FilesPage test renders the banner itself).
    store().adoptFile(
      'patients',
      store().patients as NonNullable<ReturnType<typeof store>['patients']>,
    )
    expect(store().exampleSlots.patients).toBe(false)
    expect(store().exampleSlots.measurements).toBe(true)
    expect(store().exampleLoaded).toBe(true)
    store().adoptFile(
      'measurements',
      store().measurements as NonNullable<ReturnType<typeof store>['measurements']>,
    )
    expect(store().exampleLoaded).toBe(false)
  })
})

/** A long failure line: the case that broke the card's button row. */
const LONG_ERROR =
  'No method with a published environment can run on the example data on this computer, so the ' +
  'example models could not be prepared. Check the method catalogue and try again.'

const CARD_PATHS = ['pretrained', 'train', 'reuse'] as const

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
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(3))

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
      // The row holds the two buttons only.
      expect(childIds(row), path).toEqual([
        `txr-intake-start-card-${path}-cta`,
        `txr-use-example-${path}`,
      ])
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
    fireEvent.click(screen.getByTestId('txr-use-example-pretrained'))

    const actions = screen.getByTestId('txr-intake-start-card-pretrained-actions')
    const row = screen.getByTestId('txr-intake-start-card-pretrained-buttons')
    expect(childIds(row)).toEqual(['txr-intake-start-card-pretrained-cta'])
    expect(childIds(actions)).toEqual([
      'txr-intake-start-card-pretrained-buttons',
      'txr-use-example-message-pretrained',
    ])
    const message = screen.getByTestId('txr-use-example-message-pretrained')
    expect(within(message).getByTestId('txr-use-example-confirm')).toBeTruthy()
    expect(within(message).getByTestId('txr-use-example-confirm-yes')).toBeTruthy()
    expect(within(message).getByTestId('txr-use-example-confirm-no')).toBeTruthy()

    // "Keep my files" closes the question; the row gets its Use example back.
    fireEvent.click(screen.getByTestId('txr-use-example-confirm-no'))
    expect(screen.queryByTestId('txr-use-example-message-pretrained')).toBeNull()
    expect(childIds(row)).toEqual([
      'txr-intake-start-card-pretrained-cta',
      'txr-use-example-pretrained',
    ])
    expect(store().predictMeasurements?.source.name).toBe('mine.csv')
  })
})
