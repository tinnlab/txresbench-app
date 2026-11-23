// @vitest-environment jsdom
/**
 * TEST-MOD-11 [acceptance] [invariant: INV-4, INV-7] — screen J (ITEM-8):
 * the `ModelsPage` suite (PROV-UI-MODELS-5).
 *
 * Pinned behaviors:
 *
 * - the board's table: the six visible columns + the Actions column (the
 *   screen-reader-only header), the row sublines — a run row "6 markers ·
 *   uses age" (the grown `marker_count` / `uses_covariates` fields), an
 *   imported row "opened from colleague-panel.txr · 5 markers" with the
 *   "not recorded" trained-on and the "opened 4 Dec 2026" Made entry, a
 *   row with no marker/covariate/import fact rendering the name alone —
 *   the Predicts / Trained-on / Made entries through the ITEM-4 formatters;
 * - the search: debounced 250 ms, then `ApiClient.Models.listModels`
 *   carries the server-side `q` (the generated namespace is `Models` —
 *   DEC-17's table; the TESTS.md draft's `Txr.` namespace was an
 *   editorial slip, corrected at this item);
 * - "Open a model file": a File-constructed pick posts the multipart
 *   import (the `file` part) and refreshes the list;
 * - Use → `setIntent('reuse')` + the module store's pending id +
 *   navigation to `/predict-files` (the DEC-10 handoff);
 * - Export → the generated download (the provider's attachment saved
 *   under the sanitised `<name>.txr` — the blob saved, the URL revoked);
 * - Rename → PATCH (`renameModel({id, name})`); Delete → the confirm
 *   dialog whose copy is the board's deletion promise verbatim, then
 *   DELETE; both refresh the inventory;
 * - the footnotes; qa-fixes4 ITEM-1 (results-r3 R3-results-2): the
 *   board's "Models are stored in <path> · Open the folder" line is GONE —
 *   the footnote renders the kept-models sentence, and neither the path
 *   nor the folder button exists in web or mocked-desktop mode (the
 *   models root is an internal host fact);
 * - the `?set=` focus: the provider's `set_id` filter + the "Showing the
 *   set … · Show all" affordance (DEC-19, CONS-HIST-16);
 * - the states: the first-load line, the error + Retry, the empty state
 *   with the Open-a-model-file CTA, the honest no-match line.
 *
 * Every fixture value is synthetic (INV-4): the module's own J payload
 * (`TXRMODELS_J_RESPONSE` — four rows, 42 patients in the fixture family,
 * days 60/35, horizons 240/165) — the boards' numbers are never constants
 * here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ModelListResponse, ModelSetListResponse, ModelSummary } from '@/api-client/types'
import { DEMO_POOL_STATEMENT } from '@/modules/demo/copy'
import { resetDemoMode, seedDemoMode } from '@/modules/demo/test-utils/demoSeed'
import { useStepTrailStore, useTxrIntakeStore } from '@/modules/txrintake'
import {
  TXRMODELS_J_RESPONSE,
  TXRMODELS_MODEL_SET_LIST,
  fixtureModelId,
} from '../fixtures'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { ModelsPage } from './ModelsPage'
import '@/core/actions/builtin/stepActions'
import { RouterBridge } from '@/core/actions/navigateBridge'

// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Input/Button) construct one on pointer interaction, which would
// throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in (the sibling suites' shim, copied).
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

// jsdom has no ResizeObserver either (the kit Input's adornment path).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  listSets: vi.fn(),
  renameModel: vi.fn(),
  deleteModel: vi.fn(),
  importModel: vi.fn(),
  exportModel: vi.fn(),
  getUsage: vi.fn(),
}))
vi.mock('@/api-client', () => ({
  ApiClient: {
    Models: {
      listModels: api.listModels,
      renameModel: api.renameModel,
      deleteModel: api.deleteModel,
      importModel: api.importModel,
      exportModel: api.exportModel,
    },
    ModelSets: {
      listSets: api.listSets,
    },
    History: {
      getUsage: api.getUsage,
    },
  },
}))

// ── jsdom download stubs (the export's blob + anchor path) ────────────────
const createObjectURL = vi.fn((_blob: Blob) => 'blob:txr-models-test')
const revokeObjectURL = vi.fn((url: string) => {})
const clickSpy = vi.fn()
const invokeSpy = vi.fn((_cmd: string, _args: unknown) => Promise.resolve())

function LocationProbe() {
  const location = useLocation()
  return (
    <div data-testid="route-location">
      {location.pathname}
      {location.search}
    </div>
  )
}

function renderPage(initialEntry = '/models') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      {/* "Use" runs the registered models.useModel; its navigation goes
          through the router bridge, as in the app. */}
      <RouterBridge />
      <ModelsPage />
      <LocationProbe />
    </MemoryRouter>,
  )
}

