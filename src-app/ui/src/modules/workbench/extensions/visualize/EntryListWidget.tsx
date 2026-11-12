// `entry_list` (ITEM-23 / DEC-2, design §5.6) — the one new widget KIND.
//
// An AXIS ENTRY is not a token. A `multiselect` chip can carry a value and a label and nothing
// else, and the things this control exists to state are all "else": WHICH sources an entry
// resolved to, that it resolved to ZERO (U1), a per-source sub-toggle under disposition `each`,
// the active-filter badge a collapsed section reads (R6), and — since the entry section — a group
// heading that survives search, a row that says WHICH annotation a search hit, and a ▶ that
// makes a picture of the row.
//
// ── SCALE IS AN OBJECTION, AND THIS CONTROL IS THE PARTY THAT ANSWERS IT ────────────────
//
// This file used to say that kit's `MultiSelect` is virtualised "so the scale objection was
// already answered". That was a non-sequitur about a component this widget does not use, and
// it was load-bearing in the wrong direction: the engine declares an axis browsable up to
// `ENTRY_BROWSE_MAX` (200,000), an ordinary project hands this list tens of thousands of
// entries, and `shown.map(renderEntry)` mounted every one of them — plus a nested per-source
// `<ul>` under each — the moment the section was expanded. The list is what renders, so the
// list is what has to be bounded.
//
// It is bounded by TRUE WINDOWING, never by a cap on what is offered: the whole job of this
// section is to browse and search tens of thousands of entries, so refusing above some size
// would refuse the task.
//
// It used to be bounded by a MOUNT BUDGET — a first page, grown by a "Show 200 more" control —
// and this header used to argue that a budget was preferable to a window because a window
// "tells a screen reader a different row count from the one the DOM holds". The owner
// (ledger #38) resolved that objection the other way round: *"use virtual scrolling with proper
// aria row indices"*. The objection was never to windowing; it was to windowing with the
// accessibility work left undone. So the work is DONE here, and it is the whole reason this
// list is a `grid` rather than the `<ul>` it used to be — `aria-rowindex` on an `<li>` is
// ignored, so the markup changed rather than the attributes:
//   · `aria-rowcount` on the grid is the size of the FULL FILTERED SET, never the window.
//   · `aria-rowindex` on each rendered row is its 1-based index IN THAT SET, never its
//     position in the window. A reader on row 12,000 is told they are on row 12,000.
//
// Three properties the budget preserved, which the window preserves for the same reasons and
// with the same tests:
//   · SEARCH matches the WHOLE set — filtering happens first and the window slices the
//     RESULT. A window over an unfiltered list would answer a question about the first N.
//   · GROUP HEADINGS count the whole MATCHED set (`n of N`), not the mounted slice — a
//     heading counting the window would say the axis is smaller than it is.
//   · THE END IS REACHABLE. The budget reached it by pressing a control; the window reaches it
//     by scrolling to it, because the scroll track is the full set's height (below).
//
// ── THE SCROLLBAR IS THE HONESTY SIGNAL, and it is NOT a native one ─────────────────────
//
// Same instruction, second half: *"Also do not use native scroll bar please"*. The list scrolls
// inside the kit's `ScrollArea` (overlayscrollbars), which is already the house rule for every
// pane scroll track — not beside it, and not with a second scrollbar implementation of this
// widget's own.
//
// Two things follow, and both are deliberate rather than discovered:
//   · overlayscrollbars wraps its content in its OWN viewport element, so the virtualiser's
//     height measurement and its scroll/resize listeners bind to `elements().scrollOffsetElement`
//     — NOT to the host box. Binding the host yields a window that never updates, which reads
//     as "virtualisation isn't working" rather than "the wrong node was measured".
//   · the grid is `height: getTotalSize()` — the summed height of EVERY row in the filtered
//     set, not of the mounted window — so the viewport's `scrollHeight` is the true size and
//     the thumb overlayscrollbars derives from it is proportioned to the true size. That is
//     what makes the thumb honest, and it is why the "Showing 200 of 35,477" line and its
//     "Show 200 more" button are GONE rather than kept beside it: a thumb that is 1/180th of
//     its track already says how much list there is, and a second, weaker statement of the same
//     fact is the redundancy ledger #38 asks to remove. (Had the thumb been unable to represent
//     the true size, the count control would have STAYED — the one outcome ruled out is
//     neither.) The count that remains is the group heading's, and it was never the window's.
//
// It is registered through the ordinary `registerWidget` seam and is NOT in core's
// `WIDGET_KINDS`: core's list is the FORM-CONTROL vocabulary that must be complete-by-kind, and
// a visualize-specific control in the transport layer is what the open-kind seam exists to stop.
//
// ── TWO MODELS, and each renders only what it was DECLARED with ────────────────────────
//
// A row may be a CHOICE (a `value` binding ⇒ a checkbox; the chosen set feeds an
// `axis_entry_values` binding) or a VERB (`action` declared ⇒ a ▶; ITEM-34, DEC-10 — *"each
// row carries a ▶ on its right that visualizes it"*). Neither is inferred from the other's
// absence: a spec that binds no `value` renders NO checkbox rather than an inert one,
// which is the dead-control failure this round removes. Both may be declared; the two are
// independent.

