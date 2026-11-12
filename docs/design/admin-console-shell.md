# Admin Console shell — design

**Source of intent:** GitHub issue [#42](https://github.com/tinnlab/txresbench/issues/42)
("Admin Console shell: settingsAdminPages cluster + saas-gating seam + defineAction
discipline") — the shell item of the Admin Console epic (blocks #43–48). This doc
formalizes the shell's non-negotiables so the later admin pages have a stable seam to
plug into.

## Problem

The Admin nav group in Settings (`modules/settings/SettingsPage.tsx`) renders only if
`settingsAdminPages` holds **≥1 permitted entry**. The epic adds account / billing /
usage / credits admin pages (#44–47); those need a place to cluster and a way for the
saas-only ones to disappear cleanly in an OSS/desktop build where their backend
permission was never generated.

This shell delivers three seams and one proof-of-render page — **not** the pages
themselves:

1. **The admin-console section** — an ordered landing entry under the existing "Admin"
   nav group so the new admin pages cluster together, plus a real landing/catalog page
   that renders for an admin (proving the group shows).
2. **The saas-gating seam** — a reusable permission-*presence* primitive the saas admin
   pages (#45/#46/#47) use to self-hide in a non-saas build.
3. **The defineAction discipline** — one example admin action proving every admin
   control is a permissioned `defineAction`, validated by `action-refs-lint` /
   `action-coverage`.

## Shell — non-negotiables (lifted as PLAN invariants)

- **Admin sees the section; a non-admin does not.** An admin (holding `admin::accounts`,
  or `is_admin`) sees the Admin console section in Settings; a user lacking it sees no
  admin-console nav entry and a direct deep-link to the route renders an in-place 403 —
  while that same restricted user still loads their own Settings (the positive control
  that proves "absent" means *gated*, not *never rendered*).

- **A saas admin page self-hides on permission *presence*, not a hardcoded `isSaas`
  boolean.** Each saas page gates its nav entry + route on the presence of its
  backend-generated permission. In a build where that permission was stripped from the
  OpenAPI spec (OSS/desktop) it is absent from the generated `Permissions` enum, so the
  gate resolves false — the entry and route simply do not render, **even for a root
  admin** (whose `is_admin` short-circuit would otherwise reveal it). Presence is
  checked before the admin short-circuit.

- **Every admin control is a permissioned `defineAction`.** No admin control is a bare
  inline `onClick` that only the human path can reach; each is declared once via
  `defineAction` with a real `permission`, so it is equally drivable by the command
  palette and the AI agent (`.claude/skills/ai-controllable-actions`). Enforced by
  `action-refs-lint` (every `action="…"` / `runAction('…')` names a registered id) and
  `action-coverage`.

## The saas-gating seam — how a saas page uses it

The seam is two small additions to `src/core/permissions`:

- `isKnownPermission(permKey: string): boolean` — non-reactive; true iff `permKey` is a
  value of the **generated** `Permissions` enum. This is the presence check: a
  build-stripped saas permission is not a member, so it returns false.
- `useHasPermission(permKey: string): boolean` — reactive hook; `isKnownPermission(permKey)
  && usePermission(permKey)`. Returns false when the permission is absent from the build
  **or** the user does not hold it. The presence guard is evaluated first so an absent
  permission stays hidden even for a root admin.

A saas admin page (#45 billing shown) uses them at two layers:

```tsx
// modules/billing/module.tsx — conditional slot + route registration.
const BILLING_PERM = 'billing::manage'          // string, NOT Permissions.X: the enum
                                                //   member does not exist in an OSS build
const billingEntry = isKnownPermission(BILLING_PERM)
  ? { settingsAdminPages: [{ id: 'billing', /* … */ permission: BILLING_PERM as PermissionExpr }] }
  : {}                                          // absent → the entry never registers
```

```tsx
// modules/billing/pages/BillingPage.tsx — component-level self-hide (defense in depth).
export function BillingPage() {
  if (!useHasPermission('billing::manage')) return <Result status="403" … />
  // …real billing UI…
}
```

The nav entry hides at the slot layer (`isKnownPermission` false → not registered), the
route is protected the same way, and the page self-guards. Nothing hardcodes `isSaas`;
the single source of truth is whether the backend generated the permission.
