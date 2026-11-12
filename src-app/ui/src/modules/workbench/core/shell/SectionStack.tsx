// SectionStack (visualize-pane ITEM-3) — the body of a SECTION pane: N contributed blocks
// in ONE scroll track, each in the host's `SectionFrame`.
//
// ── It is `DeclarativeStack` minus the run band, and that is the whole difference ───────
//
// `DeclarativeRegion.tsx::DeclarativeStack` is the twin: a pane column, track 1 a
// `PaneScroll` wrapping a `RegionBody` (the readable-width cap + the `gap-3` rhythm), track
// 2 an `AnalysisRunListHost`. A section pane has no runs to report — nothing here launches
// anything — so there is no track 2. Everything else is deliberately identical, because a
// divergence from that layout is a bug and not a variant: the same `min-h-0 flex-1` column,
// the same full-width scroller (a capped scroller draws its bar mid-pane — see
// `RegionBody`'s header), the same cap on the CONTENT one box further in.
//
// ── ONE scroll track for the PANE, not one per section ─────────────────────────────────
//
// Sections scroll together. Per-section scrollers would mean a stack of small independent
// viewports, each with its own bar and its own scroll position, in a 260px-wide rail — the
// user could not see two sections' contents in one glance, and the drag-reorder handles
// would sit at the top of boxes that had themselves scrolled. So the `PaneScroll` is the
// stack's, and a section is just content inside it.
//
// ── What this component does NOT do ─────────────────────────────────────────────────────
//
// It never reaches `placeViews`, `reconcileViews`, `viewAutomountGate`, `isViewAvailable`,
// `assertContributableArea`, `ROLE_REGION` or the dock. It reads `registry.sections` — a
// slot none of those consult — and renders. That is INV-12 ("a section is not a view") as
// code rather than as a promise, and `placement.test.ts`'s TEST-7 asserts it at runtime.

import type * as React from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { Empty } from '@txresbench/kit'

import { cn } from '@/lib/utils'
import type { SectionContribution } from '@/modules/workbench/core'
import { computeAvailability } from '@/modules/workbench/core/contributions/availability'
import { DeclarativeRegion } from '@/modules/workbench/core/render/DeclarativeRegion'
import { RegionBody } from '@/modules/workbench/core/render/RegionBody'
import type { PaneKind } from '@/modules/workbench/core/shell/dock/paneModel'
import { PaneScroll } from '@/modules/workbench/core/shell/dock/paneModel'
import { useWhenContext, useWorkbench } from './WorkbenchContext'
import { CoordinateAxisBinding } from './CoordinateAxisBinding'
import { SectionFrame } from './SectionFrame'
import { applyReorderAt, resolveVerticalDrop, startPointerDrag } from './regions/pointerDrag'
import type { DropSlotItem } from './regions/pointerDrag'
import { resolveSectionOrder } from './regions/resolveSectionOrder'
import { workbenchRegionsStore } from './regions/WorkbenchRegions.store'
import { sectionBadgeOf, sectionBadgeStore } from '@/modules/workbench/core/render/sectionBadge.store'

/** The DOM attribute a section's outer box carries, so the reorder drag can ask "which
 *  section am I over?" through the shared `attributeAtPoint`. */
const SECTION_ATTR = 'data-section-id'

/** The attribute on the box that CONTAINS the sections. It scopes the reorder's measurement to
 *  THIS pane's list — two section panes are on screen at once, and a drag in one must not
 *  measure boundaries in the other. It is no longer asked "am I over the list?": that question
 *  is answered by the TRACK's box (below), because the empty space under the last section is
 *  where an append is performed and a content-height column does not extend into it. */
const STACK_ATTR = 'data-section-list'

/** The attribute the stack puts on each drag handle, so the keyboard path can find the control
 *  it must return focus to after a reorder. Section ids are dotted package names
 *  (`sc.viz.coordinates`), which are safe inside an attribute-value selector. */
const HANDLE_ATTR = 'data-section-handle'

/** The insertion line. Absolutely positioned INTO the 12px gap either side of a section box, so
 *  it marks the boundary without occupying it — see the call site for why height matters here. */
function DropLine({ pane, edge }: { pane: PaneKind; edge: 'top' | 'bottom' }): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-testid={`section-drop-indicator-${pane}`}
      data-drop-edge={edge}
      className={cn(
        'pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary',
        edge === 'top' ? '-top-1.5' : '-bottom-1.5',
      )}
    />
  )
}

