// PaneToolbar.tsx — the per-pane TOP toolbar (it replaced the old dark `CellChrome` pill, which is
// now DELETED — see `cellKinds.ts` for what survived it and why). It OCCUPIES a
// 32px strip at the top of a pane (never overlays the plot) and is kit-styled to match the TxResBench
// workbench tab strip (`h-8`, `bg-muted/40`, `border-b border-border`, ghost kit icon-buttons + tooltips,
// lucide icons at 14px). Presentational: every mutation is a callback prop. Shown only when the global
// tool rail's "cell toolbars" toggle is on.
//
// THIS TOOLBAR IS THE ENTRY POINT FOR EVERY PER-PANE SURFACE (finding #14). Edit, Annotate and Segment
// are siblings here — *"it should be like the edit form, when we click on it, it opens separate form
// for each pane"*. Annotate/Segment used to be GLOBAL left-rail modes that opened every capable pane at
// once; they are gone from the rail entirely.
//
// GLYPHS COME FROM THE REGISTRY (`tools/registry.ts`), not from lucide directly. This file importing
// `Pencil` while the rail imported `Pencil` for annotate-mode was the SEVENTH unregistered vocabulary
// and produced exactly the collision INV-14 exists to stop: two pencils meaning different things. Only
// non-tool CHROME (drag grip, Split, New window, Close) is still imported directly, and
// `registry.test.ts` asserts those glyphs collide with no registered one.

import { type ReactNode, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, MenuRowButton, Popover, Select } from '@txresbench/kit'
// BLIND-AUDIT M13: removing a PANE is destructive (it takes the pane and its docks with it) while
// a dock's own `X` merely closes a panel — the two sat side by side wearing the same `X`. The
// destructive one now reads as destructive; `X` is left to mean "close this panel".
import { GripVertical, MoreHorizontal, SplitSquareHorizontal, Trash2 } from 'lucide-react'
import { toolFor } from '../tools/registry'
import { type CellKind, type GridCell, cellTestId, paneRemoveBlockedReason } from './gridModel'
import type { GripHandlers } from './CellView'
import type { DatasetCatalog } from '../data/wire'
import { cellKindOptionsFor, cellBindingSchema } from './cellKinds'

export interface PaneToolbarProps {
  readonly cell: GridCell
  readonly catalog?: DatasetCatalog
  readonly onSetKind: (kind: CellKind) => void
  readonly onSplit: () => void
  readonly onRemove: () => void
  /** Open the edit form for this pane. */
  readonly onEdit: () => void
  /** Whether this pane's edit form is currently open (drives the button's active-tab indicator). */
  readonly editOpen?: boolean
  /** Toggle THIS pane's ANNOTATE dock. Supplied only for an annotate-CAPABLE pane (same predicate
   *  `GridWorkspace` uses to decide which panes can hold a dock) ⇒ no button on other panes. */
  readonly onAnnotate?: () => void
  /** Whether this pane's annotate dock is open (active-tab indicator; stays in sync with the dock's ×). */
  readonly annotateOpen?: boolean
  /** Toggle THIS pane's SEGMENT (mask review/correct) dock. Supplied only for a segment-CAPABLE pane. */
  readonly onSegment?: () => void
  /** Whether this pane's segment dock is open (active-tab indicator; stays in sync with the dock's ×). */
  readonly segmentOpen?: boolean
  /** Toggle SELECTION LINK for this pane (start link-picking, or open the manage popover when already
   *  linked). Omitted ⇒ no link button. */
  readonly onToggleLink?: () => void
  /** The pane's link-group color (a linked pane badges its link button in this color). Absent ⇒ unlinked. */
  readonly linkColor?: string
  /** True while a link-PICKING session is active (highlights the button as the active tool). */
  readonly linkActive?: boolean
  /** Export THIS pane (omitted ⇒ no export button). */
  readonly onExport?: () => void
  /** Toggle the plotting-data TABLE overlay for this pane (omitted ⇒ no data button). */
  readonly onShowData?: () => void
  /** Whether the data table is currently open (drives the button's pressed state). */
  readonly dataOpen?: boolean
  readonly gripHandlers?: GripHandlers
  /** Extra LEFT-side control (the colour-by picker), rendered immediately after the plot-kind
   *  Select in the PINNED left group. Never folds — see `LEFT GROUP IS PINNED` below.
   *
   *  A RENDER FUNCTION, not a node: the toolbar decides from MEASURED fit whether the pinned group
   *  shows its expanded (value-as-text) or collapsed (icon-only) form, and only the owner can render
   *  the collapsed twin — it needs the option list to put the CURRENT VALUE in the accessible name.
   *  Passing two pre-built nodes was the alternative and is worse: the caller would have to build a
   *  form that is usually thrown away, and "which form is this node" becomes something the toolbar
   *  INFERS from the node rather than something the owner DECLARES (the JSX-truthiness class,
   *  convergence-3 HIGH). `collapsed` is passed; nothing is deduced from the returned element. */
  readonly extra?: (collapsed: boolean) => ReactNode
  /** Extra RIGHT-side control (the pop-out / return button), rendered between Split and Close. */
  readonly rightExtra?: ReactNode
}

const ICON = 'size-3.5'

