// RegionTab — THE region tab. One primitive, both strips.
//
// ── WHY IT IS A PRIMITIVE AND NOT TWO COPIES ────────────────────────────────────────────────
//
// The horizontal bar (centre / bottom) and the vertical rail (left / right) each hand-rolled a
// `role="tab"` with its own keyboard handler, its own close button, its own drag start and its
// own blocked-reason node. `27b19e86` already had to fix ONE of them (the rail's missing scroll
// track) after the two had diverged, and every property below is a contract a per-strip copy
// re-litigates. So the ROLE, the KEYBOARD, the CLOSE and the BLOCKED state live here once; a
// strip supplies only what its shape genuinely owns — the arrangement of icon and label, and
// where the close X sits.
//
// ── THE CLOSE IS NOT A FOCUSABLE CONTROL, AND THAT IS THE POINT ─────────────────────────────
//
// It used to be a real `<button>` INSIDE the `role="tab"`, which is axe `nested-interactive`
// (WCAG 4.1.2): a composite widget's element must not wrap another interactive control, because
// the two compete for one activation and no AT can present "a tab, and also a button" as one
// node. `27b19e86`'s axe pass over the real rail found it and allow-listed that one rule id
// rather than fix it in that lane.
//
// The resolution is the one most tabbed editors ship: the X stays exactly where a mouse user
// reaches for it, and leaves the accessibility and focus trees — `aria-hidden`, no tab stop —
// so the tab is one node again. Closing is then exposed ON THE TAB, by key:
//
//     Delete / Backspace on the focused tab  →  close it
//
// Backspace is not a synonym added for comfort: an Apple keyboard's `Delete` key sends
// Backspace, so a Mac user pressing the key labelled Delete would otherwise get nothing.
//
// The shortcut is ANNOUNCED rather than folklore — `aria-keyshortcuts` for assistive tech, and
// the close X's own hover text for a sighted keyboard user, which is the only channel that
// reaches someone who can see the X but cannot click it.
//
// ── WHAT WAS REJECTED ───────────────────────────────────────────────────────────────────────
//
//   · Make the tab a `<button>` and put the close beside it as a sibling. A `tablist` may own
//     only `tab` children, so the sibling button is a NEW `aria-required-children` violation —
//     the exact rule `27b19e86` had to keep alive when it moved these strips onto the overlay
//     scroll track ("wrap, never convert"). Trading one violation for another is not a fix.
//   · Wrap the pair in a `role="presentation"` div inside the tablist. Same rule, and it turns
//     on whether axe traverses presentational containers — a property nothing in this repo has
//     measured, on a tree that has already cost one migration for guessing about it.
//   · A context menu as a SECOND close path. It serves the population that already has the
//     visible X (pointer users), adds a surface both strips must keep in step, and does nothing
//     for the keyboard user this change is for. The X's hover text carries the shortcut instead.
//
// ── WHAT THE TAB STILL IS ───────────────────────────────────────────────────────────────────
//
// `tabIndex={0}` on every tab, unchanged. A roving-tabindex tablist (only the selected tab in
// the tab order, arrows to move) is the fuller ARIA pattern, but switching to it would REMOVE
// tab-key reachability from every unselected tab and hand it to arrow keys nothing implements
// yet. That trade belongs to a change that ships the arrow keys, not to this one.

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Tooltip } from '@txresbench/kit'
import { cn } from '@/lib/utils'
import { paneTitle } from '@/modules/workbench/core/shell/dock/paneModel'
import type { WorkbenchPane } from '@/modules/workbench/core/shell/dock/paneModel'

/** The keys that close the focused tab. `Backspace` because an Apple keyboard's `Delete` key
 *  sends it — the same physical key, a different name on the wire. */
const CLOSE_KEYS: ReadonlySet<string> = new Set(['Delete', 'Backspace'])
/** What `aria-keyshortcuts` announces. The canonical spelling of the pair above; a screen
 *  reader reads one shortcut, not a list of platform spellings. */
const CLOSE_KEYSHORTCUT = 'Delete'

