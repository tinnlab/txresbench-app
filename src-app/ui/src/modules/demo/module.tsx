import { createModule } from '@txresbench/framework'
// Side-effect import: `DemoMode.store` self-registers via `registerLazyStore`.
import '@/modules/demo/DemoMode.store'
import { DemoMode } from '@/modules/demo/DemoMode.store'

/**
 * demo — the demo-mode UI foundation module (ITEM-5).
 *
 * The module owns NO route and NO store registration of its own (the store
 * self-registers at import). Its ONE job is the boot read: `GET /api/app/mode`
 * fires at module-INITIALIZE time — BEFORE the router and the pages mount —
 * mirroring the session module's boot mint, so every page reads the settled
 * mode (useAppMode) and the no-flash rule holds (the store starts unknown and
 * only the settled answer renders demo chrome).
 */
export default createModule({
  metadata: {
    name: 'demo',
    version: '1.0.0',
    description:
      'Demo-mode UI foundation: the app-mode context, the notice bar, the mode-gated components.',
  },
  dependencies: ['router'],
  routes: [],
  stores: [],
  initialize: () => {
    void DemoMode.init()
  },
})