/** Root horizontal padding (`px-1` = 4px each side) — excluded from the width available to the groups. */
const TOOLBAR_PAD_PX = 8
/** `gap-0.5` between items. */
const GAP_PX = 2
/** The drag grip, which never folds (it is the drag SOURCE and cannot live in a popover). */
const GRIP_W_PX = 22
/** The overflow trigger, which occupies a slot as soon as anything folds. */
const OVERFLOW_BTN_PX = 26
/** Width of ONE pinned Select in its COLLAPSED, icon-only form — a `size="icon"` kit Button, the
 *  same 32px target every other toolbar action uses (MEASURED live, not assumed: the toolbar's own
 *  icon buttons render 32x32 and the kit Select trigger's min-content — chevron + padding, no value
 *  text — is 40px, which is why "shrink the text form further" is not an option that leaves a
 *  usable control). */
const SELECT_ICON_W_PX = 32
/** Natural width of ONE pinned Select in its EXPANDED, text form, used only until the real width is
 *  learned from the DOM. Over-estimated on purpose (measured: plot-kind 84px, colour-by 88px): an
 *  over-estimate collapses to the icon form, which is always usable, while an under-estimate leaves
 *  the text form clipped — the failure this whole round exists to remove. */
const SELECT_NATURAL_W_PX = 88
/** Width assumed for a present-but-never-yet-measured item. Every action is a fixed icon button, so
 *  this is an over-estimate on purpose: over-folding costs one click, under-folding makes controls
 *  unreachable (convergence-4 MEDIUM). */
const FALLBACK_ITEM_W_PX = 28

/** The order items fold into the overflow menu — FIRST entry folds FIRST. Ranked by how much the
 *  pane's job depends on the item being one click away: rarely-used chrome folds early, and the
 *  per-pane SURFACES (Edit / Annotate / Segment) survive longest, because opening them is what this
 *  toolbar exists for (finding #14). `config` is NOT here: the plot-kind + colour-by Selects are
 *  PINNED to the left group and are not foldable at all (see `LEFT GROUP IS PINNED`). */
const RANK_ORDER = ['split', 'popout', 'data', 'export', 'link', 'remove', 'segment', 'annotate', 'edit'] as const
/** The per-pane SURFACE entry points (finding #14). They may fold as a last resort, but they are
 *  reserved ahead of the pinned Selects' discretionary width so the primary affordance is not buried
 *  behind an overflow menu at an ordinary pane width. */
const TOP_RANK_KEYS: readonly string[] = ['edit', 'annotate', 'segment']

/** Registry descriptors for the toolbar's TOOL-ish buttons — glyph AND label from the one vocabulary.
 *  `pane.*` `order` is the fixed right-group order below, so that order is the registry's job. */
const T_LINK = toolFor('pane', 'link')
const T_EDIT = toolFor('pane', 'edit')
const T_ANNOTATE = toolFor('pane', 'annotate')
const T_SEGMENT = toolFor('pane', 'segment')
const T_EXPORT = toolFor('pane', 'export')
const T_DATA = toolFor('pane', 'data')
const T_KIND = toolFor('pane', 'kind')
const T_COLORBY = toolFor('pane', 'colorby')

/** One toolbar affordance in its two forms. `menu` is a THUNK — see the in-body doc on `Item`. */
export type ToolbarItem = {
  readonly key: string
  readonly inline: ReactNode
  readonly menu: () => ReactNode
}

/** The overflow menu's body, as a COMPONENT rather than inline JSX.
 *
 *  This exists purely so the rows are not built until the popup is actually mounted. The kit
 *  `Popover` takes `content: ReactNode`, so inline JSX at the call site is evaluated on every
 *  toolbar render — which is how the closed menu's rows came to cost 96 `MenuRowButton` + ~320
 *  `span` element creations per wheel step. A component element is ONE creation; its body (and
 *  therefore every `item.menu()` call) runs only when Base UI's `Portal` mounts the popup. */
function OverflowPanel({ paneId, items }: { paneId: string; items: readonly ToolbarItem[] }) {
  return (
    <div data-testid={`viz-cell-overflow-panel-${paneId}`} className="flex min-w-44 flex-col items-stretch gap-1">
      {items.map(i => i.menu())}
    </div>
  )
}