import * as React from 'react'
import { observeElementOffset, observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { Checkbox, Input, ScrollArea, Select } from '@txresbench/kit'
import { cn } from '@/lib/utils'
import { EmitControl } from '@/modules/workbench/core/render/EmitControl'
import type {
  EntryListSource,
  EntryListWidget as EntryListWidgetSpec,
} from '@/modules/workbench/core/manifest/viewSpec'
import { evalExpr, interpolateBraces } from '@/modules/workbench/core/runtime/expr'
import type { WidgetRenderer } from '@/modules/workbench/core/render/registry'
import { WidgetField } from '@/modules/workbench/core/render/WidgetField'

/** Copy is centralized so a test asserts the sentence rather than re-typing it, and so a
 *  future i18n pass has one target. */
export const ENTRY_LIST_COPY = {
  /** The ENGINE's fallback for "nothing offered". A view that knows better declares
   *  `empty_text` (INV-5) — it is the only party that can say WHICH emptiness this is. */
  empty: 'No entries yet',
  /** The engine's fallback for U1. Same rule: the view's `unresolved_text` wins. */
  unresolved: 'chosen, but no values on these rows',
  search: 'Search…',
  noMatch: 'No entry matches that search',
  /** ITEM-50 — the prefix of the sub-line a row shows when it matched on something OTHER than
   *  the annotation being displayed. Without it a row appears in the results for no visible
   *  reason, which is a small mystery on every cross-annotation search. */
  matched: 'matched',
} as const

/**
 * THE FIRST-PAINT HEIGHTS, in px — what a row is GUESSED to be before it has been measured.
 *
 * Every rendered row is measured for real (`measureElement`) and the measurement replaces the
 * guess, so these three numbers decide exactly two things: the scroll track's height before
 * anything has been measured, and how many rows the first paint mounts. They are deliberately
 * close to the shipped row (`gap-0.5`, `text-sm`, `EmitControl` at `size-7`) so the track does
 * not visibly resize under the thumb on the first scroll.
 *
 * They are NOT a fixed row height. A row is variable by construction — it may carry a match
 * sub-line (ITEM-50) and, under disposition `each`, a nested list of one line per source — so
 * the estimator ADDS a line per thing the row is about to render and the measurement corrects
 * whatever it got wrong. A fixed-height virtualiser would silently misplace exactly those rows.
 */
export const ENTRY_ROW_ESTIMATE = 28
/** One extra line on a row — the match sub-line, or one per-source sub-row. */
export const ENTRY_LINE_ESTIMATE = 20
/** A group heading plus the gap above it, on the row that carries one. */
export const ENTRY_HEADING_ESTIMATE = 24

/** How many rows beyond the viewport are mounted on each side. Enough that an ordinary wheel
 *  gesture lands on already-mounted rows, small enough that the DOM stays a screenful. */
export const ENTRY_LIST_OVERSCAN = 8

/**
 * WHAT A VIEWPORT OF UNKNOWN HEIGHT IS ASSUMED TO BE, px — the height of the scroll box
 * (`max-h-96`).
 *
 * A window's mounted range is a function of the viewport's measured height, and a height of
 * ZERO produces an EMPTY range: no rows at all. Zero is not a hypothetical — it is what a
 * viewport reports before the first layout pass, inside a collapsed or not-yet-laid-out pane,
 * and under any renderer with no layout engine. A list that renders NOTHING in those moments is
 * strictly worse than one that renders a screenful it may have to correct, because "nothing" is
 * indistinguishable from "this axis has no entries".
 *
 * So a measurement of exactly 0 is read as "not measured yet" and answered with a screenful.
 * Any real measurement, including a genuinely tiny pane, is used as-is.
 */
export const ENTRY_LIST_ASSUMED_VIEWPORT = 384

/**
 * THE ROW TRACK — owner, ledger #31: *"each row in the group and values are too tall, we do not
 * need row line"*.
 *
 * Both halves of that sentence are this one string, and it is a NAMED constant because both
 * halves are assertable and a test that re-typed the class would pass while the list rendered
 * something else.
 *
 * · NO ROW LINE. There is no `divide-y`, no `border-b`, no `[&>li]:border`. The rows this
 *   complaint was made about were `table` tiles — a grid draws a rule under every row by
 *   construction — and the column section is an `entry_list` now (ledger #32), where separation is
 *   whitespace. The absence is stated here rather than being merely true, so a future "let's
 *   add a subtle divider" arrives at a comment instead of at a blank line.
 * · TIGHTER. 2px between rows rather than 4px. The other half of the row's height is the emit
 *   control's, and it gave a step back too (`EmitControl`, `size-7`).
 *
 * The 2px is the ROW's own `pb-0.5` ({@link ENTRY_ROW_CLASS}) and NOT a `gap-0.5` on this
 * container, which is what it used to be. A flex `gap` is not part of any row's measured height,
 * so a virtualiser that positions rows from their measurements would fall 2px behind per row —
 * 70,954px of drift over the owner's axis, i.e. the list would stop tracking its own scrollbar
 * about a fifth of the way down. Spacing that must be measured has to live INSIDE the measured
 * box.
 */
export const ENTRY_LIST_ROWS_CLASS = 'flex flex-col'

/** ONE RIGHT EDGE for the whole widget body (owner: entrylist-align). The scroll region is
 *  full-bled TO the card's inner border (so the overlay scrollbar sits flush there), while the
 *  rows inside it keep an inline-end gutter that holds the "Plot ▶" clear of the border-flush
 *  thumb. That gutter is {@link ENTRY_LIST_ROWS_GUTTER} = 2×`--section-inset` (1rem ≥ the ~10px
 *  thumb, with margin).
 *
 *  The content ABOVE the scroll area (the "Show:" select, the search box) is NOT full-bled — it
 *  sits at the accordion body's own inset, which is `--section-inset` INSIDE the card border. So
 *  to land on the SAME right edge as the rows it needs the SMALLER gutter
 *  {@link ENTRY_LIST_ABOVE_GUTTER} = `2×--section-inset − --section-inset` = `--section-inset`.
 *  Both are expressed off the one `--section-inset` token (published by `SectionFrame`) so the
 *  two gutters cannot drift apart and the alignment holds for any inset value. */
export const ENTRY_LIST_ROWS_GUTTER = '[padding-inline-end:calc(var(--section-inset)*2)]'
export const ENTRY_LIST_ABOVE_GUTTER = '[padding-inline-end:var(--section-inset)]'

/** The 2px, on the row itself — see {@link ENTRY_LIST_ROWS_CLASS} for why it is not a gap. */
export const ENTRY_ROW_CLASS = 'pb-0.5'

/** One offered entry, normalized. The KEY is the identity; every other field is display and is
 *  never keyed on (INV-1). */
interface EntrySpec {
  key: string
  label: string
  /** ITEM-51 — `— no <Annotation>`, when the displayed annotation has no value here. */
  missingNote: string | null
  /** ITEM-54 — the declared group this entry falls in. */
  group: string | null
  /** ITEM-52 — the qualifier a CONTESTED name carries in the list. `null` when uncontested,
   *  which is the whole rule: *"show a distinguisher only where there is something to
   *  distinguish"*. */
  qualifier: string | null
  /** ITEM-58 — what a PLOT of this entry is called, which always qualifies. */
  title: string
  /** ITEM-50's search corpus — every annotation's value for this entry, the displayed one
   *  first. */
  values: ReadonlyArray<{ title: string; value: string }>
  /**
   * THE ROW'S SECOND LINE — a whole sentence about this entry, on its own line beneath the
   * name (dimension-membership ITEM-10).
   *
   * It is NOT a third `values` annotation, and the distinction is why the field exists. An
   * annotation is a VALUE with a title (`2 levels`, `0 – 9`), it competes for the one inline
   * slot {@link secondAnnotation} fills, and that slot deliberately shows exactly one — "print
   * what distinguishes, suppress what is constant". A sentence is not competing with those: it
   * says something about the entry RELATIVE TO WHAT THE PANE IS FRAMED ON, so it is a
   * different kind of fact and it gets its own line rather than displacing the annotation.
   *
   * It was declared and it was not on screen. `row_space_columns` has been putting the figure
   * in `values[2]` since ITEM-10, where nothing rendered it — the resolver was right, its unit
   * tests were right, and the sentence reached no user. That is what the e2e tier caught, and
   * it is why the field is on `EntrySpec` rather than in a third annotation slot that would
   * have to argue with the suppress-what-is-constant rule to be shown at all.
   *
   * `null` on every entry that declares none — which is every row of the sibling entry-axis
   * section, and every row of every project that has produced no membership, so no list gains a
   * blank line.
   */
  note: string | null
  /** ITEM-29c's gate — a non-empty string IS the refusal of this row's ▶. */
  refusal: string | null
  /** the entry's INDEX on its own axis. Captured here and handed to the action, because a
   *  column-indexed encoding is addressed by position and the position must come from the
   *  axis's own order. */
  position: number
  /**
   * THE ROW AS THE ENGINE DECLARED IT, unnormalized.
   *
   * `$row` in an action's `args` is evaluated against the row, and until now that was the
   * NORMALIZED spec above — so a declaration could only address the seven fields this widget
   * happens to model, and an engine that stated an eighth had no way to hand it to the action.
   * That is a real limit and not a hypothetical: the column section's rows carry the producer's
   * declared summary `kind`, which decides whether an emitted tile is coloured as a category
   * or as a range, and no field of `EntrySpec` could carry it.
   *
   * So the record travels UNDER the normalized fields (`{...record, ...entry}`): every name
   * this widget models keeps the widget's own normalization, and everything else the engine
   * declared is addressable. A widget that silently dropped fields it did not model would make
   * the seam declarable-only-for-what-was-anticipated, which is the closed vocabulary the
   * open-kind seam exists to avoid.
   */
  record: Record<string, unknown>
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function toEntries(raw: unknown): EntrySpec[] {
  if (!Array.isArray(raw)) return []
  const out: EntrySpec[] = []
  raw.forEach((e, position) => {
    if (typeof e === 'string') {
      if (e !== '') {
        out.push({
          key: e,
          label: e,
          missingNote: null,
          group: null,
          qualifier: null,
          title: e,
          values: [],
          note: null,
          refusal: null,
          position,
          record: {},
        })
      }
      return
    }
    if (!e || typeof e !== 'object') return
    const rec = e as Record<string, unknown>
    const key = String(rec.key ?? rec.value ?? '')
    if (key === '') return
    const label = str(rec.label) || key
    out.push({
      key,
      label,
      missingNote: nullableStr(rec.missing_note),
      group: nullableStr(rec.group),
      qualifier: nullableStr(rec.qualifier),
      title: str(rec.title) || label,
      values: Array.isArray(rec.values)
        ? (rec.values as unknown[])
            .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
            .map(v => ({ title: str(v.title), value: str(v.value) }))
        : [],
      note: nullableStr(rec.note),
      refusal: nullableStr(rec.plot_refusal),
      position,
      record: rec,
    })
  })
  return out
}

/**
 * Normalize the `sources` binding.
 *
 * TWO shapes, and the second is the one the entry seam actually lands: a `{ entry → sources }`
 * MAP, or a flat ARRAY that applies to EVERY entry. The array is not a shorthand — candidacy is
 * a property of the AXIS, since an artifact declaring the axis is indexed by its keys and so
 * carries every entry of it. A map of 18,000 identical arrays would be the same fact written
 * 18,000 times, and the two entries whose sources genuinely differ do not exist.
 */
function toSourceMap(raw: unknown): { map: Record<string, EntryListSource[]>; all?: EntryListSource[] } {
  if (Array.isArray(raw)) {
    return { map: {}, all: raw.filter((s): s is EntryListSource => !!s && typeof s === 'object') }
  }
  if (!raw || typeof raw !== 'object') return { map: {} }
  const out: Record<string, EntryListSource[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue
    out[k] = v.filter((s): s is EntryListSource => !!s && typeof s === 'object')
  }
  return { map: out }
}

/** A source's ADDRESS — `(artifact, selector)`, never its title (INV-1). The title may be
 *  absent, may repeat, and may be renamed under a grid tile that is already open; the address
 *  may not. */
const sourceId = (s: EntryListSource): string => `${s.artifact} ${s.selector ?? ''}`
const sourceLabel = (s: EntryListSource): string => s.title ?? s.selector ?? s.artifact

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** `{ entry: enabledSourceIds[] }`, or `{}` when nothing is declared — which means EVERY source
 *  is enabled, since that is what `each` says with nothing said. */
function toEnabledMap(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, asStringList(v)]),
  )
}

