import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { InstanceHandlerMissingError, InstanceNotFoundError } from '../instanceErrors'
import {
  MODELS_RUN,
  MODELS_SET_LIST_FILTERS,
  MODELS_SET_SELECTION,
  TXR_MODEL_LIST_CONTEXT,
} from '@/modules/txrmodels/lib/modelRun'

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
    'On the model step (the merged model list), start the run with the models that are checked. Refused when the chosen models were trained at different decision days (each model runs at its own day), when no model is chosen, and when a selected lab model cannot be run (a download still running or failed). Requires the current state token (view.describe).',
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

defineAction({
  id: MODELS_SET_SELECTION,
  title: 'Select models to run',
  permission: Permissions.McpUse,
  mutating: true,
  kind: 'instance',
  stateful: true,
  context: TXR_MODEL_LIST_CONTEXT,
  surfaces: { palette: false, ai: true },
  group: 'Analysis',
  description:
    'On the merged model list, set the checked models by their row ids (the same write the checkboxes and "Select all that can run" make). Rows the list shows as cannot run are never selectable. Requires the current state token (view.describe).',
  aliases: ['select models', 'check models', 'set the model selection'],
  keywords: ['models', 'selection', 'state token'],
  params: z.object({
    view_id: z.string().describe('The model list (views.list, type txr.model-list).'),
    expected: z
      .string()
      .describe('The current state token of the model list (view.describe._state_token).'),
    ids: z.array(z.string()).describe('The row ids to check (the selection replaces the current one).'),
  }),
  run: ({ view_id, expected, ids }, ctx) => {
    const list = ctx.instance(TXR_MODEL_LIST_CONTEXT, view_id)
    if (list === undefined) throw new InstanceNotFoundError(view_id)
    const handler = list.handlers[MODELS_SET_SELECTION]
    if (handler === undefined) {
      throw new InstanceHandlerMissingError(view_id, MODELS_SET_SELECTION)
    }
    return handler({ expected, ids }, ctx)
  },
})

defineAction({
  id: MODELS_SET_LIST_FILTERS,
  title: 'Filter and sort the model list',
  permission: Permissions.McpUse,
  mutating: true,
  kind: 'instance',
  stateful: true,
  context: TXR_MODEL_LIST_CONTEXT,
  surfaces: { palette: false, ai: true },
  group: 'Analysis',
  description:
    'On the merged model list, set the view: the source chips (From the lab / Saved / Imported), "Can run only", the host chips (Same outcome as my file, Published rules, Learned by the benchmark, Checked on 2 or more other cohorts), the search text over the run name and the sort. Each omitted field keeps the current value; "all" is cleared by passing empty sources, no chips and canRunOnly false. Requires the current state token (view.describe).',
  aliases: ['filter the models', 'sort the models', 'set the model filters'],
  keywords: ['models', 'filters', 'sort', 'state token'],
  params: z.object({
    view_id: z.string().describe('The model list (views.list, type txr.model-list).'),
    expected: z
      .string()
      .describe('The current state token of the model list (view.describe._state_token).'),
    sources: z
      .array(z.enum(['lab', 'saved', 'imported']))
      .optional()
      .describe('The source chips to show ("lab", "saved", "imported"; several on = any of them).'),
    canRunOnly: z.boolean().optional().describe('Show only the models that can run on the file.'),
    chips: z
      .array(
        z.enum([
          'same-outcome',
          'published',
          'learned',
          'checked-2-plus',
        ]),
      )
      .optional()
      .describe('The other host chips to show.'),
    search: z.string().optional().describe('Text to find over the run name and the model facts.'),
    sort: z
      .enum(['transfer', 'newest-run', 'patients', 'time'])
      .optional()
      .describe('The sort: "transfer", "newest-run", "patients" or "time".'),
  }),
  run: ({ view_id, expected, sources, canRunOnly, chips, search, sort }, ctx) => {
    const list = ctx.instance(TXR_MODEL_LIST_CONTEXT, view_id)
    if (list === undefined) throw new InstanceNotFoundError(view_id)
    const handler = list.handlers[MODELS_SET_LIST_FILTERS]
    if (handler === undefined) {
      throw new InstanceHandlerMissingError(view_id, MODELS_SET_LIST_FILTERS)
    }
    return handler(
      { expected, sources, canRunOnly, chips, search, sort },
      ctx,
    )
  },
})
