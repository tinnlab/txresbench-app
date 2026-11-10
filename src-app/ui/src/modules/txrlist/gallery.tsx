/**
 * txrlist dev-gallery surface (PROV-UI-LIST-5) — the module's screen spec
 * rendered offline, one seeded surface per board state.
 *
 * The stories ARE the module's contract in action:
 *
 * - `txr-list-e`: the screen-E list fed by the REAL adapter — the story
 *   host mounts `useMethodRows` + `useListEstimate` over the mock cassette
 *   (`MethodCatalogue.list` / `.eligibility` / `.estimate`, DEC-11), holds
 *   the selection + the run options, and records the Run callback's keys +
 *   options into `txr-list-run-result` (the gallery-e2e's assertion seam —
 *   the component is never probed).
 * - `txr-list-d` / `txr-list-i`: HOST-BUILT rows (ui-models's side): the
 *   fixture rows are already `TxrListRow`s; the story hosts own the
 *   chips/search/sort state and the totals (the module renders only).
 * - `txr-list-narrow-390`: the board row at 390 px — the wrap path
 *   (EXAMPLE-UL-6) with the fixture's long-name / long-detail rows.
 * - `txr-list-empty` / `txr-list-error` / `txr-list-loading`: the module's
 *   no-rows states (EXAMPLE-UL-7).
 *
 * All data is the synthetic `fixtures.ts`; no patient data, no
 * restricted/ content, and the module is reached only through its barrel
 * (a host screen imports the module the same way). The total lines the D/I
 * hosts compute come from `estimateScheduleSeconds` — the same LPT rule
 * the real endpoint uses (fixtures.ts), so "about N minutes in total" is
 * an honest reading of the fixture instead of a hardcoded string.
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type { TxrListRow, TxrFilterChip, TxrSortControl } from './types'
import { TxrSelectList } from './components/TxrSelectList'
import { TxrListBottomBar, TXRLIST_DEFAULT_AT_A_TIME } from './components/TxrListBottomBar'
import { TxrMethodPicker } from './components/TxrMethodPicker'
import { useMethodRows } from './data/useMethodRows'
import { useListEstimate } from './data/useListEstimate'
import { countSelected } from './lib/selection'
import { formatTotalTime } from './lib/format'
import { recommendedSelection } from './lib/methodPicker'
import {
  TXRLIST_D_MODELS,
  TXRLIST_D_NOTE,
  TXRLIST_ELIGIBILITY,
  TXRLIST_ESTIMATE_SECONDS,
  TXRLIST_I_MODELS,
  TXRLIST_I_NOTE,
  TXRLIST_I_SECTIONS,
  TXRLIST_INVENTORY,
  TXRLIST_METHODS,
  estimateScheduleSeconds,
  txrlistEstimate,
  txrlistNarrowRows,
} from './fixtures'

// ── the run-result seam (the gallery-e2e asserts this, never the component) ──

interface RunResult {
  keys: string[]
  opts: { atATime: number; saveModels: boolean }
}

/** The board's research-use notice (DEC-13 — rendered when the host passes it). */
const RESEARCH_NOTICE = "For research. Not for deciding a patient's treatment."

/** The story hosts' list frame: a bounded, white list area (the board pane). */
const LIST_FRAME: CSSProperties = {
  height: 560,
  background: 'var(--txr-surface)',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
}