/** ITEM-54's declared group totals, `{ name → count }`. */
function toGroupCounts(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(raw)) return out
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue
    const rec = g as Record<string, unknown>
    const name = str(rec.name)
    if (name === '') continue
    out.set(name, typeof rec.count === 'number' ? rec.count : 0)
  }
  return out
}

/**
 * ITEM-33's numeral — how many plots of this entry are open.
 *
 * Tolerant of both shapes a counting binding lands: a bare number, or `count_by`'s
 * `{before, after}` record. Tolerant because the widget is not the party that chose the
 * derivation, and a control that rendered nothing because the caller used the repo's own
 * counting primitive would be a silent omission.
 */
function toCount(raw: unknown, key: string): number {
  if (!raw || typeof raw !== 'object') return 0
  const v = (raw as Record<string, unknown>)[key]
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && typeof (v as { before?: unknown }).before === 'number') {
    return (v as { before: number }).before
  }
  return 0
}

/** WHICH annotation a query hit, when it is not the one being displayed (ITEM-50). `null` when
 *  the displayed name (or the key) already explains the match, which is the common case — so
 *  the sub-line is rare by construction rather than by a cap. */
function matchedOther(entry: EntrySpec, q: string): { title: string; value: string } | null {
  if (q === '') return null
  if (entry.label.toLowerCase().includes(q) || entry.key.toLowerCase().includes(q)) return null
  for (const v of entry.values) {
    if (v.value !== '' && v.value.toLowerCase().includes(q)) return v
  }
  return null
}

/**
 * THE ROW'S SECOND ANNOTATION — the mockup's `CD3E   ENSG…98851`, inline and secondary to the
 * name.
 *
 * `values` arrives in the header's own option order with the DISPLAYED annotation first, so
 * "the other name this entry has" is the next one that says anything. It is the thing that
 * genuinely VARIES per row, and it was missing from the shipped list while a string identical
 * on every row (the source's datatype and matrix dims) occupied the slot beneath it — the
 * exact inversion of "print what distinguishes, suppress what is constant".
 *
 * `null` when the entry has no second annotation, or when the only one it has says nothing new.
 * TWO ways it can say nothing new, and the second was caught by LOOKING AT THE SCREENSHOT rather
 * than by any assertion:
 *
 *   · it repeats the NAME — a row reading `CD3E   CD3E` spends the slot on a constant of the
 *     row instead of a constant of the list, the same defect one scale down;
 *   · it repeats the GROUP — the group HEADING above already states it, so printing it on every
 *     row under that heading puts one constant in the slot whose whole job is to distinguish
 *     rows. That is the reported defect exactly, at group scale instead of list scale: the first
 *     capture of this section showed `RNA` beside all three rows under a heading reading `RNA`.
 *
 * It is the pane's own suppress-what-is-constant rule, applied to the one slot this change added
 * — which is precisely where a new instance of it could be introduced by the fix for it.
 */
function secondAnnotation(entry: EntrySpec): { title: string; value: string } | null {
  for (const v of entry.values.slice(1)) {
    if (v.value === '' || v.value === entry.label) continue
    if (entry.group !== null && v.value === entry.group) continue
    // …and never the SECOND LINE's own sentence. An engine that puts its `note` in the search
    // corpus too (which `row_space_columns` does, so a reader can search the figure) would
    // otherwise have it printed twice on any row whose annotation slot is empty — the same
    // string in two places, which is the redundancy this function's other two clauses remove.
    if (entry.note !== null && v.value === entry.note) continue
    return v
  }
  return null
}

/**
 * MAY THIS ROW SHOW ITS SOURCES AT ALL?
 *
 * Only where an entry genuinely resolves to MORE THAN ONE (owner, 2026-08-13). With one source
 * the sub-row printed the same string under every entry in the list — a datatype id and a
 * matrix's dimensions, identical on all 18,000 rows, in the position whose whole job is to tell
 * one row from the next — and carried a SECOND emit control doing what the row's own already
 * did. Both are the same rule the rest of this pane already states: print what distinguishes,
 * suppress what is constant, and never two controls for one verb.
 *
 * The sub-rows are NOT a smaller version of a working affordance in the one-source case; there
 * is nothing there to choose between and nothing there to name. Where there ARE two sources
 * they come back in full, because then which source a picture came from is the information.
 */
function sourcesDistinguish(resolved: readonly EntryListSource[]): boolean {
  return resolved.length > 1
}

/** Does this entry match the query AT ALL — across EVERY annotation, plus the key (ITEM-50).
 *  Someone pasting a key under a header showing something else must find its row; refusing
 *  would be perverse. */