export interface RegionTabProps {
  pane: WorkbenchPane
  /** Is this the region's selected tab? */
  isActive: boolean
  /** Why the close is unavailable right now (`null` = it works). Owned by the dock store's
   *  `removeBlockedReason`, never restated per strip. */
  closeBlocked: string | null
  /** Select this pane (and, on a collapsed rail, expand the region). */
  onActivate: () => void
  /** Close this pane. Never called while `closeBlocked` is set. */
  onClose: () => void
  /** Begin a cross-region drag from this tab. */
  onDragStart: (e: React.PointerEvent) => void
  /** The tab box's own classes — the strip's shape (row vs column, sizes, active treatment). */
  className: string
  /** The close X's own classes — where it sits in this strip's box. */
  closeClassName: string
  /** Native `title`, for the rail whose label is rotated and clipped. */
  title?: string
  /** The tab's visible content: this strip's arrangement of icon + label. */
  children: ReactNode
}

export function RegionTab({
  pane,
  isActive,
  closeBlocked,
  onActivate,
  onClose,
  onDragStart,
  className,
  closeClassName,
  title,
  children,
}: RegionTabProps) {
  const label = paneTitle(pane)
  const whyId = `region-tab-close-why-${pane.id}`
  return (
    <div
      role="tab"
      aria-selected={isActive}
      // Explicit accessible name = the clean pane title, so the tab is looked up by the title a
      // contribution DECLARED (not the raw view id) and is never assembled from its content.
      aria-label={label}
      // The close key, announced. Assistive tech reads this out with the tab; without it the
      // only way to discover the shortcut is to be told, and a control you must be told about
      // is a control you do not have.
      aria-keyshortcuts={CLOSE_KEYSHORTCUT}
      // The blocked REASON hangs off the TAB, because the tab is now the element that refuses
      // the close — the X is out of the accessibility tree entirely. It used to hang off the
      // button.
      aria-describedby={closeBlocked ? whyId : undefined}
      tabIndex={0}
      data-testid={`region-tab-${pane.id}`}
      title={title}
      onPointerDown={onDragStart}
      onClick={onActivate}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate()
          return
        }
        if (CLOSE_KEYS.has(e.key)) {
          // A blocked close refuses the KEY exactly as it refuses the click — structurally, by
          // there being nothing to call, rather than by a guard inside a live handler.
          if (closeBlocked) return
          e.preventDefault()
          onClose()
        }
      }}
      className={className}
    >
      {children}
      {/* THE CLOSE: a pointer affordance, `aria-hidden`, never a tab stop.
          Live → the hover text is the action AND the key that performs it, which is the only
          channel that reaches a sighted keyboard user. Blocked → the hover text is the REASON,
          the same contract the pane header's close carries; the reason also reaches assistive
          tech through the tab's own `aria-describedby` above.
          `aria-hidden` is what takes it out of the composite widget: the a11y tree sees ONE
          node (the tab), so there is nothing nested inside it to violate 4.1.2. It is safe to
          hide precisely BECAUSE the action it performs is reachable another way — an
          `aria-hidden` control whose function had no keyboard route would simply be a control
          removed. */}
      <Tooltip content={closeBlocked ?? `Close ${label} (${CLOSE_KEYSHORTCUT})`}>
        <span
          aria-hidden="true"
          data-testid={`region-tab-close-${pane.id}`}
          data-close-blocked={closeBlocked ? '' : undefined}
          // NO `onPointerDown` stopPropagation, deliberately. The obvious guard — "a press on
          // the X is a close gesture, not the start of a tab drag" — changes nothing a test can
          // hold: `startTabDrag` needs >4px of movement before it does anything at all, so a
          // click never drags either way, and a press-and-drag from the X behaved exactly like a
          // press-and-drag from the tab before this component existed. It was written, measured
          // to kill no mutation, and removed rather than kept as belt-and-braces.
          onClick={
            closeBlocked
              ? undefined
              : e => {
                  e.stopPropagation()
                  onClose()
                }
          }
          className={cn(
            closeClassName,
            'flex items-center justify-center rounded-sm hover:bg-accent hover:text-foreground',
            closeBlocked
              ? 'cursor-not-allowed opacity-40 hover:bg-transparent'
              : 'cursor-pointer',
          )}
        >
          <X className="size-3" />
        </span>
      </Tooltip>
      {closeBlocked ? (
        <span id={whyId} className="sr-only">
          {closeBlocked}
        </span>
      ) : null}
    </div>
  )
}
