import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { requestModelFilePicker } from '@/modules/txrmodels/lib/modelFilePicker'
import { useDemoModeStore } from '@/modules/demo/DemoMode.store'
import { DEMO_DISABLED_REASON } from '@/modules/demo/copy'

// `models.openModelFile` — the Start page's "Open a model file" (predict-card
// merge round 1) and the Models page's import affordance, as ONE registered,
// permissioned action the command palette and the AI agent drive.
//
// The import itself (`POST /api/txr/models/import`) needs a browser file
// picker, and a picker can only open from the human's OWN gesture — so the
// action has two sides:
//
// - A mounted picker host (every `useModelFileImport` mount — the Start
//   card, the Models page) answers `requestModelFilePicker()` when a user
//   activation is active: the `.txr` picker opens IN PLACE, and the host's
//   import runs the POST + the two error lines and lands on the Models page
//   (success from the Start card; refresh in place from the Models page).
// - No host / no gesture (the agent's path): the action navigates to the
//   Models page and returns the one line telling the caller to choose the
//   file there.
//
// Demo mode refuses (the server blocks `models/import` — the import
// affordance is absent on the Models page there too) with the demo's
// standard refusal line.
//
// `permission`: the /models route carries no route permission, so this uses
// the permission the registered navigation action (`app.navigate`,
// `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrmodels/module.tsx` (the module
// that owns the Models page).

const MODELS_ROUTE = '/models'

defineAction({
  id: 'models.openModelFile',
  title: 'Open a model file',
  permission: Permissions.McpUse,
  mutating: true,
  group: 'Models',
  description:
    'Open a saved model container (.txr file): on the Start page the picker opens in place and the imported model lands on the Models page; with no open picker (the agent path) it opens the Models page instead, where "Open a model file" is the same affordance. Refused in demo mode.',
  aliases: ['open a model file', 'open model file', 'import a model file', 'use a model file'],
  keywords: ['import', 'model file', '.txr'],
  params: z.object({}),
  run: (_params, ctx) => {
    if (useDemoModeStore.getState().mode === 'demo') {
      throw new Error(DEMO_DISABLED_REASON)
    }
    // A mounted picker host answers (the human gesture's click is still on
    // the stack, so the picker opens); otherwise the agent path: navigate
    // to the Models page and say where to choose.
    if (requestModelFilePicker()) {
      return { status: 'picker' }
    }
    ctx.navigate(MODELS_ROUTE)
    return { status: 'navigated', text: 'Choose the model file on the Models page.' }
  },
})
