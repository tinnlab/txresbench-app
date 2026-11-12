// SectionFrame (ITEM-4) — the chrome around ONE section in a pane's stack (§4.2).
//
// ── It is the HOST'S frame, not a widget ────────────────────────────────────────────
//
// This is the whole point of the component, and it is a structural choice rather than a
// stylistic one. If the header were something a section DECLARED, a section could ship
// without one — no title, no way to collapse it, no way to reorder it, and (worst) no
// mark that a collapsed section is still holding a filter. Sections come from packages
// the app has never seen, so "every section remembered to declare its chrome" is not a
// property anything can enforce. Making the frame the STACK's means a section cannot
// forget to have one: `SectionStack` (ITEM-3) wraps every section it renders, and the
// section supplies only its body.
//
// So the four header elements below are unconditional:
//
//   · TITLE          — from the section's manifest declaration.
//   · STATE BADGE    — R6: *"a COLLAPSED section states that it holds state. Collapse is
//                      display, not reset: an active filter or chosen entry shows the
//                      header badge. Without it, collapsing hides a filter still in
//                      force."* So the badge is emphatically NOT hidden when collapsed —
//                      collapsed is the state it exists FOR.
//   · COLLAPSE       — the chevron, from kit's `Accordion` (the trigger IS the header).
//   · DRAG HANDLE    — vertical reorder (ITEM-9). Rendered even before a stack wires it
//                      up, because a handle that appears only for "reorderable" sections
//                      is a second thing a package could be missing.
//
// THAT ORDER IS THE RENDERED ORDER, and it moved (owner, ledger #25). The owner first asked
// for the plot count *"on the right of the collapse button"* — where it already was, so the
// previous round read the DOM, found the requirement satisfied and changed nothing — and then
// corrected themselves: *"it should be on the LEFT of the collapse button"*. The later wording
// governs.
//
// Moving it means moving it INSIDE the trigger, and that is the whole mechanic worth stating:
// the collapse control is `AccordionTrigger`, the chevron rides at its right edge (`ml-auto`),
// and the header's `extra` slot sits AFTER the trigger. So anything in `extra` is to the right
// of the chevron by construction, and no arrangement within `extra` could satisfy the request.
// The badge therefore travels with the TITLE, as part of what the trigger says, and only the
// grip is left in `extra` — which is also where the grip belongs: it is the grab target and
// wants the stable outermost position, and clicks in `extra` do not toggle the panel.
//
// The cost is one real thing, and it is acceptable rather than unnoticed: the badge is now part
// of the trigger's accessible NAME (`Coordinates 2`). A number the section is holding is a fair
// part of what the control is called, and the alternative — hiding it from assistive tech to
// keep the name clean — would hide exactly the fact R6 exists to state.
//
// ── Why kit's `Accordion` and not a hand-rolled disclosure ──────────────────────────
//
// The header needs a real toggle (keyboard-operable, `aria-expanded`, focus ring) and an
// `extra` region whose clicks do NOT toggle the panel — a drag handle that collapsed the
// section every time you grabbed it would be unusable. `Accordion` already ships both:
// `AccordionTrigger` renders the chevron + `aria-expanded`, and its `extra` slot sits
// OUTSIDE the trigger button with click propagation stopped. Hand-rolling would re-derive
// both and drop one of them.
//
// ONE `Accordion` per section (`type: 'multiple'`), not one Accordion over the whole
// stack: sections are independently collapsible and independently ORDERED, and a single
// multi-item Accordion would own the ordering — which belongs to `resolveSectionOrder`
// (ITEM-8) and the user's saved arrangement, not to a rendering primitive.

import * as React from 'react'

import { Accordion, Badge } from '@txresbench/kit'
import { GripVertical } from 'lucide-react'

import { cn } from '@/lib/utils'
import { PANE_CONTENT_INSET } from '@/modules/workbench/core/shell/dock/paneModel'