function PaneToolbarImpl({
  cell,
  catalog,
  onSetKind,
  onSplit,
  onRemove,
  onEdit,
  editOpen,
  onAnnotate,
  annotateOpen,
  onSegment,
  segmentOpen,
  onToggleLink,
  linkColor,
  linkActive,
  onExport,
  onShowData,
  dataOpen,
  gripHandlers,
  extra,
  rightExtra,
}: PaneToolbarProps) {
  // THE ID A READER ADDRESSES (see `cellTestId`). Every testid and every accessible name on this
  // strip is stamped from it, so a spec addressing this toolbar never has to know the composition
  // separator or which declaration contributed the pane. `cell.id` survives only where the DOM
  // needs a document-unique value — see `blockedAction`'s `whyId`.
  const testId = cellTestId(cell)
  const kindOptions = useMemo(
    () => cellKindOptionsFor(cell, catalog).map(k => ({ value: k, label: k })),
    [cell, catalog],
  )
  // Recomputed on every render before this — including all 8 renders per wheel step — for a value
  // that changes only when the pane's view kind does.
  const bindings = useMemo(() => cellBindingSchema(cell.kind), [cell.kind])
  // `undefined` ⇒ this pane is removable (the overwhelmingly common case, byte-identical to before);
  // a string ⇒ its close is unavailable and this is what the user is told. This is the ONLY place the
  // decision is taken: `CellView` deliberately does not re-decide it (see the note beside its `remove`
  // callback), so a blocked pane cannot end up looking disabled here while acting live there.
  const removeBlocked = paneRemoveBlockedReason(cell)

  // ── PRIORITY+ (convergence H5) ─────────────────────────────────────────────────────────────────
  // Two prior attempts were wrong in opposite directions. `min-w-0 flex-1 overflow-hidden` clipped
  // the left group to clientWidth=0 (controls invisible AND unhittable). `shrink-0` at natural width
  // then let the ~194px config group eat the whole strip, pushing the ACTION buttons out of view at
  // rest — measured at a 147px pane: only grip + kind hittable, Link/Edit/Annotate/Export requiring
  // 143-327px of scroll that a plain wheel and a drag both produce ZERO of. That also silently
  // inverted DRIFT-3.7's recorded rule ("the ACTION group on the right must never be pushed out").
  //
  // Priority+ resolves it by RANK instead of by scroll: the actions are the primary affordances and
  // stay pinned; the low-rank CONFIG controls (plot-type + colour-by) collapse into one overflow
  // popover when they no longer fit. Chosen over `wrap` (breaks the fixed 32px strip) and over a
  // pure scroller (reachable only if you already know a gesture nothing advertises — the scrollbar
  // is suppressed to keep the strip 32px). The grip is exempt: it is the drag SOURCE, so it must
  // stay a real drag target and cannot live inside a popover.
  // ── LEFT GROUP IS PINNED ───────────────────────────────────────────────────────────────────────
  // The plot-kind and colour-by Selects sit INLINE at the start of the strip, next to the grip, and
  // are NOT foldable — declared structurally by living outside `RANK_ORDER`, not inferred from a
  // prop. That is what makes the nested-popup class UNREPRESENTABLE rather than merely guarded: a
  // kit Select popup (z-[60]) inside the overflow kit Popover (z-[70]) painted UNDER its own parent
  // and swallowed the click (convergence-2 HIGH), and the two later attempts to detect "this item
  // opens a popup" both misfired — first on JSX truthiness (convergence-3 HIGH), then as an
  // unsatisfiable predicate that made the whole pin branch dead (convergence-4 LOW). No
  // popup-opening control is foldable now, so the menu can never need to host one, and the
  // flattened kind/colour-by row machinery that existed only to survive folding is gone.
  //
  // The pin is fed INTO the width pass as a reserved budget (`leftReserve`), never subtracted from
  // the fold set afterwards — post-hoc mutation of an already-sized strip is exactly what turned a
  // mis-detection into clipped, unpressable controls (convergence-3 HIGH). Under pressure the
  // Selects SHRINK and truncate (they stay real tap targets that open a full-width popup listing
  // every option) while the right group folds; the right group never shrinks, so the overflow
  // trigger cannot be pushed past the clip.
  // How many pinned Selects this pane actually shows (kind always; colour-by only on a dense pane).
  const pinnedCount = 1 + (extra ? 1 : 0)
  /** The pinned group in its COLLAPSED form — icon buttons, a fixed, always-usable width. This is a
   *  FLOOR that is genuinely reachable, not an aspiration: when the expanded form does not fit we
   *  render exactly this, so the group's real width and its reserved budget agree. The old
   *  `SELECT_MIN_W_PX` floor reserved 28px for a control that then rendered at 0 visible px, and the
   *  reservation for that invisible control is what buried the per-pane Annotate entry point. */
  const leftCollapsedW = GRIP_W_PX + pinnedCount * SELECT_ICON_W_PX + (pinnedCount - 1) * GAP_PX
  const rootRef = useRef<HTMLDivElement | null>(null)
  const leftRef = useRef<HTMLDivElement | null>(null)
  /** The pinned group's CONTENT node, measured instead of its wrapper.
   *
   *  The wrapper (`leftRef`) is `flex-1`, so it GROWS to absorb every spare pixel in the strip:
   *  measured on a 2 304px toolbar its `scrollWidth` read **2 072px** while the content it holds was
   *  **254px**. `measure()` learned that grown figure as the group's "natural, untruncated width",
   *  so `leftWant` swallowed the whole strip, `availFull` came out at ~202px — just under the
   *  ~204px the foldable icons want — and exactly ONE item folded. At EVERY width. `split` was
   *  therefore buried in the overflow menu on every pane no matter how wide, and the overflow
   *  Popover subtree was mounted unconditionally on all four panes (+96 elements/wheel, the entire
   *  element regression this month — see PLAN.md `## Re-captured baseline`).
   *
   *  `scrollWidth` on a flex-GROWN box reports the grown size, not the content size, which is why
   *  the bug was invisible to the comment's intent ("natural (untruncated) content width"). Measure
   *  the content node, which is `shrink`/`min-w-0` and reports its own width truthfully. */
  const leftContentRef = useRef<HTMLElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)
  /** Natural width per item key, learned from the REAL inline nodes while they are unfolded.
   *  An off-screen measuring probe was the obvious alternative and is a trap: it duplicates every
   *  `data-testid` in the DOM, which makes a strict-mode `page.click('[data-testid=…]')` ambiguous
   *  and hangs the suite. The first layout pass always renders unfolded (`hiddenRank` starts at 0),
   *  so every width is observed once before anything folds. */
  const widthsRef = useRef(new Map<string, number>())
  /** The foldable keys ACTUALLY present on this pane, in rank order — written during render from the
   *  `items` array itself (the single source), read by `measure()` after that render commits.
   *
   *  `measure()` used to rank over the LEARNED-WIDTH map instead, which silently assumed every
   *  present item had been rendered inline at least once. A capability that resolves late (a segment
   *  pane gains `onSegment` after the first pass) is never rendered inline once folding has started,
   *  so its width is never observed: the ranking came out one entry SHORT of the foldable set, the
   *  fold loop saturated with a low-rank item still inline, and the OVERFLOW TRIGGER itself was
   *  pushed past the clip — making every folded control, including the per-pane Segment entry point,
   *  mouse-unreachable at ≤640px (convergence-4 MEDIUM). Presence and rank now come from the items;
   *  only the WIDTH is learned, with a conservative fallback. */
  const presentKeysRef = useRef<readonly string[]>([])
  /** Natural (untruncated) content width of the pinned left group, learned from the REAL nodes while
   *  they are EXPANDED. Same learning pattern as `widthsRef`: the first layout pass always renders
   *  expanded, so it is observed once before anything collapses, and `scrollWidth` stays truthful
   *  even while the group is being clipped. Until it is learned, a deliberate over-estimate. */
  const leftNaturalRef = useRef(0)
  /** How many of the lowest-ranked items are folded into the overflow menu. */
  const [hiddenRank, setHiddenRank] = useState(0)
  /** Whether the pinned Selects render as icon-only triggers. See `PINNED SELECTS COLLAPSE` below. */
  const [configCollapsed, setConfigCollapsed] = useState(false)
  /** TIER 1 OVERRIDE. Below the physical floor (`grip + collapsed icons + overflow trigger + pad`)
   *  even the icon form cannot coexist with the trigger. The trigger wins — it has NO fallback, and
   *  everything folded dies with it (convergence-4 MEDIUM), whereas a clipped pinned icon still has
   *  the trigger. So at sub-floor widths the pinned group becomes shrinkable again and absorbs the
   *  clip, instead of pushing the trigger out of the strip. */
  const [leftSqueeze, setLeftSqueeze] = useState(false)
  useLayoutEffect(() => {
    const root = rootRef.current
    const strip = rightRef.current
    if (!root || !strip || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      // Record the natural width of whatever is CURRENTLY inline (a folded item keeps its last
      // known width, which is what makes the unfold test possible at all).
      for (const el of strip.querySelectorAll<HTMLElement>('[data-item-key]')) {
        const k = el.dataset.itemKey
        const w = el.getBoundingClientRect().width
        if (k && w > 0) widthsRef.current.set(k, w)
      }
      const known = widthsRef.current
      // Rank over the items PRESENT (from the render), never over the ones whose width happens to
      // have been learned — see `presentKeysRef`. An unmeasured item costs a conservative estimate,
      // so the loop folds MORE rather than fewer.
      const present = presentKeysRef.current
      if (present.length === 0) { setHiddenRank(0); return }
      const widthOf = (k: string) => known.get(k) ?? FALLBACK_ITEM_W_PX
      const total = present.reduce((a, k) => a + widthOf(k) + GAP_PX, 0)
      // ── PINNED SELECTS COLLAPSE (convergence-5 HIGH) ────────────────────────────────────────
      // The pinned Selects cannot fold, so a squeeze used to be absorbed by TRUNCATION: the group is
      // `overflow-hidden`, so the trailing edge was simply clipped away, and because
      // `getBoundingClientRect` still reports the UNCLIPPED rect an action button painted over the
      // invisible remainder. Measured on the flagship 4-pane story, the colour-by picker had ZERO
      // strict-hittable pixels from 1100px DOWN (visible width 88→37→12→0 as the viewport narrowed,
      // strict hits 0 throughout) while staying tabbable — "present in the DOM, undrivable by mouse",
      // and invisible on top. Truncation is not a graceful degradation for a control whose whole
      // affordance is its value text.
      //
      // So the group has TWO forms and the width pass CHOOSES between them, rather than letting CSS
      // shave pixels off one form until nothing is left:
      //   • EXPANDED  — value as text (plot-kind 84px, colour-by 88px measured natural).
      //   • COLLAPSED — one icon-only trigger each, a fixed 32px target opening the SAME listbox.
      // The threshold is not a guessed pixel count: the group expands IFF its natural, untruncated
      // width fits in the space available to it. That is the only threshold that guarantees the
      // expanded form is never truncated and the collapsed form is never 0px — every width either
      // shows the full value or shows a full-size icon. It also lands where it should: measured, a
      // 4-pane 1400px grid gives the group ~232px against a ~174px want ⇒ EXPANDED, and 1100px gives
      // ~157px ⇒ COLLAPSED.
      //
      // How much the pinned group may claim. Three tiers, in priority order, because each has a
      // different fallback:
      //   1. the overflow TRIGGER — no fallback at all; everything folded dies with it,
      //   2. the TOP-RANK actions (Edit / Annotate / Segment) — the per-pane entry points this
      //      toolbar exists for (finding #14). They *can* fold into the menu, but burying the
      //      primary affordance at an ordinary width is a real regression, so they are reserved,
      //   3. the pinned SELECTS — cannot fold, so they take what is left, in whichever form fits.
      // Reserving the Selects' NATURAL width ahead of tier 2 was tried and is wrong: on a 4-pane
      // 1400px grid it folded Annotate/Segment on every pane.
      const topRankReserve = TOP_RANK_KEYS.reduce(
        (a, k) => a + (present.includes(k) ? widthOf(k) + GAP_PX : 0), 0)
      const leftCap = Math.max(
        leftCollapsedW,
        root.clientWidth - TOOLBAR_PAD_PX - OVERFLOW_BTN_PX - GAP_PX - topRankReserve,
      )
      // Learn the natural width only while EXPANDED — collapsed, `scrollWidth` measures the icons.
      // Measured on the CONTENT node, never on `leftRef`: that wrapper is `flex-1` and grows to fill
      // the strip, so its `scrollWidth` reports the space available rather than the space wanted.
      if (!configCollapsed) {
        const w = leftContentRef.current?.scrollWidth ?? 0
        if (w > 0) leftNaturalRef.current = w
      }
      const leftNatural = GRIP_W_PX + (leftNaturalRef.current || pinnedCount * SELECT_NATURAL_W_PX + (pinnedCount - 1) * GAP_PX)
      const collapse = leftNatural > leftCap
      setConfigCollapsed(prev => (prev === collapse ? prev : collapse))
      // Tier 1 beats tier 3: if grip + the collapsed icons + the trigger do not physically fit, let
      // the pinned group be clipped so the TRIGGER keeps its slot.
      const squeeze = collapse && root.clientWidth - TOOLBAR_PAD_PX < leftCollapsedW + OVERFLOW_BTN_PX + GAP_PX
      setLeftSqueeze(prev => (prev === squeeze ? prev : squeeze))
      // Reserve the width of the form we are actually going to RENDER, so the budget and the DOM
      // agree. Reserving an expanded width for a control that renders collapsed (or vice versa) is
      // what let a 30px reservation for a 0px control bury the per-pane Annotate entry point.
      const leftWant = collapse ? leftCollapsedW : Math.min(leftNatural, leftCap)
      const availFull = root.clientWidth - TOOLBAR_PAD_PX - leftWant
      if (total <= availFull) { setHiddenRank(0); return }
      // Something must fold ⇒ the overflow trigger itself takes a slot.
      const avail = availFull - OVERFLOW_BTN_PX - GAP_PX
      let n = 0
      let need = total
      while (n < present.length && need > avail) {
        need -= widthOf(present[n]) + GAP_PX
        n += 1
      }
      setHiddenRank(prev => (prev === n ? prev : n))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
    // Deps cover every prop that gates an item's PRESENCE, so `presentKeysRef` is always re-read
    // after a capability arrives late — which is the case the old learned-width ranking missed.
    // `configCollapsed` is READ inside `measure()` (to know whether `scrollWidth` is measuring the
    // expanded form) and WRITTEN by it, so it must be a dep or the learn step goes stale. There is no
    // feedback loop: `leftCap` is derived from the ROOT width and the right group, never from the left
    // group's own rendered size, so collapsing cannot change the input that decided to collapse.
  }, [kindOptions.length, extra, rightExtra, onAnnotate, onSegment, onExport, onShowData, onToggleLink,
      leftCollapsedW, pinnedCount, configCollapsed])

  // Every collapsible item, in DISPLAY order. Fold order is decided SOLELY by `RANK_ORDER` (index 0
  // folds first): the per-pane SURFACES (Edit / Annotate / Segment) rank last because opening them is
  // what this toolbar exists for (finding #14); destructive and rarely-used chrome folds earlier; the
  // wide config block folds first of all. There is deliberately no second per-item rank field — one
  // existed (`collapseAt`), was never read, and agreed with `RANK_ORDER` only by luck, so editing the
  // field the comment pointed at would have silently changed nothing (convergence-2 LOW).
  /** `inline` is eager BY NECESSITY — it is read unconditionally for every unfolded item on every
   *  render, so deferring it would buy nothing. `menu` is a THUNK (ITEM-3 / INV-3): the overflow row
   *  for EVERY item used to be built on every render whether or not that item folded and whether or
   *  not the menu had ever been opened — measured at 96 `MenuRowButton` + ~320 `span` creations per
   *  wheel step, unchanged since the design source profiled it. Nothing reads `menu` unless the item
   *  is in the fold set AND the popup is open, so the build is deferred to `OverflowPanel`. */
  type Item = ToolbarItem

  const activeBar = (color?: string) =>
    color ? (
      <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: color, pointerEvents: 'none' }} />
    ) : null

  /** One UNAVAILABLE toolbar action, in both its inline (icon) and overflow (labelled row) forms.
   *
   *  WHY `aria-disabled` AND NOT A NATIVE `disabled`. A natively-disabled `<button>` fires no pointer
   *  events and leaves the tab order, so the tooltip that carries the reason can never open — the
   *  control would be greyed out and MUTE, which is the failure this whole branch exists to remove
   *  (`SettingsFormActions` hits the same wall and answers it by wrapping the button in a focusable
   *  `<span>`; that is right for a page-level Save, but here it would add a second tab stop per pane
   *  inside a 32px strip and could not carry into the folded menu row at all). `aria-disabled` keeps
   *  ONE element that is hoverable, focusable and announced as unavailable. It is also what the kit's
   *  own Button already does for its `loading` state, and `aria-disabled:opacity-50` is the vendored
   *  shadcn layer's own idiom (tabs / sidebar / accordion).
   *
   *  Activation is blocked STRUCTURALLY — no `onClick` is passed — rather than by an early return
   *  inside a live handler, so there is no handler to forget to guard. Note `pointer-events-none` is
   *  deliberately NOT applied: it would restore exactly the hover-can't-reach-it problem above.
   *
   *  The reason reaches BOTH audiences, and not only on hover:
   *    · sighted (mouse or keyboard) — the kit tooltip, which opens on hover AND on focus;
   *    · assistive tech — `aria-describedby` onto a visually-hidden node, so a screen reader
   *      announces "<label>, button, unavailable, <reason>" with no pointer involved. A tooltip is
   *      not a description: it exists in the tree only while it is open.
   *  Folded into the overflow menu there IS room for text, so the reason is simply VISIBLE in the
   *  row — the strongest form, needing neither hover nor focus — and the row is natively `disabled`
   *  there because a popover the user already opened is not a place a tooltip can help. */
  const blockedAction = (key: string, label: string, Icon: typeof GripVertical, reason: string): Item => {
    // THE ONE PLACE ON THIS STRIP THAT KEEPS THE GRID KEY, and deliberately. This is an `id=`
    // attribute wired up by `aria-describedby`, so it must be UNIQUE IN THE DOCUMENT — and the
    // reader-facing id is not: two independently-authored declarations may legitimately name a pane
    // the same thing, which is precisely why the host namespaces the key in the first place. A
    // duplicate `id` does not fail loudly; the browser resolves the reference to whichever node came
    // first, so one pane's blocked-Close would silently announce the OTHER pane's reason. Nothing
    // addresses this value — it is never a testid, never rendered — so it costs a reader nothing.
    const whyId = `viz-cell-${key}-${cell.id}-why`
    return {
      key,
      inline: (
        <span key={key} style={{ position: 'relative', display: 'inline-flex' }}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={label}
            aria-disabled
            aria-describedby={whyId}
            // No `tooltipSide` override: every peer button on this strip uses the default side, and
            // a lone dissenter is its own lint finding (peer buttons in one group must agree).
            tooltip={reason}
            data-testid={`viz-cell-${key}-${testId}`}
            className="cursor-not-allowed opacity-50"
          >
            <Icon className={ICON} />
          </Button>
          <span id={whyId} className="sr-only">
            {reason}
          </span>
        </span>
      ),
      menu: () => (
        <MenuRowButton
          key={key}
          data-testid={`viz-cell-${key}-${testId}`}
          aria-label={`${label} — ${reason}`}
          title={reason}
          disabled
        >
          <Icon className={ICON} />
          <span className="flex min-w-0 flex-col items-start gap-0.5 text-start">
            <span className="truncate">{label}</span>
            <span className="text-xs text-muted-foreground">{reason}</span>
          </span>
        </MenuRowButton>
      ),
    }
  }

  /** One toolbar action, in both its inline (icon) and overflow (labelled row) forms. */
  const action = (
    key: string,
    label: string,
    Icon: typeof GripVertical,
    onClick: () => void,
    opts: { pressed?: boolean; barColor?: string; destructive?: boolean } = {},
  ): Item => ({
    key,
    inline: (
      <span key={key} style={{ position: 'relative', display: 'inline-flex' }}>
        <Button
          size="icon"
          variant="ghost"
          {...(opts.pressed !== undefined ? { 'aria-pressed': opts.pressed } : {})}
          tooltip={label}
          data-testid={`viz-cell-${key}-${testId}`}
          onClick={onClick}
        >
          <Icon className={ICON} />
        </Button>
        {activeBar(opts.pressed ? 'var(--primary)' : opts.barColor)}
      </span>
    ),
    // `aria-pressed` USED to be spread here and was silently dropped: `MenuRowButton` destructures an
    // explicit prop list and spreads nothing, so a folded Edit / Annotate / Segment announced its OPEN
    // state in NO channel — not to a screen reader and not visually (the inline form's `--primary`
    // active bar has no menu twin). It takes `selected`, which it renders as `aria-current="page"`,
    // and its doc says the row-level HIGHLIGHT is the caller's job — so the caller supplies it.
    menu: () => (
      <MenuRowButton
        key={key}
        data-testid={`viz-cell-${key}-${testId}`}
        aria-label={opts.pressed ? `${label} (open)` : label}
        selected={opts.pressed}
        className={opts.pressed ? 'bg-accent font-medium text-accent-foreground' : undefined}
        onClick={onClick}
      >
        <Icon className={ICON} />
        <span className="truncate">{label}</span>
      </MenuRowButton>
    ),
  })

  /** The PINNED left group: plot-kind + colour-by, inline at the start of the strip beside the grip.
   *  Not an `Item` — it has no `menu` form BY CONSTRUCTION, because it can never fold.
   *
   *  Two FORMS, chosen by `configCollapsed` from measured fit (see `PINNED SELECTS COLLAPSE`). The
   *  collapsed form is the same `Select` — same listbox, same options, same keyboard behaviour — with
   *  its trigger content replaced by a registry glyph via `labelRender`, and sized to the toolbar's
   *  standard 32px icon target. Rebuilding it as a bespoke button-plus-popover would fork the
   *  listbox; swapping only what the TRIGGER paints keeps one control with one behaviour.
   *
   *  Losing the visible value is the cost of collapsing, so the value moves into the accessible name
   *  AND the native tooltip — `aria-label="Plot type: scatter"` — where it is available to a screen
   *  reader and to a hovering mouse user. */
  const kindLabel = kindOptions.find(o => o.value === cell.kind)?.label ?? cell.kind
  const configGroup = (
    <span
      ref={leftContentRef}
      data-testid={`viz-cell-config-${testId}`}
      data-collapsed={configCollapsed ? '1' : undefined}
      className={configCollapsed && !leftSqueeze ? 'flex shrink-0 items-center gap-0.5' : 'flex min-w-0 items-center gap-0.5'}
    >
      <span title={configCollapsed ? `${T_KIND.label}: ${kindLabel}` : undefined} className="inline-flex shrink-0">
        <Select
          size="sm"
          className={
            configCollapsed
              ? 'w-8 shrink-0 justify-center border-0 bg-transparent px-0 shadow-none [&>svg:last-child]:hidden'
              : 'min-w-7 shrink border-0 bg-transparent shadow-none'
          }
          data-testid={`viz-cell-kind-${testId}`}
          aria-label={configCollapsed ? `${T_KIND.label}: ${kindLabel}` : `View kind for ${testId}`}
          value={cell.kind}
          onValueChange={v => onSetKind(v as CellKind)}
          options={kindOptions}
          {...(configCollapsed ? { labelRender: () => <T_KIND.Icon className={ICON} /> } : {})}
          {...(bindings.length ? { 'aria-describedby': undefined } : {})}
        />
      </span>
      {extra?.(configCollapsed)}
    </span>
  )

  const items: Item[] = [
    ...(onToggleLink ? [action('link', linkColor ? 'Filtering linked — manage' : T_LINK.label, T_LINK.Icon, onToggleLink, { barColor: linkColor })] : []),
    action('edit', T_EDIT.label, T_EDIT.Icon, onEdit, { pressed: !!editOpen }),
    ...(onAnnotate ? [action('annotate', T_ANNOTATE.label, T_ANNOTATE.Icon, onAnnotate, { pressed: !!annotateOpen })] : []),
    ...(onSegment ? [action('segment', T_SEGMENT.label, T_SEGMENT.Icon, onSegment, { pressed: !!segmentOpen })] : []),
    ...(onExport ? [action('export', T_EXPORT.label, T_EXPORT.Icon, onExport)] : []),
    ...(onShowData ? [action('data', T_DATA.label, T_DATA.Icon, onShowData, { pressed: !!dataOpen })] : []),
    action('split', 'Split cell', SplitSquareHorizontal, onSplit),
    ...(rightExtra
      ? [{
          key: 'popout',
          inline: <span key="popout" className="inline-flex">{rightExtra}</span>,
          menu: () => <div key="popout" className="flex items-center gap-2 px-1 py-0.5">{rightExtra}</div>,
        }]
      : []),
    // REMOVE is the one action whose availability is a property of the CELL rather than of the host
    // having supplied a callback. `onRemove` is always supplied, so presence cannot express "this
    // pane cannot be closed" — a host that had nowhere to route the close still got a live X that
    // did nothing. The cell says so instead, and says WHY (`removeBlockedReason`).
    removeBlocked
      ? blockedAction('remove', 'Remove cell', Trash2, removeBlocked)
      : action('remove', 'Remove cell', Trash2, onRemove),
  ]

  // How many of the LOW-rank items must fold away for the rest to fit. Measured, not guessed: the
  // config block is wide and variable (its Select is sized by the longest option label), while every
  // action is a fixed 24px icon button, so a pure arithmetic estimate would be wrong for exactly the
  // pane widths that matter.
  const foldCount = Math.max(0, Math.min(items.length, hiddenRank))
  // ONE derivation of "what is present, in rank order", shared with `measure()` through the ref, so
  // the width arithmetic is sized around exactly the set that actually folds. Writing it during
  // render is deliberate: the effect callback runs after this render commits, so it reads the fresh
  // value on both the mount pass and every ResizeObserver tick.
  const present = RANK_ORDER.filter(k => items.some(i => i.key === k))
  presentKeysRef.current = present
  const folded = new Set<string>(present.slice(0, foldCount))
  const inlineItems = items.filter(i => !folded.has(i.key))
  const menuItems = items.filter(i => folded.has(i.key))

  return (
    <div
      ref={rootRef}
      data-testid={`viz-pane-toolbar-${testId}`}
      data-collapsed={menuItems.length > 0 ? '1' : undefined}
      // No horizontal scroller: priority+ keeps the strip inside its own width, so there is nothing
      // to scroll TO and nothing hidden behind a gesture nothing advertises.
      className="pointer-events-auto flex h-8 w-full items-center gap-0.5 overflow-hidden border-b border-border bg-muted/40 px-1"
      // Keep a pointer interaction on the toolbar from starting a deck pan underneath.
      onPointerDown={e => e.stopPropagation()}
    >
      {/* Drag grip — the drag SOURCE for swap / tear-off, so it can never move into a popover. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Drag ${testId} to swap or tear off`}
        title="Drag onto another cell to swap, or outside the grid to open in its own window"
        data-testid={`viz-cell-grip-${testId}`}
        onPointerDown={gripHandlers?.onPointerDown}
        className="flex h-6 shrink-0 cursor-grab touch-none items-center rounded-sm px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <GripVertical className={ICON} />
      </span>

      {/* PINNED left group — the plot-kind + colour-by Selects, next to the grip. `min-w-0 flex-1`
          so it yields space to the `shrink-0` right group; `overflow-hidden` is load-bearing, not
          cosmetic: without it a Select's MIN-CONTENT width becomes the flex item's floor, so on a
          very narrow pane the group refuses to shrink and pushes the OVERFLOW TRIGGER past the
          strip's own clip — taking every folded control with it (convergence-4 MEDIUM).
          What the clip must NEVER do is eat a control: the previous round left exactly that promise
          ("the Selects truncate from their trailing edge and their leading edge stays hittable") and
          it was false — measured, the colour-by picker had ZERO strict-hittable pixels from 1100px
          down. Truncation is no longer the degradation path at all: below its natural width the
          group switches to the icon-only form (`configCollapsed`), which is sized to fit, so the
          clip has nothing to remove. */}
      <div
        ref={leftRef}
        className={
          configCollapsed && !leftSqueeze
            // Collapsed the group is two 32px icons — small, fixed, and NOT negotiable. `shrink-0`
            // is what makes the reserved budget (`leftCollapsedW`) and the rendered width the same
            // number; while it was allowed to shrink, the right group kept taking space and the
            // icons were clipped exactly like the text form they replaced.
            ? 'flex shrink-0 items-center'
            // Expanded, OR collapsed on a sub-floor pane where tier 1 (the trigger) outranks the
            // pinned icons — see `leftSqueeze`.
            : 'flex min-w-0 flex-1 items-center overflow-hidden'
        }
      >
        {configGroup}
      </div>

      {/* Pinned group — the surviving items in DISPLAY order, then the overflow trigger. */}
      <div ref={rightRef} className="flex shrink-0 items-center gap-0.5">
        {inlineItems.map(i => (
          <span key={i.key} data-item-key={i.key} className="inline-flex items-center">{i.inline}</span>
        ))}
        {menuItems.length > 0 && (
          <Popover
            side="bottom"
            align="end"
            // The menu FLATTENS its contents (one row per option), so its height is unbounded by
            // construction: a dense pane's 10 view kinds + 15 colour-by columns is 25 rows ≈ 1124px,
            // taller than the viewport, and every row past the fold was simply unreachable — the kit
            // `Popover` popup is the ONE overlay in the kit that ships no height cap (`Select`,
            // `DropdownMenu`, `ContextMenu` and `Combobox` all already use this exact pair). Applied
            // at the CALL SITE rather than in `sdk`, so no other kit consumer is perturbed.
            // `--available-height` is set by the Base-UI positioner and inherits into the popup, so
            // the cap tracks the real space between this trigger and the viewport edge — a pane low
            // in the grid gets a shorter menu, not a clipped one.
            className="max-h-(--available-height) overflow-y-auto overscroll-contain"
            // ONE element, not N rows. The kit `Popover` takes `content` as a ReactNode, so the JSX
            // handed to it is evaluated HERE, on every toolbar render, open or not — which is how 96
            // `MenuRowButton` + ~320 `span` creations per wheel step were being paid for a panel
            // nobody had opened. Handing it a COMPONENT instead defers the row build to the moment
            // Base UI actually mounts the popup (its `Portal` renders no children while closed), so
            // the rows cost nothing until the menu is opened, and one element per render otherwise.
            content={<OverflowPanel paneId={testId} items={menuItems} />}
          >
            <Button
              size="icon"
              variant="ghost"
              tooltip="More"
              aria-label={`More actions for ${testId}`}
              data-testid={`viz-cell-overflow-${testId}`}
            >
              <MoreHorizontal className={ICON} />
            </Button>
          </Popover>
        )}
      </div>
    </div>
  )
}

