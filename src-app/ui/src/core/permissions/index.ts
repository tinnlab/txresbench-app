// Permission-gating for TxResBench.
//
// The runtime primitives are the SDK's (`@txresbench/framework/permissions`) — no
// app-copied logic. Only the `PermissionExpr` TYPE is narrowed to this app's
// generated `Permissions` enum (see ./types) for compile-time safety at every
// gating surface. See .claude/PERMISSION_GATING.md for the gating pattern and
// the checklist for new features.

export {
  Can,
  evaluatePermission,
  hasPermission,
  hasPermissionNow,
  usePermission,
} from '@txresbench/framework/permissions'
export type { Permission, PermissionExpr } from './types'
// The saas-gating seam (#42): presence-gated permission checks the saas admin
// pages (#45/#46/#47) use to self-hide in a non-saas build.
export { isKnownPermission, useHasPermission } from './saasGating'