/** Flush the pending microtasks (the mount fetch) + advance timers. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The J fixture's first row (the run row with the full subline). */
const RUN_ROW = TXRMODELS_J_RESPONSE.models[0]

/** The J fixture's imported row. */
const IMPORTED_ROW = TXRMODELS_J_RESPONSE.models[2]

/** The J fixture's no-facts row. */
const PLAIN_ROW = TXRMODELS_J_RESPONSE.models[3]

/** A File-constructed pick of a model container (never a real file). */
function pickFile(): File {
  return new File(['txr-bytes'], 'colleague-panel.txr', { type: 'application/octet-stream' })
}

/** Set the hidden file input's files and fire its change (jsdom files). */
function pickImport(): void {
  const input = screen.getByTestId('txr-models-import-file') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [pickFile()], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(api)) fn.mockReset()
  // The server-side read: `q`/`set_id` filter the fixture rows, exactly as
  // the provider's substring + set filter answers the real screen (a
  // search/focus view serves the honest subset).
  api.listModels.mockImplementation(async (params?: { q?: string; set_id?: string }) => {
    const q = (params?.q ?? '').toLowerCase()
    const setId = params?.set_id ?? null
    const models = TXRMODELS_J_RESPONSE.models.filter(model => {
      if (setId !== null && model.set_id !== setId) return false
      if (q.length === 0) return true
      return `${model.name} ${model.method_id}`.toLowerCase().includes(q)
    })
    return {
      models,
      total: models.length,
      models_dir: TXRMODELS_J_RESPONSE.models_dir,
    }
  })
  api.listSets.mockResolvedValue(TXRMODELS_MODEL_SET_LIST)
  api.renameModel.mockImplementation(async (args: { id: string; name: string }) => {
    const model = TXRMODELS_J_RESPONSE.models.find(m => m.id === args.id)
    return { ...(model as ModelSummary), name: args.name }
  })
  api.deleteModel.mockResolvedValue(undefined)
  api.importModel.mockResolvedValue({ models: [], set_id: undefined })
  api.exportModel.mockResolvedValue(new Blob(['txr-bytes']))
  useTxrIntakeStore.getState().reset()
  useTxrModelsStore.getState().reset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  clickSpy.mockClear()
  invokeSpy.mockClear()
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    value: clickSpy,
    writable: true,
    configurable: true,
  })
  // Web mode is the birth state; the desktop arms opt in per test.
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ModelsPage — TEST-MOD-11 (screen J)', () => {
  it("renders the board header, the table's columns and the row sublines with the fallbacks", async () => {
    renderPage()
    await settle(0)
    expect(screen.getByRole('heading', { name: 'Your models' })).toBeTruthy()
    expect(
      screen.getByText(
        'Every model you train is kept here, so you can predict new patients later without training again.',
      ),
    ).toBeTruthy()
    // The board's six visible columns (every section's table is the SAME
    // table — the flat page's columns, now per set — so the equality check
    // runs over ALL of them, never only the first).
    for (const table of screen.getAllByTestId('txr-models-j-table')) {
      const headers = within(table).getAllByRole('columnheader').map(th => th.textContent)
      expect(headers).toEqual([
        'Model',
        'Method',
        'Predicts',
        'Decision day',
        'Trained on',
        'Made',
        'Actions',
      ])
    }
    // The run row: mono method, the grown subline, the board's facts words.
    const runRow = screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)
    expect(within(runRow).getByText(RUN_ROW.name)).toBeTruthy()
    expect(within(runRow).getByText('6 markers \u00b7 uses age')).toBeTruthy()
    expect(within(runRow).getByText(RUN_ROW.method_id)).toBeTruthy()
    expect(within(runRow).getByText('progression, death by day 240')).toBeTruthy()
    expect(within(runRow).getByText('42 patients')).toBeTruthy()
    expect(within(runRow).getByText('29 Nov 2026')).toBeTruthy()
    // The imported row: the "opened from …" subline, the "not recorded"
    // trained-on and the "opened …" Made entry (the board's two facts).
    const importedRow = screen.getByTestId(`txr-models-row-${IMPORTED_ROW.id}`)
    expect(within(importedRow).getByText('opened from colleague-panel.txr \u00b7 5 markers')).toBeTruthy()
    expect(within(importedRow).getByText('not recorded')).toBeTruthy()
    expect(within(importedRow).getByText('opened 4 Dec 2026')).toBeTruthy()
    // The plain row: the name alone, no subline.
    const plainRow = screen.getByTestId(`txr-models-row-${PLAIN_ROW.id}`)
    expect(within(plainRow).getByText(PLAIN_ROW.name)).toBeTruthy()
    expect(
      within(plainRow).queryByText(/markers|uses age|opened from/),
    ).toBeNull()
    // The four row actions per row.
    for (const model of TXRMODELS_J_RESPONSE.models) {
      expect(screen.getByTestId(`txr-models-use-${model.id}`)).toBeTruthy()
      expect(screen.getByTestId(`txr-models-export-${model.id}`)).toBeTruthy()
      expect(screen.getByTestId(`txr-models-rename-${model.id}`)).toBeTruthy()
      expect(screen.getByTestId(`txr-models-delete-${model.id}`)).toBeTruthy()
    }
  })

  it('groups the inventory into one section per set, newest set first, then the not-in-a-set section', async () => {
    renderPage()
    await settle(0)
    // The three sections in DOM order: set-a (newer), set-b, then the
    // not-in-a-set bucket (the imported row with no set).
    const ids = screen
      .getAllByTestId(/^txr-models-j-section-/)
      .map(el => el.getAttribute('data-testid'))
    expect(ids).toEqual([
      'txr-models-j-section-set-a',
      'txr-models-j-section-set-b',
      'txr-models-j-section-__none__',
    ])

    // The section header: the set name + the facts line from the
    // SetSummary (model_count, run source_label, created_at — engine
    // facts, never a constant; the count is the set's model_count, not the
    // two rows listed).
    const setA = screen.getByTestId('txr-models-j-section-set-a')
    expect(within(setA).getByRole('heading', { name: 'CRC cohort, day 60' })).toBeTruthy()
    expect(
      within(setA).getByText(
        '7 models \u00b7 from the run \u201cpatients.csv\u201d \u00b7 made 29 Nov 2026',
      ),
    ).toBeTruthy()
    const setB = screen.getByTestId('txr-models-j-section-set-b')
    expect(within(setB).getByRole('heading', { name: 'Lung pilot, day 35' })).toBeTruthy()
    expect(
      within(setB).getByText(
        '3 models \u00b7 from the run \u201clung-pilot.csv\u201d \u00b7 made 9 Oct 2026',
      ),
    ).toBeTruthy()

    // The not-in-a-set section: the board name + the bare count line.
    const none = screen.getByTestId('txr-models-j-section-__none__')
    expect(within(none).getByRole('heading', { name: 'Not in a set' })).toBeTruthy()
    expect(within(none).getByText('1 model')).toBeTruthy()
    // The imported row (no set) lives in that section.
    expect(within(none).getByTestId(`txr-models-row-${IMPORTED_ROW.id}`)).toBeTruthy()

    // Every section still owns the SAME table: columns + data-labels.
    for (const section of [setA, setB, none]) {
      const table = within(section).getByTestId('txr-models-j-table')
      expect(within(table).getAllByRole('columnheader')).toHaveLength(7)
    }

    // The a11y wiring: each section's h2 carries the `txr-models-j-title-<key>`
    // id and labels its own <section> and <table> by it.
    for (const section of [setA, setB, none]) {
      const key = section.getAttribute('data-testid')?.slice('txr-models-j-section-'.length)
      const titleId = `txr-models-j-title-${key}`
      expect(section.getAttribute('aria-labelledby')).toBe(titleId)
      const heading = within(section).getByRole('heading', { level: 2 })
      expect(heading.getAttribute('id')).toBe(titleId)
      expect(
        within(section).getByTestId('txr-models-j-table').getAttribute('aria-labelledby'),
      ).toBe(titleId)
    }
  })

  it('while a sets re-read is in flight, a model of a brand-new set is grouped by its own set_name (never a Not-in-a-set flash)', async () => {
    // The first paint waits for both first responses (they fire in
    // parallel); a later mutation-style refresh re-reads both. The models
    // re-read answers first with a row of a set the previous sets response
    // never knew — the fallback grouping (the sets re-read still pending)
    // must name the section from the row's own set_name, never flash the
    // model into "Not in a set".
    renderPage()
    await settle(0)
    const fresh = {
      ...IMPORTED_ROW,
      id: 'a0000000-0000-4000-8000-0000000000f1',
      set_id: 'set-imported-now',
      set_name: 'Imported tonight',
    }
    api.listModels.mockResolvedValue({ ...TXRMODELS_J_RESPONSE, models: [fresh], total: 1 })
    api.listSets.mockImplementation(
      () => new Promise<ModelSetListResponse>(() => {}),
    )
    pickImport()
    await settle(0)
    // The new set's section, named from the row's own set_name.
    const section = screen.getByTestId('txr-models-j-section-set-imported-now')
    expect(within(section).getByRole('heading', { name: 'Imported tonight' })).toBeTruthy()
    // "Not in a set" does not appear while the sets read is in flight.
    expect(screen.queryByTestId('txr-models-j-section-__none__')).toBeNull()
  })

  it('a failed sets read keeps the rows grouped by set_name and shows the muted sets-error line', async () => {
    api.listSets.mockRejectedValue(new Error('sets down'))
    renderPage()
    await settle(0)
    // The rows still render, grouped by the rows' own set_name (the sets
    // read is a secondary facts source — the inventory is the truth).
    const setA = screen.getByTestId('txr-models-j-section-set-a')
    expect(within(setA).getByRole('heading', { name: 'CRC cohort, day 60' })).toBeTruthy()
    // The facts line falls back to the LISTED count (no SetSummary facts).
    expect(within(setA).getByText('2 models')).toBeTruthy()
    expect(screen.getByTestId('txr-models-j-section-set-b')).toBeTruthy()
    expect(screen.getByTestId('txr-models-j-section-__none__')).toBeTruthy()
    // The muted one-line announcement under the header area.
    expect(screen.getByTestId('txr-models-j-sets-error').textContent).toBe(
      'The set details could not be loaded.',
    )
  })

  it('the set-focus view shows only the focused set\'s section (and the banner stays)', async () => {
    renderPage('/models?set=set-a')
    await settle(0)
    expect(api.listModels).toHaveBeenCalledWith({ set_id: 'set-a' })
    expect(screen.getByTestId('txr-models-j-section-set-a')).toBeTruthy()
    expect(screen.queryByTestId('txr-models-j-section-set-b')).toBeNull()
    expect(screen.queryByTestId('txr-models-j-section-__none__')).toBeNull()
    expect(screen.getByTestId('txr-models-j-set-focus')).toBeTruthy()
  })

  it('hides sections with no matching model under the server-side search; the facts line keeps the set\'s model_count', async () => {
    renderPage()
    await settle(0)
    // The server answers the q with only set-b's rows (the provider's
    // substring filter — the page never client-filters).
    api.listModels.mockResolvedValue({
      ...TXRMODELS_J_RESPONSE,
      models: TXRMODELS_J_RESPONSE.models.filter(model => model.set_id === 'set-b'),
      total: 3,
    })
    fireEvent.change(screen.getByTestId('txr-models-j-search'), {
      target: { value: 'lung' },
    })
    await settle(250)
    await settle(0)
    expect(screen.queryByTestId('txr-models-j-section-set-a')).toBeNull()
    expect(screen.queryByTestId('txr-models-j-section-__none__')).toBeNull()
    const setB = screen.getByTestId('txr-models-j-section-set-b')
    // The facts line is the set's OWN count (model_count), never the
    // filtered view's row count.
    expect(
      within(setB).getByText(
        '3 models \u00b7 from the run \u201clung-pilot.csv\u201d \u00b7 made 9 Oct 2026',
      ),
    ).toBeTruthy()
    // And a search with no hits at all keeps the honest no-match line.
    api.listModels.mockResolvedValue({ ...TXRMODELS_J_RESPONSE, models: [], total: 0 })
    fireEvent.change(screen.getByTestId('txr-models-j-search'), {
      target: { value: 'zzz' },
    })
    await settle(250)
    await settle(0)
    expect(screen.getByTestId('txr-models-j-no-match').textContent).toContain(
      'Nothing matches here.',
    )
    // Zero sections — the *AllBy query throws on an empty result, so the
    // honest no-section assertion is the `queryAll` variant.
    expect(screen.queryAllByTestId(/^txr-models-j-section-/)).toHaveLength(0)
  })

  it('debounces the search 250 ms and hits the generated client with the server q', async () => {
    renderPage()
    await settle(0)
    expect(api.listModels).toHaveBeenCalledTimes(1)
    expect(api.listModels).toHaveBeenCalledWith({})
    fireEvent.change(screen.getByTestId('txr-models-j-search'), {
      target: { value: 'ldh' },
    })
    await settle(249)
    expect(api.listModels).toHaveBeenCalledTimes(1)
    await settle(2)
    expect(api.listModels).toHaveBeenCalledTimes(2)
    expect(api.listModels).toHaveBeenLastCalledWith({ q: 'ldh' })
    const search = screen.getByTestId('txr-models-j-search')
    expect(search.getAttribute('aria-label')).toBe('Search models')
    // RES-18: the board's placeholder is on the box too (the box was
    // aria-only, invisible at a glance; the dark-mode palette half is
    // ITEM-7's).
    expect(search.getAttribute('placeholder')).toBe('Search models')
  })

  it('renders the marker kind and the set segment on the subline (RES-19/RES-17)', async () => {
    renderPage()
    await settle(0)
    // The catalogue-any row (kind any, count 0): "any marker", never
    // "0 markers" — the report's row said "0 markers" for a method that
    // runs on any ctDNA marker.
    const anyRow = within(screen.getByTestId(`txr-models-row-${fixtureModelId(16)}`))
    expect(anyRow.getByText(/any marker/)).toBeTruthy()
    expect(anyRow.queryByText(/0 markers/)).toBeNull()
    // The same-name row from another set: the set segment is the
    // distinguisher in the inventory (the 12-rows-6-names-twice report).
    const sameNameRow = within(screen.getByTestId(`txr-models-row-${fixtureModelId(15)}`))
    expect(
      sameNameRow.getByText("6 markers \u00b7 uses age \u00b7 from the set 'Second run, day 60'"),
    ).toBeTruthy()
    // The board-shaped row whose set name equals its display name shows
    // no duplicate set segment.
    expect(within(screen.getByTestId(`txr-models-row-${fixtureModelId(11)}`)).getByText('6 markers \u00b7 uses age')).toBeTruthy()
  })

  it('labels every J table cell for the phone card layout (RES-16)', async () => {
    renderPage()
    await settle(0)
    const row = screen.getByTestId(`txr-models-row-${fixtureModelId(11)}`)
    const labels = [...row.querySelectorAll('th, td')].map(cell => cell.getAttribute('data-label'))
    expect(labels).toEqual(['Model', 'Method', 'Predicts', 'Decision day', 'Trained on', 'Made', 'Actions'])
    // qa-fixes4 ITEM-6 (results-r3 R3-results-12): the Made entry is one
    // date ("10 Nov 2026") — never wrapped across lines ("10 Nov / 2026").
    const made = row.querySelector('td[data-label="Made"]') as HTMLElement
    expect(made.style.whiteSpace).toBe('nowrap')
  })

  it('posts the multipart import and refreshes the list (success), and surfaces a failure inline', async () => {
    renderPage()
    await settle(0)
    pickImport()
    await settle(0)
    expect(api.importModel).toHaveBeenCalledTimes(1)
    const form = api.importModel.mock.calls[0][0] as FormData
    expect(form.get('file')).toBeInstanceOf(File)
    expect((form.get('file') as File).name).toBe('colleague-panel.txr')
    // The refresh re-reads the inventory.
    expect(api.listModels.mock.calls.length).toBe(2)

    api.importModel.mockRejectedValue(new Error('INVALID_CONTAINER'))
    pickImport()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-import-error').textContent).toBe('INVALID_CONTAINER')
  })

  it('Use sets the reuse intent + the pending model id and navigates to the predict-files screen', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-use-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    // RES-21: the handoff announces the chosen model's id + name on the
    // URL (the "?set=" view precedent) so the N screen names it.
    expect(screen.getByTestId('route-location').textContent).toBe(
      '/predict-files?use=a0000000-0000-4000-8000-000000000011&name=CRC%20cohort%2C%20day%2060',
    )
    expect(useTxrIntakeStore.getState().intent).toBe('reuse')
    expect(useTxrModelsStore.getState().pendingUseModelId).toBe(RUN_ROW.id)
  })

  it('Use starts the step trail here: Back from the predict-files step returns to Your models (and this page has no Back)', async () => {
    useStepTrailStore.setState({ trail: ['/', '/study', '/files'], current: null, leaving: false })
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-step-back')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-use-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    expect(useStepTrailStore.getState().trail).toEqual(['/models'])
  })

  it('Export saves the provider attachment under the sanitised model name', async () => {
    renderPage()
    await settle(0)
    const createElement = vi.spyOn(document, 'createElement')
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-export-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    expect(api.exportModel).toHaveBeenCalledWith({ id: RUN_ROW.id })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const anchor = createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('CRC-cohort-day-60.txr')
    expect(anchor.href).toBe('blob:txr-models-test')
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:txr-models-test')
    createElement.mockRestore()
  })

  it('in the desktop app, Export… opens the Save dialog, writes the file and says where it went', async () => {
    const invoke = vi.fn((cmd: string, ..._rest: unknown[]) =>
      Promise.resolve(cmd === 'plugin:dialog|save' ? '/Users/me/Models/CRC-cohort-day-60.txr' : null),
    )
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } }
    try {
      renderPage()
      await settle(0)
      const button = screen.getByTestId(`txr-models-export-${RUN_ROW.id}`)
      expect(button.textContent).toBe('Export…')
      await act(async () => {
        fireEvent.click(button)
        await Promise.resolve()
      })
      await vi.waitFor(() => expect(screen.getByTestId('txr-models-j-export-saved')).toBeTruthy())
      expect(invoke.mock.calls[0][0]).toBe('plugin:dialog|save')
      expect(invoke.mock.calls[0][1]).toMatchObject({
        options: {
          defaultPath: 'CRC-cohort-day-60.txr',
          filters: [{ name: 'TxResBench model', extensions: ['txr'] }],
        },
      })
      expect(invoke.mock.calls[1][0]).toBe('save_file')
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(screen.getByTestId('txr-models-j-export-saved').textContent).toContain(
        'Saved to /Users/me/Models/CRC-cohort-day-60.txr',
      )
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    }
  })

  it('on the website the button still says Export', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId(`txr-models-export-${RUN_ROW.id}`).textContent).toBe('Export')
  })

  it('Rename opens the dialog with the current label prefilled and PATCHes; Delete confirms with the board promise and DELETEs', async () => {
    renderPage()
    await settle(0)
    // Rename: prefill → change → confirm → PATCH + refresh.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-rename-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    const input = screen.getByTestId(`txr-models-rename-dialog-${RUN_ROW.id}-input`)
    expect((input as HTMLInputElement).value).toBe(RUN_ROW.name)
    fireEvent.change(input, { target: { value: 'Renamed model' } })
    const callsBefore = api.renameModel.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-rename-dialog-${RUN_ROW.id}-confirm`))
      await Promise.resolve()
    })
    expect(api.renameModel).toHaveBeenCalledTimes(callsBefore + 1)
    expect(api.renameModel).toHaveBeenCalledWith({ id: RUN_ROW.id, name: 'Renamed model' })
    expect(api.listModels.mock.calls.length).toBe(2)

    // Delete: the confirm's copy is the board's deletion promise verbatim.
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-delete-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    const body = screen.getByTestId(`txr-models-delete-dialog-${RUN_ROW.id}-body`).textContent
    expect(body).toBe(
      'Deleting a model removes its file. Results already made with it are kept in History.',
    )
    const deletesBefore = api.deleteModel.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-delete-dialog-${RUN_ROW.id}-confirm`))
      await Promise.resolve()
    })
    expect(api.deleteModel).toHaveBeenCalledTimes(deletesBefore + 1)
    expect(api.deleteModel).toHaveBeenCalledWith({ id: RUN_ROW.id })
    expect(api.listModels.mock.calls.length).toBe(3)
  })

  it('renders the kept-models footnote + the deletion note; no path and no folder button in web mode (qa-fixes4 ITEM-1)', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-stored-line').textContent).toBe(
      'Models are kept so you can use them for new patients.',
    )
    expect(
      screen.getByText('Deleting a model removes its file. Results already made with it are kept in History.'),
    ).toBeTruthy()
    // The models root never renders (web mode or not) — the fix is a
    // removal, not a gate.
    expect(screen.queryByTestId('txr-models-j-models-path')).toBeNull()
    expect(screen.queryByTestId('txr-models-open-folder')).toBeNull()
  })

  it('desktop mode also renders no path and no folder button (qa-fixes4 ITEM-1)', async () => {
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: invokeSpy },
    }
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-models-j-models-path')).toBeNull()
    expect(screen.queryByTestId('txr-models-open-folder')).toBeNull()
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('a pathless list response renders the same kept-models footnote', async () => {
    api.listModels.mockResolvedValue({
      models: [],
      total: 0,
    } as ModelListResponse)
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-models-j-models-path')).toBeNull()
    expect(screen.queryByTestId('txr-models-open-folder')).toBeNull()
    expect(screen.getByTestId('txr-models-j-stored-line').textContent).toBe(
      'Models are kept so you can use them for new patients.',
    )
  })

  it('reads the ?set= focus, filters by it, shows the clear affordance and clears the param', async () => {
    renderPage('/models?set=set-a')
    await settle(0)
    expect(api.listModels).toHaveBeenCalledWith({ set_id: 'set-a' })
    expect(screen.getByTestId('txr-models-j-set-focus').textContent).toContain(
      'Showing the set',
    )
    expect(screen.getByTestId('txr-models-j-set-focus').textContent).toContain(
      TXRMODELS_J_RESPONSE.models[0].set_name ?? '',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-j-set-clear'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('route-location').textContent).toBe('/models')
    expect(screen.queryByTestId('txr-models-j-set-focus')).toBeNull()
  })

  it('renders the first-load line, then the error + Retry, then the table on a successful retry', async () => {
    let reject = true
    api.listModels.mockImplementation(() =>
      reject ? Promise.reject(new Error('transport down')) : Promise.resolve(TXRMODELS_J_RESPONSE),
    )
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-error').textContent).toBe('transport down')
    reject = false
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-j-retry'))
      await Promise.resolve()
    })
    await settle(0)
    expect(screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeTruthy()
    // The Retry re-reads the sets too (the section facts must recover with
    // the rows — the two reads are one refresh).
    expect(api.listSets).toHaveBeenCalledTimes(2)
  })

  it('the empty inventory renders the empty state with the Open-a-model-file CTA; a no-hit search is the honest no-match line', async () => {
    api.listModels.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-empty').textContent).toContain('No models yet.')
    expect(screen.getByTestId('txr-models-empty-import')).toBeTruthy()

    api.listModels.mockResolvedValue({ models: [], total: 0 } as ModelListResponse)
    fireEvent.change(screen.getByTestId('txr-models-j-search'), {
      target: { value: 'zzz' },
    })
    await settle(250)
    await settle(0)
    expect(screen.getByTestId('txr-models-j-no-match').textContent).toContain(
      'Nothing matches here.',
    )
    expect(screen.queryByTestId('txr-models-empty-import')).toBeNull()
  })
})

