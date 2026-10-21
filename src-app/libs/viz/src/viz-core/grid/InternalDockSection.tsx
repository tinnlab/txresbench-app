// InternalDockSection.tsx — the SHELL for ONE pane's editing dock when it stacks in the grid's
// INTERNAL right panel (`viz-edit-panel`), i.e. whenever the host provides no per-pane container.
//
// Why this exists (the per-pane overlap defect). ROOT 2 made the annotate/segment docks PER-PANE, so
// the internal panel — designed to hold exactly ONE dock — suddenly held N. Each dock was a bare
// `<div style={{flex:'0 0 auto'}}>` with `overflow: visible`, and `AnnotateControls`' root carried
// `h-full`. In a column flex container Chrome sizes the flex item from its content with the
// percentage treated as auto, THEN resolves `h-full` against that now-definite height — so the
// rail+classes block re-stretched to the WHOLE dock and shoved its sibling `AnnotateHierarchyPanel`
// past the dock's bottom edge. `overflow: visible` let it PAINT over the next pane's dock: "Resolve
// hierarchy" / "Objects (n)" rendered straight through the next dock's "Classes" / "New class…".
// Bounding boxes never intersected (the box was 348 while its content was 473) which is exactly why
// a suite that only asserted "each pane's controls exist and are operable" shipped green.
//
// The shell fixes the class of bug, not the instance:
//   • it is a FLEX COLUMN with a `min-h-0` scrolling BODY, so content can never paint outside the
//     dock — overflow becomes a scroll, never a spill and never a clip;
//   • it is `flex: 0 1 auto` + a `minHeight` FLOOR, so N docks share the panel's height by the
//     flexbox shrink rule: 2 docks sit at natural height, 4 shrink toward the floor and stay
//     simultaneously legible, and only once N × floor exceeds the panel does the PANEL scroll;
//   • it keeps the per-dock title + close (pane attribution) pinned above its own scroll area.
//
// Chrome mirrors `PaneEditForm`'s dock chrome (the established per-pane precedent): kit `Button`
// icon-ghost close, semantic border/background tokens, logical-direction spacing only.

import type { ReactNode } from 'react'
import { Button as KitButton } from '@ziee/kit'
import { X } from 'lucide-react'

/**
 * The smallest height a stacked dock may be shrunk to before the panel starts scrolling instead.
 * Sized to keep a dock USABLE at its floor: the header + the first rows of the tool rail / class
 * list, with the rest reachable by the dock's own scroll. Below ~150px a dock stops being a control
 * surface and becomes a title bar with a sliver, which is worse than scrolling the panel.
 */
export const INTERNAL_DOCK_MIN_HEIGHT = 160

/**
 * The narrowest a stacked dock may get. Covers the natural min-content width of both dock payloads
 * (`AnnotateControls`' 36px rail + its `min-w-40` class column + padding ≈ 212; `MaskReviewControls`'
 * own `minWidth: 200` + padding ≈ 224).
 *
 * It has to be stated EXPLICITLY because the dock body is a scroll container, and a scroll container
 * contributes ZERO min-content width to its ancestors — without this the dock would collapse with
 * the panel (to ~78px at 390px, where the grid's own ~293px min-content leaves nothing else). The
 * panel is `overflow: auto`, so at that width it scrolls TO the dock instead of squeezing the rail +
 * class column into an unreadable sliver, and the PAGE still never scrolls horizontally (ROOT 3).
 */
export const INTERNAL_DOCK_MIN_WIDTH = 224

export interface InternalDockSectionProps {
  /** Dock root testid — the per-pane handle every layout assertion selects on. */
  readonly testId: string
  readonly titleTestId: string
  readonly closeTestId: string
  /** The PANE's title. A stacked dock that does not say which dataset it edits is unusable. */
  readonly title: string
  /** Accessible name for the close control (names the pane — several docks are open at once). */
  readonly closeLabel: string
  readonly onClose: () => void
  readonly children: ReactNode
}

export function InternalDockSection({
  testId,
  titleTestId,
  closeTestId,
  title,
  closeLabel,
  onClose,
  children,
}: InternalDockSectionProps) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className="flex min-h-0 flex-col border-b border-border last:border-b-0"
      // `0 1 auto` (shrinkable) + a floor is what makes N docks coexist: natural height while the
      // panel has room, proportional shrink once it does not, panel scroll past the floor.
      style={{ flex: '0 1 auto', minHeight: INTERNAL_DOCK_MIN_HEIGHT, minWidth: INTERNAL_DOCK_MIN_WIDTH }}
    >
      <div className="flex flex-none items-center justify-between gap-2 border-b border-border/60 bg-background ps-3 pe-1 py-1">
        <span className="truncate text-xs font-semibold" data-testid={titleTestId} title={title}>
          {title}
        </span>
        {/* The SAME string in both channels. An `aria-label` reaches assistive tech and is rendered
            by nothing, so on its own this X was unexplained to every sighted user.

            It is passed EXPLICITLY, and that is now a choice rather than a workaround. When this
            was written the kit's aria-label→tooltip promotion did not fire for the `children` form
            of an icon button (`iconOnly` was `icon != null && children == null`), so a call site
            that looked compliant drew no hover text at all; the kit has since redefined `iconOnly`
            as "renders no readable words" (`hasVisibleText`), which covers this call. Stating the
            string once, here, keeps the two channels provably identical without depending on that
            promotion — but nothing here is compensating for the kit any more. */}
        <KitButton
          size="icon"
          variant="ghost"
          aria-label={closeLabel}
          tooltip={closeLabel}
          data-testid={closeTestId}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </KitButton>
      </div>
      {/* The dock's OWN scroll area — SCROLL, never clip: `overflow-auto` on both axes so nothing is
          ever unreachable. `min-h-0` is load-bearing: without it a flex child refuses to shrink below
          its content and the overflow escapes the dock again. */}
      <div
        data-testid={`${testId}-body`}
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
      >
        {children}
      </div>
    </section>
  )
}