/** The run-result seam's element (dev-only harness output). */
function RunResultLine({ result }: { result: RunResult | null }) {
  return (
    <pre
      data-testid="txr-list-run-result"
      style={{ margin: 8, fontSize: 11, color: 'var(--txr-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    >
      {result === null
        ? 'run not fired yet'
        : JSON.stringify({ keys: result.keys, ...result.opts })}
    </pre>
  )
}

/** The boards' explanatory line under the list (host chrome, muted). */
function BoardNote({ children }: { children: string }) {
  return (
    <p style={{ margin: '10px 2px 0', fontSize: 12.5, color: 'var(--txr-muted)' }}>{children}</p>
  )
}

// ── screen E — the adapter-fed method picker (cassette: MethodCatalogue.*) ──

/**
 * The E story's host: exactly what the choose-methods page does — the
 * inventory (its own), the two hooks, the selection with the one-time
 * recommended seeding (qa-fixes3 ITEM-1), the picker, the estimate-driven
 * bar, and the Run callback's record.
 */
function EStoryView() {
  const { cards, loading, error, refetch } = useMethodRows(TXRLIST_INVENTORY)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const seeded = useRef(false)
  const [atATime, setAtATime] = useState(TXRLIST_DEFAULT_AT_A_TIME)
  const [saveModels, setSaveModels] = useState(false)
  const [runResult, setRunResult] = useState<RunResult | null>(null)
  useEffect(() => {
    if (seeded.current || cards.length === 0) return
    seeded.current = true
    setSelected(new Set(recommendedSelection(cards)))
  }, [cards])
  const estimate = useListEstimate([...selected], {
    patients: TXRLIST_INVENTORY.patients,
    atATime,
  })

  return (
    <div>
      <div style={PICKER_FRAME}>
        <TxrMethodPicker
          cards={cards}
          loading={loading}
          error={error}
          onRetry={refetch}
          selected={selected}
          onSelectionChange={setSelected}
          onChangeFiles={() => {}}
          onChangeSettings={() => {}}
        />
      </div>
      <TxrListBottomBar
        itemLabel="method"
        selectedCount={countSelected(selected, cards)}
        totalTimeText={formatTotalTime(estimate.scheduleSeconds)}
        atATime={{ value: atATime, onChange: setAtATime }}
        saveModels={{ checked: saveModels, onChange: setSaveModels }}
        notice={RESEARCH_NOTICE}
        onRun={opts => {
          // The bar reports the OPTIONS; the keys are the host's selection
          // minus the cards the host can see are disabled (the page's own
          // rule — the story records the same pair).
          const disabled = new Set(cards.filter(card => card.run.disabled).map(card => card.key))
          const keys = [...selected].filter(key => !disabled.has(key))
          setRunResult({ keys, opts })
        }}
      />
      <RunResultLine result={runResult} />
    </div>
  )
}

/** The E story's frame (the picker is one document — the story gives it room). */
const PICKER_FRAME: CSSProperties = {
  background: 'var(--txr-surface)',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  padding: 12,
}

// ── screens D and I — host-built rows (the ui-models side of the contract) ──

/** The total the D/I hosts show for their selection (same LPT rule as the endpoint). */
function hostTotal(selected: ReadonlySet<string>, seconds: Record<string, number>): string {
  return formatTotalTime(
    estimateScheduleSeconds(
      Object.entries(seconds).map(([id, s]) => ({ id, seconds: s })),
      [...selected],
      TXRLIST_DEFAULT_AT_A_TIME,
    ),
  )
}

/** The model-keys' seconds table for the fixture records. */
function recordSeconds(records: Array<{ row: TxrListRow; facts: { seconds: number } }>): Record<string, number> {
  return Object.fromEntries(records.map(r => [r.row.key, r.facts.seconds]))
}

/**
 * Screen D's host: the seven board models host-built, the three host chips
 * (Published rules / Learned by the benchmark / Checked on 2 or more other
 * cohorts), the Sort-by select (Transfer to other cohorts / Patients
 * covered / Time to run), the notice, and the board's explanatory note.
 */
function DStoryView() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(['ctdna-clearance', 'cox-cutpoint-risk', 'landmark-cox-current']),
  )
  const [chip, setChip] = useState<string | null>(null)
  const [sort, setSort] = useState('transfer')
  const [runResult, setRunResult] = useState<RunResult | null>(null)

  const chips: TxrFilterChip[] = [
    {
      id: 'published',
      label: 'Published rules',
      count: TXRLIST_D_MODELS.filter(m => m.facts.kind === 'published').length,
      active: chip === 'published',
      onToggle: () => setChip(prev => (prev === 'published' ? null : 'published')),
    },
    {
      id: 'learned',
      label: 'Learned by the benchmark',
      count: TXRLIST_D_MODELS.filter(m => m.facts.kind === 'learned').length,
      active: chip === 'learned',
      onToggle: () => setChip(prev => (prev === 'learned' ? null : 'learned')),
    },
    {
      id: 'checked',
      label: 'Checked on 2 or more other cohorts',
      count: TXRLIST_D_MODELS.filter(m => m.facts.otherCohorts >= 2).length,
      active: chip === 'checked',
      onToggle: () => setChip(prev => (prev === 'checked' ? null : 'checked')),
    },
  ]

  const shown = useMemo(() => {
    const filter = (m: (typeof TXRLIST_D_MODELS)[number]) =>
      chip === 'published'
        ? m.facts.kind === 'published'
        : chip === 'learned'
          ? m.facts.kind === 'learned'
          : chip === 'checked'
            ? m.facts.otherCohorts >= 2
            : true
    const sorted = TXRLIST_D_MODELS.filter(filter).sort((a, b) => {
      if (sort === 'patients') return b.facts.covered - a.facts.covered
      if (sort === 'time') return a.facts.seconds - b.facts.seconds
      return b.facts.otherCohorts - a.facts.otherCohorts
    })
    return sorted.map(m => m.row)
  }, [chip, sort])

  const sortControl: TxrSortControl = {
    value: sort,
    options: [
      { value: 'transfer', label: 'Transfer to other cohorts' },
      { value: 'patients', label: 'Patients covered' },
      { value: 'time', label: 'Time to run' },
    ],
    onChange: setSort,
  }

  return (
    <div>
      <div style={LIST_FRAME}>
        <TxrSelectList
          rows={shown}
          itemLabel="model"
          selected={selected}
          onSelectionChange={setSelected}
          filterChips={chips}
          sort={sortControl}
          bottomBar={{
            selectedCount: countSelected(selected, TXRLIST_D_MODELS.map(m => m.row)),
            totalTimeText: hostTotal(selected, recordSeconds(TXRLIST_D_MODELS)),
            notice: RESEARCH_NOTICE,
            onRun: (keys, opts) => setRunResult({ keys, opts }),
          }}
        />
      </div>
      <BoardNote>{TXRLIST_D_NOTE}</BoardNote>
      <RunResultLine result={runResult} />
    </div>
  )
}