/** ITEM-2 / INV-2. The pane chrome must not be rebuilt by a camera change.
 *
 *  A camera value lives in the same component that renders all the pane chrome, so every wheel step
 *  re-renders `GridWorkspace` → `CellView` → this toolbar, measured at 8 `PaneToolbar` element
 *  creations per wheel on a 4-pane grid (4 panes x StrictMode's 2) and ~580 elements per pane once
 *  the whole subtree is counted. `memo` is the local half of the answer.
 *
 *  IT ONLY PAYS IF EVERY PROP IS REFERENTIALLY STABLE — a shallow comparator finds a difference on
 *  the first fresh arrow function and re-renders anyway, which is why this line is worth nothing
 *  without the `useCallback`/`useMemo` block at the `CellView` call site (12 of 20 props changed
 *  identity on every render before it). `render-perf.spec.ts` measures the pair together; a future
 *  prop added un-memoized silently re-enables the whole cost, which is what TEST-5 exists to catch.
 *
 *  The structural fix is Split A, which stops the camera reaching this component at all. Until then
 *  this is the mechanism; after it, defence in depth.
 *
 *  Explicitly NO custom comparator. A hand-written `arePropsEqual` here would have to be updated
 *  every time a prop is added, and the failure mode of forgetting is a STALE TOOLBAR — a dropped
 *  `editOpen`/`annotateOpen`/`segmentOpen`/`dataOpen` transition (INV-8), which no perf counter can
 *  see. The default shallow comparison degrades safely: it re-renders more than necessary, never
 *  less. */
// The counter leg keys on component NAMES, and `memo(Impl)` would otherwise report the wrapper's
// inner name (`PaneToolbarImpl`) — which silently turns INV-1's "PaneToolbar element creations = 0"
// into a budget satisfiable by a RENAME rather than by a fix. Pin the name so the measurement
// survives this refactor and keeps meaning the same thing before and after it.
PaneToolbarImpl.displayName = 'PaneToolbar'
export const PaneToolbar = memo(PaneToolbarImpl)
PaneToolbar.displayName = 'PaneToolbar'
