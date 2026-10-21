import { z } from 'zod'
// The SAAS permission enum — carries `billing::admin` (absent from the default
// `@/api-client/permissions`). `admin::accounts` is present in both; taking it
// from the same enum keeps one import. collect-actions validates each action's
// permission VALUE against the UNION of both generated enums (the #50 seam
// completion), so these validate + live in the single committed manifest and are
// AI-drivable on the hosted build.
import { Permissions } from '@/api-client-saas/permissions'
import { defineAction } from '../defineAction'
import { BillingSubscription } from '@/modules/billing/stores/BillingSubscription.store'
import { CreditsGrants } from '@/modules/billing/stores/CreditsGrants.store'

// The Billing Console mutations (#45/#46/#47) — every admin write declared ONCE as
// a permissioned `defineAction`, so it is EQUALLY drivable by a human (button / ⌘K)
// and by the AI agent (`invoke_capability`) — never a bare inline onClick
// (`.claude/skills/ai-controllable-actions`; admin-console-shell.md §non-negotiables).
// Each `run` is a THIN wrapper over the SAME store method the drawer/confirm calls;
// the store owns the SaasApiClient call + refetch, the action owns permission +
// AI-drivability.
//
// Sole runtime import site: `src/modules/billing/module.tsx` (mirroring how
// `adminAccountActions` is imported once from `admin-accounts/module.tsx`).

const accountId = z
  .string()
  .min(1)
  .describe('The account id to act on (resolve it from the Accounts admin list).')

// ── #45 Subscription & Billing ────────────────────────────────────────────────

defineAction({
  id: 'billing.setPlan',
  title: "Set an account's plan (admin override)",
  permission: Permissions.BillingAdmin,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Directly set an account's plan/tier (an admin comp, no Stripe round-trip). The override WINS until explicitly cleared.",
  params: z.object({
    account_id: accountId,
    plan_id: z
      .string()
      .min(1)
      .describe('The target plan id from the plan catalog (e.g. "free" / "pro").'),
  }),
  run: async ({ account_id, plan_id }) => BillingSubscription.setPlan(account_id, plan_id),
})

defineAction({
  id: 'billing.clearPlan',
  title: "Clear an account's plan override",
  permission: Permissions.BillingAdmin,
  mutating: true,
  // Destructive-ish: hands plan control back to Stripe (the next webhook reconciles).
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Release an account's manual plan override so Stripe controls the plan again (the explicit release path).",
  params: z.object({ account_id: accountId }),
  run: async ({ account_id }) => BillingSubscription.clearPlan(account_id),
})

defineAction({
  id: 'billing.suspendAccount',
  title: 'Suspend (disable) an account',
  // admin::accounts (present in both builds) — the suspend route is on
  // AdminAccountScope, independent of billing::admin (admin-suspend-plan-override §Gating).
  permission: Permissions.AdminAccounts,
  mutating: true,
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Place an admin hold on an account (blocks compute + storage), independent of its billing status. An admin hold is NOT overridable by credits/premium.',
  params: z.object({
    account_id: accountId,
    reason: z
      .string()
      .optional()
      .describe('Optional operator reason for the hold (shown on the account status).'),
  }),
  run: async ({ account_id, reason }) => BillingSubscription.suspend(account_id, reason),
})

defineAction({
  id: 'billing.reactivateAccount',
  title: 'Reactivate an admin-suspended account',
  permission: Permissions.AdminAccounts,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Lift the admin hold on an account. Does NOT clear a real billing suspension (that lifts only when the invoice is paid).',
  params: z.object({ account_id: accountId }),
  run: async ({ account_id }) => BillingSubscription.reactivate(account_id),
})

// ── #47 Credits & Grants ──────────────────────────────────────────────────────

defineAction({
  id: 'billing.grantCredit',
  title: 'Grant overage credit to an account',
  permission: Permissions.BillingAdmin,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Add a positive credit grant (in cents of overage-admission budget) to an account's ledger, with a reason and an optional expiry.",
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
    CreditsGrants.grant(account_id, amount_cents, reason, expires_at),
})

defineAction({
  id: 'billing.revokeCredit',
  title: 'Revoke a credit grant',
  permission: Permissions.BillingAdmin,
  mutating: true,
  // Destructive: removes the grant from the effective balance (the row is retained,
  // stamped revoked — the ledger is append-only).
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Revoke an account's credit grant. The grant row is NOT deleted — it stays in the ledger stamped revoked (append-only, auditable).",
  params: z.object({
    account_id: accountId,
    grant_id: z.string().min(1).describe('The id of the grant to revoke.'),
  }),
  run: async ({ account_id, grant_id }) => CreditsGrants.revoke(account_id, grant_id),
})

defineAction({
  id: 'billing.setPremium',
  title: 'Toggle an account premium (unlimited) comp',
  permission: Permissions.BillingAdmin,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Comp an account to unlimited plan allowance (premium override), or clear it. Does NOT bypass a suspension.',
  params: z.object({
    account_id: accountId,
    premium: z.boolean().describe('true → comp to unlimited; false → clear the comp.'),
    reason: z.string().optional().describe('Optional reason for the comp.'),
  }),
  run: async ({ account_id, premium, reason }) =>
    CreditsGrants.setPremium(account_id, premium, reason),
})
