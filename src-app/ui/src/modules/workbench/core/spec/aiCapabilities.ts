// The `view_spec` -> AI-CAPABILITY projection (PLAN.md ITEM-10/ITEM-11's runtime
// half). A declarative view declares its own `actions:`; this turns those
// declarations into the capability entries the backend puts in the MCP catalog.
//
// This lives HERE, next to `ids.ts`/`describe.ts`/`schema.ts`, because the
// `view_spec` schema is owned by this runtime. The backend used to carry a
// second, deliberately-partial parse of the same document to do the same
// projection; that is the drift this module exists to make impossible. The
// remaining twin is the BUILD-TIME collector (`ui/scripts/collect-actions.mjs`),
// which projects the same shape to run its gates — global id uniqueness against
// every `defineAction`, a real known permission, the `kind:"instance"` shape —
// and deliberately does NOT emit these into the committed manifest.
//
// Pure: no I/O, no registry reads, no side effects. `interpreter.ts` composes it
// with `publishCapabilities` at the moment it registers the actions for real.

import type { AiCapability } from '@/core/actions/capabilityReport'
import type { ActionSpec, ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { describeActionId, namespaceActionId } from './ids'

/** An `ActionSpec` as it arrives from YAML. `parseViewSpec` validates
 *  structurally without stripping, so a declaration may legitimately carry keys
 *  the published contract type does not name yet (`context`, `description`) —
 *  the collector already reads both. Widened here rather than in the CONTRACT
 *  type, which is the published shape. */
type DeclaredAction = ActionSpec & { context?: string; description?: string }

/** Map a declared param type — a loose string (`string` / `number` /
 *  `[number, number]` / `map<…>`) or a nested object — to a JSON-Schema
 *  fragment. An unknown/complex declaration degrades to an OPEN `{}` (any): the
 *  interpreter, not this schema, is the authority on a complex param's shape. */
function paramJsonType(decl: unknown): Record<string, unknown> {
  if (decl !== null && typeof decl === 'object') {
    return Array.isArray(decl) ? { type: 'array' } : { type: 'object' }
  }
  const s = String(decl).trim()
  if (s === 'string') return { type: 'string' }
  if (s === 'number' || s === 'integer' || s === 'float') return { type: 'number' }
  if (s === 'boolean' || s === 'bool') return { type: 'boolean' }
  if (s.startsWith('[') || s.startsWith('array') || s.startsWith('list')) return { type: 'array' }
  if (s.startsWith('map') || s.startsWith('object') || s.startsWith('record')) {
    return { type: 'object' }
  }
  return {}
}

/** The `params_schema` for a declared action: `view_id` is ALWAYS a required
 *  instance target (the `kind:"instance"` contract the backend's invoke path
 *  validates against), then each declared param in declaration order. */
function paramsSchema(declared: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = { view_id: { type: 'string' } }
  const required: string[] = ['view_id']
  for (const [name, decl] of Object.entries(declared ?? {})) {
    if (name === 'view_id') continue
    properties[name] = paramJsonType(decl)
    required.push(name)
  }
  return { type: 'object', required, additionalProperties: false, properties }
}

/** One capability for a declared action, or `null` when it opts out of the AI
 *  surface (`surfaces: { ai: false }` keeps it in the ⌘K palette and drops it
 *  from what the agent can invoke). */
function actionCapability(specId: string, action: DeclaredAction): AiCapability | null {
  if (action.surfaces?.ai === false) return null
  const capability: AiCapability = {
    id: namespaceActionId(specId, action.id),
    title: action.title ?? action.id,
    kind: 'instance',
    mutating: action.mutating ?? false,
    stateful: action.stateful ?? false,
    context: action.context ?? 'global',
    permission: action.permission,
    params_schema: paramsSchema(action.params),
  }
  if (action.description) capability.description = action.description
  return capability
}

/** The synthesized `<view>::describe` read-action, kept in lock-step with
 *  `describe.ts`'s `synthesizeDescribeAction` (same id, same title, same
 *  view-level permission, same single `view_id` param) so the capability the
 *  agent is offered is the action `registerViewSpecActions` actually
 *  registered. */
function describeCapability(spec: ViewSpec): AiCapability {
  return {
    id: describeActionId(spec.id),
    title: `Describe ${spec.title}`,
    kind: 'instance',
    mutating: false,
    stateful: false,
    context: 'global',
    permission: spec.permission,
    description: `Read the live state + derived values of the "${spec.title}" view.`,
    params_schema: {
      type: 'object',
      required: ['view_id'],
      additionalProperties: false,
      properties: { view_id: { type: 'string' } },
    },
  }
}

/**
 * Project every AI-surfaced action a `view_spec` declares — plus its synthesized
 * `<view>::describe` — into capability entries.
 *
 * A permission-less action is NOT filtered here: the backend drops it
 * fail-closed and says so in its log, and duplicating that judgement in the
 * client would only hide an authoring mistake from the one place authorized to
 * rule on it. (`parseViewSpec` already refuses a permission-less action outright,
 * so a spec that reached registration has them.)
 */
export function projectViewSpecCapabilities(spec: ViewSpec): AiCapability[] {
  const out: AiCapability[] = []
  for (const action of spec.actions ?? []) {
    const capability = actionCapability(spec.id, action as DeclaredAction)
    if (capability) out.push(capability)
  }
  out.push(describeCapability(spec))
  return out
}