/** The custom property this frame publishes {@link PANE_CONTENT_INSET} on, so the header band's
 *  bleed-and-re-pad and the panel body's top/bottom inset can all read ONE value without any of
 *  them restating the number (owner, ledger #30). Exported so a test can assert that the value
 *  on the element IS the pane's inset rather than a literal that happens to match it today. */
export const SECTION_INSET_VAR = '--section-inset'

export interface SectionFrameProps {
  /** the section id — the key the user's saved order refers to, and the testid stem. */
  id: string
  /** the section's declared title. */
  title: string
  /** whether the section is currently collapsed. CONTROLLED: the stack owns the value
   *  (it is per-user arrangement, not per-render state). */
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** R6 — what the section is HOLDING (an active filter, a chosen entry, emitted plots).
   *  A number renders as a count; a string renders as a label. `undefined`/`0`/`''` ⇒ no
   *  badge, which is the "holds nothing" state and the only state without a mark. */
  badge?: number | string
  /** an accessible description of what the badge counts, for the `title` tooltip
   *  (e.g. `2 active filters`). Falls back to a generic phrasing. */
  badgeLabel?: string
  /** props the stack's reorder mechanism (ITEM-9) spreads onto the drag handle — the pointer
   *  drag AND the keyboard equivalent (`onKeyDown`, `aria-pressed`, `aria-describedby`), which
   *  are the stack's because only the stack knows the neighbours and the arrangement.
   *
   *  The handle renders with or without them, so the frame never depends on reordering being
   *  wired up; WITHOUT them it renders as a disabled control rather than as a button that
   *  silently does nothing (see the element below). */
  dragHandleProps?: React.HTMLAttributes<HTMLElement>
  className?: string
  /** the section's body — one `DeclarativeRegion` per `ui:` file. */
  children: React.ReactNode
}

/** Truthy-but-not-zero-or-empty: `0 filters` and `''` are the ABSENCE of held state, and
 *  a badge reading "0" would say the opposite of what R6 wants it to say. */
function hasHeldState(badge: number | string | undefined): boolean {
  if (badge === undefined) return false
  if (typeof badge === 'number') return badge > 0
  return badge.trim().length > 0
}

