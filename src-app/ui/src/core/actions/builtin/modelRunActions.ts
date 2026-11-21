import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { InstanceHandlerMissingError, InstanceNotFoundError } from '../instanceErrors'
import { MODELS_RUN, TXR_MODEL_LIST_CONTEXT } from '@/modules/txrmodels/lib/modelRun'

// The model-step Run as an INSTANCE action (data-pickup-bugs bug 3, UI
// half): the ready-made (D) and saved (I) model lists register ONE model-list
// instance per mounted page (`useModelListRun`, type `txr.model-list`), and
// the action's `run` resolves that instance and delegates to the SAME
// guarded handler the page's Run button calls (`startRun` — the human click
// and `invoke_capability` take one path), so the guard that refuses models
// trained at different decision days is the same for both (the engine's
// `MODEL_DECISION_DAY_MISMATCH` is the server half of the same rule).
//
// `stateful: true` (with `mutating: true`): the run's outcome depends on the
// CURRENT selection, so the engine's stale-state guard requires a valid
// `expected` state token (read via `view.describe`); the snapshot carries
// the selected model ids, so even a same-size selection change moves the
// token and a stale read is refused `STALE_STATE` — never silently applied
// against state the caller's last read didn't reflect. The handler re-checks
// the token for a caller that reaches it directly (the engine already
// enforced the guard before dispatching it).
//
// `surfaces.palette: false`: the palette cannot supply the state token an
// invoke requires (it auto-fills only `view_id`), and the Run button IS the
// human surface for this action — it stays AI-drivable through the MCP
// manifest (`collect-actions.mjs`), and a user can always reach the same
// guarded path from the button.
//
// `permission`: the model-step routes carry no route permission, so this
// uses the permission the registered navigation action (`app.navigate`,
// `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrmodels/module.tsx` (the module
// that owns the model steps).

defineAction({
  id: MODELS_RUN,
  title: 'Run the chosen models',
  permission: Permissions.McpUse,
  mutating: true,
  kind: 'instance',
  stateful: true,
  context: TXR_MODEL_LIST_CONTEXT,
  surfaces: { palette: false, ai: true },
  group: 'Analysis',
  description:
    'On the model step (the ready-made or the saved models list), start the run with the models that are checked. Refused when the chosen models were trained at different decision days (each model runs at its own day), when no model is chosen, and when a selected model cannot be run (a download still running or failed, on the ready-made list). Requires the current state token (view.describe).',
  aliases: ['run the models', 'run the chosen models', 'start the run'],
  keywords: ['models', 'run', 'state token'],
  params: z.object({
    view_id: z.string().describe('The model list (views.list, type txr.model-list).'),
    expected: z
      .string()
      .describe('The current state token of the model list (view.describe._state_token).'),
  }),
  run: ({ view_id, expected }, ctx) => {
    const list = ctx.instance(TXR_MODEL_LIST_CONTEXT, view_id)
    if (list === undefined) throw new InstanceNotFoundError(view_id)
    const handler = list.handlers[MODELS_RUN]
    if (handler === undefined) throw new InstanceHandlerMissingError(view_id, MODELS_RUN)
    return handler({ expected }, ctx)
  },
})
