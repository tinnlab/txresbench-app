import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'
import type { AdminAccountSummary, FeatureFlagView } from '@/api-client/types'
import { useFeatureFlagsStore } from '@/modules/features/FeatureFlags.store'
import { useFeatureFlagAccountsStore } from '@/modules/features/stores/FeatureFlagAccounts.store'
// Side-effect import: register the feature-flag action so the gallery's
// interactive Switch recipe doesn't throw ActionNotFoundError (the gallery does
// not load `module.tsx`).
import '@/core/actions/builtin/featureFlagActions'

/**
 * Gallery seed for the Feature Flags admin page (#48). The page fetches from
 * `Features.list` at runtime; the gallery instead seeds the store's state (the
 * `admin-accounts/gallery.tsx` `setup`-`setState` pattern) so the design-critic
 * vision pass reviews the POPULATED list (mixed on/off rows, global-override vs
 * compiled-default provenance, the toggle Switch), plus the empty, loading, and
 * cold-load-error states. The 390px narrow-viewport state is applied by the shared
 * theme/viewport matrix.
 */
const FeatureFlagsPage = lazy(() =>
  import('./pages/FeatureFlagsPage').then(m => ({ default: m.FeatureFlagsPage })),
)

const seededFlags: FeatureFlagView[] = [
  {
    flag_key: 'demo.runtime_flag',
    description: 'Demonstration runtime flag shipped by the compiled registry.',
    default_enabled: false,
    global_enabled: true,
    effective: true,
  },
  {
    flag_key: 'search.semantic',
    description: 'Semantic search across projects and datasets.',
    default_enabled: true,
    effective: true,
  },
  {
    flag_key: 'export.repro_capsule',
    description: 'Reproducibility capsule export for compute closures.',
    default_enabled: false,
    effective: false,
  },
  {
    flag_key: 'viz.beta_panels',
    description: 'Beta visualization panels in the workbench.',
    default_enabled: true,
    global_enabled: false,
    effective: false,
  },
]

// A per-account resolved view (#53): a MIX of inherited (account_enabled null) and
// overridden (account_enabled set) rows, so the design-critic + 390px review sees the
// inherited-vs-overridden distinction (badges, the "Clear override" control enabled only
// on overridden rows).
const seededAccountFlags: FeatureFlagView[] = [
  {
    flag_key: 'demo.runtime_flag',
    description: 'Demonstration runtime flag shipped by the compiled registry.',
    default_enabled: false,
    global_enabled: true,
    account_enabled: false, // overridden OFF for this account (global is ON)
    effective: false,
  },
  {
    flag_key: 'search.semantic',
    description: 'Semantic search across projects and datasets.',
    default_enabled: true,
    effective: true, // inherited (compiled default on)
  },
  {
    flag_key: 'export.repro_capsule',
    description: 'Reproducibility capsule export for compute closures.',
    default_enabled: false,
    account_enabled: true, // overridden ON for this account
    effective: true,
  },
  {
    flag_key: 'viz.beta_panels',
    description: 'Beta visualization panels in the workbench.',
    default_enabled: true,
    global_enabled: false,
    effective: false, // inherited (global default off)
  },
]

// A representative account for the picker — a real human name, never a raw UUID label.
const seededAccounts: AdminAccountSummary[] = [
  {
    account: { id: 'acct-nebula', name: 'Nebula Diagnostics' },
    member_count: 12,
    owner_label: 'Dr. Priya Raman',
  } as never,
  {
    account: { id: 'acct-orion', name: 'Orion Genomics' },
    member_count: 4,
    owner_label: 'Sam Okafor',
  } as never,
]

const DEFAULTS = {
  flags: [] as FeatureFlagView[],
  loading: false,
  error: null as string | null,
  pending: {} as Record<string, boolean>,
  selectedAccountId: null as string | null,
  accountFlags: [] as FeatureFlagView[],
  accountLoading: false,
  accountError: null as string | null,
  accountPending: {} as Record<string, boolean>,
}

function seed(partial: Partial<typeof DEFAULTS>) {
  return () => {
    useFeatureFlagsStore.setState({ ...DEFAULTS, ...partial } as never)
  }
}

// Seed BOTH stores for the per-account section: the picker's account list + the
// selected account's resolved flags.
function seedPerAccount() {
  return () => {
    useFeatureFlagAccountsStore.setState({
      accounts: seededAccounts,
      isInitialized: true,
      loading: false,
      error: null,
    } as never)
    useFeatureFlagsStore.setState({
      ...DEFAULTS,
      flags: seededFlags,
      selectedAccountId: 'acct-nebula',
      accountFlags: seededAccountFlags,
    } as never)
  }
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'feature-flags-populated',
      title: 'Feature Flags — populated list',
      note: 'Mixed on/off flags with global-override vs compiled-default provenance and the toggle Switch.',
      path: '/settings/feature-flags',
      initialPath: '/settings/feature-flags',
      component: FeatureFlagsPage,
      setup: seed({ flags: seededFlags }),
    },
    {
      slug: 'feature-flags-empty',
      title: 'Feature Flags — empty',
      note: 'A deployment whose compiled registry defines no flags.',
      path: '/settings/feature-flags',
      initialPath: '/settings/feature-flags',
      component: FeatureFlagsPage,
      setup: seed({ flags: [] }),
    },
    {
      slug: 'feature-flags-loading',
      title: 'Feature Flags — loading',
      note: 'The cold-load spinner before the first response arrives.',
      path: '/settings/feature-flags',
      initialPath: '/settings/feature-flags',
      component: FeatureFlagsPage,
      setup: seed({ flags: [], loading: true }),
    },
    {
      slug: 'feature-flags-error',
      title: 'Feature Flags — cold-load error',
      note: 'A backend outage on the initial load: a retryable ErrorState, not a blank card.',
      path: '/settings/feature-flags',
      initialPath: '/settings/feature-flags',
      component: FeatureFlagsPage,
      setup: seed({ flags: [], error: 'Failed to load feature flags' }),
    },
    {
      slug: 'feature-flags-per-account',
      title: 'Feature Flags — per-account overrides',
      note: 'An account selected in the picker with a MIX of inherited and overridden rows: the "Overridden" badge + enabled "Clear override" control vs the muted "Inherited" rows (#53).',
      path: '/settings/feature-flags',
      initialPath: '/settings/feature-flags',
      component: FeatureFlagsPage,
      setup: seedPerAccount(),
    },
  ],
}