export function SectionFrame({
  id,
  title,
  collapsed,
  onCollapsedChange,
  badge,
  badgeLabel,
  dragHandleProps,
  className,
  children,
}: SectionFrameProps): React.ReactElement {
  const showBadge = hasHeldState(badge)

  // WHAT THE TRIGGER SAYS: the title, then the badge, then (kit's own, pushed right by
  // `ml-auto`) the chevron. The badge sits BEFORE the collapse control — ledger #25; see the
  // header for why that requires being inside the trigger rather than arranged within `extra`.
  const label = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 truncate">{title}</span>
      {showBadge && (
        <Badge
          tone="primary"
          data-testid={`section-badge-${id}`}
          title={badgeLabel ?? `${title} is holding state`}
        >
          {badge}
        </Badge>
      )}
    </span>
  )

  // The header-right slot: the drag handle alone, at the far edge (it is the grab target, so
  // it wants the stable outermost position). Clicks here never toggle the panel —
  // `AccordionTrigger`'s `extra` slot stops propagation.
  const extra = (
    <div className="flex items-center gap-1">
      <span
        {...dragHandleProps}
        data-testid={`section-drag-handle-${id}`}
        role="button"
        // WIRED OR NOT, BUT NEVER LYING ABOUT IT.
        //
        // The handle renders even when no stack has wired a reorder to it (see the prop's
        // doc) — but a `role="button"` that is focusable and does nothing on Enter/Space is an
        // ARIA lie, and a screen-reader user is entitled to believe it. So the unwired handle
        // announces as DISABLED and drops out of the tab order, while the wired one is a real
        // control (the stack supplies `onKeyDown`, `aria-pressed` and the instructions it is
        // described by). The visual grip is unchanged in both states: it is chrome that says
        // "this row is a row", and nothing is gained by hiding it.
        tabIndex={dragHandleProps ? 0 : undefined}
        aria-disabled={dragHandleProps ? undefined : true}
        aria-label={`Reorder ${title}`}
        // The TAP TARGET is 44px square (`min-h-11 min-w-11`), which is the touch minimum the
        // pane's mobile checklist requires — the sheet is the primary Visualize surface below
        // 768px and a 16px grip is not grabbable with a thumb. The negative inline margin
        // keeps the header's VISUAL height unchanged: the box grows outwards into the
        // header's own padding rather than pushing the row taller, so the desktop chrome is
        // byte-identical while the touch target is not.
        //
        // `touch-none` (`touch-action: none`) is what makes that touch target actually
        // draggable. Without it the browser hands the first vertical movement to the pane's
        // scroller — the gesture is stolen before the 4px threshold is crossed, the section
        // never moves, and the pointer stream the drag was watching ends in `pointercancel`.
        // It is scoped to the grip alone, so the rest of the header still scrolls by touch.
        className="-my-2 flex min-h-11 min-w-11 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" aria-hidden />
      </span>
    </div>
  )

  return (
    // THE CARD IS A BOX AROUND THE ACCORDION, not the accordion itself.
    //
    // It was the accordion's own `className` until ledger #30 needed the ONE inset to reach the
    // element as a value rather than as a Tailwind class: kit's `Accordion` accepts `className`
    // and no `style`, and a length that lives in TypeScript (`PANE_CONTENT_INSET`) cannot be
    // spelled as a JIT-visible class. Widening kit's prop surface to publish a custom property
    // from a consumer would be the wrong direction — so the box is a plain element the consumer
    // fully owns, and the accordion inside it is unchanged.
    //
    // The testid stays on THIS element, because `section-frame-<id>` has always meant "the
    // section's outer box" to every caller that reads it (visibility, ordering, the class
    // assertions) and the box is what moved.
    <div
      data-testid={`section-frame-${id}`}
      // ── A SECTION LOOKS LIKE A SECTION (owner feedback #2) ─────────────────────────────
      //
      // This was `w-full` and nothing else, and the effect was not "minimal" — it was that a
      // section had NO visible boundary at all. Kit's accordion ships exactly one separator,
      // `not-last:border-b` on `AccordionItem`; because this component mounts one Accordion
      // Root per section holding exactly ONE item, that item is always `:last-child`, so the
      // rule never matched. The sole separation between two sections was the stack's 12px gap,
      // which is the same gap that sits between rows INSIDE a section — so the pane read as one
      // continuous column of text and the owner could not tell which heading owned what.
      //
      // A card is the fix, and it is the app's existing settings-page vocabulary rather than a
      // new one: border + card surface + its own padding, so a section's rows are visibly
      // INSIDE it and the gap between sections is visibly outside.
      //
      // ── THE HEADER IS MUTED (owner, ledger #26: *"make the header background muted"*) ────
      //
      // `bg-muted` — the EXISTING semantic token, not a new value and not an opacity variant of
      // one: the design contract's whole point is that a surface is named rather than mixed, and
      // a bespoke `bg-muted/60` here would be the first of N slightly-different section headers.
      //
      // Applied from the CONSUMER through a scoped descendant rule rather than by forking kit's
      // accordion: the header is `AccordionTrigger`'s own `<h3>` and kit passes no className to
      // it.
      //
      // ── ONE PADDING VALUE, AND IT IS THE PANE'S OWN (owner, ledger #30) ─────────────────
      //
      //   *"The padding should be consistent, how much padding do you have to the pane border
      //    then that much padding inside the card too"*
      //
      // The pane's content region insets itself from the pane border by `PANE_CONTENT_INSET`
      // (`dock/paneModel.tsx`) — ONE length the shell already publishes, and the same one a
      // pane's scroll track bleeds by. The card's own inside is now that SAME value, imported
      // rather than restated, so the two cannot be adjusted apart. Every number below reads it
      // off `--section-inset`, which is set from the constant a few lines down; there is no
      // second literal to keep in step, and changing the pane's inset moves the card's with it.
      //
      // The three symptoms the owner named are consequences of the one rule and were NOT tuned
      // individually — that is the whole point of the row:
      //   · the dataset heading in § Coordinates had no horizontal padding — the card's inline
      //     inset was `px-1.5` (6px) against a header padded 8px, and its rows sat against the
      //     border;
      //   · `GROUPS` had no top spacing — kit's accordion panel ships `pt-0`, so the first thing
      //     in every section's body touched the header band;
      //   · the entry-axis section's search box had no top spacing, for exactly that reason, one section
      //     down.
      // The header still bleeds back OUT to the card's edges and re-pads by the same inset, so
      // it reads as a band across the section rather than a floating rectangle inside it —
      // which is the one place the value is used twice, in opposite directions, from one source.
      // ── THE INLINE INSET IS ON THE HEADER + BODY, NOT THE CARD (owner: scrollbar-at-border) ──
      //
      // It USED TO be one `paddingInline` on this card box, which squeezed the whole Accordion —
      // header AND body — inward by the inset. That is why the entry_list's overlay scrollbar
      // floated 8px INSIDE the card's border instead of flush against it: the scroll region sits
      // in the accordion PANEL, which is `overflow:hidden`, so it could not bleed back out past
      // the card's own padding (a `-margin` was clipped at the panel edge — the twice-failed fix).
      //
      // So the card no longer insets its content. The SAME inset is re-applied one level in — on
      // the header band (`padding-inline`, no bleed needed now that the card doesn't pad) and on
      // the body wrapper (`padding-inline`, which is where § Coordinates and the search box get
      // their gutter). The body wrapper is NOT `overflow:hidden`, so a scroll child (the
      // entry_list `ScrollArea`) can bleed its inline-END back out to the card's inner border with
      // a negative `margin-inline-end` of exactly this inset — putting the scrollbar flush at the
      // border while every other body child stays inset. The value is still the ONE
      // `--section-inset` (= the pane's inset), read by all three rules; nothing restates it.
      style={{ [SECTION_INSET_VAR]: PANE_CONTENT_INSET } as React.CSSProperties}
      className={cn(
        'w-full rounded-lg border border-border bg-card',
        '[&_[data-slot=accordion-item]>h3]:[padding-inline:var(--section-inset)]',
        '[&_[data-slot=accordion-item]>h3]:rounded-t-md [&_[data-slot=accordion-item]>h3]:bg-muted',
        '[&_[data-slot=accordion-content]>div]:[padding-inline:var(--section-inset)]',
        '[&_[data-slot=accordion-content]>div]:[padding-top:var(--section-inset)]',
        '[&_[data-slot=accordion-content]>div]:[padding-bottom:var(--section-inset)]',
        className,
      )}
    >
      <Accordion
        type="multiple"
        data-testid={`section-accordion-${id}`}
        className="w-full"
        // COLLAPSE IS DISPLAY, NOT UNMOUNT — and that is not a claim, it is this prop.
        //
        // Base UI's Accordion defaults `keepMounted` to FALSE, so a collapsed panel's
        // subtree was DESTROYED. Three things that R6 rests on broke silently as a result:
        // the section's `DeclarativeRegion` ran its unmount cleanup and RETRACTED the badge
        // — the badge whose entire purpose is to survive a collapse, erased by the exact
        // gesture it exists for, while the plots it counted were still on the canvas; the
        // section's canvas `order` stopped being republished, so dragging a collapsed
        // section reordered the rail and not the plots; and any body state died with it.
        //
        // Nothing above this line could see it: the badge lives in the header's `extra`
        // slot, OUTSIDE the panel, so every assertion about the badge's visibility passed
        // while the published value underneath was gone.
        keepMounted
        value={collapsed ? [] : [id]}
        onValueChange={next => onCollapsedChange(!next.includes(id))}
        items={[{ key: id, label, extra, children }]}
      />
    </div>
  )
}
