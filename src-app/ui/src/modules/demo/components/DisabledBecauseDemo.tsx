import { Children, cloneElement, isValidElement, useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useAppMode } from '../useAppMode'
import { DEMO_DISABLED_REASON } from '../copy'

/**
 * DisabledBecauseDemo — marks a control unavailable in demo mode, with the
 * reason reachable through every channel (ITEM-5's reusable component; the
 * ITEM-6/7 pages wrap the blocked upload / delete / rename / export controls
 * in it).
 *
 * The plan's byte: "a disabled control with a tooltip/inline reason and
 * `aria-describedby`". The wrapper does both halves:
 *   · TOOLTIP — the `title` attribute on the control (a browser tooltip);
 *   · INLINE REASON — the reason line rendered right under/after the
 *     control, so it is visible without a hover AND is in the tab order's
 *     reading path;
 *   · ARIA — the control's `aria-describedby` points at the reason line, so
 *     a screen reader announces the reason after the control's name. The
 *     reason is also the `aria-disabled` state's explanation: the control
 *     says WHY it refused, its accessible name still says WHICH control it
 *     is (the kit Button's `unavailableReason` idiom, kept here as a
 *     wrapper because the pages wrap non-kit controls — drop zones — too).
 *
 * The no-flash rule: demo mode only (known); desktop and pending mode render
 * the children untouched.
 *
 * `cloneElement` needs ONE element child (the plan's controls are elements —
 * buttons, links, drop-zone divs). A multi-child fragment falls back to a
 * wrapper span that carries the same `aria-disabled` + `aria-describedby`
 * pair (a wrapper can describe a group, never a specific control — the
 * single-element path is the one ITEM-6/7 use).
 */
export interface DisabledBecauseDemoProps {
  /** The reason (default: the demo's generic sentence). */
  reason?: string
  children: ReactNode
}

export function DisabledBecauseDemo({ reason = DEMO_DISABLED_REASON, children }: DisabledBecauseDemoProps) {
  const { ready, isDemo } = useAppMode()
  const reasonId = useId()

  if (!ready || !isDemo) return <>{children}</>

  const reasonNode = (
    <span id={reasonId} className="txr-demo-disabled-reason" data-testid="txr-demo-disabled-reason">
      {reason}
    </span>
  )

  const kids = Children.toArray(children)
  if (kids.length === 1 && isValidElement(kids[0])) {
    const element = kids[0] as ReactElement<Record<string, unknown>>
    const describedBy = [element.props?.['aria-describedby'], reasonId].filter(Boolean).join(' ')
    return (
      <>
        {cloneElement(element, {
          'aria-disabled': true,
          'aria-describedby': describedBy,
          'data-demo-disabled': 'true',
          title: (element.props?.title as string | undefined) ?? reason,
        })}
        {reasonNode}
      </>
    )
  }

  // Not a single element (a fragment, text, or several children): wrap the
  // whole group — the group reads as one disabled unit with the reason.
  return (
    <span className="txr-demo-disabled-group" data-testid="txr-demo-disabled">
      <span role="group" aria-disabled="true" aria-describedby={reasonId}>
        {children}
      </span>
      {reasonNode}
    </span>
  )
}
