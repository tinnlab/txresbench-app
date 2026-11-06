import { createModule } from '@ziee/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { lazyWithPreload } from '@/utils/lazyWithPreload'

const ChooseMethodsPage = lazyWithPreload(() =>
  import('./pages/ChooseMethodsPage').then(m => ({ default: m.ChooseMethodsPage })),
)
const RunningPage = lazyWithPreload(() =>
  import('./pages/RunningPage').then(m => ({ default: m.RunningPage })),
)

/**
 * txrrun — the run screens of TxResBench: screen E (`Busy.dc.html`,
 * "Choose the methods and settings") and screen F (`BusyRunning.dc.html`,
 * the screen that shows the run as it executes). E turns the uploaded
 * patients/measurements/predict files and the owner's settings into a
 * method selection and creates the run through the engine; F renders that
 * run live (per-method state, progress, log, stop/skip, leave-and-
 * continue, results readable while the other methods still run).
 *
 * The module consumes the shared selection list (`txrlist`), the intake
 * store and file cards (`txrintake`), the results path builders
 * (`txrresults`), and the execution engine's run surfaces through the
 * generated client (`ApiClient.Txr.*` + `ApiClient.MethodCatalogue.*`;
 * regenerated types are provider-owned — this node never regenerates
 * OpenAPI). The route table is the URL-as-view contract the sibling flow
 * modules bind through the path builders in `routes.ts`: the E route is
 * the convention `ui-intake` already declared (its `ROUTE_CONVENTIONS`),
 * and `runningPath` is the F route screen K (`ui-history`) binds when it
 * reopens a running run. The `compare`/`methods` reserved path words
 * belong to `txrresults`' route tree — the F route never uses them.
 *
 * The run store is WHOLE-STORE-LAZY (`registerLazyStore` in its own file,
 * the `datasets`/`txrresults` precedent) — no eager module.tsx -> store
 * import, so `stores` stays empty.
 */
export default createModule({
  metadata: {
    name: 'txrrun',
    version: '1.0.0',
    description:
      'TxResBench run screens — choose the methods and settings (E), then watch the run (F).',
  },
  dependencies: ['router', 'txrshell', 'txrintake', 'txrlist', 'txrresults'],
  stores: [],
  routes: [
    {
      path: '/choose-methods',
      element: ChooseMethodsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/analysis/:runId/running',
      element: RunningPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
