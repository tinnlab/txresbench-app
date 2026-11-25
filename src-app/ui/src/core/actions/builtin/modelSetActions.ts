import { z } from 'zod'
import { ApiClient } from '@/api-client'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import {
  deleteSetById,
  notifyModelSetsChanged,
  renameSetById,
  requestDeleteSet,
} from '@/modules/txrmodels/lib/setActions'
import { downloadSetExport, SET_EXPORT_FAILED_LINE } from '@/modules/txrmodels/lib/export'

// The model-set actions of the "Your models" page (screen J) — the
// registered, permissioned wrappers the command palette and the AI agent
// drive, so a human affordance and the AI share ONE path:
//
// - `models.renameSet` — renames through the SAME `renameSetById` the
//   `TxrRenameSetDialog` confirm calls, then publishes the refresh bus
//   (`notifyModelSetsChanged`) so the Models page's inventory/sets hooks
//   re-read (the AI path has no dialog `onSaved`).
// - `models.exportSet` — runs the SAME `downloadSetExport` the Export set
//   button uses (the button itself invokes this action; the human and the
//   AI take the same download path).
// - `models.deleteSet` — does NOT delete. It only OPENS the delete confirm
//   dialog for that set through the pending-request channel
//   (`requestDeleteSet` — the module-level listener the host subscribes
//   to); the person confirms in `TxrDeleteSetDialog`, whose confirm is the
//   one caller of `deleteSetById` (`keep_files: false`, DEC-14 — the same
//   on the wire for every caller). An AI can never delete a set without a
//   person confirming in the dialog. The channel answers whether the
//   request was HANDLED (a host actually opened the dialog): when no host
//   could (nothing mounted, or the set unknown / no data yet), the action
//   REJECTS — never a success report for a dialog nobody showed.
//
// `permission`: the /models route carries no route permission, so this uses
// the permission the registered navigation action (`app.navigate`,
// `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrmodels/module.tsx` (the module
// that owns the model screens).

defineAction({
  id: 'models.renameSet',
  title: 'Rename a model set',
  permission: Permissions.McpUse,
  mutating: true,
  group: 'Models',
  description:
    'Rename a set of saved models (by its id, the name the "Your models" page shows for the set). The set and its model rows keep every other fact; the new name is shown everywhere the set is named.',
  aliases: ['rename the set', 'rename this set', 'rename the model set'],
  keywords: ['set', 'rename'],
  params: z.object({
    setId: z.string().min(1).describe('The set id (from the model sets list).'),
    name: z.string().min(1).describe('The new set name.'),
  }),
  run: async ({ setId, name }) => {
    await renameSetById(setId, name)
    // The AI path has no dialog onSaved: the refresh bus re-reads the
    // mounted host (the Models page's inventory/sets hooks).
    notifyModelSetsChanged()
    return { setId, name }
  },
})

defineAction({
  id: 'models.exportSet',
  title: 'Export a model set',
  permission: Permissions.McpUse,
  mutating: false,
  group: 'Models',
  description:
    'Download a set of saved models (by its id) as the .txr set file: the browser download on the website, the Save dialog in the desktop app. Refused when the set is not in the current model sets list.',
  aliases: ['export the set', 'export this set', 'download the set'],
  keywords: ['set', 'export'],
  params: z.object({
    setId: z.string().min(1).describe('The set id (from the model sets list).'),
  }),
  run: async ({ setId }) => {
    // The file name is `<sanitised set name>.txr`, so the action resolves
    // the set's current name from the provider first (the engine is the
    // truth; a set deleted meanwhile is refused, never a file under a
    // stale name).
    const sets = await ApiClient.ModelSets.listSets()
    const set = sets.sets.find(candidate => candidate.id === setId)
    if (set === undefined) throw new Error(SET_EXPORT_FAILED_LINE)
    const result = await downloadSetExport(set)
    return { status: result.status, ...(result.status === 'saved' ? { path: result.path } : {}) }
  },
})

defineAction({
  id: 'models.deleteSet',
  title: 'Delete a model set',
  permission: Permissions.McpUse,
  mutating: true,
  // Destructive intent (the set and its model files go): the command
  // palette interposes its own confirmation before invoking this, on top
  // of the app's delete confirm dialog the action opens — the flag is
  // advisory for the AI path, the backend permission model is the real
  // boundary (defineAction.ts's `dangerous` contract).
  dangerous: true,
  group: 'Models',
  description:
    'Open the delete confirmation for a set of saved models (by its id). The set is NOT deleted by this action: the confirmation dialog opens and the person confirms there (the files go with the models, the results already made are kept).',
  aliases: ['delete the set', 'delete this set', 'remove the model set'],
  keywords: ['set', 'delete'],
  params: z.object({
    setId: z.string().min(1).describe('The set id (from the model sets list).'),
  }),
  run: ({ setId }) => {
    // The channel answers whether any mounted host OPENED the dialog for
    // this set. Nothing opened (no host mounted, or the set is unknown to
    // it) means the action must NOT report a confirmation that nobody
    // showed — it rejects with the one line instead (it never deletes).
    if (!requestDeleteSet(setId)) {
      throw new Error(
        'The delete confirmation could not be opened: open the Models page first.',
      )
    }
    return { setId, status: 'confirming' }
  },
})
