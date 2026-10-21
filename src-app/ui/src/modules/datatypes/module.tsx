import { useEffect } from 'react'
import { createModule } from '@ziee/framework'
import { Session } from '@/modules/session/Session.store'
import { populateDatatypeRegistry, resetDatatypeRegistry, seedBootstrap } from '@/core/datatypes'

/**
 * `datatypes` module — the thin app-wiring that POPULATES the P2 datatype registry.
 * All logic lives in `@/core/datatypes` (which survives the P5 package split); this
 * module only triggers the boot populate from `GET /api/datatypes` once the user is
 * authenticated (the endpoint is gated by `projects::use`), via a `routerEffects`
 * render-nothing effect (mirrors `app`'s `SetupRedirect`). The bootstrap skeleton is
 * seeded at import so the registry is never empty pre-populate.
 */
seedBootstrap()

function DatatypeRegistryBoot() {
  const { ready, user } = Session
  useEffect(() => {
    if (ready && user) {
      void populateDatatypeRegistry()
    }
  }, [ready, user])
  return null
}

export default createModule({
  metadata: {
    name: 'datatypes',
    version: '1.0.0',
    description: 'Open datatype registry (P2) — populates the FE mirror from /api/datatypes.',
  },
  dependencies: ['router'],
  slots: {
    routerEffects: [
      {
        id: 'datatype-registry-boot',
        component: DatatypeRegistryBoot,
      },
    ],
  },
})
