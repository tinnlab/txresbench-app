import { createModule } from '@txresbench/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { lazyWithPreload } from '@/utils/lazyWithPreload'

const ResultsPage = lazyWithPreload(() =>
  import('./pages/ResultsPage').then(m => ({ default: m.ResultsPage })),
)
const MethodResultsPage = lazyWithPreload(() =>
  import('./pages/MethodResultsPage').then(m => ({ default: m.MethodResultsPage })),
)

/**
 * txrresults — the results screens of TxResBench: screen G (patient × method
 * heatmap, `BusyResults.dc.html` — live partial columns while the run
 * continues, cannot-run banners, search/sort/method filters, per-patient
 * averages, download-all CSV, save-models entry) and screen H (one run's
 * method detail: method tablist, outcome tabs, patient × method bar table,
 * the two-method compare card, the explanatory cards (`Results.dc.html` and
 * `SaveOne.dc.html`). qa-fixes4 ITEM-1: the board's saved-in / open-folder
 * line is not rendered (the run dir is an internal host fact).
 *
 * The module consumes ONLY the execution engine's run surfaces
 * (`ApiClient.Txr.*` — run detail, SSE stream, logs, predictions, CSV
 * download; regenerated types are provider-owned). The route table is the
 * URL-as-view contract the sibling flow modules bind through the path
 * builders in `routes.ts`: screen F (`ui-run`) navigates to
 * `/analysis/<runId>/results` when a run starts or continues, and screen K
 * (`ui-history`) reopens results through the same builders. `compare` and
 * `methods` are reserved path words under `/analysis/:runId/results` — they
 * are route segments, never method ids.
 */
export default createModule({
  metadata: {
    name: 'txrresults',
    version: '1.0.0',
    description:
      'TxResBench results — patient × method heatmap (G) and one-method detail (H)',
  },
  dependencies: ['router', 'txrshell'],
  // The results store is WHOLE-STORE-LAZY (`registerLazyStore` in its own
  // file, the `DatasetDetail` precedent) — no eager module.tsx -> store
  // import, so `stores` stays empty.
  stores: [],
  routes: [
    {
      path: '/analysis/:runId/results',
      element: ResultsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/analysis/:runId/results/compare',
      element: MethodResultsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/analysis/:runId/results/methods/:methodId',
      element: MethodResultsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
