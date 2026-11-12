import { lazy } from 'react'
import type { ModuleGallery } from '@txresbench/gallery'
import type { PackageLoadStatus } from '@/api-client/types'
import { useProcessorsAdminStore } from '@/modules/processors/stores/ProcessorsAdmin.store'

/**
 * Gallery seed for the admin `/settings/processors` page (D2 / ITEM-15). Seeds the
 * real ProcessorsAdmin store offline (no backend) across the loaded (≥1 ok + ≥1
 * skipped-with-error), empty, and error states, so the `gate:ui` boot-canary +
 * runtime-health cover them. The shared viewport matrix renders every seeded
 * surface at 390px (mobile) too, so the narrow-viewport DoD is covered.
 */

const ProcessorsAdminPage = lazy(() => import('@/modules/processors/ProcessorsAdminPage'))

type AdminState = ReturnType<typeof useProcessorsAdminStore.getState>

const DEFAULTS: Partial<AdminState> = {
  packages: [],
  registered: null,
  loading: false,
  reloading: false,
  error: null,
}

const LOADED: PackageLoadStatus[] = [
  { id: 'anndata-import', ok: true, version: '0.1.0' },
  { id: 'qc', ok: true, version: '0.1.0' },
  { id: 'cell-filter', ok: true, version: '0.1.0' },
  { id: 'single-cell-types', ok: true, version: '0.1.0' },
  { id: 'broken-pkg', ok: false, version: '0.1.0', error: 'broken-pkg: unknown key `bogus_key`' },
]

function seed(partial: Partial<AdminState>) {
  return () => {
    useProcessorsAdminStore.setState({ ...DEFAULTS, ...partial } as AdminState)
  }
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'processors-admin',
      title: 'Processors — discovered set',
      note: 'Loaded state: valid packages (Loaded) + one skipped-with-error package.',
      path: '/settings/processors',
      initialPath: '/settings/processors',
      component: ProcessorsAdminPage,
      setup: seed({ packages: LOADED, registered: 4 }),
    },
    {
      slug: 'processors-admin-empty',
      title: 'Processors — none discovered',
      note: 'Empty state: the processors folder scanned to zero packages.',
      path: '/settings/processors',
      initialPath: '/settings/processors',
      component: ProcessorsAdminPage,
      setup: seed({ packages: [] }),
    },
    {
      slug: 'processors-admin-error',
      title: 'Processors — load failed',
      note: 'Error state: GET /api/processors failed; the retryable error replaces the card.',
      path: '/settings/processors',
      initialPath: '/settings/processors',
      component: ProcessorsAdminPage,
      setup: seed({ packages: [], error: 'Failed to load processors' }),
    },
  ],
}
