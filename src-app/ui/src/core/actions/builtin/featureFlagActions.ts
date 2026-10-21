import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { FeatureFlags } from '@/modules/features/FeatureFlags.store'

// The Feature-Flags admin mutation (#48) — the GLOBAL enable/disable toggle
// declared ONCE as a permissioned `defineAction`, so it is EQUALLY drivable by a
// human (the page's Switch → `runAction`, the ⌘K palette) and by the AI agent
// (`invoke_capability`) — never a bare inline onClick only the human path can
// reach (`.claude/skills/ai-controllable-actions`, INV-1). The `run` is a THIN
// wrapper delegating to the SAME `FeatureFlags.setGlobal` a human handler calls;
// the store owns the mutation + in-place refresh, the action owns permission +
// AI-drivability.
//
// Import this module for its side effect to register the action — the sole
// import site is `src/modules/features/module.tsx` (mirroring how
// `builtin/adminAccountActions.ts` is imported once from `admin-accounts/module.tsx`).
//
// TEST-9 (#48): `node scripts/collect-actions.mjs --check` (run inside `npm run check`)
// verifies this action is present in the committed frontend-actions MCP manifest with
// a known permission — the AI-surface half of INV-1.

defineAction({
  id: 'features.setGlobalFlag',
  title: 'Enable or disable a feature flag (global default)',
  // The SAME permission a human needs to see the page + the Switch (the route +
  // slot gate and the `PUT /api/admin/features/{flag_key}` route are on
  // `features::manage`).
  permission: Permissions.FeaturesManage,
  mutating: true,
  // Deployment-wide — flipping the global default changes behavior for every
  // account without an explicit override, so the palette interposes a confirm
  // (INV-3); the page interposes its own `Confirm` too.
  dangerous: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Set a feature flag's GLOBAL default on or off for the whole deployment (no per-account override).",
  params: z.object({
    flag_key: z
      .string()
      .min(1)
      .describe('The flag key, e.g. "demo.runtime_flag".'),
    enabled: z
      .boolean()
      .describe('true enables the feature globally, false disables it.'),
  }),
  run: async ({ flag_key, enabled }) => {
    // Thin wrapper — the SAME store method the page's Switch confirm calls.
    return FeatureFlags.setGlobal(flag_key, enabled)
  },
})

// The per-account override SET (#53) — enable/disable one flag for ONE account without
// touching the global default or any other account. A permissioned `defineAction` (same
// `features::manage` as the page), so the page's per-account Switch AND the AI agent
// drive the SAME `FeatureFlags.setAccount` mutation (INV-5). Not `dangerous` — a
// per-account override affects only that account, unlike the deployment-wide global.
defineAction({
  id: 'features.setAccountFlag',
  title: 'Enable or disable a feature flag for one account (per-account override)',
  permission: Permissions.FeaturesManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Set a PER-ACCOUNT override for a feature flag (on/off) for a single account, leaving the global default and other accounts untouched.",
  params: z.object({
    flag_key: z.string().min(1).describe('The flag key, e.g. "demo.runtime_flag".'),
    account_id: z.string().min(1).describe('The account UUID to override the flag for.'),
    enabled: z
      .boolean()
      .describe('true enables the feature for this account, false disables it.'),
  }),
  run: async ({ flag_key, account_id, enabled }) => {
    // Thin wrapper — the SAME store method the page's per-account Switch confirm calls.
    return FeatureFlags.setAccount(flag_key, account_id, enabled)
  },
})

// The per-account override CLEAR (#53) — the missing half of #48: remove one account's
// override so it reverts to inheriting the global/compiled default. A permissioned
// `defineAction` delegating to the SAME `FeatureFlags.clearAccount` the page's "Clear
// override" control calls (INV-5), so the revert is equally AI-drivable.
defineAction({
  id: 'features.clearAccountOverride',
  title: 'Clear a per-account feature-flag override (revert to inherit)',
  permission: Permissions.FeaturesManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    "Remove a feature flag's PER-ACCOUNT override for one account, so the account reverts to inheriting the global default (or the compiled default).",
  params: z.object({
    flag_key: z.string().min(1).describe('The flag key, e.g. "demo.runtime_flag".'),
    account_id: z
      .string()
      .min(1)
      .describe('The account UUID whose override should be cleared.'),
  }),
  run: async ({ flag_key, account_id }) => {
    // Thin wrapper — the SAME store method the page's "Clear override" control calls.
    return FeatureFlags.clearAccount(flag_key, account_id)
  },
})
