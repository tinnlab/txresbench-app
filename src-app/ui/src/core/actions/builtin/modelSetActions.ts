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

// The model-set actions of the "Your models" page (screen J) AND the
// saved-models page's set actions (Card 3) — the registered, permissioned
// wrappers the command palette and the AI agent drive, so a human affordance
// and the AI share ONE path:
//
// - `models.renameSet` — renames through the SAME `renameSetById` the
//   `TxrRenameSetDialog` confirm calls, then publishes the refresh bus
//   (`notifyModelSetsChanged`) so the Models page's inventory/sets hooks and
//   the saved-models store re-read (the AI path has no dialog `onSaved`).
// - `models.exportSet` — runs the SAME `downloadSetExport` the Export set
//   button uses (the button itself invokes this action; the human and the
//   AI take the same download path).
// - `models.deleteSet` — does NOT delete. It only OPENS the delete confirm
//   dialog for that set through the pending-request channel
//   (`requestDeleteSet` — the module-level listener both hosts subscribe
//   to); the person confirms in `TxrDeleteSetDialog`, whose confirm is the
//   one caller of `deleteSetById` (`keep_files: false`, DEC-14 — the same
//   on the wire for every caller). An AI can never delete a set without a
//   person confirming in the dialog.
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
    // mounted hosts (the Models page hooks + the saved-models store).
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
  group: 'Models',
  description:
    'Open the delete confirmation for a set of saved models (by its id). The set is NOT deleted by this action: the confirmation dialog opens and the person confirms there (the files go with the models, the results already made are kept).',
  aliases: ['delete the set', 'delete this set', 'remove the model set'],
  keywords: ['set', 'delete'],
  params: z.object({
    setId: z.string().min(1).describe('The set id (from the model sets list).'),
  }),
  run: ({ setId }) => {
    requestDeleteSet(setId)
    return { setId, status: 'confirming' }
  },
})
