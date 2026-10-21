import { z } from 'zod'

// Converts an action's zod `params` schema into a minimal, scalar-only field
// list for the palette's inline param form (PLAN.md ITEM-1; DEC — complex/
// nested schemas are descoped, ITEM-14). Reuses zod v4's native
// `z.toJSONSchema` — the SAME conversion `scripts/collect-actions.mjs` uses
// to build the backend manifest — rather than hand-rolling a second zod
// introspector.

export type ParamFieldType = 'string' | 'number' | 'boolean'

export interface ParamField {
  name: string
  type: ParamFieldType
  required: boolean
  /** Falls back to `name` when the schema carries no `.describe()`/title. */
  label: string
}

/** Empty for a schema with no object shape (or zero properties) — the
 *  palette runs such an action immediately, with no form step. */
export function paramSchemaToFields(schema: z.ZodType<unknown>): ParamField[] {
  let json: unknown
  try {
    json = z.toJSONSchema(schema)
  } catch {
    // A schema shape `z.toJSONSchema` can't represent (rare, e.g. a
    // function/custom refinement type) — no form field this round; the
    // action still runs (with `{}` params, which will fail zod validation
    // with a clear error if params were actually required).
    return []
  }
  if (
    typeof json !== 'object' ||
    json === null ||
    (json as { type?: unknown }).type !== 'object'
  ) {
    return []
  }
  const obj = json as {
    required?: unknown
    properties?: Record<string, { type?: unknown; title?: unknown; description?: unknown }>
  }
  const required = new Set(Array.isArray(obj.required) ? (obj.required as string[]) : [])
  const properties = obj.properties ?? {}
  return Object.entries(properties).map(([name, prop]) => {
    const jsonType = typeof prop?.type === 'string' ? prop.type : 'string'
    const type: ParamFieldType =
      jsonType === 'number' || jsonType === 'integer'
        ? 'number'
        : jsonType === 'boolean'
          ? 'boolean'
          : 'string'
    const label =
      (typeof prop?.title === 'string' && prop.title) ||
      (typeof prop?.description === 'string' && prop.description) ||
      name
    return { name, type, required: required.has(name), label }
  })
}

/** Default form value per field type (empty string / undefined / false). */
export function defaultParamValue(type: ParamFieldType): string | number | boolean | undefined {
  switch (type) {
    case 'number':
      return undefined
    case 'boolean':
      return false
    case 'string':
    default:
      return ''
  }
}