describe('ModelsPage demo arm (TEST-DM-7, ITEM-7)', () => {
  beforeEach(() => {
    seedDemoMode('demo')
    api.getUsage.mockResolvedValue({
      runs: 37,
      run_limit: 50,
      models: 12,
      model_limit: 50,
      pinned_runs: 1,
      pinned_models: 2,
      shared: true,
    })
  })
  afterEach(() => resetDemoMode())

  it('shows the shared-pool statement + "n of 50 models"; import, export, rename and delete are absent', async () => {
    renderPage()
    await settle(0)
    expect(screen.getByTestId('txr-demo-retention-statement').textContent).toBe(DEMO_POOL_STATEMENT)
    expect(screen.getByTestId('txr-demo-retention-counter').textContent).toBe('12 of 50 models')
    // The import affordance + its hidden input are absent (no upload path).
    expect(screen.queryByTestId('txr-models-import')).toBeNull()
    expect(screen.queryByTestId('txr-models-import-file')).toBeNull()
    // The row actions: Use stays, Export/Rename/Delete are absent.
    const row = screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)
    expect(within(row).getByTestId(`txr-models-use-${RUN_ROW.id}`)).toBeTruthy()
    expect(within(row).queryByTestId(`txr-models-export-${RUN_ROW.id}`)).toBeNull()
    expect(within(row).queryByTestId(`txr-models-rename-${RUN_ROW.id}`)).toBeNull()
    expect(within(row).queryByTestId(`txr-models-delete-${RUN_ROW.id}`)).toBeNull()
    // The deletion footnote is the desktop promise — absent in demo.
    expect(screen.queryByText(/Deleting a model removes its file/)).toBeNull()
    expect(screen.getByTestId('txr-models-j-stored-line')).toBeTruthy()
  })

  it('desktop mode keeps the import + the row actions and shows no retention block', async () => {
    seedDemoMode('desktop')
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-demo-retention')).toBeNull()
    expect(screen.getByTestId('txr-models-import')).toBeTruthy()
    const row = screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)
    expect(within(row).getByTestId(`txr-models-export-${RUN_ROW.id}`)).toBeTruthy()
    expect(within(row).getByTestId(`txr-models-rename-${RUN_ROW.id}`)).toBeTruthy()
    expect(within(row).getByTestId(`txr-models-delete-${RUN_ROW.id}`)).toBeTruthy()
  })
})
