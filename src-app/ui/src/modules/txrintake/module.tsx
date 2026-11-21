import { createModule } from '@txresbench/framework'
import { TxrLayoutDef } from '@/modules/txrshell/module'
import { FLOW_ROUTES } from '@/modules/txrshell/lib/flowSteps'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
// Side-effect import: registers the step-flow actions (`flow.back`,
// `models.switchList`, `flow.startPath`, `models.useModel`,
// `history.useSettingsAgain`: the step views' Back button, the model-list
// switch and the entries that start a path), so each is drivable by the
// palette and the AI, not only a button.
import '@/core/actions/builtin/stepActions'
// Side-effect import: registers the day choices' actions (`flow.setLastDrawDay`
// on the questions step, `runSettings.setDay` on step 4's settings).
import '@/core/actions/builtin/dayActions'

/**
 * txrintake — the intake flow of TxResBench: screen A (Start), B (Your
 * study), C (Your files) and N (Add the patients to predict), the four
 * screens a clinician walks before the method/model choice screens (E, D, I)
 * that `ui-run` and `ui-models` build.
 *
 * Route handoff: this module owns `/` (screen A) — the `txrshell` scaffold
 * route for `/` is removed so the app opens on the real Start screen. Same
 * handoff class: `/help` belongs to the `txrhelp` module (the content page
 * the shell scaffold used to render) — the validation problems list of this
 * module links each problem to its Help entry through that module's route
 * builder (see `components/TxrProblemList.tsx`), so `txrhelp` is a
 * dependency here.
 *
 * Route conventions DECLARED here for the sibling choice screens (the
 * ownership stays with their modules; RECONCILE confirms the bindings with
 * `ui-run` and `ui-models`): E = `/choose-methods`, D = `/pretrained-models`,
 * I = `/saved-models` — see ROUTE_CONVENTIONS. Every route is read from the
 * one list of steps (`txrshell/lib/flowSteps.ts`).
 */
export const ROUTE_CONVENTIONS = {
  /** Screen E — choose methods and settings (`ui-run`). */
  methods: FLOW_ROUTES.methods,
  /** Screen D — choose pretrained models (`ui-models`). */
  pretrainedModels: FLOW_ROUTES.pretrainedModels,
  /** Screen I — choose saved models (`ui-models`). */
  savedModels: FLOW_ROUTES.savedModels,
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
  dependencies: ['router', 'txrhelp'],
  routes: [
    {
      path: FLOW_ROUTES.start,
      element: StartPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: FLOW_ROUTES.study,
      element: StudyPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: FLOW_ROUTES.files,
      element: FilesPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: FLOW_ROUTES.predictFiles,
      element: PredictFilesPage,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
