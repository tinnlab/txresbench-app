import { createModule } from '@txresbench/framework'
// Side-effect import: `AppMode.store` self-registers via `registerLazyStore`.
import '@/modules/app/AppMode.store'

// TxResBench: the first-run setup surface (`/setup`, the setup-status check, the
// setup-admin call) was REMOVED — the single local owner is provisioned by the
// server's local-session module / the desktop harness at boot, so the app never
// has a setup screen. Only the `AppMode` platform flag remains (consumed by the
// settings page's desktop variant).
export default createModule({
  metadata: {
    name: 'app',
    version: '1.0.0',
    description: 'Application-level module (platform mode flag only).',
  },
  routes: [],
  stores: [],
  initialize: () => {},
})
