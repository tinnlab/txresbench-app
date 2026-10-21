// @vitest-environment jsdom
//
// The /visualization page's "Color by" control, asserted on the RENDERED PAGE.
//
// Two properties, and both of them are about the page's own tree rather than its source:
//
//   1. NO NATIVE <select> SURVIVES ANYWHERE ON THE PAGE. The control used to be a raw
//      `<select>/<option>` — the last one in the app after the picker rewrite. A source-text
//      scan for the string "<select" would be trivially evaded (a `React.createElement('select')`,
//      a component that renders one, a re-export); querying the mounted DOM is not, because the
//      thing being forbidden is the ELEMENT, so that is what is looked for.
//   2. THE CONTROL IS SEARCHABLE, AND CHOOSING THROUGH IT REALLY RECOLORS. The column list is
//      unbounded — a real dataset can carry thousands of value columns — so the picker has to
//      filter. Rendering it proves nothing on its own: the test opens it, types, picks the
//      narrowed row, and then asserts the page RE-DERIVED its coloring for the chosen column —
//      the observable consequence, read off the engine call the page makes, not off component
//      state.
//
// Column NAMES are read out of the catalog at test time, never written down here: the picker's
// contract is "whatever the source offers", so a literal would both lie about that and pin this
// suite to one fixture's vocabulary.
//
// The GL boundary — and only the GL boundary — is stubbed: `<Viz>` is a deck.gl/WebGL mount that
// jsdom has no context for, and `<ExportDialog>` reads a canvas. Everything the assertions depend
// on (the real `FixtureSource` catalog, the real `computeColoring`, the real kit `<Select>`) runs.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SELECT_SEARCH_THRESHOLD } from '@ziee/kit'
import type { DatasetCatalog } from '@ziee/viz'

const coloringCalls: string[] = []

vi.mock('@ziee/viz', async importOriginal => {
  const actual = await importOriginal<typeof import('@ziee/viz')>()
  return {
    ...actual,
    // The two GL/canvas mounts. Nothing else is replaced.
    Viz: () => <div data-testid="viz-gl-stub" />,
    ExportDialog: () => <div data-testid="viz-export-dialog-stub" />,
    // The REAL engine, observed: every recolor the page asks for is recorded, so a selection
    // can be checked by its effect instead of by peeking at React state.
    computeColoring: (source: unknown, colorBy: { mode: string; key: string }) => {
      coloringCalls.push(`${colorBy.mode}:${colorBy.key}`)
      return (actual.computeColoring as (s: unknown, c: unknown) => unknown)(source, colorBy)
    },
  }
})

// Imported AFTER the mock factory is registered (vitest hoists `vi.mock`, so this is the
// mocked module the page sees).
const { VisualizationPage } = await import('./VisualizationPage')

beforeEach(() => {
  cleanup()
  coloringCalls.length = 0
  window.localStorage.clear()
})

/** The colour-by trigger, re-queried every time: the kit swaps the control's ARM (and so its
 *  trigger node) once the option count crosses the search threshold, so a node captured while
 *  the catalog was still loading is a detached one. */
const colorByTrigger = (): HTMLElement => screen.getByTestId('viz-page-colorby')

/** Mount the page and wait for the fixture catalog to land — the control is empty (and
 *  disabled) until it does. */
async function mountPage(): Promise<void> {
  render(<VisualizationPage />)
  await screen.findByTestId('viz-page-colorby', undefined, { timeout: 20_000 })
  await waitFor(() => expect(colorByTrigger().hasAttribute('disabled')).toBe(false), {
    timeout: 20_000,
  })
}

/** Open the popup the way a mouse does. */
function openColorBy(): void {
  const trigger = colorByTrigger()
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)
}

/** The catalog the page itself mounts — same source, same seed, a token point count. Every
 *  column name the assertions use comes from HERE. */
async function pageCatalog(): Promise<DatasetCatalog> {
  const { FixtureSource } = await import('@ziee/viz')
  return new FixtureSource({ seed: 42, pointCount: 16 }).catalog()
}

