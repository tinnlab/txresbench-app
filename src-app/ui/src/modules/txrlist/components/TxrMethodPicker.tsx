/**
 * TxrMethodPicker — the redesigned E-screen method picker (qa-fixes3
 * ITEM-1), the ONE list surface of the choose-methods page. It is NOT the
 * D/I board-row stream: the page scrolls as ONE document (no nested scroll
 * box), the default view is ONLY the methods that can run on the user's
 * data and this deployment ("Ready to run", N — nothing red), the
 * cannot-run methods are collapsed in a bottom section with a count per
 * reason, and the row is the method's short title + summary + facts (the
 * plan's row contract, `TxrMethodCardRow`).
 *
 * STATE (all UI state is the picker's; the SELECtion is the host's):
 * - the host's selection is controlled (`selected` +
 *   `onSelectionChange`) — the page needs it for the time estimate and the
 *   Run button (DEC-3), so the picker reports every change through
 *   `lib/methodPicker.ts`'s pure rules (toggle, presets, group select-all);
 * - the picker owns the toolbar state (search query, family multi-filter,
 *   sort, the preset last clicked), the per-section show-more, the can't-run
 *   section and the per-reason expansion. The pressed preset is the one last
 *   clicked while the selection still equals its set (`activePreset`: on a
 *   small catalogue two presets often give the same methods, and the one the
 *   user clicked is the one that shows), else the preset the selection
 *   equals, else Custom.
 *
 * DISPLAY RULES:
 * - the family order + explainer + the preset/recommendation rules are
 *   `lib/methodPicker.ts`'s constants and pure functions (one source);
 * - the first 6 rows of a section show; "Show N more" expands; a search or
 *   a family filter shows every match ("searching or filtering expands");
 * - a section header is STICKY within the page's one scroll container;
 * - the can't-run section is collapsed by default: "N methods can't run on
 *   this data" + one count chip per reason; a reason chip expands its plain
 *   list (title + id + the one-line reason + the one-line fix);
 * - zero runnable methods: the plan's plain statement (what blocks
 *   everything, what to change) + the two actions "Change files" / "Change
 *   settings";
 * - a re-check (`refreshing` with cards on screen) shows the "Re-checking"
 *   line; when it ends, the host's `recheckResult` ("Checked again: the same
 *   5 methods can run.", `recheckLine`) shows in a status line, so a change
 *   that leaves the list as it was is still visibly answered.
 *
 * The copy is location-neutral (qa-fixes2 ITEM-2 rules): no "on this
 * computer" anywhere; the deployment fact (fewer methods can start than the
 * catalogue lists) is stated as "no published environment".
 *
 * app-shell ITEM-2: the picker's pieces can be SPLIT by the host through
 * the `layout` render prop (toolbar → the page's fixed top slot, list →
 * the scroll region) while the toolbar state stays inside this component —
 * one state owner, one keyboard model, whichever box the toolbar ends up
 * in. Without `layout` the two pieces render inline exactly as before (the
 * gallery and the D/I screens keep the old composition). Since the step-4
 * fix the E page uses the inline composition too: its whole picker scrolls
 * in the page's one region.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Select, Skeleton } from '@txresbench/kit'
import { useAction } from '@/core/actions/useAction'
import { useActiveContext } from '@/core/actions/activeContext'
import { createVersioned } from '@/core/actions/versioned'
import type { TxrMethodCard } from '../types'
import {
  activePreset,
  fastSelection,
  filterMethodCards,
  METHODS_APPLY_PRESET,
  presetSelection,
  reasonGroups,
  recommendedSelection,
  runnableCards,
  sortCards,
  TXR_METHOD_PICKER_CONTEXT,
  TXRMETHOD_GROUP_ORDER,
  TXRMETHOD_GROUP_EXPLAINER,
  type TxrMethodGroupId,
  type TxrMethodPreset,
  type TxrMethodSort,
} from '../lib/methodPicker'
import { TxrMethodCardRowView } from './TxrMethodCardRow'

/** The picker's section frame. */
const PICKER: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }

/** The toolbar's card (the search/filter/sort/preset row). */
const TOOLBAR: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface-dim)',
}

/** The search box's width (the board's find-a-model box span). */
const SEARCH: CSSProperties = { width: 280, minWidth: 180 }

