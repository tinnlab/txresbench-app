// WidgetField (shared) — the ONE label+control+help+error scaffold every declarative CONTROL
// renderer (select / text / multiselect / range_slider / dataset-picker / …) composes, built on
// the kit `Field` primitives (`@txresbench/kit/shadcn/field`) instead of a hand-rolled
// `<label className="flex flex-col gap-1">`. Composing the kit means the label association,
// vertical rhythm, invalid state, disabled dimming, and a11y all come from the design system —
// so a fix here (spacing, width cap, tokens) improves EVERY declarative surface at once.
//
// The control is passed as a render-prop that receives a STABLE, UNIQUE id (`React.useId`), wired
// to `FieldLabel htmlFor` so the visible label actually associates with the control — correct even
// for `for_each`-repeated widgets (each rendered instance gets its own id, no duplicate-id bug).
// The field is width-capped (`max-w-md`) so a control never stretches edge-to-edge in a wide
// (bottom-dock) pane; the parent `RegionBody` caps the whole form column on top.

import * as React from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@txresbench/kit/shadcn/field'
import { cn } from '@/lib/utils'

export interface WidgetFieldProps {
  /** Visible field label (rendered as a `FieldLabel`, associated via `htmlFor`). */
  label?: React.ReactNode
  /** Optional helper text under the control. */
  description?: React.ReactNode
  /**
   * Optional supplementary content rendered UNDER the control (and under `description`),
   * and PROGRAMMATICALLY associated with it via `aria-describedby` — so a fact about the
   * current value is read out with the control rather than merely sitting near it.
   *
   * Distinct from `description`, which describes the CONTROL and is present whether or not
   * anything is chosen. `detail` describes the current VALUE, so it appears and disappears
   * as the value does. Kept generic (a node, no vocabulary of its own) rather than named
   * for its first user: the scaffold is shared by every declarative control, and a slot
   * named after one of them would be a per-widget affordance living in the shared layer.
   */
  detail?: React.ReactNode
  /**
   * The live VALIDATION message for this control, when it has one to show.
   *
   * It lives HERE, in the one scaffold every control composes, rather than in each
   * renderer — so `aria-invalid` on the control, the message's id in the control's
   * `aria-describedby`, `role="alert"` on the message and the field's own invalid styling
   * are one edit and cannot drift apart between eleven controls.
   *
   * It is rendered OUTSIDE the control, and that is not a layout preference: a disabled
   * control is out of the tab order, so anything inside it is unreachable to a keyboard or
   * screen-reader user. (The same reason the empty-options reading already sits in
   * `description` rather than in the listbox.)
   *
   * WHETHER to pass one is the caller's decision, not this scaffold's — see
   * `core/form/validity.ts::shouldShow`: a control that is empty and never touched is not
   * wrong, it is not yet answered.
   */
  error?: React.ReactNode
  /** Test id for the field wrapper. */
  testid?: string
  /** Fallback accessible name when no visible `label` (forwarded to the render-prop). */
  ariaLabel?: string
  className?: string
  /** Renders the control, receiving the generated id (→ `FieldLabel htmlFor`), an aria-label
   *  to apply when there is no visible label, the `aria-describedby` list, and whether the
   *  control must carry `aria-invalid` (a colour alone is not a message). */
  children: (control: {
    id: string
    ariaLabel: string
    describedBy?: string
    invalid?: boolean
  }) => React.ReactNode
}

export function WidgetField({
  label,
  description,
  detail,
  error,
  testid,
  ariaLabel,
  className,
  children,
}: WidgetFieldProps): React.ReactElement {
  const id = React.useId()
  const descId = `${id}-description`
  const detailId = `${id}-detail`
  const errorId = `${id}-error`
  const hasLabel = label != null && label !== ''
  const hasDescription = description != null && description !== ''
  const hasDetail = detail != null && detail !== ''
  const hasError = error != null && error !== ''
  const name = hasLabel ? String(label) : (ariaLabel ?? 'field')
  // EVERY id, space-separated, in visual order — `aria-describedby` takes a list, and
  // dropping one when another is present would make the association depend on which
  // optional slot happened to be filled.
  const describedBy =
    [
      hasError ? errorId : undefined,
      hasDescription ? descId : undefined,
      hasDetail ? detailId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined
  return (
    <Field
      data-testid={testid}
      // The kit's `fieldVariants` already styles `data-[invalid=true]` — set it here so the
      // label picks up the state too, rather than only the message being coloured.
      data-invalid={hasError ? 'true' : undefined}
      className={cn('w-full max-w-md', className)}
    >
      {hasLabel ? <FieldLabel htmlFor={id}>{label}</FieldLabel> : null}
      {/* `describedBy` is threaded to the control so the description is PROGRAMMATICALLY
          associated, not merely adjacent — the kit's `FieldDescription` emits a bare <p> with
          no id and wires no `aria-describedby` of its own, so without this a screen reader
          never reads the helper text with the control (FIX-2.9). */}
      {children({ id, ariaLabel: name, describedBy, invalid: hasError || undefined })}
      {/* Directly under the control, ABOVE the helper text: what is wrong right now
          outranks what the control is for. `FieldError` is the kit's own — `role="alert"`,
          `data-slot="field-error"`, `text-destructive` — so the semantics and the token come
          from the design system rather than from each caller. */}
      {hasError ? (
        <FieldError id={errorId} data-testid={testid ? `${testid}-error` : undefined}>
          {error}
        </FieldError>
      ) : null}
      {hasDescription ? (
        <FieldDescription id={descId} data-testid={testid ? `${testid}-description` : undefined}>
          {description}
        </FieldDescription>
      ) : null}
      {hasDetail ? (
        <FieldDescription id={detailId} data-testid={testid ? `${testid}-detail` : undefined}>
          {detail}
        </FieldDescription>
      ) : null}
    </Field>
  )
}
