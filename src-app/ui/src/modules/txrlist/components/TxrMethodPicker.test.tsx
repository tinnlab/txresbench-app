// @vitest-environment jsdom
/**
 * TEST-UL-16 (qa-fixes3 ITEM-1) — the redesigned E-screen picker
 * (`TxrMethodPicker` + `TxrMethodCardRow`): the plan's measured behaviors
 * in the jsdom tier — the default ready-only view (no "Cannot run" text
 * anywhere), the family sections with the explainer + count + select-all,
 * the show-more cap and its search-driven expansion, the presets, the
 * collapsed can't-run section with per-reason chips + expansion, the
 * zero-runnable state with its two actions, and the row contract (checkbox
 * accessible name with the method title, whole-row toggle, estimate + rank
 * + needs lines, in-place About disclosure).
 *
 * jsdom has no layout: the measured (viewport/scroll-container/contrast)
 * assertions land in the gallery tier (`txr-method-picker.spec.ts`); here
 * the STRUCTURE and the RULES are pinned. The repo's DOM-assertion idiom is
 * `textContent`/`getAttribute` (no jest-dom matchers are installed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TxrMethodCard } from '../types'
import { TXRMETHOD_GROUP_ORDER } from '../lib/methodPicker'
import { TxrMethodPicker } from './TxrMethodPicker'

// The About disclosure asks the catalogue for the method detail — the one
// fetch in this suite (the picker's skeleton/error states are the host's,
// pinned in the page suite).
const api = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock('@/api-client', () => ({
  ApiClient: { MethodCatalogue: { detail: api.detail } },
}))

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

/** One card whose support is minimal (the picker is a passthrough for it). */
function card(over: Partial<TxrMethodCard> & { id: string }): TxrMethodCard {
  const { id, ...rest } = over
  return {
    key: id,
    id,
    title: id,
    summary: `Summary of ${id}.`,
    paperTitle: null,
    group: 'response-probability',
    groupLabel: 'Response probability',
    language: 'R',
    journal: 'Fixture Journal',
    year: 2020,
    paperDoi: '10.0000/txr.demo',
    estimate: { seconds: 120, quality: 'measured' },
    rank: null,
    needs: { markers: '1 marker', covariates: 'covariates optional', draws: '1+ draws' },
    run: {
      status: 'can',
      coverageLine: 'all 151 patients',
      reasonCode: null,
      reasonLine: 'all 151 patients',
      reasonFix: '',
      disabled: false,
    },
    ...rest,
  }
}

const runnable = (id: string, groupLabel: string, over: Partial<TxrMethodCard> = {}): TxrMethodCard =>
  card({ id, groupLabel, group: groupLabel.toLowerCase().replace(' ', '-') as TxrMethodCard['group'], ...over })

/** 7 runnable cards across the four families (one over the 6-row limit). */
const CARDS: TxrMethodCard[] = [
  runnable('r1', 'Response call', { title: 'Rule one', estimate: { seconds: 45, quality: 'measured' } }),
  runnable('r2', 'Response call', { title: 'Rule two' }),
  runnable('p1', 'Response probability', { title: 'Chance one', rank: { median: 0.74, kind: 'c-index', nDatasets: 38 } }),
  runnable('p2', 'Response probability', { title: 'Chance two' }),
  runnable('p3', 'Response probability', { title: 'Chance three' }),
  runnable('s1', 'Static risk', { title: 'Baseline one' }),
  runnable('d1', 'Dynamic risk', { title: 'Dynamic one' }),
]

const CANNOT: TxrMethodCard[] = [
  card({
    id: 'c1',
    title: 'Cox never',
    group: 'static-risk',
    groupLabel: 'Static risk',
    run: {
      status: 'cannot',
      coverageLine: '',
      reasonCode: 'REQUIRED_MARKER_MISSING',
      reasonLine: 'needs LDH, not in your file',
      reasonFix: 'Add a column named LDH',
      disabled: true,
    },
  }),
  card({
    id: 'c2',
    title: 'No env rule',
    group: 'response-call',
    groupLabel: 'Response call',
    run: {
      status: 'cannot',
      coverageLine: '',
      reasonCode: 'ENV_IMAGE_MISSING',
      reasonLine: 'no published environment available',
      reasonFix: 'This method is not available yet.',
      disabled: true,
    },
  }),
]

function renderPicker(
  cards: TxrMethodCard[],
  selected: ReadonlySet<string> = new Set(),
  onSelectionChange: (next: ReadonlySet<string>) => void = () => {},
) {
  return render(
    <TxrMethodPicker
      cards={cards}
      loading={false}
      error={null}
      onRetry={() => {}}
      selected={selected}
      onSelectionChange={onSelectionChange}
      onChangeFiles={() => {}}
      onChangeSettings={() => {}}
    />,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  api.detail.mockReset()
  api.detail.mockResolvedValue({
    id: 'r1',
    description: 'The fixture description.',
    journal: 'Fixture Journal',
    year: 2020,
    paper_doi: '10.0000/txr.demo',
  })
})