function matches(entry: EntrySpec, q: string): boolean {
  if (q === '') return true
  if (entry.label.toLowerCase().includes(q) || entry.key.toLowerCase().includes(q)) return true
  return entry.values.some(v => v.value !== '' && v.value.toLowerCase().includes(q))
}

/**
 * ONE ROW OF THE WINDOWED LIST — an entry, plus the group heading it carries when it is the
 * first match in its group.
 *
 * The heading rides ON the row rather than being a row of its own, and that is what keeps the
 * two ARIA numbers exactly the filtered set: `aria-rowcount` is `placed.length` and a row's
 * `aria-rowindex` is its index in `placed`, with nothing interleaved that is not an entry. The
 * alternative — a heading as its own `role="row"` — would either consume row indices (so the
 * count would no longer be the set) or be a row with no index (which the grid pattern does not
 * allow). A `role="rowgroup"` per group is the third option and it cannot be windowed: one
 * absolutely-positioned track cannot also be a nest of per-group containers.
 */
interface PlacedRow {
  entry: EntrySpec
  /** The heading text, on the first matched row of each group; `null` on every other row. */
  heading: string | null
  /** The group's own name, for the heading's testid. */
  groupKey: string | null
}

/**
 * FILTERED SET → DISPLAY ORDER, with the headings placed.
 *
 * Ungrouped, this is the filtered set unchanged. Grouped (ITEM-54/55), the matches are gathered
 * into their declared groups in the axis's own order of first appearance — the same order the
 * unwindowed list built — and each group's first row carries the heading.
 *
 * A group heading counts every MATCH in that group (`n of N` under a query, the bare declared
 * total otherwise). It is a statement about the axis, never about the window: a heading that
 * counted what happened to be mounted would say the axis is smaller than it is.
 */
function place(
  shown: readonly EntrySpec[],
  grouped: boolean,
  groupCounts: Map<string, number>,
  q: string,
): PlacedRow[] {
  if (!grouped) return shown.map(entry => ({ entry, heading: null, groupKey: null }))
  const order: string[] = []
  const byGroup = new Map<string, EntrySpec[]>()
  for (const e of shown) {
    const g = e.group ?? ''
    if (!byGroup.has(g)) {
      byGroup.set(g, [])
      order.push(g)
    }
    byGroup.get(g)!.push(e)
  }
  const out: PlacedRow[] = []
  for (const g of order) {
    const rows = byGroup.get(g)!
    const total = groupCounts.get(g)
    const count =
      total === undefined
        ? String(rows.length)
        : q === '' || rows.length === total
          ? total.toLocaleString()
          : `${rows.length.toLocaleString()} of ${total.toLocaleString()}`
    rows.forEach((entry, i) => {
      out.push({
        entry,
        heading: i === 0 ? (g === '' ? count : `${g} · ${count}`) : null,
        groupKey: i === 0 ? g : null,
      })
    })
  }
  return out
}

/**
 * THE VIRTUALISER MUST NOT MOUNT INSIDE A HIDDEN PANEL.
 *
 * A section frame collapses with `keepMounted` (base-ui accordion), so a collapsed section stays
 * mounted under `display:none`. A `useVirtualizer` bound to the overlayscrollbars viewport then
 * measures against a zero-height, un-laid-out box the whole time it is hidden, and the re-measure
 * on re-show is a class of failure the widget should not depend on tanstack's own guards to
 * survive (a shipped viz § Items ships `collapsed: true`, so it opens from exactly
 * that state). The structural fix is to not mount the windowed body while hidden at all: gate it
 * on visibility, render a placeholder while hidden, and let the virtualiser mount FRESH against a
 * laid-out viewport on expand.
 *
 * Visibility is read as `offsetParent === null` (which is `display:none` under an ancestor,
 * precisely the collapsed-panel case — NOT scrolled-out-of-view) inside a `ResizeObserver`
 * callback, because a `display` toggle changes the observed box's size and so fires the
 * observer. It DEFAULTS to visible and only ever downgrades from the callback, so a host with no
 * `ResizeObserver` (jsdom unit tests) keeps the body mounted exactly as before — the callback
 * never fires there, and no `offsetParent` is consulted.
 */
function useEntryListVisible(): [boolean, (el: HTMLElement | null) => void] {
  const [visible, setVisible] = React.useState(true)
  const observerRef = React.useRef<ResizeObserver | null>(null)
  const setRef = React.useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setVisible(el.offsetParent !== null))
    ro.observe(el)
    observerRef.current = ro
  }, [])
  React.useEffect(() => () => observerRef.current?.disconnect(), [])
  return [visible, setRef]
}

/** The per-row hooks the windowed body hands each rendered row — the virtualiser's measure ref
 *  and the roving-focus state, which now live in {@link EntryListBody} rather than in the
 *  renderer, so they never exist while the panel is hidden. */
interface RowControl {
  /** `virt.measureElement` — the row measures its real height back into the track. */
  measureRef: (el: HTMLElement | null) => void
  /** whether THIS row is the keyboard's row (the single tab-order stop). */
  active: boolean
  /** claim the keyboard's row (on focus). */
  onActivate: () => void
}

/**
 * THE WINDOWED BODY — the `ScrollArea` + the tanstack virtualiser, extracted into a child so it
 * MOUNTS FRESH each time the section expands and never mounts while the section is collapsed
 * (see {@link useEntryListVisible}). Everything virtualiser- or window-scoped lives here: the
 * overlayscrollbars viewport, the roving keyboard index, the scroll-reset and focus-claim
 * effects, and the keyboard navigation. The renderer above owns only the DERIVATIONS (which do
 * not depend on the viewport) and the per-row content (`renderRow`), so the search box, grouping
 * and the R6 badge are unaffected by the gate.
 */