/**
 * Screen I's host: the two fixture run groups, the find-a-model search and
 * the Sort-by (Newest run first / Patients covered / Time to run — sorts
 * WITHIN each run; the run order is the host's run list order, the sort
 * axis is the models of a run), the "Same outcome as my file" chip, and
 * the board's explanatory note.
 */
function IStoryView() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(['cox-cutpoint-risk', 'landmark-cox-current', 'dynforest']),
  )
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('newest')
  const [outcomeOnly, setOutcomeOnly] = useState(false)
  const [runResult, setRunResult] = useState<RunResult | null>(null)

  const chips: TxrFilterChip[] = [
    {
      id: 'same-outcome',
      label: 'Same outcome as my file',
      count: TXRLIST_I_MODELS.filter(m => m.sectionKey === 'crc-cohort-day-56').length,
      active: outcomeOnly,
      onToggle: () => setOutcomeOnly(prev => !prev),
    },
  ]

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const inRun = new Map<string, typeof TXRLIST_I_MODELS>()
    for (const record of TXRLIST_I_MODELS) {
      if (outcomeOnly && record.sectionKey !== 'crc-cohort-day-56') continue
      if (q.length > 0 && !record.row.name.toLowerCase().includes(q)) continue
      const group = inRun.get(record.sectionKey) ?? []
      group.push(record)
      inRun.set(record.sectionKey, group)
    }
    const order = TXRLIST_I_SECTIONS.map(s => s.key)
    const records = order.flatMap(key => {
      const group = [...(inRun.get(key) ?? [])]
      group.sort((a, b) => {
        if (sort === 'patients') return b.facts.covered - a.facts.covered
        if (sort === 'time') return a.facts.seconds - b.facts.seconds
        return 0
      })
      return group
    })
    return records.map(r => r.row)
  }, [query, sort, outcomeOnly])

  const sortControl: TxrSortControl = {
    value: sort,
    options: [
      { value: 'newest', label: 'Newest run first' },
      { value: 'patients', label: 'Patients covered' },
      { value: 'time', label: 'Time to run' },
    ],
    onChange: setSort,
  }

  return (
    <div>
      <div style={{ ...LIST_FRAME, height: 620 }}>
        <TxrSelectList
          rows={shown}
          sections={TXRLIST_I_SECTIONS}
          itemLabel="model"
          selected={selected}
          onSelectionChange={setSelected}
          filterChips={chips}
          search={{ value: query, onChange: setQuery }}
          sort={sortControl}
          bottomBar={{
            selectedCount: countSelected(selected, TXRLIST_I_MODELS.map(m => m.row)),
            totalTimeText: hostTotal(selected, recordSeconds(TXRLIST_I_MODELS)),
            notice: RESEARCH_NOTICE,
            onRun: (keys, opts) => setRunResult({ keys, opts }),
          }}
        />
      </div>
      <BoardNote>{TXRLIST_I_NOTE}</BoardNote>
      <RunResultLine result={runResult} />
    </div>
  )
}

