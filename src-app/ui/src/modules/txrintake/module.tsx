import { createModule } from '@ziee/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { lazyWithPreload } from '@/utils/lazyWithPreload'

/**
 * txrintake — the intake flow of TxResBench: screen A (Start), B (Your
 * study), C (Your files) and N (Add the patients to predict), the four
 * screens a clinician walks before the method/model choice screens (E, D, I)
 * that `ui-run` and `ui-models` build.
 *
 * Route handoff: this module owns `/` (screen A) — the `txrshell` scaffold
 * route for `/` is removed so the app opens on the real Start screen; the
 * shell keeps `/models`, `/history`, `/help` (see `txrshell/module.tsx`).
 *
 * Route conventions DECLARED here for the sibling choice screens (the
 * ownership stays with their modules; RECONCILE confirms the bindings with
 * `ui-run` and `ui-models`): E = `/choose-methods`, D = `/pretrained-models`,
 * I = `/saved-models` — see ROUTE_CONVENTIONS.
 */
export const ROUTE_CONVENTIONS = {
  /** Screen E — choose methods and settings (`ui-run`). */
  methods: '/choose-methods',
  /** Screen D — choose pretrained models (`ui-models`). */
  pretrainedModels: '/pretrained-models',
  /** Screen I — choose saved models (`ui-models`). */
  savedModels: '/saved-models',
} as const

const StartPage = lazyWithPreload(() =>
  import('./pages/StartPage').then(m => ({ default: m.StartPage })),
)
const StudyPage = lazyWithPreload(() =>
  import('./pages/StudyPage').then(m => ({ default: m.StudyPage })),
)
const FilesPage = lazyWithPreload(() =>
  import('./pages/FilesPage').then(m => ({ default: m.FilesPage })),
)
const PredictFilesPage = lazyWithPreload(() =>
  import('./pages/PredictFilesPage').then(m => ({ default: m.PredictFilesPage })),
)

export default createModule({
  metadata: {
    name: 'txrintake',
    version: '1.0.0',
    description:
      'TxResBench intake — Start (A), Your study (B), Your files (C), Add the patients to predict (N).',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/',
      element: StartPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/study',
      element: StudyPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/files',
      element: FilesPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/predict-files',
      element: PredictFilesPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