function EntryListBody({
  idPrefix,
  gridLabel,
  placed,
  estimateSize,
  q,
  offer,
  renderRow,
}: {
  idPrefix: string
  gridLabel: string
  placed: readonly PlacedRow[]
  estimateSize: (i: number) => number
  q: string
  offer: string
  renderRow: (p: PlacedRow, index: number, ctl: RowControl) => React.ReactNode
}): React.ReactElement {
  /** overlayscrollbars' OWN viewport — the element that actually scrolls, and therefore the one
   *  the virtualiser measures and listens to. The host box does neither. */
  const [viewport, setViewport] = React.useState<HTMLElement | null>(null)
  /** The row the keyboard is on. A roving index, so exactly one row is in the tab order and a
   *  row that scrolls out of the window does not strand focus on a removed node. */
  const [active, setActive] = React.useState(0)
  const gridRef = React.useRef<HTMLDivElement | null>(null)
  /** Set when the keyboard asked to move: the target row may not be mounted until the scroll
   *  the move provoked has re-rendered, so focus is claimed by the first commit that has it. */
  const wantFocus = React.useRef(false)

  // A NEW ANSWER STARTS AT ITS TOP — the return-to-top the renderer used to do inline before the
  // body was extracted. React's sanctioned adjust-state-during-render form (compare with the
  // previous value in state, set both, no effect and no extra commit).
  const answerKey = `${offer}\u0000${q}`
  const [seenAnswer, setSeenAnswer] = React.useState(answerKey)
  if (seenAnswer !== answerKey) {
    setSeenAnswer(answerKey)
    setActive(0)
  }

  const virt = useVirtualizer({
    count: placed.length,
    getScrollElement: () => viewport,
    estimateSize,
    overscan: ENTRY_LIST_OVERSCAN,
    getItemKey: i => placed[i]?.entry.key ?? i,
    // An UNMEASURED viewport mounts a screenful rather than nothing — see
    // {@link ENTRY_LIST_ASSUMED_VIEWPORT}.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, rect =>
        cb({ width: rect.width, height: rect.height === 0 ? ENTRY_LIST_ASSUMED_VIEWPORT : rect.height }),
      ),
    // CANCEL THE LEAKED SCROLL-RESET TIMER ON UNMOUNT (react-virtual `observeOffset`).
    //
    // The default scroll observer schedules a `isScrollingResetDelay` (150 ms) debounce
    // `setTimeout` on every scroll to flip `isScrolling` back off. Its unsubscribe removes the
    // scroll listener but does NOT `clearTimeout` that pending debounce, so a scroll < 150 ms
    // before this widget unmounts leaves a timer that fires AFTER unmount → the virtualizer's
    // `maybeNotify` → the adapter's `onChange` → a react-dom state update against a viewport
    // whose host is gone. Under vitest's jsdom that host is the torn-down `window`, so the
    // stray update throws `ReferenceError: window is not defined` as an UNHANDLED error (all
    // tests still pass, but `vitest run` exits non-zero). Wrapping the offset callback with a
    // `stopped` guard flipped in this observer's own cleanup makes any timer that outlives the
    // registration a no-op — no update fires after unmount. (Fixes the leak introduced when the
    // list was windowed; the guard is per-registration, so a scroll-element swap is unaffected.)
    observeElementOffset: (instance, cb) => {
      let stopped = false
      const unsub = observeElementOffset(instance, (offset, isScrolling) => {
        if (!stopped) cb(offset, isScrolling)
      })
      return () => {
        stopped = true
        unsub?.()
      }
    },
  })

  // A NEW ANSWER STARTS AT ITS TOP (the viewport half). Through the virtualiser's OWN scroll,
  // not by assigning `scrollTop`: a bare assignment moves the box but leaves the virtualiser's
  // idea of the offset where it was.
  React.useEffect(() => {
    if (viewport) virt.scrollToOffset(0)
  }, [viewport, offer, q, virt])

  // CROSSING THE WINDOW BOUNDARY MUST NOT STRAND FOCUS — the claim stands until a commit has the
  // node, instead of being made once against a DOM that has not caught up.
  React.useEffect(() => {
    if (!wantFocus.current) return
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (el) {
      el.focus()
      wantFocus.current = false
    }
  })

  /** Move the keyboard's row. Clamped to the set, never to the window. */
  const moveActive = (to: number): void => {
    const next = Math.max(0, Math.min(placed.length - 1, to))
    wantFocus.current = true
    setActive(next)
    virt.scrollToIndex(next, { align: 'auto' })
  }

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step =
      e.key === 'ArrowDown' ? 1
        : e.key === 'ArrowUp' ? -1
          : e.key === 'PageDown' ? 10
            : e.key === 'PageUp' ? -10
              : 0
    if (step !== 0) {
      e.preventDefault()
      moveActive(active + step)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      moveActive(0)
    } else if (e.key === 'End') {
      // The END IS REACHABLE — in one keystroke rather than scrolling a windowed list by hand.
      e.preventDefault()
      moveActive(placed.length - 1)
    }
  }

  const items = virt.getVirtualItems()
  return (
    <ScrollArea
      axis="y"
      autoHide="leave"
      // FULL-BLEED THE INLINE-END so the overlay scrollbar sits FLUSH at the card's inner border
      // (owner: scrollbar-at-border). `SectionFrame` now insets the section body via a
      // `padding-inline` on the accordion body wrapper (NOT the card box), and that wrapper is not
      // `overflow:hidden` — so this scroll region can reach back out to the card border by exactly
      // that inset (`--section-inset`, published by `SectionFrame`).
      //
      // A negative `margin-inline-end` alone does NOT do it: this host is `width:100%`, so a
      // negative end-margin only pulls FOLLOWING content left — the border-box right edge (which
      // the overlay scrollbar rides) stays put. So the box is WIDENED by the inset
      // (`width:calc(100% + --section-inset)`) to push its inline-end edge to the card's inner
      // border, and the matching negative `margin-inline-end` keeps its margin-box from forcing
      // the panel any wider. Inline-START is untouched, so the list stays aligned with the search
      // box above it; the rows keep their inline-end gutter below to clear the border-flush thumb.
      className="max-h-96 [width:calc(100%+var(--section-inset))] [margin-inline-end:calc(var(--section-inset)*-1)]"
      data-testid={`${idPrefix}-scroll`}
      events={{
        // overlayscrollbars' OWN viewport — the node the virtualiser must measure and listen
        // to. `updated` as well as `initialized`, because the viewport is replaced when the
        // instance re-initialises and a stale node is a window that never moves again.
        initialized: i => setViewport(i.elements().scrollOffsetElement as HTMLElement),
        updated: i => setViewport(i.elements().scrollOffsetElement as HTMLElement),
      }}
    >
      <div
        ref={gridRef}
        role="grid"
        // THE FULL FILTERED SET — never the window. A reader is told how much list there is.
        aria-rowcount={placed.length}
        aria-label={gridLabel}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        data-testid={`${idPrefix}-grid`}
        style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}
      >
        <div
          role="rowgroup"
          // BUG 2 — a logical inline-end gutter so the overlayscrollbars overlay thumb (which
          // takes NO layout space) does not paint over each row's "Plot ▶" at the right edge.
          // Now that the scroll region is full-bled to the card border (see the `ScrollArea`
          // `-margin-inline-end` above), the thumb sits AT the border, so this gutter is what
          // holds the Plot button clear of it. {@link ENTRY_LIST_ROWS_GUTTER} = 2×`--section-inset`
          // (1rem) clears the ~10px thumb with a margin AND is the RIGHT EDGE the search box + Show
          // select align to (see that constant). It is on the ROWGROUP, not the grid, and
          // padding-inline does not change a row's measured height, so the virtualiser's height
          // invariant is safe.
          className={cn(ENTRY_LIST_ROWS_CLASS, ENTRY_LIST_ROWS_GUTTER)}
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            top: 0,
            width: '100%',
            transform: `translateY(${items[0]?.start ?? 0}px)`,
          }}
        >
          {items.map(vi => {
            const p = placed[vi.index]
            return p === undefined
              ? null
              : renderRow(p, vi.index, {
                  measureRef: virt.measureElement,
                  active: active === vi.index,
                  onActivate: () => setActive(vi.index),
                })
          })}
        </div>
      </div>
    </ScrollArea>
  )
}

