import { createModule } from '@ziee/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { lazyWithPreload } from '@/utils/lazyWithPreload'

const HistoryPage = lazyWithPreload(() =>
  import('./pages/HistoryPage').then(m => ({ default: m.HistoryPage })),
)

/**
 * txrhistory — the history screen of TxResBench: screen K (board
 * `History.dc.html` — "Everything you ran, newest
 * first"), the newest-first run list with the board's search + filter, the
 * collapsible per-run card (header row + expanded detail block), the four
 * run actions (open results / run again / download predictions / open the
 * folder / show the log), the footer (run count + disk usage + the two
 * retention controls).
 *
 * Route handoff: this module owns `/history` — the `txrshell` scaffold
 * route for it is removed on the same branch (the `/` handoff is
 * `txrintake`'s and the `/models` handoff is `txrmodels`'s, same file,
 * their own blocks). The module consumes ONLY the providers' frozen
 * contracts — `ApiClient.History.*` (history-store) and
 * `ApiClient.Txr.*` (execution-engine) via the generated client, and the
 * sibling modules' path builders via their barrels (never a URL literal,
 * never a re-implementation).
 *
 * The history store is WHOLE-STORE-LAZY (`registerLazyStore` in its own
 * file, the `datasets`/`txrresults` precedent) — no eager module.tsx ->
 * store import, so `stores` stays empty.
 */
export default createModule({
  metadata: {
    name: 'txrhistory',
    version: '1.0.0',
    description: 'TxResBench history — everything you ran, newest first (screen K).',
  },
  dependencies: ['router', 'txrshell', 'txrresults', 'txrrun', 'txrintake'],
  // The history store is WHOLE-STORE-LAZY (registerLazyStore in its own
  // file) — the module stays eager-free; K emits no events and owns no
  // slot (PROV-HIST-8: no dialog host, the log dialog is the page's own).
  stores: [],
  routes: [
    {
      path: '/history',
      element: HistoryPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
