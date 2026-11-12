import { createModule } from '@txresbench/framework'
// Side-effect imports: `Session.store` self-registers via `registerLazyStore`
// AND sets the SDK permission seam at module scope.
import '@/modules/session/Session.store'
import { SessionGuard } from '@/modules/session/SessionGuard'
import { Session } from '@/modules/session/Session.store'

export default createModule({
  metadata: {
    name: 'session',
    version: '1.0.0',
    description: 'Single-user local session (no login screen).',
  },
  dependencies: ['router'],
  routes: [],
  stores: [],
  // Fill the router-owned `routeGuards` slot so protected routes wait for the
  // local session instead of bouncing to a login page.
  slots: {
    routeGuards: [{ id: 'session-guard', component: SessionGuard }],
  },
  initialize: () => {
    // Kick the session mint at module-INITIALIZE time (before the router
    // mounts), mirroring the old boot-session-verify behaviour.
    void Session.initSession()
  },
})
