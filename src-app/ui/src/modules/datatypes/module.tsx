import { useEffect } from 'react'
import { createModule } from '@ziee/framework'
import { Auth } from '@/modules/auth/Auth.store'
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
  const isAuthenticated = Auth.isAuthenticated
  useEffect(() => {
    if (isAuthenticated) {
      void populateDatatypeRegistry()
    } else {
      // Logout / not-yet-authed: drop the authoritative lattice back to the
      // non-sensitive bootstrap so a subsequent (possibly restricted) login never
      // inherits the prior account's viewers/capabilities.
      resetDatatypeRegistry()
    }
  }, [isAuthenticated])
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