/** The section header's sticky look (one scroll container — a header never
 *  disappears under it; the page bg covers the rows it slides over). */
const SECTION_HEADER: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '4px 12px',
  padding: '8px 12px',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  background: 'var(--txr-surface-dim)',
  minWidth: 0,
}

const SECTION_TITLE: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--txr-text)' }

const SECTION_EXPLAINER: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--txr-muted)' }

const SECTION_COUNT: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)' }

const ROWS: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }

const MORE_LINE: CSSProperties = { display: 'flex', justifyContent: 'flex-start' }

/** The panel's plain-voice muted text. */
const MUTED: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

/** The recompute line (ITEM-2: a settings change re-checks eligibility —
 *  the old rows stay visible under it, never a blank flash). */
const REFRESH_LINE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--txr-muted)',
}

/** The re-check result line (step-4 fix: after a re-check the user is told
 *  what changed, or that nothing did). */
const RECHECK_LINE: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--txr-text-2)' }

/** The empty status element: kept in the DOM (a live region must exist
 *  before its text changes to be announced), out of the flow (an absolute
 *  child takes no flex gap) and invisible. */
const STATUS_EMPTY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  margin: 0,
}

/** What the picker instance reports to the action registry (`view.describe`,
 *  `views.list`): the pressed preset, the counts, and whether the method list
 *  is there yet (`loading` during the first load, `load_error` when that
 *  load failed; the preset action is refused in both states). */
type TxrMethodPickerSnapshot = {
  preset: TxrMethodPreset | 'custom'
  selected_count: number
  runnable_count: number
  loading: boolean
  load_error: string | null
}

/** The preset action's refusal while the method list is not there yet (the
 *  first load, or a first load that failed). The preset buttons are hidden
 *  then; a preset applied to an empty list would select nothing and stop the
 *  page's recommended selection on arrival. */
export const TXRMETHOD_LIST_UNAVAILABLE = 'UNAVAILABLE: the method list has not loaded yet'

/** A fresh `view_id` for one mounted picker (never reused). */
function newViewId(): string {
  return crypto.randomUUID()
}

/** The rows a section shows before "Show N more" (the plan's 6). */
const SECTION_SHOW_FIRST = 6

export interface TxrMethodPickerProps {
  /** The joined cards (the catalogue × eligibility adapter's output). */
  cards: TxrMethodCard[]
  /** The first load (the skeleton state). */
  loading: boolean
  /** True while a NEWER inventory's answer is in flight (the settings
   *  recompute): the picked rows stay on screen under the re-check line —
   *  a settings change is never a blank flash. */
  refreshing?: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
  /** The error state's Retry handler. */
  onRetry(): void
  /** The host's selection set (controlled — the page owns it, DEC-3). */
  selected: ReadonlySet<string>
  /** The selection changed (the picker reports the toggle/preset results). */
  onSelectionChange(next: ReadonlySet<string>): void
  /** The zero-state's "Change files" action (the page's dialog). */
  onChangeFiles(): void
  /** The zero-state's "Change settings" action (scroll to the settings). */
  onChangeSettings(): void
  /** The line that answers the last re-check (`recheckLine`, computed by the
   *  host, which knows when a new eligibility answer landed). Shown in a
   *  `role="status"` line under the presets, hidden while a re-check is in
   *  flight; `null`/omitted shows nothing. */
  recheckResult?: string | null
  /** The preset the user last applied, as the host kept it (a return to the
   *  page): it shows as pressed again while the selection still equals its
   *  set. Read on mount only. */
  initialPreset?: TxrMethodPreset | null
  /** A preset was applied (a button or `methods.applyPreset`), for a host
   *  that keeps it across a remount (`initialPreset`). */
  onPresetChosen?(preset: TxrMethodPreset): void
  /** The host's own composition of the picker's two pieces (toolbar + list).
   *  Default: both inline in one column (the pre-ITEM-2 byte). */
  layout?(parts: TxrMethodPickerLayoutParts): ReactNode
}

/** The picker's two pieces (app-shell ITEM-2's split). */
export interface TxrMethodPickerLayoutParts {
  /** The presets row, the re-check line and the search/filter/sort toolbar.
   *  `null` while the first load is in flight (the old early-return byte). */
  toolbar: ReactNode | null
  /** The loading / error / zero / sections / cannot-run bodies. */
  list: ReactNode
}

