import { z } from 'zod'
// The SAAS permission enum — carries `billing::admin` (absent from the default
// `@/api-client/permissions`). collect-actions validates each action's permission
// VALUE against the UNION of both generated enums (the #50 seam completion), so
// these validate + live in the single committed manifest and are AI-drivable on the
// hosted build.
import { Permissions } from '@/api-client-saas/permissions'
import { defineAction } from '../defineAction'
import { Users } from '@/modules/user/stores/Users.store'

// The Users-admin tier/premium comp mutations (#43) — every admin write declared ONCE
// as a permissioned `defineAction`, so it is EQUALLY drivable by a human (the tier
// column's Switch→Confirm / grant drawer) and by the AI agent (`invoke_capability`) —
// never a bare inline onClick (`.claude/skills/ai-controllable-actions`;
// admin-console-shell.md §non-negotiables, INV-2). Each `run` is a THIN wrapper over
// the SAME Users-store method the human path calls; the store owns the
// `SaasApiClient.Admin.*` call + list refetch, the action owns permission +
// AI-drivability. These act on the user's PERSONAL account and refetch the USERS list
// (the tier column) — distinct from the account-scoped `billing.*` actions, which
// refetch the credit ledger.
//
// Sole runtime import site: `src/modules/user/module.tsx` (present-gated, mirroring how
// `billingActions` is imported once from `billing/module.tsx`). collect-actions scans
// the source statically, so the committed manifest carries these regardless of gating.

const accountId = z
  .string()
  .min(1)
  .describe(
    "The user's personal account id (the row's `personal_account_id`; the user must have one).",
  )

defineAction({
  id: 'user.grantPremiumComp',
  title: "Toggle a user's premium (unlimited) comp",
  permission: Permissions.BillingAdmin,
  mutating: true,
  // Dangerous: comps the user's personal account to UNLIMITED plan allowance.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Comp a user's personal account to unlimited plan allowance (premium override), or clear it. Does NOT bypass a suspension. Refreshes the Users tier column.",
  params: z.object({
    account_id: accountId,
    premium: z.boolean().describe('true → comp to unlimited; false → clear the comp.'),
    reason: z.string().optional().describe('Optional reason for the comp.'),
  }),
  run: async ({ account_id, premium, reason }) =>
    Users.setPersonalAccountPremium(account_id, premium, reason),
})

defineAction({
  id: 'user.grantUserCredit',
  title: "Grant overage credit to a user's account",
  permission: Permissions.BillingAdmin,
  mutating: true,
  // Dangerous: grants real overage-admission budget against the user's account.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Add a positive credit grant (in integer CENTS of overage-admission budget) to a user's personal account, with a reason and an optional expiry. Refreshes the Users tier column.",
  params: z.object({
    account_id: accountId,
    amount_cents: z
      .number()
      .int()
      .positive()
      .describe('The grant amount in integer CENTS (must be > 0).'),
    reason: z.string().min(1).describe('Why the credit is granted (required, non-empty).'),
    expires_at: z
      .string()
      .optional()
      .describe('Optional ISO-8601 expiry; omit for a grant that never expires.'),
  }),
  run: async ({ account_id, amount_cents, reason, expires_at }) =>
    Users.grantPersonalAccountCredit(account_id, amount_cents, reason, expires_at),
})