export function SectionStack({ pane }: { pane: PaneKind }) {
  const { api, lattice } = useWorkbench()
  const whenCtx = useWhenContext()

  // The user's saved arrangement for THIS pane (ITEM-7). Subscribed, so a drag re-renders
  // the stack in its new order without the stack owning any order state of its own.
  const userOrder = useStore(workbenchRegionsStore, s => s.sectionOrder[pane])

  // ITEM-64 / R6 — what each contributed view is HOLDING, published by the views themselves
  // (`ViewSpec.badge`). The stack reads a number per `view_id` and never a section's fields, so
  // "holding something" stays the section's own definition and the frame stays the host's.
  const badges = useStore(sectionBadgeStore, s => s.byView)

  // LISTED sections: this pane's, whose `applies_to` the project's data satisfies.
  //
  // The two filters answer DIFFERENT questions and neither substitutes for the other
  // (design §6.1): `pane` is "does this section belong to this stack at all", `appliesTo`
  // is "is this KIND of data present in this project". The third question — "is this
  // particular candidate ALIGNED to the anchored row space" — is the ENGINE's offering
  // predicate (ITEM-17), applied per candidate inside a section, never here: a section
  // whose columns are all misaligned still LISTS, and says so.
  const sections = useMemo(() => {
    const all = (api.registry.sections?.all() ?? []) as SectionContribution[]
    const listed = all.filter(s => s.pane === pane && computeAvailability(s, whenCtx, lattice))
    // Composition adds; arbitration discards (INV-20). Several packages may contribute a
    // section for the same data — every one of them appears, stacked. There is no
    // "pick the best contributor" step here, and its absence is the invariant.
    return resolveSectionOrder(userOrder, listed)
  }, [api.registry, pane, whenCtx, lattice, userOrder])

  // Collapse is per-section DISPLAY state, seeded from each section's declared default and
  // then owned here. It is deliberately NOT persisted alongside `sectionOrder`: the plan
  // persists ARRANGEMENT (ITEM-7), and collapse of a section a user has never touched must
  // follow the package's `collapsed:` declaration — an author marking a section
  // `collapsed: true` is stating that it is the secondary act, and a persisted "expanded"
  // from a different project's session would silently overrule that.
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({})
  const isCollapsed = (s: SectionContribution) => collapsedOverride[s.id] ?? s.collapsed ?? false

  // ── WHAT THE STACK SAYS WHILE A REORDER IS HAPPENING ────────────────────────────────────
  //
  // Two channels, because the two ways of reordering are seen by different people. The DROP
  // INDICATOR is for the pointer user: the floating ghost says only *what* is being dragged,
  // never *where it would land*, and a stack whose only feedback is a label following the
  // cursor is strictly less legible than the horizontal tab strip this drag was extracted
  // from — which paints a target highlight (`RegionShell`'s `setDragOver`). The ANNOUNCEMENT
  // is the same information for the keyboard/screen-reader user, whose reorder is otherwise
  // completely silent: the rail visibly changes and nothing says so.
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')

  /** The keyboard reorder's PICKED-UP section, or null. Modal on purpose: bare arrow keys on a
   *  focused handle would fight the pane's own scrolling and give the user no way to say "I am
   *  done", so a pickup brackets the move and Escape can put it back. */
  const [pickedUp, setPickedUp] = useState<string | null>(null)
  /** The arrangement as it was at pickup — what Escape restores. Kept in a ref because it is
   *  not rendered; it exists only to be handed back to the store. */
  const beforePickup = useRef<readonly string[] | null>(null)

  const helpId = `section-reorder-help-${pane}`

  /** Write a new arrangement and say where the section now sits. Position is 1-based and
   *  carries the total, because "position 2" alone does not tell a non-sighted user whether
   *  they have reached the end. */
  const commitOrder = useCallback(
    (next: readonly string[], title: string, id: string, verb: string) => {
      workbenchRegionsStore.getState().setSectionOrder(pane, [...next])
      const at = next.indexOf(id)
      setAnnouncement(`${title} ${verb} position ${at + 1} of ${next.length}.`)
    },
    [pane],
  )

  /**
   * MEASURE the list, in the same client coordinates the pointer reports in.
   *
   * Read at each move rather than cached: the pane SCROLLS under a live drag (and a section can
   * be collapsed mid-drag), so boundaries captured at press time describe a list that has since
   * moved. The container is the TRACK, not the section column — releasing below the last
   * section is the one gesture that unambiguously means "put it at the end", and the column
   * stops at its last child, so a column-scoped container makes that gesture unperformable.
   */
  const measure = useCallback((): { items: DropSlotItem[]; bounds: DOMRect | null } => {
    const list = document.querySelector(`[${STACK_ATTR}="${pane}"]`)
    // The scroller, reached from the list rather than by testid: `PaneScroll` marks its host
    // with `data-pane-scroll`, which is a production attribute the layout owns. Selecting a
    // TESTID from production code would make a test affordance load-bearing.
    const track = list?.closest('[data-pane-scroll]')
    const items = [...(list?.querySelectorAll(`[${SECTION_ATTR}]`) ?? [])].map(el => {
      const r = el.getBoundingClientRect()
      return { id: el.getAttribute(SECTION_ATTR) ?? '', top: r.top, bottom: r.bottom }
    })
    return { items, bounds: track?.getBoundingClientRect() ?? null }
  }, [pane])

  const onDragHandle = useCallback(
    (id: string, title: string, e: React.PointerEvent) => {
      // The SAME pointer-drag primitive the region tab strip uses (`pointerDrag.ts`), which
      // is axis-agnostic and already drives the vertical side strip. A section reorder is a
      // different drop VOCABULARY, not a different drag.
      const resolve = (x: number, y: number) => {
        const { items, bounds } = measure()
        return resolveVerticalDrop(items, id, x, y, bounds)
      }
      startPointerDrag({
        label: title,
        event: e,
        // The indicator is drawn at the SLOT the release resolves to — the same number the drop
        // uses — so what the user is shown and what they get cannot disagree.
        onMove: (x, y) => {
          const drop = resolve(x, y)
          setDropAt(drop.kind === 'at' ? drop.index : null)
        },
        // A gesture the user abandoned (the OS took the pointer, or they pressed Escape) must
        // leave the arrangement exactly as it was — so this puts the indicator away and does
        // nothing else. It is emphatically not a drop.
        onCancel: () => setDropAt(null),
        onDrop: (x, y, moved) => {
          setDropAt(null)
          if (!moved) return
          const drop = resolve(x, y)
          if (drop.kind === 'none') return
          commitOrder(applyReorderAt(sections.map(s => s.id), id, drop), title, id, 'moved to')
        },
      })
    },
    [measure, sections, commitOrder],
  )

  /** The handle whose focus must survive the next commit — set by the keyboard path, cleared
   *  once focus is back. See `useLayoutEffect` below for why it exists. */
  const keepFocus = useRef<string | null>(null)

  /** The grip for a section. Addressed by an attribute the stack itself puts on the handle
   *  (below), not by its testid — the focus restore is production behaviour and must not rest
   *  on a test affordance. */
  const handleEl = (id: string) => document.querySelector<HTMLElement>(`[${HANDLE_ATTR}="${id}"]`)

  // REORDERING A KEYED LIST TAKES THE FOCUS AWAY, AND THAT ENDS THE KEYBOARD PATH.
  //
  // React reorders keyed children by MOVING the DOM nodes (`insertBefore`), and moving a node
  // that contains the focused element blurs it — focus lands on `<body>`. So without this, a
  // keyboard reorder worked exactly ONCE: the first arrow moved the section, focus was lost,
  // the second arrow was delivered to nothing, and the blur handler below had meanwhile ended
  // the pickup. Pressing Down twice moved once, silently.
  //
  // It cannot be seen in jsdom — jsdom does not blur on a node move — so it is asserted here by
  // driving the sequence a browser produces (`SectionStack.test.tsx`), and the fix is the one
  // the DOM semantics call for rather than a workaround: put the focus back on the control the
  // user is holding, in the same commit that moved it.
  useLayoutEffect(() => {
    const id = keepFocus.current
    if (!id) return
    keepFocus.current = null
    const el = handleEl(id)
    if (el && document.activeElement !== el) el.focus()
  })

  /** Leaving the handle ENDS the pickup — otherwise the mode outlives the focus that started
   *  it: the user tabs away, comes back later, presses an arrow, and a section moves for reasons
   *  they cannot reconstruct.
   *
   *  DEFERRED to a microtask, and this is the whole subtlety: the blur a REORDER causes (see
   *  above) is indistinguishable from a blur the USER caused at the moment it fires. By the end
   *  of the task they are trivially different — the reorder has put focus back on this same
   *  handle, and the user has not. So the question is asked once focus has settled, rather than
   *  guessed at from `relatedTarget` (which is null for both a node move and a click on empty
   *  space). The arrangement is already committed at each step, so there is nothing to save on
   *  the way out and nothing to announce — focus has moved on, and the live region would be
   *  talking over whatever it moved to. */
  const onHandleBlur = useCallback((id: string) => {
    queueMicrotask(() => {
      if (document.activeElement === handleEl(id)) return
      setPickedUp(current => (current === id ? null : current))
      beforePickup.current = null
    })
  }, [])

  // ── THE SAME REORDER, WITHOUT A POINTER ─────────────────────────────────────────────────
  //
  // The handle was a `role="button"` with a pointer listener and nothing else, which means the
  // arrangement — a per-user setting the whole pane is read against — was reachable by mouse
  // and touch and by NO other means. Enter/Space picks the section up, the arrows move it,
  // Enter/Space drops it and Escape puts it back; every step is announced, and the instructions
  // are on the handle itself via `aria-describedby` so the affordance is discoverable rather
  // than folklore.
  const onHandleKeyDown = useCallback(
    (id: string, title: string, e: React.KeyboardEvent) => {
      const ids = sections.map(s => s.id)
      const at = ids.indexOf(id)
      if (at === -1) return

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (pickedUp === id) {
          setPickedUp(null)
          beforePickup.current = null
          setAnnouncement(`${title} dropped at position ${at + 1} of ${ids.length}.`)
        } else {
          beforePickup.current = ids
          setPickedUp(id)
          setAnnouncement(
            `${title} picked up, position ${at + 1} of ${ids.length}. Use the up and down arrows to move it, Enter to drop it, Escape to cancel.`,
          )
        }
        return
      }

      if (pickedUp !== id) return

      if (e.key === 'Escape') {
        e.preventDefault()
        const original = beforePickup.current
        setPickedUp(null)
        beforePickup.current = null
        keepFocus.current = id
        if (original) commitOrder(original, title, id, 'move canceled, back at')
        return
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const to = at + (e.key === 'ArrowUp' ? -1 : 1)
        if (to < 0 || to >= ids.length) {
          // Refused rather than silently ignored: at an end, "nothing happened" and "the key
          // did not register" are indistinguishable without being told which.
          setAnnouncement(`${title} is already at position ${at + 1} of ${ids.length}.`)
          return
        }
        const next = [...ids]
        next.splice(at, 1)
        next.splice(to, 0, id)
        keepFocus.current = id
        commitOrder(next, title, id, 'moved to')
      }
    },
    [sections, pickedUp, commitOrder],
  )

  // WHERE EACH BLOCK'S PLOTS BELONG ON THE SHARED CANVAS (ITEM-31b).
  //
  // The canvas composes every contributor's declaration into one grid and used to stack them in
  // FIRST-PUBLISH order — which is when a host happened to mount, not how the user arranged it.
  // A block that publishes late (collapsed on open, or whose availability resolved a tick later)
  // sank to the bottom whatever the stack said, and dragging the stack afterwards moved nothing.
  //
  // The stack is the only thing that knows the arrangement, so the stack states it: each view's
  // position in the FLATTENED stack order, recomputed on every render — which is what makes a
  // drag move the plots, since `sections` is already the reordered list. A section's several
  // `ui:` files keep their declared order within it.
  const canvasOrder = useMemo(() => {
    const at = new Map<string, number>()
    let i = 0
    for (const s of sections) for (const v of s.views) at.set(v.view_id, i++)
    return at
  }, [sections])

  if (sections.length === 0) {
    return (
      <div data-testid={`section-stack-${pane}-empty`} className="flex min-h-0 flex-1 items-center justify-center">
        <Empty
          data-testid={`section-stack-empty-${pane}`}
          title="Nothing to show yet"
          description="No sections apply to this project's data."
        />
      </div>
    )
  }

  return (
    // The PANE column — `DeclarativeStack`'s, verbatim. `flex-1` makes the column's height
    // definite, which is what the scroll track's own `flex-1 min-h-0` resolves against.
    <div data-testid={`section-stack-${pane}`} className="flex min-h-0 w-full flex-1 flex-col">
      {/* WHICH ROWS THE PANE IS ABOUT — DERIVED from the chosen coordinate set, and rendering
          nothing (owner, 2026-08-13). A control asking the question stood here for months; the
          question does not exist, so the pane's FIRST BLOCK is the first contributed section
          (§ Coordinates) and the derivation is invisible chrome. */}
      <CoordinateAxisBinding />
      {/* THE ONE TRACK. Full-width (the bar belongs at the pane's edge, never 512px in);
          the readable-width cap is on the CONTENT, one box further in. */}
      <PaneScroll axis="y" className="min-h-0 flex-1" data-testid={`section-track-${pane}`}>
        <RegionBody data-testid={`section-body-${pane}`}>
          {/* THE LIST BOX — the measurement scope for this pane's reorder (see `STACK_ATTR`). */}
          <div {...{ [STACK_ATTR]: pane }} className="flex w-full flex-col gap-3">
            {sections.map((section, i) => (
              <div key={section.id} {...{ [SECTION_ATTR]: section.id }} className="relative w-full">
                {/* WHERE IT WOULD LAND — the boundary the release currently resolves to, drawn
                    in the same primary-tinted vocabulary as the region drop overlay so the two
                    drags read as one mechanism.
                    ABSOLUTE, sitting in the gap above (or below the last section), for two
                    reasons: it lands ON the boundary rather than pushing the section down off
                    it, and it adds no height — an in-flow line would move every box below it
                    mid-drag, i.e. change the very geometry the next move is measured against.
                    `aria-hidden`: the keyboard path says it in words instead. */}
                {dropAt === i && <DropLine pane={pane} edge="top" />}
                {dropAt === sections.length && i === sections.length - 1 && <DropLine pane={pane} edge="bottom" />}
              <SectionFrame
                id={section.id}
                title={section.title}
                collapsed={isCollapsed(section)}
                onCollapsedChange={c => setCollapsedOverride(prev => ({ ...prev, [section.id]: c }))}
                // R6 (ITEM-64) — a COLLAPSED section states that it holds state, so the mark
                // survives collapse: collapse is display, not reset. What counts as "holding
                // something" is the SECTION's own declaration (its views' `badge` expression),
                // summed here; a section whose views declare none passes `undefined` and
                // `SectionFrame` renders no badge, which is the honest "holds nothing".
                badge={sectionBadgeOf(badges, section.views.map(v => v.view_id))}
                badgeLabel="open plots"
                dragHandleProps={{
                  onPointerDown: e => onDragHandle(section.id, section.title, e),
                  onKeyDown: e => onHandleKeyDown(section.id, section.title, e),
                  onBlur: () => onHandleBlur(section.id),
                  ...{ [HANDLE_ATTR]: section.id },
                  // The handle's own state, so assistive tech reports a picked-up section as
                  // held rather than as an ordinary button that did nothing.
                  'aria-pressed': pickedUp === section.id,
                  'aria-describedby': helpId,
                }}
              >
                {/* ONE `DeclarativeRegion` per `ui:` file, in declaration order — the same
                    relationship a pane has with its analysis' files. No `analysisId`: a
                    section HAS no analysis (ITEM-65), which is what keeps a producer-derived
                    affordance from quietly reframing it as one (INV-14). */}
                {section.views.map(view => (
                  <DeclarativeRegion key={view.view_id} view={view} canvasOrder={canvasOrder.get(view.view_id)} />
                ))}
              </SectionFrame>
            </div>
          ))}
          </div>
          {/* The keyboard reorder's two assistive-tech channels: the instructions every handle
              is described by, and the running commentary. `role="status"` + `aria-live="polite"`
              so a move is spoken after the key, not over the top of it. Visually hidden — the
              pointer user already has the indicator above. */}
          <span id={helpId} className="sr-only">
            Press Enter or Space to pick this section up, then use the up and down arrows to move
            it. Enter drops it; Escape cancels.
          </span>
          <div role="status" aria-live="polite" data-testid={`section-reorder-status-${pane}`} className="sr-only">
            {announcement}
          </div>
        </RegionBody>
      </PaneScroll>
      {/* NO track 2. A section pane has no runs — that is the whole structural difference
          from `DeclarativeStack`, and it is stated here so a future edit adding a band has
          to argue with this comment first. */}
    </div>
  )
}