// ── the remaining board states (EXAMPLE-UL-7's no-rows states + the wrap path) ──

/** The 390-px wrap story: the fixture's overflow rows at the board's mobile width. */
function NarrowStoryView() {
  const rows = useMemo(txrlistNarrowRows, [])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  return (
    <div style={{ width: 390, maxWidth: '100%' }}>
      <div style={LIST_FRAME}>
        <TxrSelectList
          rows={rows}
          itemLabel="method"
          selected={selected}
          onSelectionChange={setSelected}
          bottomBar={{
            selectedCount: countSelected(selected, rows),
            totalTimeText: formatTotalTime(null),
            onRun: () => undefined,
          }}
        />
      </div>
    </div>
  )
}

/** The empty state (zero rows, no loading, no error). */
function EmptyStoryView() {
  return (
    <div style={LIST_FRAME}>
      <TxrSelectList
        rows={[]}
        itemLabel="method"
        selected={new Set()}
        onSelectionChange={() => undefined}
        emptyText="No methods to show"
        bottomBar={{
          selectedCount: 0,
          totalTimeText: formatTotalTime(null),
          onRun: () => undefined,
        }}
      />
    </div>
  )
}

/** The first-load failure state (the error line + the Retry button). */
function ErrorStoryView() {
  const [attempts, setAttempts] = useState(0)
  return (
    <div style={LIST_FRAME}>
      <TxrSelectList
        rows={[]}
        itemLabel="method"
        selected={new Set()}
        onSelectionChange={() => undefined}
        error="Could not load the method list"
        onRetry={() => setAttempts(n => n + 1)}
        bottomBar={{
          selectedCount: 0,
          totalTimeText: formatTotalTime(null),
          onRun: () => undefined,
        }}
      />
    </div>
  )
}

/** The first-load state (the skeleton rows). */
function LoadingStoryView() {
  return (
    <div style={LIST_FRAME}>
      <TxrSelectList
        rows={[]}
        itemLabel="method"
        selected={new Set()}
        onSelectionChange={() => undefined}
        loading
        bottomBar={{
          selectedCount: 0,
          totalTimeText: formatTotalTime(null),
          onRun: () => undefined,
        }}
      />
    </div>
  )
}