export const EntryListRenderer: WidgetRenderer = (spec, ctx) => {
  const w = spec as EntryListWidgetSpec
  const id = `widget-${(w as { id?: string }).id ?? 'entry_list'}`
  const rawEntries = evalExpr(w.entries, ctx.scope)
  const rawGroups = evalExpr(w.groups, ctx.scope)
  const sources = toSourceMap(evalExpr(w.sources, ctx.scope))
  const chosen = new Set(asStringList(evalExpr(w.value, ctx.scope)))
  const enabled = toEnabledMap(evalExpr(w.source_value, ctx.scope))
  const grouped = evalExpr(w.grouped, ctx.scope) === true
  const counts = w.counts === undefined ? undefined : evalExpr(w.counts, ctx.scope)

  // EVERY hook is unconditional and stays above every early return: this renderer is invoked
  // inside `RenderedWidget`, so its hooks are that component's, and a return that skipped one
  // would change the hook order the first time a binding flipped.
  const [query, setQuery] = React.useState('')
  /** Whether the windowed body may mount — false while the section frame holds this widget
   *  collapsed under `display:none`. The virtualiser lives in {@link EntryListBody} and only
   *  mounts when this is true, so it never measures a hidden viewport. */
  const [bodyVisible, bodyVisibleRef] = useEntryListVisible()

  // The derivations the WINDOW re-runs on: a scroll re-renders this component, and re-filtering
  // 35,477 entries on every animation frame is exactly the cost virtualisation was adopted to
  // avoid. They are keyed on the raw bindings rather than on the normalized arrays, which
  // `toEntries` rebuilds on every render by construction.
  const entries = React.useMemo(() => toEntries(rawEntries), [rawEntries])
  const groupCounts = React.useMemo(() => toGroupCounts(rawGroups), [rawGroups])

  const q = query.trim().toLowerCase()
  // Filter FIRST, window second — the search is over every offered entry, and the window only
  // decides how much of the ANSWER is mounted.
  const shown = React.useMemo(
    () => (q === '' ? entries : entries.filter(e => matches(e, q))),
    [entries, q],
  )
  /** THE FILTERED SET, in display order, with the group headings placed. Its LENGTH is what
   *  `aria-rowcount` states and what the scroll track is sized from; an index into it is what
   *  `aria-rowindex` states. Nothing here knows about the window. */
  const placed = React.useMemo(
    () => place(shown, grouped, groupCounts, q),
    [shown, grouped, groupCounts, q],
  )

  // THE READER IS RETURNED TO THE TOP WHEN THE OFFER IS REPLACED, not when it is relabelled.
  //
  // The identity is the offer's KEYS (count + first + last), not the array reference and not the
  // labels: changing the DISPLAYED annotation relabels the same entries and must NOT move the
  // reader — it is the same list, and throwing them back to the top would punish them for
  // renaming what they are looking at. This is React's sanctioned adjust-state-during-render
  // form (compare with the previous value in state, set both, no effect and no extra commit).
  const offer = `${entries.length}:${entries[0]?.key ?? ''}:${entries[entries.length - 1]?.key ?? ''}`

  // The per-source sub-affordances exist ONLY under `each`. Under `combined` and `one` the
  // sources are not separately addressable, so offering one would offer a choice that does not
  // exist — which is worse than not offering it, because it looks like it worked.
  const perSource = w.disposition === 'each'
  const sourcesFor = (key: string): EntryListSource[] => sources.all ?? sources.map[key] ?? []

  // ── THE WINDOW ─────────────────────────────────────────────────────────────────────────
  //
  // `count` is the FILTERED SET, so every index the virtualiser speaks in is an index into that
  // set — which is exactly what `aria-rowindex` has to be. The virtualiser itself lives in
  // {@link EntryListBody} (so it never mounts while the section is collapsed); this row-height
  // estimator is passed down to it. It depends only on the DERIVATIONS above (never on the
  // viewport), so it stays here where the row content is built.
  const rowEstimate = (i: number): number => {
    const p = placed[i]
    if (p === undefined) return ENTRY_ROW_ESTIMATE
    let h = ENTRY_ROW_ESTIMATE
    if (p.heading !== null) h += ENTRY_HEADING_ESTIMATE
    if (matchedOther(p.entry, q) !== null) h += ENTRY_LINE_ESTIMATE
    const resolved = sourcesFor(p.entry.key)
    if (perSource && sourcesDistinguish(resolved)) h += resolved.length * ENTRY_LINE_ESTIMATE
    return h
  }

  // ── "no rows" is not one fact (the empty-vs-refused conflation) ─────────────────────────
  //
  // `entries` arriving empty is the same array whether the axis resolved and holds nothing,
  // the axis was REFUSED as over-budget (4.1M entries), or no row space is anchored yet — and
  // this control used to answer all three with `empty_text`. Beside a section alert saying the
  // axis has 4,100,000 entries, that prints two sentences of which exactly one is true, which
  // is worse than either alone.
  //
  // So the CONTROL cannot claim emptiness unless the engine says the list was actually listed.
  // Undeclared ⇒ the caller makes no claim and `entries` is the whole truth (the shape every
  // existing view binds). Declared ⇒ only a literal `true` is a listing; anything else — a
  // refusal, an unanchored pane, a slice that has not resolved yet — renders NOTHING here and
  // leaves the sentence to the party that knows which absence it is (INV-5 / ITEM-63).
  const listed = w.browsable === undefined || evalExpr(w.browsable, ctx.scope) === true
  if (!listed && ctx.error === undefined) return null

  const isEmpty = entries.length === 0
  // INV-5 — the view's own sentence wins, because the view is the only party that can say WHICH
  // emptiness this is; the engine can only say THAT it is empty.
  const emptyText = w.empty_text?.trim() || ENTRY_LIST_COPY.empty
  const unresolvedText = w.unresolved_text?.trim() || ENTRY_LIST_COPY.unresolved
  // A row is a CHOICE when the spec binds a chosen SET to it, and a VERB when it declares an
  // `action`. The gate is the `value` binding rather than `onChange`, because `value` is what
  // makes "chosen" a fact this control can render at all — a spec with no chosen set has no
  // three states to distinguish, and a checkbox on such a row would be a control whose ticked
  // state nothing reads.
  const choosable = w.value !== undefined
  const act = w.action

  const toggleEntry = (key: string, next: boolean): void => {
    const value = next ? [...chosen, key] : [...chosen].filter(k => k !== key)
    ctx.dispatch(w.onChange, { value, entry: key, selected: next })
  }

  /** ONE press of a ▶. `source` absent ⇒ the parent's press. */
  const emit = (entry: EntrySpec, source?: EntryListSource): void => {
    if (entry.refusal != null || !act) return
    const rowSources = sourcesFor(entry.key)
    // ITEM-59 — the PARENT ▶ emits under the section's declared disposition: with `each`, one
    // click is one plot PER SOURCE. The engine does not decide that (INV-19); the declaration
    // does, and this control is where the declaration is read.
    const targets = source ? [source] : perSource && rowSources.length > 0 ? rowSources : [undefined]
    for (const target of targets) {
      // `...entry.record` FIRST so the widget's own normalization wins on every name it
      // models, and the engine's other declared fields are addressable underneath it.
      const scope = { ...ctx.scope, row: { ...entry.record, ...entry }, source: target ?? null }
      const args: Record<string, unknown> = {
        entry: entry.key,
        label: entry.label,
        title: entry.title,
        position: entry.position,
        ...(target ? { artifact: target.artifact, source_title: sourceLabel(target) } : {}),
      }
      for (const [k, expr] of Object.entries(act.args ?? {})) args[k] = evalExpr(expr, scope)
      ctx.dispatch(act.onClick, args)
    }
  }

  /** The EMIT button itself — {@link EmitControl}, the pane's ONE emit control (owner, ledger
   *  #33). This list used to hand-write the button and "deliberately agree by hand" with the
   *  table renderer's glyph and variant; two files agreeing by hand is what the owner was
   *  looking at when they asked why the same verb had a border in one section and not in
   *  another. The glyph, the variant, the click suppression and the refusal handling are the
   *  component's now, and this file supplies only the NAME (ITEM-30 — forty rows called "Plot"
   *  would be forty identical accessible names). `interpolateBraces` is the app's existing
   *  explicitly-delimited form, so a label with no braces is unchanged. */
  const playButton = (
    testId: string,
    name: string,
    refusal: string | null,
    onPress: () => void,
  ): React.ReactNode => {
    const label = `${interpolateBraces(act?.label ?? '', ctx.scope) || 'Plot'} ${name}`
    return (
      <EmitControl
        data-testid={testId}
        name={label}
        refusal={refusal ?? undefined}
        onPress={onPress}
      />
    )
  }

  // ITEM-48/49 — the header's DISPLAY select. It renders only when the engine says there is
  // something to distinguish; `when: false` means the control does not exist, not that it is
  // disabled, because a disabled control still asserts there was a decision to make.
  const showSpec = w.show
  const showVisible = showSpec !== undefined && evalExpr(showSpec.when, ctx.scope) !== false
  const showOptions = showVisible
    ? (evalExpr(showSpec.options, ctx.scope) as unknown[] | undefined) ?? []
    : []
  const showNote = showVisible ? str(evalExpr(showSpec.note, ctx.scope)) : ''

  const header = showVisible ? (
    // Aligned to the rows' right edge — see {@link ENTRY_LIST_ABOVE_GUTTER}.
    <div className={cn('flex flex-col gap-1', ENTRY_LIST_ABOVE_GUTTER)} data-testid={`${id}-show`}>
      <div className="flex items-center gap-2">
        {showSpec.label ? <span className="text-xs text-muted-foreground">{showSpec.label}</span> : null}
        <Select
          data-testid={`${id}-show-select`}
          aria-label={showSpec.label ?? 'Show'}
          value={str(evalExpr(showSpec.value, ctx.scope))}
          onValueChange={(v: string) => ctx.dispatch(showSpec.onChange, { value: v })}
          options={showOptions
            .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
            .map(o => ({ value: str(o.value), label: str(o.label) || str(o.value) }))}
        />
      </div>
      {showNote !== '' ? (
        <p data-testid={`${id}-show-note`} className="text-xs text-muted-foreground">
          {showNote}
        </p>
      ) : null}
    </div>
  ) : null

  /**
   * ONE ROW OF THE GRID, at its index IN THE FILTERED SET.
   *
   * The outer element is the `role="row"` that carries `aria-rowindex` — the whole reason this
   * list is a grid and not the `<ul>` it used to be. `data-index` is what the virtualiser reads
   * back off the measured node, so a row whose real height differs from the estimate (a match
   * sub-line, a nest of per-source sub-rows) corrects the track rather than being misplaced in
   * it. `ref={ctl.measureRef}` (the virtualiser's `measureElement`, handed down from
   * {@link EntryListBody}) is that measurement.
   */
  const renderRow = (p: PlacedRow, index: number, ctl: RowControl): React.ReactNode => {
    const e = p.entry
    const picked = chosen.has(e.key)
    const resolved = sourcesFor(e.key)
    // THREE STATES, and the third is the one a token cannot carry (INV-6 / U1): unchosen ·
    // chosen-and-resolved (with its source COUNT) · chosen-and-UNRESOLVED, which STAYS chosen
    // and says so. Dropping the choice instead would make "I picked it and nothing happened"
    // indistinguishable from "I never picked it".
    const state = !picked ? 'unchosen' : resolved.length > 0 ? 'resolved' : 'unresolved'
    const hit = matchedOther(e, q)
    const second = secondAnnotation(e)
    const open = counts === undefined ? 0 : toCount(counts, e.key)
    return (
      <div
        key={e.key}
        role="row"
        // THE SET INDEX, not the window index — 1-based, as the grid pattern requires.
        aria-rowindex={index + 1}
        data-index={index}
        // The virtualiser's measure ref + the roving-focus state now come from
        // {@link EntryListBody} (via `ctl`), which owns the window — see {@link RowControl}.
        ref={ctl.measureRef}
        // A ROVING TAB INDEX: exactly one row is in the tab order, so Tab reaches the list at
        // the row the reader was last on and the arrow keys move within it.
        tabIndex={ctl.active ? 0 : -1}
        onFocusCapture={ctl.onActivate}
        data-testid={`${id}-row-${e.key}`}
        className={ENTRY_ROW_CLASS}
      >
        {/* ITEM-54/55 — the group's heading, on the first matched row of the group. It rides on
            the row (see {@link PlacedRow}) so that every grid row is an entry and the two ARIA
            numbers stay exactly the filtered set. */}
        {p.heading !== null ? (
          <p
            data-testid={`${id}-group-${p.groupKey ?? ''}`}
            className="pt-2 pb-1 text-xs font-medium text-muted-foreground"
          >
            {p.heading}
          </p>
        ) : null}
        <div
          role="gridcell"
          data-testid={`${id}-entry-${e.key}`}
          data-entry-state={state}
          className="flex flex-col gap-1"
        >
        <div className="flex items-center gap-2 text-sm">
          {choosable ? (
            <Checkbox
              data-testid={`${id}-toggle-${e.key}`}
              aria-label={e.label}
              checked={picked}
              onCheckedChange={(v: boolean) => toggleEntry(e.key, v === true)}
            />
          ) : null}
          {/* THE NAME. Carries its own testid so an assertion about what the row is CALLED can
              be made against the name and not against the row's whole text — the row also
              holds a secondary annotation now, and "the name did not silently fall back to
              another vocabulary" is a claim about the name. */}
          <span data-testid={`${id}-label-${e.key}`} className="min-w-0 flex-1 truncate">
            {e.label}
            {/* ITEM-52 — the qualifier, only where the name is contested. */}
            {e.qualifier ? (
              <span data-testid={`${id}-qualifier-${e.key}`} className="text-muted-foreground">
                {` (${e.qualifier})`}
              </span>
            ) : null}
            {/* ITEM-51 — the ABSENCE, stated. Never a silent fallback to another vocabulary. */}
            {e.missingNote ? (
              <span data-testid={`${id}-missing-${e.key}`} className="ps-2 text-xs text-muted-foreground">
                {e.missingNote}
              </span>
            ) : null}
          </span>
          {/* THE OTHER NAME (the mockup's `CD3E   ENSG…98851`) — inline, secondary, and the
              one thing on the row that varies per row. Its accessible text carries the
              annotation's TITLE, because `ENSG…98851` read aloud with no noun is a string.

              IT YIELDS TO THE NAME, and that is `min-w-0 max-w-[45%] shrink truncate`, NOT
              `shrink-0`. A `metadata-column` chosen via `Show:` can be free text — a long
              description, not just a short id — and a `shrink-0` secondary refuses to shrink,
              so `truncate` (which needs an inline-size bound) was INERT: a long value took its
              full intrinsic width, collapsed the `flex-1 min-w-0` name to ZERO, and shoved the
              count + "Plot ▶" past the row's inline-end edge, off-screen and overflowing the
              pane. Letting it shrink is not enough on its own — the `flex-1` name has basis 0%,
              so it, not the secondary, absorbs the shrink and still collapses; the `max-w-[45%]`
              cap is what guarantees the name keeps the majority of the row and the secondary
              truncates within its share. Short ids (the common case) sit below the cap and are
              unaffected. Guarded by
              `tests/gallery-e2e/entry-list-second-annotation-overflow.spec.ts`. */}
          {second ? (
            <span
              data-testid={`${id}-second-${e.key}`}
              title={`${second.title} · ${second.value}`}
              className="min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground"
            >
              {second.value}
            </span>
          ) : null}
          {choosable && state === 'resolved' ? (
            <span data-testid={`${id}-count-${e.key}`} className="text-xs text-muted-foreground">
              {resolved.length === 1 ? '1 source' : `${resolved.length} sources`}
            </span>
          ) : null}
          {choosable && state === 'unresolved' ? (
            <span data-testid={`${id}-unresolved-${e.key}`} className="text-xs text-muted-foreground">
              {unresolvedText}
            </span>
          ) : null}
          {/* ITEM-33 — the row's only PERSISTENT mark: how many pictures of it are open. A
              small numeral rather than a filled control, because a filled control would read
              as a SELECTED state and a row is a verb. Absent at zero. */}
          {open > 0 ? (
            <span data-testid={`${id}-open-${e.key}`} className="text-xs text-muted-foreground">
              {open}
            </span>
          ) : null}
          {/* ITEM-30/ITEM-58 — the ▶ is named from `title`, the ALWAYS-qualified form, not
              from the displayed `label`. Two rows may legitimately DISPLAY the same name
              (that is what `qualifier` exists for), and naming both buttons from the label
              gives a screen-reader user two controls called "Plot CD3" — the same defect as
              forty rows called "Plot", one step later. `title` is the row's disambiguated
              name by construction, so it is what the button says. */}
          {act ? playButton(`${id}-plot-${e.key}`, e.title, e.refusal, () => emit(e)) : null}
        </div>
        {/* THE SECOND LINE (dimension-membership ITEM-10 / Q3) — what this entry says about
            itself RELATIVE TO WHAT THE PANE IS FRAMED ON. A whole sentence, so it takes a line
            rather than the inline annotation slot beside the name, and nothing suppresses it:
            where the fact is genuinely not derivable the engine sends the sentence that says
            so, and where no frame states a population the engine sends no `note` at all. */}
        {e.note ? (
          <p data-testid={`${id}-note-${e.key}`} className="ps-6 text-xs text-muted-foreground">
            {e.note}
          </p>
        ) : null}
        {/* ITEM-50 — WHICH annotation the search hit, on the rows where the displayed name
            does not explain it. */}
        {hit ? (
          <p data-testid={`${id}-matched-${e.key}`} className="ps-6 text-xs text-muted-foreground">
            {`${ENTRY_LIST_COPY.matched} ${hit.title} · ${hit.value}`}
          </p>
        ) : null}
        {perSource && (act || state === 'resolved') && sourcesDistinguish(resolved) ? (
          <ul className="flex flex-col gap-1 ps-6">
            {resolved.map(s => {
              const sid = sourceId(s)
              const declared = enabled[e.key]
              const on = declared === undefined ? true : declared.includes(sid)
              return (
                <li key={sid} className="flex items-center gap-2 text-xs">
                  {choosable && state === 'resolved' ? (
                    <Checkbox
                      data-testid={`${id}-source-${e.key}-${sourceLabel(s)}`}
                      aria-label={`${e.label} — ${sourceLabel(s)}`}
                      checked={on}
                      onCheckedChange={(v: boolean) =>
                        ctx.dispatch(w.onSourceChange, { entry: e.key, source: sid, value: v === true })
                      }
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{sourceLabel(s)}</span>
                  {/* NO ALIGNMENT MARK. A source used to carry one here (DEC-11's "offered but
                      MARKED"); the owner retired the whole telling in ledger #28 + #29, so a
                      source states its NAME and the row states its verb. The source is still
                      offered — see `runtime/rowSpaceColumns.ts`'s note. */}
                  {/* ITEM-59 — the per-source ▶ emits exactly THIS one, where the parent emits
                      one per source. */}
                  {act
                    ? playButton(
                        `${id}-plot-${e.key}-${sourceLabel(s)}`,
                        // Same rule one level down: a per-source ▶ inherits the row's
                        // ambiguity, so it inherits the row's qualified name too.
                        `${e.title} — ${sourceLabel(s)}`,
                        e.refusal,
                        () => emit(e, s),
                      )
                    : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        </div>
      </div>
    )
  }

  /**
   * THE WINDOW, as DOM — or a placeholder while the section is collapsed.
   *
   *   grid  (role=grid, aria-rowcount = the FILTERED SET, height = the FILTERED SET)
   *     └ rowgroup  (the track, offset to the first mounted row)
   *         └ row × the window only
   *
   * The grid/rowgroup/window all live in {@link EntryListBody}, mounted here ONLY when the widget
   * is actually visible (`bodyVisible`). While the section frame holds it collapsed under
   * `display:none`, a lightweight placeholder stands in and the virtualiser is not mounted at
   * all — so it never measures a zero-height viewport and always mounts FRESH against a laid-out
   * one on expand. The visibility ref sits on a STABLE wrapper (present in both states) so the
   * `ResizeObserver` sees the `display` toggle in either direction.
   */
  const body = (): React.ReactNode => {
    if (shown.length === 0) {
      return (
        <p data-testid={`${id}-no-match`} className="text-sm text-muted-foreground">
          {ENTRY_LIST_COPY.noMatch}
        </p>
      )
    }
    return (
      <div ref={bodyVisibleRef} className="w-full">
        {bodyVisible ? (
          <EntryListBody
            idPrefix={id}
            gridLabel={typeof w.label === 'string' && w.label !== '' ? w.label : 'entries'}
            placed={placed}
            estimateSize={rowEstimate}
            q={q}
            offer={offer}
            renderRow={renderRow}
          />
        ) : (
          <div
            data-testid={`${id}-collapsed-placeholder`}
            aria-hidden
            className="max-h-96 w-full"
          />
        )}
      </div>
    )
  }

  return (
    <WidgetField
      label={w.label}
      testid={`${id}-field`}
      ariaLabel="entries"
      description={isEmpty && listed ? emptyText : undefined}
      error={ctx.error}
    >
      {({ id: controlId, describedBy }) => (
        <div
          id={controlId}
          data-testid={id}
          aria-describedby={describedBy}
          className="flex w-full flex-col gap-2"
        >
          {header}
          {/* Not LISTED and still rendering ⇒ this control has an ERROR to show and nothing
              else. It states the error and says nothing about entries, because it has not
              been told there are any. */}
          {!listed ? null : isEmpty ? (
            <output
              data-testid={`${id}-empty`}
              data-empty="true"
              className="block rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            >
              {emptyText}
            </output>
          ) : (
            <>
              {/* Wrapped so the full-width Input's inline-END EDGE lands on the rows' right edge:
                  padding on the (full-width) wrapper shrinks its content box by
                  {@link ENTRY_LIST_ABOVE_GUTTER}, and the `w-full` Input fills that box — whereas
                  padding on the Input itself would only pad its interior, not move its edge. */}
              <div className={ENTRY_LIST_ABOVE_GUTTER}>
                <Input
                  data-testid={`${id}-search`}
                  aria-label={w.search?.placeholder ?? ENTRY_LIST_COPY.search}
                  placeholder={w.search?.placeholder ?? ENTRY_LIST_COPY.search}
                  value={query}
                  onChange={e => {
                    // A new query is a new answer, and it starts at its own top. The return-to-top
                    // (viewport + the keyboard's row) is {@link EntryListBody}'s, keyed on the
                    // query changing — so this only updates the query.
                    setQuery(e.target.value)
                  }}
                />
              </div>
              {/* The list itself — its own scroll track, its own window, and NO count line
                  under it: the thumb states the size (see the header). */}
              {body()}
            </>
          )}
        </div>
      )}
    </WidgetField>
  )
}