afterEach(() => {
  cleanup()
})

describe('the default view (ready to run only, nothing red)', () => {
  it('renders the runnable sections in the fixed family order; no "Cannot run" text anywhere', () => {
    renderPicker([...CARDS, ...CANNOT])
    const sections = screen
      .getAllByTestId(/^txr-method-section-/)
      // The sticky header + the select-all button also carry the section
      // testid prefix; the ORDER under test is the section elements' own.
      .filter(el => {
        const id = el.dataset.testid ?? ''
        return TXRMETHOD_GROUP_ORDER.some(group => id === `txr-method-section-${group}`)
      })
      .map(el => el.getAttribute('data-testid'))
    expect(sections).toEqual([
      'txr-method-section-response-call',
      'txr-method-section-response-probability',
      'txr-method-section-static-risk',
      'txr-method-section-dynamic-risk',
    ])
    expect(screen.getByTestId('txr-method-ready-heading').textContent).toBe('Ready to run (7)')
    expect(document.body.textContent).not.toContain('Cannot run')
    // the cannot headline uses the plan's plain words
    expect(screen.getByTestId('txr-method-cannot-heading').textContent).toBe(
      "2 methods can't run on this data",
    )
  })

  it('every section header: name, one-sentence explainer, count, select-all', () => {
    renderPicker(CARDS)
    const header = screen.getByTestId('txr-method-section-header-response-probability')
    expect(header.textContent).toContain('Response probability')
    expect(header.textContent).toContain('Gives each patient a chance of responding')
    expect(header.textContent).toContain('3')
    expect(
      screen.getByTestId('txr-method-section-select-all-response-probability').textContent,
    ).toBe('Select all in group')
  })

  it('the "Select all in group" toggles exactly the group\'s runnable members', () => {
    let next: ReadonlySet<string> = new Set()
    renderPicker(CARDS, next, value => {
      next = value
    })
    fireEvent.click(screen.getByTestId('txr-method-section-select-all-response-probability'))
    expect([...next].sort()).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('the row contract', () => {
  it('the checkbox carries the method title as its accessible name', () => {
    renderPicker(CARDS)
    expect(screen.getByTestId('txr-method-checkbox-r1').getAttribute('aria-label')).toBe(
      'Select Rule one',
    )
  })

  it('the whole row toggles the selection (click + Space), excluding the nested controls', () => {
    let next: ReadonlySet<string> = new Set()
    renderPicker(CARDS, next, value => {
      next = value
    })
    fireEvent.click(screen.getByTestId('txr-method-card-r1'))
    expect(next.has('r1')).toBe(true)
    fireEvent.keyDown(screen.getByTestId('txr-method-card-p1'), { key: 'Enter' })
    expect(next.has('p1')).toBe(true)
    // The About button's click is its own: no selection change.
    const before = next.size
    fireEvent.click(screen.getByTestId('txr-method-about-toggle-r1'))
    expect(next.size).toBe(before)
    expect(screen.getByTestId('txr-method-about-r1')).toBeTruthy()
  })

  it('the row shows title, id, chips, estimate, rank and the needs line', () => {
    renderPicker(CARDS)
    const row = screen.getByTestId('txr-method-card-p1')
    expect(row.textContent).toContain('Chance one')
    expect(row.textContent).toContain('p1')
    expect(row.textContent).toContain('Response probability')
    expect(row.textContent).toContain('R')
    expect(screen.getByTestId('txr-method-estimate-p1').textContent).toBe('Estimated about 2 min')
    expect(screen.getByTestId('txr-method-rank-p1').textContent).toBe(
      'Benchmark score 0.74 (38 cohorts)',
    )
    expect(screen.getByTestId('txr-method-rank-p1').getAttribute('title')).toBe(
      'The median concordance across the 38 datasets the method was tested on.',
    )
    expect(screen.getByTestId('txr-method-needs-p1').textContent).toBe(
      'Needs: 1 marker · covariates optional · 1+ draws',
    )
  })
})

describe('presets', () => {
  it('presets change the selection; the recommended preset reports the deterministic set', () => {
    let next: ReadonlySet<string> = new Set()
    renderPicker(CARDS, next, value => {
      next = value
    })
    expect(screen.getByTestId('txr-method-preset-recommended').textContent).toBe('Recommended (7)')
    fireEvent.click(screen.getByTestId('txr-method-preset-all'))
    expect(next.size).toBe(7)
    fireEvent.click(screen.getByTestId('txr-method-preset-none'))
    expect(next.size).toBe(0)
    fireEvent.click(screen.getByTestId('txr-method-preset-fast'))
    expect([...next].sort()).toEqual(['r1'])
  })

  it('the family filter and search restrict the sections and restore', () => {
    renderPicker(CARDS)
    const input = screen.getByTestId('txr-method-search')
    fireEvent.change(input, { target: { value: 'Chance' } })
    expect(screen.getByTestId('txr-method-section-response-probability')).toBeTruthy()
    expect(screen.queryByTestId('txr-method-section-response-call')).toBeNull()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByTestId('txr-method-section-response-call')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-method-family-static-risk'))
    expect(screen.queryByTestId('txr-method-section-response-call')).toBeNull()
    expect(screen.getByTestId('txr-method-section-static-risk')).toBeTruthy()
  })
})

describe('show-more and the can\'t-run section', () => {
  it('shows the first 6 rows of a section and "Show N more" expands it', () => {
    const many = [
      runnable('a1', 'Response call'),
      runnable('a2', 'Response call'),
      runnable('a3', 'Response call'),
      runnable('a4', 'Response call'),
      runnable('a5', 'Response call'),
      runnable('a6', 'Response call'),
      runnable('a7', 'Response call'),
    ]
    renderPicker(many)
    const section = screen.getByTestId('txr-method-section-response-call')
    expect(section.querySelectorAll('[data-testid^="txr-method-card-"]')).toHaveLength(6)
    const more = screen.getByTestId('txr-method-section-more-response-call')
    expect(more.textContent).toBe('Show 1 more')
    fireEvent.click(more)
    expect(section.querySelectorAll('[data-testid^="txr-method-card-"]')).toHaveLength(7)
    expect(screen.queryByTestId('txr-method-section-more-response-call')).toBeNull()
  })

  it('the can\'t-run section is closed by default; a reason chip opens its list with the fix line', () => {
    renderPicker([...CARDS, ...CANNOT])
    expect(screen.getByTestId('txr-method-cannot-chips')).toBeTruthy()
    fireEvent.click(screen.getByTestId('txr-method-reason-marker'))
    expect(screen.getByTestId('txr-method-cannot-row-c1').textContent).toContain('Cox never')
    expect(screen.getByTestId('txr-method-cannot-row-c1').textContent).toContain(
      'needs LDH, not in your file',
    )
    expect(screen.getByTestId('txr-method-cannot-row-c1').textContent).toContain(
      'Add a column named LDH',
    )
  })

  it('the toolbar toggle opens the whole can\'t-run section', () => {
    renderPicker([...CARDS, ...CANNOT])
    fireEvent.click(screen.getByTestId('txr-method-cannot-toggle'))
    expect(screen.getByTestId('txr-method-cannot-lists')).toBeTruthy()
    expect(screen.getByTestId('txr-method-cannot-row-c2').textContent).toContain(
      'This method is not available yet.',
    )
  })
})

describe('the zero-runnable state', () => {
  it('says plainly what blocks everything and offers Change files + Change settings', () => {
    let files = 0
    let settings = 0
    render(
      <TxrMethodPicker
        cards={CANNOT}
        loading={false}
        error={null}
        onRetry={() => {}}
        selected={new Set()}
        onSelectionChange={() => {}}
        onChangeFiles={() => {
          files += 1
        }}
        onChangeSettings={() => {
          settings += 1
        }}
      />,
    )
    expect(screen.getByTestId('txr-method-zero')).toBeTruthy()
    expect(screen.getByTestId('txr-method-zero').textContent).toContain(
      'None of the 2 methods can run on this data.',
    )
    fireEvent.click(screen.getByTestId('txr-method-zero-change-files'))
    expect(files).toBe(1)
    fireEvent.click(screen.getByTestId('txr-method-zero-change-settings'))
    expect(settings).toBe(1)
  })
})

describe('ITEM-2 — the recompute state and the tab order', () => {
  it('a settings change (refreshing with cards on screen) shows the re-check line, never the skeleton', () => {
    render(
      <TxrMethodPicker
        cards={CARDS}
        loading={true}
        refreshing={true}
        error={null}
        onRetry={() => {}}
        selected={new Set()}
        onSelectionChange={() => {}}
        onChangeFiles={() => {}}
        onChangeSettings={() => {}}
      />,
    )
    expect(screen.getByTestId('txr-method-refreshing')).toBeTruthy()
    expect(screen.queryByTestId('txr-method-loading')).toBeNull()
    expect(screen.getByTestId('txr-method-picker')).toBeTruthy()
  })

  it('the presets row precedes the toolbar (the ITEM-2 keyboard order: presets, then search)', () => {
    renderPicker(CARDS)
    const presets = screen.getByTestId('txr-method-presets')
    const toolbar = screen.getByTestId('txr-method-toolbar')
    const position = presets.compareDocumentPosition(toolbar)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
