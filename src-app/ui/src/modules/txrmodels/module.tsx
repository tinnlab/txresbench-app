import { createModule } from '@ziee/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import { TxrModelsDialogHost } from './components/TxrModelsDialogHost'

const PretrainedModelsPage = lazyWithPreload(() =>
  import('./pages/PretrainedModelsPage').then(m => ({ default: m.PretrainedModelsPage })),
)
const SavedModelsPage = lazyWithPreload(() =>
  import('./pages/SavedModelsPage').then(m => ({ default: m.SavedModelsPage })),
)
const ModelsPage = lazyWithPreload(() =>
  import('./pages/ModelsPage').then(m => ({ default: m.ModelsPage })),
)

/**
 * txrmodels — the model screens of TxResBench: screen D (choose pretrained
 * models, `Pretrained.dc.html`), screen I (choose saved models, grouped by
 * the training run, `Saved.dc.html`) and screen J (Your models — the
 * inventory table, `Models.dc.html`), plus the save dialogs L / L2 / L3
 * (`SaveModels/SaveOne/SaveDone.dc.html`) that run over the results screen.
 *
 * Route handoff: this module owns `/models` (screen J) — the `txrshell`
 * scaffold route for it is removed on the same branch (the `/` handoff is
 * `txrintake`'s, same file, different block). The D and I routes are the
 * conventions `txrintake` already declared (`ROUTE_CONVENTIONS`); the path
 * builders live in `routes.ts`.
 *
 * The dialog host is THE seam (PROV-UI-MODELS-2): one render-nothing effect
 * component mounted via `Slots.routerEffects` inside the router context
 * (the `command-palette` precedent), which subscribes to the EventBus events
 * `txr:save-models-requested` (from `txrresults`' "Save the models" button)
 * and `txr:save-one-model-requested` and renders the three dialogs. Nothing
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
      'TxResBench models — choose pretrained (D) and saved (I) models to run, the Your-models inventory (J), and the save dialogs (L/L2/L3)',
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
      path: '/pretrained-models',
      element: PretrainedModelsPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/saved-models',
      element: SavedModelsPage,
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
