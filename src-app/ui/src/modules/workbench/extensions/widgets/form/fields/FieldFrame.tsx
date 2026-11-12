import type { ReactNode } from 'react'

/** Minimal field metadata every renderer needs for its label/description frame. */
export interface FieldMeta {
  id: string
  title?: string
  doc?: string
  required?: boolean
}

/**
 * The label / description / required frame shared by every field renderer. `@txresbench/kit`
 * exposes no `Field` primitive, so (per DESIGN_SYSTEM's fallback) we compose an
 * accessible `<label>`-associated stack: a `flex flex-col gap-1.5` column with the
 * `doc` as muted helper text. Labelable controls (`Input`/`Select`/`Switch`/…) receive
 * `id={htmlFor}` so the visible title focuses them; non-labelable composites (e.g.
 * MultiSelect's `role=combobox` div) additionally carry an `aria-label` at the call site.
 */
export function FieldFrame({
  field,
  htmlFor,
  children,
}: {
  field: FieldMeta
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={`schemaform-fieldrow-${field.id}`}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {field.title ?? field.id}
        {field.required && (
          <>
            <span className="ms-1 text-destructive" aria-hidden>
              *
            </span>
            {/* the visual asterisk is aria-hidden; announce "required" to AT via the
                label text (the control's accessible name includes this label). */}
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      {children}
      {field.doc && <p className="text-sm text-muted-foreground">{field.doc}</p>}
    </div>
  )
}
