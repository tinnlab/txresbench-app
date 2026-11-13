// The saas-gating seam (#42 admin-console-shell, ITEM-3).
//
// A saas-only admin page (billing #45, usage/quota #46, credits #47) must
// self-hide in a non-saas build. The build signal is NOT a hardcoded `isSaas`
// boolean — it is the PRESENCE of the page's backend-generated permission. A
// build that stripped that permission from its OpenAPI spec (OSS/desktop) never
// generates the member in the `Permissions` enum, so a presence check is false
// there and true in a saas build. See the admin-console design.
// ("The saas-gating seam — how a saas page uses it") and `.claude/PERMISSION_GATING.md`.

import { Permissions } from '@/api-client/permissions'
import type { Permission } from './types'
import { usePermission } from '@txresbench/framework/permissions'

/** Every permission string the CURRENT build generated (the enum's VALUES, e.g.
 *  `'admin::accounts'`). Computed once — the enum is a build constant. A
 *  build-stripped saas permission is simply not in this set. */
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(Object.values(Permissions))

/**
 * Non-reactive presence check: is `permKey` a permission THIS build knows about
 * (a value of the generated `Permissions` enum)?
 *
 * This is the saas seam's foundation. Use it to CONDITIONALLY register a saas
 * page's slot entry / route at module-load time (a stripped permission → don't
 * register the entry at all), where a hook cannot run. A saas module references
 * its permission by STRING (the enum member does not exist to import in an OSS
 * build), so it passes the string here.
 */
export function isKnownPermission(permKey: string): boolean {
  return KNOWN_PERMISSIONS.has(permKey)
}

/**
 * Reactive: does the current user hold `permKey`, AND is `permKey` a permission
 * this build knows about? Returns `false` when the permission is ABSENT from the
 * build (saas-stripped) OR the user simply doesn't hold it.
 *
 * The presence guard is evaluated FIRST, on purpose: the SDK's `hasPermission`
 * grants a root admin every permission via the `is_admin` short-circuit
 * (`sdk .../permissions/hasPermission.ts`), so without the presence guard a root
 * admin would see a saas page in an OSS build. Checking `isKnownPermission`
 * first makes an absent permission hide the page for admins too — which is the
 * whole point of the seam.
 *
 * Use it for a saas page's component-level self-hide (defense in depth behind
 * the conditional slot/route registration):
 *
 *   if (!useHasPermission('billing::manage')) return <Result status="403" … />
 *
 * `usePermission` is always called (never conditionally), so this obeys the
 * Rules of Hooks — the presence result only gates the boolean it returns.
 */
export function useHasPermission(permKey: string): boolean {
  const held = usePermission(permKey as Permission)
  return isKnownPermission(permKey) && held
}