/** The family chip's toggleable pill (the kit Button wears the pill look).
 *  The border is written as LONGHANDS: the pressed looks override
 *  `borderColor`, and with a `border` shorthand here React's removal of the
 *  dropped `borderColor` on release left the kit's own border colour. */
const FAMILY_CHIP: CSSProperties = {
  fontSize: 12.5,
  height: 'auto',
  padding: '3px 10px',
  borderRadius: 999,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--txr-border)',
  background: 'var(--txr-surface)',
  color: 'var(--txr-text-2)',
}

const FAMILY_CHIP_ON: CSSProperties = {
  borderColor: 'var(--txr-brand)',
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
  fontWeight: 700,
}

const PRESET_ON: CSSProperties = {
  borderColor: 'var(--txr-brand)',
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
  fontWeight: 700,
}

export function TxrMethodPicker({
  cards,
  loading,
  refreshing = false,
  error,
  onRetry,
  selected,
  onSelectionChange,
  onChangeFiles,
  onChangeSettings,
  recheckResult = null,
  initialPreset = null,
  onPresetChosen,
  layout,
}: TxrMethodPickerProps) {
  const [query, setQuery] = useState('')
  const [familyFilter, setFamilyFilter] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<TxrMethodSort>('recommended')
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<string>>(new Set())
  const [cannotOpen, setCannotOpen] = useState(false)
  const [expandedReasons, setExpandedReasons] = useState<ReadonlySet<string>>(new Set())
  /** The preset last applied (null until one is): it stays pressed while the
   *  selection still equals its set (`activePreset`). */
  const [chosenPreset, setChosenPreset] = useState<TxrMethodPreset | null>(initialPreset)

  const runnable = useMemo(() => runnableCards(cards), [cards])
  const cannot = useMemo(() => cards.filter(card => card.run.disabled), [cards])
  const reasonGroupsList = useMemo(() => reasonGroups(cards), [cards])
  const preset = activePreset(selected, cards, chosenPreset)
  const filterActive = query.trim() !== '' || familyFilter.size > 0
  // The first load and a failed first load: no list, no presets (the
  // toolbar is not rendered) and the preset action is refused.
  const firstLoad = loading && cards.length === 0
  const firstError = error !== null && cards.length === 0
  // The picker as an AI-controllable instance (`methods.applyPreset`,
  // `core/actions/builtin/methodActions.ts`): one `view_id` per mounted
  // picker, its snapshot versioned so every selection change, whoever made
  // it, moves the `_state_token` the world-model reads return.
  const [viewId] = useState(newViewId)
  const snapshot: TxrMethodPickerSnapshot = {
    preset,
    selected_count: runnable.filter(card => selected.has(card.key)).length,
    runnable_count: runnable.length,
    loading: firstLoad,
    load_error: firstError ? error : null,
  }
  const [versioned] = useState(() => createVersioned(viewId, snapshot))
  const stamped = useRef({ selected, cards, chosenPreset, firstLoad, firstError })
  useEffect(() => {
    const last = stamped.current
    if (
      last.selected === selected &&
      last.cards === cards &&
      last.chosenPreset === chosenPreset &&
      last.firstLoad === firstLoad &&
      last.firstError === firstError
    ) {
      return
    }
    stamped.current = { selected, cards, chosenPreset, firstLoad, firstError }
    versioned.set(snapshot)
  })

  const shown = useMemo(() => {
    const filtered = filterMethodCards(runnable, query, familyFilter)
    return sortCards(filtered, sort)
  }, [runnable, query, familyFilter, sort])

  const toggleFamily = (group: string): void => {
    const next = new Set(familyFilter)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    setFamilyFilter(next)
  }

  /** Apply a preset: the button's click and the `methods.applyPreset`
   *  action run this same handler. */
  const applyPreset = (value: TxrMethodPreset): TxrMethodPickerSnapshot => {
    const keys = presetSelection(value, cards)
    setChosenPreset(value)
    onPresetChosen?.(value)
    onSelectionChange(new Set(keys))
    return {
      preset: value,
      selected_count: keys.length,
      runnable_count: runnable.length,
      loading: false,
      load_error: null,
    }
  }

  useAction(viewId, {
    type: TXR_METHOD_PICKER_CONTEXT,
    handlers: {
      [METHODS_APPLY_PRESET]: params => {
        // The buttons are not on screen until the list has loaded; the
        // action is refused the same way (it would select nothing and stop
        // the page's recommended seed).
        if (firstLoad) throw new Error(TXRMETHOD_LIST_UNAVAILABLE)
        if (firstError) throw new Error(`${TXRMETHOD_LIST_UNAVAILABLE} (${error})`)
        return applyPreset((params as { preset: TxrMethodPreset }).preset)
      },
    },
    getSnapshot: () => versioned.snapshot(),
  })
  useActiveContext(TXR_METHOD_PICKER_CONTEXT, { entityId: viewId })

  const toggleGroupAll = (group: TxrMethodGroupId, members: TxrMethodCard[]): void => {
    const memberKeys = members.map(member => member.key)
    const allOn = memberKeys.every(key => selected.has(key))
    const next = new Set(selected)
    if (allOn) {
      for (const key of memberKeys) next.delete(key)
    } else {
      for (const key of memberKeys) next.add(key)
    }
    onSelectionChange(next)
  }

  const toggleReason = (key: string): void => {
    const next = new Set(expandedReasons)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpandedReasons(next)
  }

  const openCannot = (): void => {
    setCannotOpen(mode => {
      if (!mode) {
        setExpandedReasons(new Set(reasonGroupsList.map(group => group.key)))
      }
      return !mode
    })
  }

  const recommendations = recommendedSelection(cards)
  const allKeys = presetSelection('all', cards)
  const fastKeys = fastSelection(cards)
  // Every set-taking preset shows its count, so a user can see when two of
  // them give the same methods.
  const presets: { value: TxrMethodPreset; label: string }[] = [
    { value: 'recommended', label: `Recommended (${recommendations.length})` },
    { value: 'all', label: `All that can run (${allKeys.length})` },
    { value: 'fast', label: `Fast only, under 1 min each (${fastKeys.length})` },
    { value: 'none', label: 'None' },
  ]


  // The toolbar (the page may pin it OUTSIDE the list's scroll region): the
  // first-load and first-error states have no toolbar (the old early-return
  // byte — the page's fixed top then carries only the page's own header).
  const toolbar =
    firstLoad || firstError ? null : (
      <>
        <div data-testid="txr-method-presets" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {presets.map(item => (
            <Button
              key={item.value}
              type="button"
              data-testid={`txr-method-preset-${item.value}`}
              aria-pressed={preset === item.value}
              variant="outline"
              className="txr-method-preset"
              style={preset === item.value ? { ...FAMILY_CHIP, ...PRESET_ON } : FAMILY_CHIP}
              onClick={() => applyPreset(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        {refreshing && cards.length > 0 ? (
          <div data-testid="txr-method-refreshing" aria-busy="true" style={REFRESH_LINE}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                border: '2px solid var(--txr-border)',
                borderTopColor: 'var(--txr-brand)',
                display: 'inline-block',
              }}
            />
            Re-checking what can run with these settings…
          </div>
        ) : null}
        <p
          data-testid="txr-method-recheck-result"
          role="status"
          style={recheckResult !== null && !refreshing ? RECHECK_LINE : STATUS_EMPTY}
        >
          {refreshing ? null : recheckResult}
        </p>

        <div data-testid="txr-method-toolbar" style={TOOLBAR}>
          <Input
            data-testid="txr-method-search"
            aria-label="Search methods"
            placeholder="Search methods"
            allowStyle
            style={SEARCH}
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          {TXRMETHOD_GROUP_ORDER.map(group => {
            const count = runnable.filter(card => card.group === group).length
            if (count === 0) return null
            const active = familyFilter.has(group)
            return (
              <Button
                key={group}
                type="button"
                data-testid={`txr-method-family-${group}`}
                aria-pressed={active}
                variant="outline"
                className="txr-method-family"
                style={active ? { ...FAMILY_CHIP, ...FAMILY_CHIP_ON } : FAMILY_CHIP}
                onClick={() => toggleFamily(group)}
              >
                {cards.find(card => card.group === group)?.groupLabel ?? group} ({count})
              </Button>
            )
          })}
          <Select
            data-testid="txr-method-sort"
            aria-label="Sort methods"
            size="sm"
            options={[
              { value: 'recommended', label: 'Recommended' },
              { value: 'fastest', label: 'Fastest' },
              { value: 'name', label: 'Name' },
              { value: 'year', label: 'Year' },
            ]}
            value={sort}
            onValueChange={value => setSort(value as TxrMethodSort)}
          />
          {/* demo-mode ITEM-6: the E page hands the picker the recorded
              methods only (list = bundle methods only), so there is no
              cannot-run section and the toggle is a dead control — it
              renders only when there is a section to open. */}
          {cannot.length > 0 ? (
            <Button
              data-testid="txr-method-cannot-toggle"
              variant="outline"
              aria-pressed={cannotOpen}
              onClick={openCannot}
            >
              {cannotOpen ? 'Hide methods that can\'t run' : "Show methods that can't run"}
            </Button>
          ) : null}
        </div>
      </>
    )

  const list =
    firstLoad ? (
      <div data-testid="txr-method-loading" aria-busy="true" style={PICKER}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} style={{ height: 92, borderRadius: 10 }} />
        ))}
      </div>
    ) : firstError ? (
      <div data-testid="txr-method-error" style={PICKER}>
        <span style={{ fontSize: 13.5, color: 'var(--txr-danger)' }}>{error}</span>
        <div>
          <Button data-testid="txr-method-retry" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    ) : runnable.length === 0 ? (
        <div
          data-testid="txr-method-zero"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '16px 18px',
            border: '1px solid var(--txr-border)',
            borderRadius: 10,
            background: 'var(--txr-surface)',
          }}
        >
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>
            None of the {cards.length} methods can run on this data.
          </p>
          <p style={MUTED}>What blocks everything, and what to change:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {reasonGroupsList.map(group => (
              <span key={group.key} data-testid={`txr-method-zero-reason-${group.key}`} style={{ ...FAMILY_CHIP, background: 'var(--txr-danger-soft)', color: 'var(--txr-danger)', borderColor: 'var(--txr-danger-border)' }}>
                {group.label} ({group.count}) — {group.fix}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <Button data-testid="txr-method-zero-change-files" variant="outline" onClick={onChangeFiles}>
              Change files
            </Button>
            <Button data-testid="txr-method-zero-change-settings" variant="outline" onClick={onChangeSettings}>
              Change settings
            </Button>
          </div>
        </div>
      ) : (
        <>
        <div data-testid="txr-method-sections" style={PICKER}>
          <h2 data-testid="txr-method-ready-heading" style={{ margin: '4px 0 0', fontSize: 16 }}>
            Ready to run ({runnable.length})
          </h2>
          {TXRMETHOD_GROUP_ORDER.filter(group => shown.some(card => card.group === group)).map(group => {
            const groupRunnable = runnable.filter(card => card.group === group)
            const members = shown.filter(card => card.group === group)
            const sectionExpanded = expandedSections.has(group)
            const visible = filterActive || sectionExpanded ? members : members.slice(0, SECTION_SHOW_FIRST)
            const allSelected =
              groupRunnable.length > 0 && groupRunnable.every(member => selected.has(member.key))
            return (
              <section key={group} data-testid={`txr-method-section-${group}`}>
                <div data-testid={`txr-method-section-header-${group}`} style={SECTION_HEADER}>
                  <h3 style={SECTION_TITLE}>{groupRunnable[0].groupLabel}</h3>
                  <p style={SECTION_EXPLAINER}>{TXRMETHOD_GROUP_EXPLAINER[group]}</p>
                  <span style={SECTION_COUNT}>{groupRunnable.length}</span>
                  <Button
                    data-testid={`txr-method-section-select-all-${group}`}
                    variant="link"
                    aria-pressed={allSelected}
                    style={{ padding: 0, height: 'auto', fontSize: 12.5 }}
                    onClick={() => toggleGroupAll(group, groupRunnable)}
                  >
                    {allSelected ? 'Unselect all in group' : 'Select all in group'}
                  </Button>
                </div>
                <div style={ROWS}>
                  {visible.map(card => (
                    <TxrMethodCardRowView
                      key={card.key}
                      card={card}
                      checked={selected.has(card.key)}
                      onToggle={card => {
                        const next = new Set(selected)
                        if (next.has(card.key)) next.delete(card.key)
                        else next.add(card.key)
                        onSelectionChange(next)
                      }}
                    />
                  ))}
                  {!filterActive && !sectionExpanded && members.length > SECTION_SHOW_FIRST ? (
                    <div style={MORE_LINE}>
                      <Button
                        data-testid={`txr-method-section-more-${group}`}
                        variant="link"
                        style={{ padding: 0, height: 'auto', fontSize: 12.5 }}
                        onClick={() => setExpandedSections(prev => new Set(prev).add(group))}
                      >
                        Show {members.length - SECTION_SHOW_FIRST} more
                      </Button>
                    </div>
                  ) : null}
                </div>
              </section>
            )
          })}
        </div>

        {cannot.length > 0 ? (
          <section data-testid="txr-method-cannot" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 data-testid="txr-method-cannot-heading" style={{ margin: '4px 0 0', fontSize: 16 }}>
              {cannot.length} {cannot.length === 1 ? 'method' : 'methods'} can't run on this data
            </h2>
            {!cannotOpen ? (
              <div data-testid="txr-method-cannot-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {reasonGroupsList.map(group => (
                  <Button
                    key={group.key}
                    type="button"
                    data-testid={`txr-method-reason-${group.key}`}
                    variant="outline"
                    style={{ ...FAMILY_CHIP, background: 'var(--txr-danger-soft)', color: 'var(--txr-danger)', borderColor: 'var(--txr-danger-border)' }}
                    aria-expanded={expandedReasons.has(group.key)}
                    onClick={() => {
                      setCannotOpen(true)
                      setExpandedReasons(prev => {
                        const next = new Set(prev)
                        if (next.has(group.key)) next.delete(group.key)
                        else next.add(group.key)
                        return next
                      })
                    }}
                  >
                    {group.label} ({group.count})
                  </Button>
                ))}
              </div>
            ) : (
              <div data-testid="txr-method-cannot-lists" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {reasonGroupsList.map(group => (
                  <div key={group.key} data-testid={`txr-method-reason-group-${group.key}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Button
                      type="button"
                      data-testid={`txr-method-reason-toggle-${group.key}`}
                      aria-expanded={expandedReasons.has(group.key)}
                      variant="outline"
                      style={expandedReasons.has(group.key) ? { ...FAMILY_CHIP, ...FAMILY_CHIP_ON } : FAMILY_CHIP}
                      onClick={() => toggleReason(group.key)}
                    >
                      {group.label} ({group.count})
                    </Button>
                    {expandedReasons.has(group.key) ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {group.cards.map(card => (
                          <div key={card.key} data-testid={`txr-method-cannot-row-${card.id}`} style={{ padding: '6px 10px', border: '1px solid var(--txr-border-subtle)', borderRadius: 8, background: 'var(--txr-surface)' }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txr-text)' }}>
                              {card.title}
                            </div>
                            <div style={{ fontSize: 12, fontFamily: "'Source Code Pro', monospace", color: 'var(--txr-muted)' }}>
                              {card.id}
                            </div>
                            {/* qa-fixes4 ITEM-3 (methods-r3 R2-6): the row
                                shows EVERY reason the verdict carries, one
                                line each — the environment fact first, the
                                data reasons (a missing marker, the drawn-day
                                coverage, too few draws) BESIDE it; the old
                                first-reason-only line hid what the user
                                could fix. */}
                            {card.run.reasonLines.map((reasonLine, index) => (
                              <div
                                key={`${card.id}-${index}`}
                                data-testid={`txr-method-cannot-reason-${card.id}-${index}`}
                                style={{ fontSize: 12.5, color: 'var(--txr-text-2)' }}
                              >
                                {reasonLine}
                              </div>
                            ))}
                            <div style={{ fontSize: 12.5, color: 'var(--txr-muted)' }}>
                              {card.run.reasonFix || group.fix}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </>
    )

  const compose = layout ?? ((parts: TxrMethodPickerLayoutParts) => (
    <div data-testid="txr-method-picker" style={PICKER}>
      {parts.toolbar}
      {parts.list}
    </div>
  ))
  return compose({ toolbar, list })
}
