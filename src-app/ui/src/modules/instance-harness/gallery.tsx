import { lazy } from 'react'
import type { ModuleGallery } from '@ziee/gallery'

/**
 * Gallery seed for the instance-action harness page (PLAN.md ITEM-9). The
 * page is fully self-contained (a locally-minted `view_id` + local state via
 * `useAction`/`versioned` — no store/API dependency), so a single default
 * render covers it; the interesting behavior (a real AI-driven instance
 * invoke) is proven at the e2e tier (TEST-11), not here.
 */

const InstanceHarnessPage = lazy(() => import('./InstanceHarnessPage'))

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'instance-harness',
      title: 'Instance Action Harness',
      note: 'A live useAction-registered instance surface (slice-3 demonstrator).',
      path: '/instance-harness',
      initialPath: '/instance-harness',
      component: InstanceHarnessPage,
      setup: () => {},
    },
  ],
}
