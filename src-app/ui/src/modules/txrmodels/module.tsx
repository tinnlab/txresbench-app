import { createModule } from '@txresbench/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { FLOW_ROUTES } from '@/modules/txrshell/lib/flowSteps'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import { TxrModelsDialogHost } from './components/TxrModelsDialogHost'
// Side-effect import: registers the model-step Run (`models.run`) — the
// merged list's Run button and the AI agent take the same guarded path.
import '@/core/actions/builtin/modelRunActions'
// Side-effect import: registers the model-file action
// (`models.openModelFile`) — the Models page's "Open a model file" and the
// Start card's, the human picker and the agent's navigate path share it.
import '@/core/actions/builtin/modelFileActions'
// Side-effect import: registers the model-set actions (`models.renameSet` /
// `models.exportSet` / `models.deleteSet`) — the set section buttons on the
// Models page and the AI agent take the same path.
import '@/core/actions/builtin/modelSetActions'

/** The old D route's address — kept as a REDIRECT to the merged list (round
 *  2), never a flow step any more (round 3 removed the `pretrained-models`
 *  step id; this address survives for old links and bookmarks). */
const OLD_PRETRAINED_MODELS_ROUTE = '/pretrained-models'
/** The old I route's address — the same redirect rule (`source=saved`). */
const OLD_SAVED_MODELS_ROUTE = '/saved-models'

const PretrainedModelsRedirectRoute = lazyWithPreload(() =>
  import('./pages/RedirectRoutes').then(m => ({ default: m.PretrainedModelsRedirectRoute })),
)
const SavedModelsRedirectRoute = lazyWithPreload(() =>
  import('./pages/RedirectRoutes').then(m => ({ default: m.SavedModelsRedirectRoute })),
)
const ModelsPage = lazyWithPreload(() =>
  import('./pages/ModelsPage').then(m => ({ default: m.ModelsPage })),
)
const ChooseModelsPage = lazyWithPreload(() =>
  import('./pages/ChooseModelsPage').then(m => ({ default: m.ChooseModelsPage })),
)

/**
 * txrmodels — the model screens of TxResBench: the merged model step
 * (choose-models, the ONE list of the predict path — rounds 2/3) and screen
 * J (Your models — the inventory table, `Models.dc.html`), plus the save
 * dialogs L / L2 / L3 (`SaveModels/SaveOne/SaveDone.dc.html`) that run over
 * the results screen. The old D/I pages are gone (round 3); their addresses
 * REDIRECT to the merged list (round 2's `RedirectRoute`, the source preset
 * pinned in the query).
 *
 * Route handoff: this module owns `/models` (screen J) — the `txrshell`
 * scaffold route for it is removed on the same branch (the `/` handoff is
 * `txrintake`'s, same file, different block).
 *
 * The dialog host is THE seam (PROV-UI-MODELS-2): one effect component
 * mounted via `Slots.routerEffects` inside the router context
 * (the `command-palette` precedent), which subscribes to the EventBus events
 * `txr:save-models-requested` (from `txrresults`' "Save the models" button)
 * and `txr:save-one-model-requested` and renders exactly one of the three
 * dialogs. Nothing
 * outside this module opens them and this module never reaches into
 * `txrresults`' store.
 *
 * The model store is WHOLE-STORE-LAZY (`registerLazyStore` in its own file,
 * the `datasets`/`txrresults` precedent) — no eager module.tsx -> store
 * import, so `stores` stays empty.
 */
export default createModule({
  metadata: {
    name: 'txrmodels',
    version: '1.0.0',
    description:
      'TxResBench models — the merged model step (choose-models), the D/I redirects, the Your-models inventory (J), and the save dialogs (L/L2/L3)',
  },
  dependencies: ['router', 'txrshell', 'txrintake', 'txrlist', 'txrrun', 'txrresults'],
  stores: [],
  slots: {
    routerEffects: [
      {
        id: 'txr-models-dialog-host',
        component: TxrModelsDialogHost,
      },
    ],
  },
  routes: [
    {
      path: OLD_PRETRAINED_MODELS_ROUTE,
      element: PretrainedModelsRedirectRoute,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: OLD_SAVED_MODELS_ROUTE,
      element: SavedModelsRedirectRoute,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: FLOW_ROUTES.chooseModels,
      element: ChooseModelsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/models',
      element: ModelsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
