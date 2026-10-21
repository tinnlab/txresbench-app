import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import type { ActionContext } from '../ctx'
import { runChoreography, type Step } from '../choreography'

// The dataset CHOREOGRAPHY vocabulary (richer-actions ITEM-11/12/13) — the reference
// vertical for visible, human/AI-parity actions:
//   • dataset.add       (human, ⌘K + workbench palette) — open the datasets panel,
//                        reveal the attach picker, and YIELD (the user picks). Soft.
//   • dataset.add.byId  (AI-only, hidden from the palette) — the SAME visible
//                        sequence run to completion for a given dataset id. Narrated.
//   • dataset.list      (AI-only read) — the id-resolution read the AI uses before
//                        dataset.add.byId (every AI compound gets a paired read).
// All three are `context:'workbench'` instance actions (view_id = the workbench).
// The choreography opens the pane via the workbench instance's `workbench.openDatasets`
// handler, then drives the DATASETS instance's private affordance handlers
// (revealPicker / selectDataset / attach / listCandidates), spotlighting each — the
// SAME handlers the human's picker + Attach button call. Side-effect import registers
// them (see `modules/actions/module.tsx`). No new permission: `projects::use` (the
// existing datasets-attach gate).

const WORKBENCH_STORE_KEY = 'workbench'
const DATASETS_STORE_KEY = 'datasets'

/** Shared prefix (DEC-1): open the datasets pane + reveal the attach picker. The
 *  spotlight names are feature-namespaced to match the affordances DatasetsPanel
 *  registers (`datasets:picker` / `datasets:attach-button`). */
const ADD_PREFIX: Step[] = [
  { op: 'openPane', kind: 'datasets' },
  { handler: 'revealPicker', spotlight: 'datasets:picker', caption: 'Opening the dataset picker…' },
]
/** Human: stage the picker and hand back (DEC-7 yield). */
const DATASET_ADD_STEPS: Step[] = [...ADD_PREFIX, { op: 'yield' }]
/** AI: the same prefix, then pick the dataset + press Attach (run to completion).
 *  The handler reads `params.dataset_id` (the whole params object is passed). */
const DATASET_ADD_BYID_STEPS: Step[] = [
  ...ADD_PREFIX,
  { handler: 'selectDataset', spotlight: 'datasets:picker', caption: 'Choosing the dataset…' },
  { handler: 'attach', spotlight: 'datasets:attach-button', caption: 'Attaching the dataset…' },
]

/** Open a workbench pane by delegating to the live workbench instance's
 *  `workbench.open<Kind>` handler (the region-aware open the human affordance
 *  drives) — keeps this core module free of a workbench-store import. */
function openPaneVia(ctx: ActionContext, params: Record<string, unknown>) {
  return (kind: string) => {
    const wb = ctx.instance(WORKBENCH_STORE_KEY, String(params.view_id ?? ''))
    const handlerId = `workbench.open${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
    return wb?.handlers[handlerId]?.(params, ctx)
  }
}

// ── dataset.add — human, palette-visible. Soft (un-narrated) choreography.
defineAction({
  id: 'dataset.add',
  title: 'Add dataset',
  group: 'Datasets',
  aliases: ['attach dataset', 'import data', 'link dataset', 'add data'],
  description: 'Open the datasets panel and pick a dataset to link to this project.',
  kind: 'instance',
  context: WORKBENCH_STORE_KEY,
  mutating: true,
  permission: Permissions.ProjectsUse,
  params: z.object({ view_id: z.string() }),
  run: (params, ctx) =>
    runChoreography(DATASET_ADD_STEPS, params as Record<string, unknown>, ctx, {
      instanceType: DATASETS_STORE_KEY,
      narrate: false,
      openPane: openPaneVia(ctx, params as Record<string, unknown>),
    }),
})

// ── dataset.add.byId — AI-only (hidden from ⌘K). Fully narrated, runs to completion.
defineAction({
  id: 'dataset.add.byId',
  title: 'Add dataset by id',
  group: 'Datasets',
  aliases: ['attach dataset by id', 'link dataset by id'],
  description: 'Link a specific dataset to this project by id, visibly driving the datasets panel (pick + attach).',
  kind: 'instance',
  context: WORKBENCH_STORE_KEY,
  mutating: true,
  permission: Permissions.ProjectsUse,
  surfaces: { palette: false },
  params: z.object({ view_id: z.string(), dataset_id: z.string() }),
  run: (params, ctx) =>
    runChoreography(DATASET_ADD_BYID_STEPS, params as Record<string, unknown>, ctx, {
      instanceType: DATASETS_STORE_KEY,
      narrate: true,
      openPane: openPaneVia(ctx, params as Record<string, unknown>),
    }),
})

// ── dataset.list — AI-only read: the attach candidates the AI resolves a dataset_id
//    from (DEC-12). Delegates to the datasets instance's `listCandidates` handler.
defineAction({
  id: 'dataset.list',
  title: 'List datasets to link',
  group: 'Datasets',
  description: 'List the datasets available to link to this project (id + name), for choosing one to add.',
  kind: 'instance',
  context: WORKBENCH_STORE_KEY,
  mutating: false,
  permission: Permissions.ProjectsUse,
  surfaces: { palette: false },
  params: z.object({ view_id: z.string() }),
  run: (params, ctx) => {
    const inst = ctx.instances(DATASETS_STORE_KEY)[0]
    const handler = inst?.handlers['listCandidates']
    // Miss shape mirrors workbenchActions' `unavailable(actionId)` contract.
    return handler
      ? handler(params as Record<string, unknown>, ctx)
      : { ok: false, unavailable: true, error: 'dataset.list: datasets pane not available' }
  },
})