// ── the module's gallery seed ──

export const gallery: ModuleGallery = {
  // The E story's mock endpoints — the ONLY network-ish surface the module
  // has, and the keys are the generated `ApiEndpoints` ids (DEC-11's
  // reconcile-if-different path resolved to `MethodCatalogue.*`; note (b)).
  cassette: {
    'MethodCatalogue.list': { methods: TXRLIST_METHODS, total: TXRLIST_METHODS.length },
    'MethodCatalogue.eligibility': () => TXRLIST_ELIGIBILITY,
    'MethodCatalogue.estimate': (ctx: { body?: unknown }) =>
      txrlistEstimate((ctx.body ?? {}) as { method_ids?: string[]; at_a_time?: number }),
  },

  seeded: [
    {
      slug: 'txr-list-e',
      title: 'Method picker (screen E) — adapter-fed',
      note: 'The redesigned picker (qa-fixes3 ITEM-1) fed by the REAL fetch hooks over the mock cassette: 38 catalogue methods × eligibility verdicts (the board\'s first rows verbatim), the family sections with the explainer + select-all, the presets (Recommended is ticked on arrival), the search/family/sort toolbar, the collapsed can\'t-run section with per-reason chips, and the estimate bar; the Run click records the keys + options below the list.',
      path: '/txrlist/e',
      initialPath: '/txrlist/e',
      component: lazy(() => Promise.resolve({ default: EStoryView })),
    },
    {
      slug: 'txr-list-d',
      title: 'Pretrained models (screen D) — host-built rows',
      note: 'The seven board models as host-built rows: Published/Learned chips, the performance column, the type chips + Sort by, the research notice in the bar, and the board\'s "what is missing" note under the list.',
      path: '/txrlist/d',
      initialPath: '/txrlist/d',
      component: lazy(() => Promise.resolve({ default: DStoryView })),
    },
    {
      slug: 'txr-list-i',
      title: 'Saved models (screen I) — run groups',
      note: 'Two run groups (11 CRC + 2 Lung models) with the run-facts headers, the section select-alls and the Rename/Delete actions; find-a-model search + Sort by (sorts within a run), the "Same outcome as my file" chip, the research notice, and the board\'s navigation note.',
      path: '/txrlist/i',
      initialPath: '/txrlist/i',
      component: lazy(() => Promise.resolve({ default: IStoryView })),
    },
    {
      slug: 'txr-list-narrow-390',
      title: 'List at 390 px — the wrap path',
      note: 'The board\'s mobile width: rows wrap (name/tag above status/detail/time/action), the long method id and the long missing-marker line stay inside the row, no horizontal page overflow (EXAMPLE-UL-6).',
      path: '/txrlist/narrow-390',
      initialPath: '/txrlist/narrow-390',
      component: lazy(() => Promise.resolve({ default: NarrowStoryView })),
    },
    {
      slug: 'txr-list-empty',
      title: 'List — zero rows',
      note: 'An empty set (no loading, no error): the board-silent state gets the module constant sentence (EXAMPLE-UL-7).',
      path: '/txrlist/empty',
      initialPath: '/txrlist/empty',
      component: lazy(() => Promise.resolve({ default: EmptyStoryView })),
    },
    {
      slug: 'txr-list-error',
      title: 'List — first-load failure',
      note: 'The error line + the Retry button (a retry in this story just re-counts the attempts — the refetch wiring is the adapter-fed E story\'s).',
      path: '/txrlist/error',
      initialPath: '/txrlist/error',
      component: lazy(() => Promise.resolve({ default: ErrorStoryView })),
    },
    {
      slug: 'txr-list-loading',
      title: 'List — first load',
      note: 'The skeleton rows before the first response (EXAMPLE-UL-7).',
      path: '/txrlist/loading',
      initialPath: '/txrlist/loading',
      component: lazy(() => Promise.resolve({ default: LoadingStoryView })),
    },
  ],
}