describe('the /visualization page colour-by control', () => {
  it('renders NO native <select> anywhere on the page', async () => {
    await mountPage()
    // The whole document, not just the page subtree: a kit popup portals OUT of it, and a
    // native `<select>` smuggled into a portal is exactly as much of a native select.
    expect(document.querySelectorAll('select')).toHaveLength(0)
    expect(document.querySelectorAll('option')).toHaveLength(0)

    // …and again with the list OPEN, so the assertion covers the options too and not just
    // the resting control.
    openColorBy()
    await screen.findByTestId('viz-page-colorby-popup')
    expect(document.querySelectorAll('select')).toHaveLength(0)
    expect(document.querySelectorAll('option')).toHaveLength(0)
  })

  it('is a combobox NAMED "Color by" — the caption is not the only thing that says so', async () => {
    await mountPage()
    expect(screen.getByRole('combobox', { name: 'Color by' })).toBe(colorByTrigger())
  })

  it('says it is still loading, and refuses input, until the catalog lands', () => {
    // Synchronous: asserted on the FIRST render, before the catalog effect resolves, so this
    // is the real pre-catalog state rather than a race that usually wins.
    render(<VisualizationPage />)
    const trigger = colorByTrigger()
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(trigger.textContent).toContain('Loading columns…')
  })

  it('offers every column the catalog has — past the kit search threshold, so it filters', async () => {
    await mountPage()
    openColorBy()
    await screen.findByTestId('viz-page-colorby-popup')

    // The count read off the RENDERED list, then checked BOTH ways:
    //   · against the catalog, so no column is silently dropped from the picker, and
    //   · against the kit's own exported switch point, so "the list is long enough that search
    //     turns itself on" is a measured premise rather than an assumption. Both matter: a
    //     picker that quietly offered only the categorical columns would still be searchable
    //     for some datasets and would still pass a bare threshold check.
    const catalog = await pageCatalog()
    const expected =
      catalog.categoricalColumns.length + catalog.continuousColumns.length + catalog.valueColumns.length
    const rendered = document.querySelectorAll('[data-testid^="viz-page-colorby-opt-"]')
    expect(rendered).toHaveLength(expected)
    expect(rendered.length).toBeGreaterThanOrEqual(SELECT_SEARCH_THRESHOLD)
  })

  it('every button the page renders comes from the kit — none is hand-rolled', async () => {
    // A restorable prior workspace, so the restore banner (the page's OTHER button cluster)
    // is mounted for this assertion instead of being silently skipped.
    window.localStorage.setItem(
      'viz:autosave:v1',
      // Any pane id OTHER than the initial one makes the saved workspace worth offering back.
      JSON.stringify({ series: [{ type: 'scatter', id: 'a-prior-session' }], grid: [{}] }),
    )
    await mountPage()
    expect(screen.getByTestId('viz-restore-banner')).toBeTruthy()
    openColorBy()
    await screen.findByTestId('viz-page-colorby-popup')

    // Read off the DOM, not off the source: every kit control stamps a `data-slot` on the
    // element it renders (`button`, `select-trigger`, …). A hand-rolled `<button>` carries
    // none — which is the difference this asserts, without a single source-text scan.
    const unslotted = [...document.querySelectorAll('button')].filter(b => !b.hasAttribute('data-slot'))
    expect(unslotted.map(b => b.getAttribute('data-testid') ?? b.textContent)).toEqual([])
  })

  it('opens, FILTERS, and choosing a filtered row really recolors the page', async () => {
    const catalog = await pageCatalog()
    // The LAST value column — deep enough in the list that it is only reachable by scrolling,
    // which is the case the search exists for. Its name is the catalog's, not this file's.
    const target = catalog.valueColumns[catalog.valueColumns.length - 1]
    const firstCategorical = catalog.categoricalColumns[0].id
    const firstContinuous = catalog.continuousColumns[0].id

    await mountPage()
    // The page starts on its default categorical column.
    await waitFor(() => expect(coloringCalls).toContain(`categorical:${firstCategorical}`))

    openColorBy()

    // The search field only exists because the option count crossed the kit threshold.
    const search = await screen.findByTestId('viz-page-colorby-search')
    // Its copy names what is being searched — a bare "Search…" in a toolbar of controls does not.
    expect(search.getAttribute('placeholder')).toContain('column')
    expect(search.getAttribute('aria-label')).toContain('column')

    fireEvent.change(search, { target: { value: target } })
    await waitFor(() => {
      expect(screen.getByTestId(`viz-page-colorby-opt-value:${target}`)).toBeTruthy()
      // NEGATIVE CONTROL — the filter really narrowed; other rows are gone, not merely styled.
      expect(screen.queryByTestId(`viz-page-colorby-opt-categorical:${firstCategorical}`)).toBeNull()
      expect(screen.queryByTestId(`viz-page-colorby-opt-continuous:${firstContinuous}`)).toBeNull()
    })

    fireEvent.click(screen.getByTestId(`viz-page-colorby-opt-value:${target}`))

    // THE CONSEQUENCE: the page re-derived its coloring for the chosen column.
    await waitFor(() => expect(coloringCalls).toContain(`value:${target}`), { timeout: 20_000 })
    // …and the trigger now reads as that column, so the choice is also visible.
    await waitFor(() => expect(colorByTrigger().textContent).toContain(target))
  })

  it('a query that matches nothing says so, and clearing it restores the list', async () => {
    const catalog = await pageCatalog()
    const firstCategorical = catalog.categoricalColumns[0].id
    await mountPage()
    openColorBy()
    const search = await screen.findByTestId('viz-page-colorby-search')

    fireEvent.change(search, { target: { value: 'no such column' } })
    await waitFor(() =>
      // Not merely "the popup emptied": it says WHAT found nothing, in this control's own words.
      expect(screen.getByTestId('viz-page-colorby-no-match').textContent).toContain('No column matches'),
    )

    // POSITIVE CONTROL — the assertion above is about the FILTER, not about a list that
    // stopped rendering.
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() =>
      expect(screen.getByTestId(`viz-page-colorby-opt-categorical:${firstCategorical}`)).toBeTruthy(),
    )
  })
})
