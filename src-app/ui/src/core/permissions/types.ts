// See .claude/PERMISSION_GATING.md for the gating pattern and the
// checklist for new features.

import type { Permissions } from '@/api-client/permissions'

/**
 * A single permission, restricted to the `Permissions` enum emitted
 * by the OpenAPI type generator. Pass enum members for type-safety:
 *
 *   import { Permissions } from '@/api-client/permissions'
 *   permission: Permissions.UsersDelete
 *
 * If a permission you need isn't in the enum, the backend's
 * endpoint-level OpenAPI annotation is missing the structured 403
 * example — fix the handler (call `with_permission` and drop any
 * `.response::<403, ...>` / `.response_with::<403, ...>` overrides
 * that clobber the auto-attached body), then rerun `just openapi-regen`
 * (which regenerates the OpenAPI spec + this `types.ts`).
 */
export type Permission = Permissions

/**
 * Composable permission expression. Used by every gating surface
 * (slot fields, <Can> component, usePermission hook, evaluator).
 *
 * - bare leaf: an exact permission (prefer `Permissions.*` enum
 *   members; raw strings accepted for not-yet-in-enum perms). Matched
 *   with the same wildcard rules as the backend (`*`,
 *   `module::resource::*`, etc.).
 * - `allOf`: every child expression must pass (AND).
 * - `anyOf`: at least one child expression must pass (OR).
 *
 * The expression names mirror JSON Schema / OpenAPI conventions used
 * elsewhere in this project. The shape is intentionally serializable
 * (no functions) so it can flow through slot registrations and be
 * inspected by tooling.
 */
export type PermissionExpr =
  | Permission
  | { allOf: PermissionExpr[] }
  | { anyOf: PermissionExpr[] }
