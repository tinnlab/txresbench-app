// @vitest-environment jsdom
/**
 * TEST-MOD-11 [acceptance] [invariant: INV-4, INV-7] — screen J (ITEM-8):
 * the `ModelsPage` suite (PROV-UI-MODELS-5).
 *
 * Pinned behaviors:
 *
 * - the ONE table (the one-table round): the board's seven columns + the
 *   Set column + the Actions column (the screen-reader-only header), the
 *   row sublines — a run row "6 markers · uses age" (the grown
 *   `marker_count` / `uses_covariates` fields), an imported row "opened
 *   from colleague-panel.txr · 5 markers" with the "not recorded"
 *   trained-on and the "opened 4 Dec 2026" Made entry, a row with no
 *   marker/covariate/import fact rendering the name alone — the Predicts /
 *   Trained-on / Made entries through the ITEM-4 formatters;
 * - the set rows: CLOSED by default; the chevron disclosure
 *   (`aria-expanded` + the "Show/Hide the models of “<set>”" label, the
 *   same text on the `title`, no `aria-controls` — the chevron's own row
 *   lives in the tbody it would name) expands/collapses the set's model
 *   rows, and the open sets live in the module-level store — they survive
 *   a re-render AND a remount while the app is open (never persisted to
 *   disk); in the `?set=` focus view the chevron is inert (`disabled`,
 *   still aria-expanded=true);
 * - a set row carries the name + its facts line UNDER it (from the run /
 *   from the file / training files kept — the "N models" part and the made
 *   date moved out: the set row's Model column spells the count and the Made
 *   column the date), the set actions (Rename set · Export set · Delete
 *   set), and the other entries empty;
 * - the no-set models are PLAIN top-level rows: an empty Set entry, no
 *   indentation, no "Not in a set" section heading/facts;
 * - the model rows of a set's expansion are indented in the Model column;
 * - the search: debounced 250 ms, then `ApiClient.Models.listModels`
 *   carries the server-side `q`; a collapsed set with matches stays
 *   collapsed (the group rows work with the filtered response);
 * - "Open a model file": a File-constructed pick posts the multipart
 *   import (the `file` part) and refreshes the list; a failure surfaces
 *   the steady "The model file could not be opened." line, except the
 *   server's 409 SET_NAME_TAKEN, which names the remedy;
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
 *   set … · Show all" affordance (DEC-19, CONS-HIST-16) — the focus view
 *   shows ONLY that set row, always expanded;
 * - the states: the first-load line, the error + Retry, the empty state
 *   with the Open-a-model-file CTA, the honest no-match line;
 * - ONE-TABLE's box byte: the table box (the page's ScrollRegion) is the
 *   scroll container (`overflow: auto`, both axes) and the column headers
 *   are sticky — jsdom cannot measure layout, so the style/class is the
 *   pinned byte; the ~5-row minimum height rides the PAGE spine (not the
 *   box's scrollport), every row carries the 44 px `scroll-margin-top`,
 *   and only the whole table's LAST row drops its bottom border (F1/F2/F8);
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
  TXRMODELS_SET_A,
  TXRMODELS_SET_B,
  fixtureModelId,
} from '../fixtures'
import { useTxrModelsStore } from '../stores/TxrModels.store'
import { clearSetExpansion, isSetExpanded } from '../lib/setExpansion'
import { ModelsPage } from './ModelsPage'
import '@/core/actions/builtin/stepActions'
import '@/core/actions/builtin/modelSetActions'
import { getActionRegistry } from '@/core/actions/defineAction'
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

// The scrollIntoView spy: the page reveals the toggled set row inside the
// box (`block: 'nearest'`) — jsdom cannot scroll, so the call is pinned
// instead (the ChooseMethodsPage precedent).
const scrollIntoViewSpy = vi.fn()

const api = vi.hoisted(() => ({
  listModels: vi.fn(),
  listSets: vi.fn(),
  renameModel: vi.fn(),
  deleteModel: vi.fn(),
  importModel: vi.fn(),
  exportModel: vi.fn(),
  renameSet: vi.fn(),
  deleteSet: vi.fn(),
  exportSet: vi.fn(),
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
      renameSet: api.renameSet,
      deleteSet: api.deleteSet,
      exportSet: api.exportSet,
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

/** Expand (or collapse) one set through its chevron. */
async function toggleSet(setId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`txr-models-set-toggle-${setId}`))
    await Promise.resolve()
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
  clearSetExpansion()
  scrollIntoViewSpy.mockReset()
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoViewSpy,
    configurable: true,
    writable: true,
  })
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
  api.renameSet.mockResolvedValue(TXRMODELS_MODEL_SET_LIST.sets[0])
  api.deleteSet.mockResolvedValue(undefined)
  api.exportSet.mockResolvedValue(new Blob(['txr-set-bytes']))
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
  it("renders the ONE table's columns, the closed sets by default, and the row sublines with the fallbacks", async () => {
    renderPage()
    await settle(0)
    expect(screen.getByRole('heading', { name: 'Your models' })).toBeTruthy()
    expect(
      screen.getByText(
        'Every model you train is kept here, so you can predict new patients later without training again.',
      ),
    ).toBeTruthy()
    // ONE table (never a per-section table) with the board's columns AND
    // the ONE-TABLE Set column.
    const table = screen.getByTestId('txr-models-j-table')
    const headers = within(table).getAllByRole('columnheader').map(th => th.textContent)
    expect(headers).toEqual([
      'Set',
      'Model',
      'Method',
      'Predicts',
      'Decision day',
      'Trained on',
      'Made',
      'Actions',
    ])
    // The set rows: the name + the facts line under it (the "N models" part
    // is the Model column's, the made date the Made column's) + the actions.
    const setA = screen.getByTestId('txr-models-set-row-set-a')
    expect(within(setA).getByText('CRC cohort, day 60')).toBeTruthy()
    expect(within(setA).getByText('from the run \u201cpatients.csv\u201d')).toBeTruthy()
    expect(within(setA).getByText('7 models')).toBeTruthy()
    expect(within(setA).getByText('29 Nov 2026')).toBeTruthy()
    expect(within(setA).getByTestId('txr-models-set-rename-btn-set-a')).toBeTruthy()
    expect(within(setA).getByTestId('txr-models-set-export-btn-set-a')).toBeTruthy()
    expect(within(setA).getByTestId('txr-models-set-delete-btn-set-a')).toBeTruthy()
    const setB = screen.getByTestId('txr-models-set-row-set-b')
    expect(within(setB).getByText('3 models')).toBeTruthy()
    expect(within(setB).getByText('from the run \u201clung-pilot.csv\u201d')).toBeTruthy()
    expect(within(setB).getByText('9 Oct 2026')).toBeTruthy()
    // CLOSED by default: no model row yet.
    expect(screen.queryByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeNull()

    // Expand both sets and assert the model rows (the board's facts words).
    await toggleSet('set-a')
    await toggleSet('set-b')
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

  it('renders ONE table: the set rows newest first, then the no-set model as a plain row with an empty Set entry', async () => {
    renderPage()
    await settle(0)
    // ONE table — never three section tables.
    expect(screen.getAllByTestId('txr-models-j-table')).toHaveLength(1)
    // The old section surface is gone.
    expect(screen.queryAllByTestId(/^txr-models-j-section-/)).toHaveLength(0)
    expect(screen.queryByText('Not in a set')).toBeNull()
    // The set rows in DOM order (newest set first), no model rows (closed).
    const setRowIds = screen
      .getAllByTestId(/^txr-models-set-row-/)
      .map(el => el.getAttribute('data-testid'))
    expect(setRowIds).toEqual(['txr-models-set-row-set-a', 'txr-models-set-row-set-b'])
    // The imported (no-set) model is a plain TOP-LEVEL row after them.
    const importedRow = screen.getByTestId(`txr-models-row-${IMPORTED_ROW.id}`)
    expect(importedRow.getAttribute('data-testid')).toBeTruthy()
    // Its Set entry is EMPTY (and it is not indented — a top-level row).
    const setEntry = importedRow.querySelector('td[data-label="Set"]') as HTMLElement
    expect(setEntry.textContent).toBe('')
    const modelEntry = importedRow.querySelector('th[data-label="Model"]') as HTMLElement
    expect(modelEntry.style.paddingLeft).toBe('')
    // An expanded set's model IS indented (the inSet flag's byte).
    await toggleSet('set-a')
    const runEntry = screen
      .getByTestId(`txr-models-row-${RUN_ROW.id}`)
      .querySelector('th[data-label="Model"]') as HTMLElement
    expect(runEntry.style.paddingLeft).toBe('42px')
    // Every set's chevron carries the label as its `title` too (the
    // tooltip text is the same as the accessible name), and NO
    // `aria-controls`: the chevron's own row would be inside the tbody it
    // names (an aria-controls target must not contain its trigger).
    // Set-a was expanded above, so its label (and title) reads "Hide…".
    expect(
      screen
        .getByTestId('txr-models-set-toggle-set-a')
        .getAttribute('title'),
    ).toBe('Hide the models of \u201cCRC cohort, day 60\u201d')
    expect(
      screen.getByTestId('txr-models-set-toggle-set-b').getAttribute('title'),
    ).toBe('Show the models of \u201cLung pilot, day 35\u201d')
    for (const setId of ['set-a', 'set-b']) {
      const toggle = screen.getByTestId(`txr-models-set-toggle-${setId}`)
      expect(toggle.getAttribute('aria-controls')).toBeNull()
    }
  })

  it('the chevron expands/collapses (aria-expanded + the aria-label/title flip) and reveals the set inside the box; open sets survive a remount', async () => {
    renderPage()
    await settle(0)
    const toggle = screen.getByTestId('txr-models-set-toggle-set-a')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe(
      'Show the models of \u201cCRC cohort, day 60\u201d',
    )
    expect(toggle.getAttribute('title')).toBe(
      'Show the models of \u201cCRC cohort, day 60\u201d',
    )
    expect(screen.queryByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeNull()

    // Expand: aria flips, the models appear, and the reveal scrolls the
    // LAST model row into view (block: nearest — as much of the set as
    // fits; the set row is scrolled after it only if it left the view,
    // and in jsdom every rect is 0, so exactly the one call is pinned).
    await toggleSet('set-a')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe(
      'Hide the models of \u201cCRC cohort, day 60\u201d',
    )
    expect(toggle.getAttribute('title')).toBe(
      'Hide the models of \u201cCRC cohort, day 60\u201d',
    )
    expect(screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeTruthy()
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1)
    expect(scrollIntoViewSpy.mock.calls[0]).toEqual([{ block: 'nearest' }])
    expect(scrollIntoViewSpy.mock.contexts[0]).toBe(
      screen.getByTestId(`txr-models-row-${PLAIN_ROW.id}`),
    )

    // Collapse: the models vanish, the set row stays, and the set row
    // itself is the reveal target (nothing else remains to scroll to).
    await toggleSet('set-a')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeNull()
    expect(screen.getByTestId('txr-models-set-row-set-a')).toBeTruthy()
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(2)
    expect(scrollIntoViewSpy.mock.contexts[1]).toBe(
      screen.getByTestId('txr-models-set-row-set-a'),
    )

    // The module-level store: an open set survives the page's UNMOUNT (and
    // thus a re-render) while the app is open.
    await toggleSet('set-a')
    cleanup()
    renderPage()
    await settle(0)
    const again = screen.getByTestId('txr-models-set-toggle-set-a')
    expect(again.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeTruthy()
  })

  it('while a sets re-read is in flight, the known set rows keep their facts (never a "not recorded" flash)', async () => {
    // The first paint waits for both first responses (they fire in
    // parallel); a later mutation-style refresh re-reads both. The sets
    // re-read does NOT answer yet — the page keeps serving the LAST sets
    // response (brief 4b F9), so a known set row keeps its run-source
    // facts, its count and its made date; the own-facts fallback grouping
    // is the FIRST load's only.
    renderPage()
    await settle(0)
    api.listModels.mockResolvedValue({
      ...TXRMODELS_J_RESPONSE,
      models: TXRMODELS_J_RESPONSE.models.filter(model => model.set_id === 'set-a'),
      total: 2,
    })
    api.listSets.mockImplementation(() => new Promise<ModelSetListResponse>(() => {}))
    pickImport()
    await settle(0)
    // The refresh re-reads both; the sets one is still pending.
    expect(api.listSets.mock.calls.length).toBe(2)
    const setA = screen.getByTestId('txr-models-set-row-set-a')
    expect(within(setA).getByText('from the run \u201cpatients.csv\u201d')).toBeTruthy()
    expect(within(setA).getByText('7 models')).toBeTruthy()
    expect(within(setA).getByText('29 Nov 2026')).toBeTruthy()
    expect(within(setA).queryByText('not recorded')).toBeNull()
    // Set-b has no listed model under this filtered response — it is
    // omitted (the server filtered), never a fact-less ghost row.
    expect(screen.queryByTestId('txr-models-set-row-set-b')).toBeNull()
  })

  it('a model of a brand-new set is a plain top-level row while the sets re-read is pending, then groups once it answers', async () => {
    // The first paint waits for both first responses (they fire in
    // parallel); a later mutation-style refresh re-reads both. The models
    // re-read answers first with a row of a set the PREVIOUS sets response
    // never knew — while the re-read is pending the page serves the LAST
    // response, so the row is the honest plain top-level row (a fabricated
    // set row would invent facts on a set the store does not know yet);
    // when the sets re-read answers with the new set, the row groups.
    renderPage()
    await settle(0)
    const fresh = {
      ...IMPORTED_ROW,
      id: 'a0000000-0000-4000-8000-0000000000f1',
      set_id: 'set-imported-now',
      set_name: 'Imported tonight',
    }
    api.listModels.mockResolvedValue({ ...TXRMODELS_J_RESPONSE, models: [fresh], total: 1 })
    let resolveSets: ((value: ModelSetListResponse) => void) | null = null
    api.listSets.mockImplementation(
      () =>
        new Promise<ModelSetListResponse>(resolve => {
          resolveSets = resolve
        }),
    )
    pickImport()
    await settle(0)
    // The last response is the truth during the re-read: the unknown set
    // id is a plain top-level row, never a fact-less fallback set row.
    const row = screen.getByTestId(`txr-models-row-${fresh.id}`)
    expect(row.querySelector('td[data-label="Set"]')?.textContent).toBe('')
    expect(screen.queryByTestId('txr-models-set-row-set-imported-now')).toBeNull()
    // No "Not in a set" surface anywhere.
    expect(screen.queryByText('Not in a set')).toBeNull()
    // The sets re-read answers with the new set: the row groups under it.
    await act(async () => {
      resolveSets?.({
        total: 3,
        sets: [
          {
            ...TXRMODELS_SET_A,
            id: 'set-imported-now',
            name: 'Imported tonight',
            created_at: '2026-12-04T10:00:00Z',
          },
          TXRMODELS_SET_A,
          TXRMODELS_SET_B,
        ],
      })
      await Promise.resolve()
    })
    await settle(0)
    const setRow = screen.getByTestId('txr-models-set-row-set-imported-now')
    expect(within(setRow).getByText('Imported tonight')).toBeTruthy()
    // The row sits under the group once expanded.
    expect(screen.queryByTestId(`txr-models-row-${fresh.id}`)).toBeNull()
    await toggleSet('set-imported-now')
    expect(screen.getByTestId(`txr-models-row-${fresh.id}`)).toBeTruthy()
  })

  it('a failed sets read keeps the set rows named by set_name and shows the muted sets-error line', async () => {
    api.listSets.mockRejectedValue(new Error('sets down'))
    renderPage()
    await settle(0)
    // The rows still render, grouped by the rows' own set_name (the sets
    // read is a secondary facts source — the inventory is the truth).
    const setA = screen.getByTestId('txr-models-set-row-set-a')
    expect(within(setA).getByText('CRC cohort, day 60')).toBeTruthy()
    // The count falls back to the LISTED count (no SetSummary facts); no
    // run/file facts line exists (the set record is unknown).
    expect(within(setA).getByText('2 models')).toBeTruthy()
    expect(within(setA).queryByText(/from the run|from the file/)).toBeNull()
    expect(within(setA).getByText('not recorded')).toBeTruthy()
    expect(screen.getByTestId('txr-models-set-row-set-b')).toBeTruthy()
    // The no-set model is still a plain top-level row.
    expect(screen.getByTestId(`txr-models-row-${IMPORTED_ROW.id}`)).toBeTruthy()
    // The muted one-line announcement under the header area.
    expect(screen.getByTestId('txr-models-j-sets-error').textContent).toBe(
      'The set details could not be loaded.',
    )
  })

  it("the set-focus view shows ONLY the focused set row, expanded, with an inert chevron (and the banner stays)", async () => {
    renderPage('/models?set=set-a')
    await settle(0)
    expect(api.listModels).toHaveBeenCalledWith({ set_id: 'set-a' })
    expect(screen.getByTestId('txr-models-set-row-set-a')).toBeTruthy()
    expect(screen.queryByTestId('txr-models-set-row-set-b')).toBeNull()
    // The focused set is expanded even though closed by default…
    const toggle = screen.getByTestId('txr-models-set-toggle-set-a')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe(
      'Hide the models of \u201cCRC cohort, day 60\u201d',
    )
    // …and its chevron is INERT (disabled, still aria-expanded): the
    // focus is the URL's view, never a togglable store state (F7) —
    // clicking must not collapse the set or touch the module store.
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      fireEvent.click(toggle)
      await Promise.resolve()
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)).toBeTruthy()
    expect(isSetExpanded('set-a')).toBe(false)
    expect(screen.getByTestId(`txr-models-row-${PLAIN_ROW.id}`)).toBeTruthy()
    // No no-set row in the focus view.
    expect(screen.queryByTestId(`txr-models-row-${IMPORTED_ROW.id}`)).toBeNull()
    expect(screen.getByTestId('txr-models-j-set-focus')).toBeTruthy()
  })

  it('hides set rows with no matching model under the server-side search; the Model column keeps the set\'s model_count', async () => {
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
    expect(screen.queryByTestId('txr-models-set-row-set-a')).toBeNull()
    expect(screen.queryByTestId(`txr-models-row-${IMPORTED_ROW.id}`)).toBeNull()
    const setB = screen.getByTestId('txr-models-set-row-set-b')
    // The Model column is the set's OWN count (model_count), never the
    // filtered view's row count; a collapsed set with matches stays
    // collapsed.
    expect(within(setB).getByText('3 models')).toBeTruthy()
    expect(screen.queryByTestId(`txr-models-row-${fixtureModelId(12)}`)).toBeNull()
    await toggleSet('set-b')
    expect(screen.getByTestId(`txr-models-row-${fixtureModelId(12)}`)).toBeTruthy()
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
    // Zero set rows — the *AllBy query throws on an empty result, so the
    // honest no-row assertion is the `queryAll` variant.
    expect(screen.queryAllByTestId(/^txr-models-set-row-/)).toHaveLength(0)
    expect(screen.queryAllByTestId(/^txr-models-row-/)).toHaveLength(0)
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
    await toggleSet('set-a')
    await toggleSet('set-b')
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

  it('labels every J column entry for the phone card layout (RES-16)', async () => {
    renderPage()
    await settle(0)
    await toggleSet('set-a')
    const row = screen.getByTestId(`txr-models-row-${fixtureModelId(11)}`)
    const labels = [...row.querySelectorAll('th, td')].map(el => el.getAttribute('data-label'))
    expect(labels).toEqual(['Set', 'Model', 'Method', 'Predicts', 'Decision day', 'Trained on', 'Made', 'Actions'])
    // qa-fixes4 ITEM-6 (results-r3 R3-results-12): the Made entry is one
    // date ("10 Nov 2026") — never wrapped across lines ("10 Nov / 2026").
    const made = row.querySelector('td[data-label="Made"]') as HTMLElement
    expect(made.style.whiteSpace).toBe('nowrap')
    // A set row's empty entries carry no labels on the phone card (the
    // card's own header words read) — the truth byte is on the model row
    // above; the set row's data-labels are absent per the card rule.
    const setRow = screen.getByTestId('txr-models-set-row-set-a')
    expect([...setRow.querySelectorAll('th, td')].map(el => el.getAttribute('data-label'))).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it('the table box is the scroll container and the column headers are sticky (jsdom measures no layout — the style/class is the byte)', async () => {
    renderPage()
    await settle(0)
    const box = screen.getByTestId('txr-models-j-table-box')
    // The box is the ScrollRegion (the labelled region the shell's route
    // legs read) and its own `overflow: auto` (both axes) makes it the
    // scrollport.
    expect(box.getAttribute('aria-label')).toBe('Your models')
    expect(box.style.overflowY).toBe('auto')
    expect(box.style.overflowX).toBe('auto')
    // The ~5-row minimum lives on the PAGE spine (the main), NOT the box's
    // scrollport: on the scrollport it forced the box past its frame at a
    // short window, painting over the footer (brief 4b F2). Below the
    // minimum the routed area scrolls instead.
    expect(box.style.minHeight).toBe('')
    const main = screen.getByTestId('txr-models-j')
    expect(main.style.minHeight).toBe('260px')
    // Every column header is sticky against the box (opaque token + above
    // the rows), and every row carries the reveal scroll-margin (44 px —
    // scrollIntoView must never hide a row under the sticky thead).
    const table = within(box).getByTestId('txr-models-j-table')
    for (const th of within(table).getAllByRole('columnheader')) {
      const header = th as HTMLElement
      expect(header.style.position).toBe('sticky')
      expect(header.style.top).toBe('0px')
      expect(header.style.zIndex).toBe('2')
      expect(header.style.background).toBe('var(--txr-surface-dim)')
    }
    // Every DATA row carries the reveal scroll-margin (the thead row has
    // none — it is the sticky header, never a scroll target).
    for (const rowEl of table.querySelectorAll('tbody tr')) {
      expect((rowEl as HTMLElement).style.scrollMarginTop).toBe('44px')
    }
    for (const headEl of table.querySelectorAll('thead tr')) {
      expect((headEl as HTMLElement).style.scrollMarginTop).toBe('')
    }
  })

  it('a closed table keeps the bottom border on every row except the whole table\u2019s very last (F1)', async () => {
    renderPage()
    await settle(0)
    // Every set / no-set row is its own tbody: the per-tbody `isLast` used
    // to strip the separator under EVERY collapsed set. The truth is
    // whole-table — with the default CLOSED fixture the last row is the
    // imported no-set model; set-a, set-b and every other row keep theirs.
    const SEPARATOR = '1px solid var(--txr-border-subtle)'
    const borderByte = (el: HTMLElement): string =>
      (el.querySelector('th, td') as HTMLElement).style.borderBottom
    expect(borderByte(screen.getByTestId('txr-models-set-row-set-a'))).toBe(SEPARATOR)
    expect(borderByte(screen.getByTestId('txr-models-set-row-set-b'))).toBe(SEPARATOR)
    const imported = screen.getByTestId(`txr-models-row-${IMPORTED_ROW.id}`)
    // jsdom serializes the `none` shorthand's width as its initial value
    // (`medium`); the honest byte is the STYLE, which reads `none`.
    expect(borderByte(imported)).toBe('medium')
    expect((imported.querySelector('td') as HTMLElement).style.borderBottomStyle).toBe('none')
    // Expanding set-a inserts model rows with THEIR separator; the last row
    // of the WHOLE table is still the imported one until set-b is expanded.
    await toggleSet('set-a')
    expect(borderByte(screen.getByTestId(`txr-models-row-${RUN_ROW.id}`))).toBe(SEPARATOR)
    expect(borderByte(imported)).toBe('medium')
    // Expand set-b too: the unsetted imported row stays the table's LAST
    // row (the no-set models come after every group), so even set-b's last
    // model keeps its separator — the imported row is the one border-less
    // row in the table.
    await toggleSet('set-b')
    expect(borderByte(screen.getByTestId(`txr-models-row-${fixtureModelId(16)}`))).toBe(SEPARATOR)
    expect(borderByte(imported)).toBe('medium')
    expect((imported.querySelector('td') as HTMLElement).style.borderBottomStyle).toBe('none')
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

    // The one steady failure line (never the transport's own words).
    api.importModel.mockRejectedValue(new Error('INVALID_CONTAINER'))
    pickImport()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-import-error').textContent).toBe(
      'The model file could not be opened.',
    )
  })

  it('an import whose set name is taken (409 SET_NAME_TAKEN) names the remedy', async () => {
    renderPage()
    await settle(0)
    const taken = new Error('a set named "CRC cohort, day 60" already exists (set names are case-insensitive)') as Error & {
      error_code?: string
      status?: number
    }
    taken.error_code = 'SET_NAME_TAKEN'
    taken.status = 409
    api.importModel.mockRejectedValue(taken)
    pickImport()
    await settle(0)
    expect(screen.getByTestId('txr-models-j-import-error').textContent).toBe(
      'A set with this name already exists. Rename that set first, or open the file from inside it to add its models.',
    )
  })

  it('Use sets the reuse intent + the pending model id and navigates to the predict-files screen', async () => {
    renderPage()
    await settle(0)
    await toggleSet('set-a')
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
    await toggleSet('set-a')
    await act(async () => {
      fireEvent.click(screen.getByTestId(`txr-models-use-${RUN_ROW.id}`))
      await Promise.resolve()
    })
    expect(useStepTrailStore.getState().trail).toEqual(['/models'])
  })

  it('Export saves the provider attachment under the sanitised model name', async () => {
    renderPage()
    await settle(0)
    await toggleSet('set-a')
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
      await toggleSet('set-a')
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
    await toggleSet('set-a')
    expect(screen.getByTestId(`txr-models-export-${RUN_ROW.id}`).textContent).toBe('Export')
  })

  it('Rename opens the dialog with the current label prefilled and PATCHes; Delete confirms with the board promise and DELETEs', async () => {
    renderPage()
    await settle(0)
    await toggleSet('set-a')
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

  it('shows the three set actions on every real set row and none for a no-set model (there is no "Not in a set" row)', async () => {
    renderPage()
    await settle(0)
    // Every real set row: Rename set, Export set, Delete set (link
    // buttons), the set id in the testids.
    for (const setId of ['set-a', 'set-b']) {
      expect(screen.getByTestId(`txr-models-set-rename-btn-${setId}`).textContent).toBe(
        'Rename set',
      )
      expect(screen.getByTestId(`txr-models-set-export-btn-${setId}`).textContent).toBe(
        'Export set',
      )
      expect(screen.getByTestId(`txr-models-set-delete-btn-${setId}`).textContent).toBe(
        'Delete set',
      )
    }
    // The a11y wrap: each set row's three buttons live in ONE labelled
    // group (screen readers announce the set the actions act on).
    const setAGroup = screen.getByRole('group', { name: 'Actions for CRC cohort, day 60' })
    expect(within(setAGroup).getByTestId('txr-models-set-rename-btn-set-a')).toBeTruthy()
    expect(within(setAGroup).getByTestId('txr-models-set-export-btn-set-a')).toBeTruthy()
    expect(within(setAGroup).getByTestId('txr-models-set-delete-btn-set-a')).toBeTruthy()
    const setBGroup = screen.getByRole('group', { name: 'Actions for Lung pilot, day 35' })
    expect(within(setBGroup).getByTestId('txr-models-set-delete-btn-set-b')).toBeTruthy()
    // The no-set model is a plain row — no set actions, no set row at all.
    expect(screen.queryByTestId('txr-models-set-row-__none__')).toBeNull()
    expect(screen.queryByTestId('txr-models-set-rename-btn-__none__')).toBeNull()
    expect(screen.queryByTestId('txr-models-set-export-btn-__none__')).toBeNull()
    expect(screen.queryByTestId('txr-models-set-delete-btn-__none__')).toBeNull()
  })

  it('a sets-read failure keeps the group\u2019s set actions (they act by the real set id)', async () => {
    api.listSets.mockRejectedValue(new Error('sets down'))
    renderPage()
    await settle(0)
    // The failed sets read yields the fallback set rows, named from the rows'
    // own set_name — a real set id, so the row's actions stay.
    expect(screen.getByTestId('txr-models-set-rename-btn-set-a')).toBeTruthy()
    expect(screen.getByTestId('txr-models-set-export-btn-set-a')).toBeTruthy()
    expect(screen.getByTestId('txr-models-set-delete-btn-set-a')).toBeTruthy()
  })

  it('Rename set opens the dialog prefilled and calls ModelSets.renameSet, then refreshes models + sets', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-rename-btn-set-a'))
      await Promise.resolve()
    })
    const input = screen.getByTestId('txr-models-set-rename-set-a-input') as HTMLInputElement
    expect(input.value).toBe('CRC cohort, day 60')
    fireEvent.change(input, { target: { value: 'CRC cohort, day 60 (v2)' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-rename-set-a-confirm'))
      await Promise.resolve()
    })
    await settle(0)
    expect(api.renameSet).toHaveBeenCalledWith({
      id: 'set-a',
      name: 'CRC cohort, day 60 (v2)',
    })
    // The refresh re-reads BOTH reads (the set row facts are the sets read's).
    expect(api.listModels.mock.calls.length).toBe(2)
    expect(api.listSets.mock.calls.length).toBe(2)
  })

  it('Delete set confirms with the exact button, keeps keep_files false, refreshes and clears the ?set= focus', async () => {
    // This set records keep_training_files: the confirm body gains the
    // training-files sentence.
    api.listSets.mockResolvedValue({
      ...TXRMODELS_MODEL_SET_LIST,
      sets: [{ ...TXRMODELS_SET_A, keep_training_files: true }, TXRMODELS_SET_B],
    })
    renderPage('/models?set=set-a')
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-btn-set-a'))
      await Promise.resolve()
    })
    // Opening never touches the wire: the action only OPENS the confirm.
    expect(api.deleteSet).not.toHaveBeenCalled()
    const confirm = screen.getByTestId('txr-models-set-delete-set-a-confirm')
    expect(confirm.textContent).toBe('Delete the set')
    const body = screen.getByTestId('txr-models-set-delete-set-a-body').textContent
    expect(body).toBe(
      'This removes the set and its models\u2019 files. Results already made with them are kept in History. The training files kept with this set are removed too.',
    )
    await act(async () => {
      fireEvent.click(confirm)
      await Promise.resolve()
    })
    await settle(0)
    expect(api.deleteSet).toHaveBeenCalledWith({ id: 'set-a', keep_files: false })
    // The refresh re-reads the inventory twice: once for the mutation
    // (still on the focused view) and once when the focus-clear re-issues
    // the unfiltered read; the sets read refreshes once.
    expect(api.listModels.mock.calls.length).toBe(3)
    expect(api.listSets.mock.calls.length).toBe(2)
    // The deletion of the FOCUSED set clears the URL focus (the set is gone;
    // the honest page is the unfiltered inventory).
    expect(screen.getByTestId('route-location').textContent).toBe('/models')
    expect(screen.queryByTestId('txr-models-j-set-focus')).toBeNull()
  })

  it('a set that does not keep training files shows the delete body without the extra sentence', async () => {
    renderPage()
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-btn-set-a'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-models-set-delete-set-a-body').textContent).toBe(
      'This removes the set and its models\u2019 files. Results already made with them are kept in History.',
    )
  })

  it('onSetDeleted clears only ?set= and keeps the other params (a dead focus, not a wiped URL)', async () => {
    renderPage('/models?set=set-a&src=history')
    await settle(0)
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-btn-set-a'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-set-a-confirm'))
      await Promise.resolve()
    })
    await settle(0)
    // The deletion of the focused set clears ONLY the set param: the other
    // param survives the URL update (a wiped URL would lose it).
    expect(screen.getByTestId('route-location').textContent).toBe('/models?src=history')
    expect(screen.queryByTestId('txr-models-j-set-focus')).toBeNull()
    // The unfiltered re-read after the focus-clear (the inventory is read
    // a third time, the sets read once more).
    expect(api.listModels.mock.calls.length).toBe(3)
    expect(api.listSets.mock.calls.length).toBe(2)
  })

  it('a failed delete-open shows the one fixed line, never the action\u2019s own message', async () => {
    renderPage()
    await settle(0)
    // Make the OPEN itself fail (the action rejects) — the button path must
    // answer with the page's fixed line, not the raw error text.
    const entry = getActionRegistry().get('models.deleteSet')
    expect(entry).toBeDefined()
    const spy = vi.spyOn(entry as NonNullable<typeof entry>, 'run').mockImplementation(() => {
      throw new Error('the transport said something else')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-delete-btn-set-a'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-models-j-action-error').textContent).toBe(
      'The set could not be deleted.',
    )
    // Nothing was opened and nothing was deleted.
    expect(screen.queryByTestId('txr-models-set-delete-set-a')).toBeNull()
    expect(api.deleteSet).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('Export set saves the attachment under the sanitised set name (.txr)', async () => {
    renderPage()
    await settle(0)
    const createElement = vi.spyOn(document, 'createElement')
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-export-btn-set-a'))
      await Promise.resolve()
    })
    // The registered action runs downloadSetExport: the set's current name
    // is resolved from the sets read, the bytes come from exportSet.
    expect(api.exportSet).toHaveBeenCalledWith({ id: 'set-a' })
    const anchor = createElement.mock.results
      .map(result => result.value)
      .find(value => value instanceof HTMLAnchorElement) as HTMLAnchorElement
    expect(anchor.download).toBe('CRC-cohort-day-60.txr')
    expect(anchor.href).toBe('blob:txr-models-test')
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:txr-models-test')
    createElement.mockRestore()
  })

  it('a failed set export shows the one failure line', async () => {
    renderPage()
    await settle(0)
    api.exportSet.mockRejectedValue(new Error('export down'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-models-set-export-btn-set-a'))
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-models-j-action-error').textContent).toBe(
      'The set could not be exported.',
    )
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

  it('renders the first-load line, then the error + Retry, then the set rows on a successful retry', async () => {
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
    expect(screen.getByTestId('txr-models-set-row-set-a')).toBeTruthy()
    // The Retry re-reads the sets too (the set facts must recover with the
    // rows — the two reads are one refresh).
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
    await toggleSet('set-a')
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

  it('the set row actions are absent in demo mode (the pools are the shared one)', async () => {
    renderPage()
    await settle(0)
    // The set rows render (the inventory read is the shared pool's), the
    // set action buttons do not (the server blocks rename/delete/export of
    // the recorded stubs — the row-action rule, at the set level).
    expect(screen.getByTestId('txr-models-set-row-set-a')).toBeTruthy()
    expect(screen.queryByTestId('txr-models-set-rename-btn-set-a')).toBeNull()
    expect(screen.queryByTestId('txr-models-set-export-btn-set-a')).toBeNull()
    expect(screen.queryByTestId('txr-models-set-delete-btn-set-a')).toBeNull()
  })

  it('desktop mode keeps the import + the row actions and shows no retention block', async () => {
    seedDemoMode('desktop')
    renderPage()
    await settle(0)
    expect(screen.queryByTestId('txr-demo-retention')).toBeNull()
    expect(screen.getByTestId('txr-models-import')).toBeTruthy()
    await toggleSet('set-a')
    const row = screen.getByTestId(`txr-models-row-${RUN_ROW.id}`)
    expect(within(row).getByTestId(`txr-models-export-${RUN_ROW.id}`)).toBeTruthy()
    expect(within(row).getByTestId(`txr-models-rename-${RUN_ROW.id}`)).toBeTruthy()
    expect(within(row).getByTestId(`txr-models-delete-${RUN_ROW.id}`)).toBeTruthy()
  })
})
