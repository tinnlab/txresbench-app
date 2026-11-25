import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { currentPathViaBridge } from '../navigateBridge'
import { getActiveEntity } from '../activeContext'
import { TxrIntake } from '@/modules/txrintake/stores/TxrIntake.store'
import { runExampleFlow } from '@/modules/txrintake/lib/example'
import type { IntakeIntent, PredictModelSource } from '@/modules/txrintake/types'
import { FLOW_ROUTES, stepOfUrl } from '@/modules/txrshell/lib/flowSteps'
import {
  beginPath,
  assertCanLeaveStep,
  HELP_BACK_NO_STEP,
  helpReturnTarget,
  isStepUrl,
  replaceCurrentStep,
  STEP_BACK_DIALOG_OPEN,
  STEP_BACK_LEAVING,
  takeStepBack,
  TXR_HELP_FROM_STEP_CONTEXT,
  TXR_MODEL_STEP_CONTEXT,
  TXR_STEP_CONTEXT,
  useStepTrailStore,
} from '@/modules/txrintake/lib/stepTrail'

// The step-flow actions of a new analysis: the Back button of each step view,
// the switch between the published and the saved model lists on the model
// step, Help's "Back to step N" (Help opened from a step view), and the
// entries that start a path (the Start and Help cards, Your models "Use",
// History "Use these settings again", the saved-models dialog).
// Registered once so the buttons, the command palette and the AI take the
// same path. The models and history stores are loaded on use (they are not
// part of the start-up code).
//
// `permission`: the step routes carry no route permission
// (`modules/txrintake/module.tsx`), so these use the permission the
// registered navigation action (`app.navigate`, `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrintake/module.tsx`.

// The routes come from the one list of steps (`txrshell/lib/flowSteps.ts`).

/** The first step of each path (Start's card picker: learn → the files step, the predict paths → N). */
const FILES_ROUTE = FLOW_ROUTES.files
const PREDICT_FILES_ROUTE = FLOW_ROUTES.predictFiles

/** The learn path's last step (History "Use these settings again" opens it). */
const CHOOSE_METHODS_ROUTE = FLOW_ROUTES.methods

/** Where every path starts (the Start screen, step 1 of each path). */
const START_ROUTE = FLOW_ROUTES.start

/**
 * A new path may start now: nothing on a step view holds it (a run being
 * created, an open dialog, a Back already leaving the step).
 */
function assertCanStartPath(): void {
  const { current, leaving } = useStepTrailStore.getState()
  if (current === null) return
  if (leaving) throw new Error(STEP_BACK_LEAVING)
  if (current.blockedReason !== null) throw new Error(current.blockedReason)
  if (current.dialogOpen) throw new Error(STEP_BACK_DIALOG_OPEN)
}

/**
 * Begin a new step trail where the path is started from: the page the user is
 * on (Help, Your models, History, a results page), or Start when that page is
 * itself a step view (a new path replaces the one on screen).
 */
function beginPathHere(): void {
  const here = currentPathViaBridge()
  beginPath(isStepUrl(here) ? START_ROUTE : here)
}

defineAction({
  id: 'flow.back',
  title: 'Go back to the previous step',
  permission: Permissions.McpUse,
  mutating: true,
  context: TXR_STEP_CONTEXT,
  aliases: ['back', 'previous step'],
  description:
    'On a step of a new analysis, go back to the step this path showed before, or to where the path started. Refused while a run is starting or a dialog is open.',
  params: z.object({}),
  run: (_params, ctx) => {
    const path = takeStepBack()
    ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'help.backToStep',
  title: 'Go back from Help to the step it was opened from',
  permission: Permissions.McpUse,
  mutating: true,
  context: TXR_HELP_FROM_STEP_CONTEXT,
  aliases: ['back to step', 'back to my step'],
  description:
    'On Help opened from a step of a new analysis (a problem code link on the file step, for example), go back to that step. The step keeps what was entered there. Offered only then.',
  params: z.object({}),
  run: (_params, ctx) => {
    const path = helpReturnTarget(getActiveEntity(TXR_HELP_FROM_STEP_CONTEXT))
    if (path === null) throw new Error(HELP_BACK_NO_STEP)
    ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'models.switchList',
  title: 'Switch between the ready-made models and your saved models',
  permission: Permissions.McpUse,
  mutating: true,
  context: TXR_MODEL_STEP_CONTEXT,
  aliases: ['use my saved models', 'use the ready-made models', 'use the published models'],
  description:
    'On the model step of a new analysis, show the other model kind of the one merged list: "saved" turns the Saved and Imported chips on, "published" turns the From the lab chip on. Everything else (the searched file, the selection) stays; the old two-list switch is this alias\'s mapping.',
  params: z.object({
    list: z
      .enum(['saved', 'published'])
      .describe('"saved" for your saved models, "published" for the ready-made models.'),
  }),
  run: async ({ list }, ctx) => {
    const onScreen = useStepTrailStore.getState().current
    if (
      onScreen === null ||
      (onScreen.step !== 'pretrained-models' &&
        onScreen.step !== 'saved-models' &&
        onScreen.step !== 'choose-models')
    ) {
      throw new Error('Open the model step of a new analysis first.')
    }
    assertCanLeaveStep()
    const { useTxrModelsStore } = await import('@/modules/txrmodels/stores/TxrModels.store')
    // The ONE merged list's source chips (the round-2 alias mapping: the
    // old list switch becomes the chip preset; nothing moves between
    // steps — the merged list IS the model step).
    useTxrModelsStore.getState().setListFilters({
      sources: list === 'saved' ? ['saved', 'imported'] : ['lab'],
    })
    TxrIntake.setIntent('predict', list === 'saved' ? 'saved' : 'lab')
    const path = FLOW_ROUTES.chooseModels
    // From an old model step (the D/I pages still in the tree this round)
    // the merged list TAKES ITS PLACE in the trail, so Back from it goes
    // to the file step. From the merged list itself (its chips preset only)
    // the trail is the model step already and must keep the current step's
    // leaving flag untouched — a same-URL navigate would otherwise leave
    // `leaving` stuck and Block the Back button.
    if (onScreen.step !== 'choose-models') replaceCurrentStep(path)
    ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'flow.startPath',
  title: 'Start a new analysis',
  permission: Permissions.McpUse,
  mutating: true,
  aliases: ['learn from my data', 'predict new patients', 'predict with a ready-made model', 'predict with a pretrained model', 'use a model I saved'],
  description:
    'Pick one of the two ways of the Start screen: "train" learns from your own patients, "predict" predicts new patients with a ready-made model, a saved model or an opened model file. The old two-list spellings stay accepted: "pretrained" (a ready-made model from the lab) and "reuse" (a model you saved) both start the predict way with that list pinned. Opens the first step of that way, its file step (the learn way asks its questions after the files); files already added are kept. Back from that step returns to the page it was started from. Refused while a run is starting or a dialog is open.',
  params: z.object({
    intent: z
      .enum(['predict', 'train', 'pretrained', 'reuse'])
      .describe('"predict" (any model), "train" (learn from my data), or the old list spellings "pretrained" (a ready-made model) / "reuse" (a saved model).'),
    startAtFiles: z
      .boolean()
      .optional()
      .describe('Open the file step directly (every path already starts with its file step; kept for older callers).'),
  }),
  run: ({ intent, startAtFiles }, ctx) => {
    assertCanStartPath()
    // The old two-list intents become the ONE predict intent plus the source
    // preset they pinned (`lab` / `saved`); `predict` pins no source (round
    // 1's bridge then continues to the saved-models list — round 2 replaces
    // it with /choose-models).
    const pathIntent: IntakeIntent = intent === 'train' ? 'train' : 'predict'
    const source: PredictModelSource | null =
      intent === 'pretrained' ? 'lab' : intent === 'reuse' ? 'saved' : null
    TxrIntake.setIntent(pathIntent, source)
    beginPathHere()
    // Every path starts with its file step (the learn path's study questions
    // come after the files); `startAtFiles` changes nothing any more.
    void startAtFiles
    const path = pathIntent !== 'train' ? PREDICT_FILES_ROUTE : FILES_ROUTE
    ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'flow.useExample',
  title: 'Use the example data in a flow',
  permission: Permissions.McpUse,
  mutating: true,
  aliases: ['use example', 'use the example data', 'try the example data'],
  description:
    'The one-click example path of the Start cards (and Help\'s try-it cards): "predict" adopts the example patients-to-predict table, ensures the "Example models" set (usually under a minute; the first time also downloads the methods) and opens the predict path\'s file step with that set ticked once it checks out; "train" fills the learn path\'s study answers and both example files and opens its file step. Back from the step returns to the page it was started from. Refused while a run is starting or a dialog is open.',
  params: z.object({
    intent: z
      .enum(['predict', 'train'])
      .describe('"predict" (the example patients to predict + the example models) or "train" (learn from my data).'),
  }),
  run: async ({ intent }, ctx) => {
    assertCanStartPath()
    // Round-1 audit item 3: when the person is ALREADY on the step this
    // leads to (the file step's own "Use example"), beginning the path here
    // would reset the step trail (Help → files → Back would go to Start
    // instead of Help). Only begin the path and navigate when the person is
    // not already on that step.
    const path = intent === 'train' ? FILES_ROUTE : PREDICT_FILES_ROUTE
    const here = currentPathViaBridge()
    const alreadyThere = stepOfUrl(here) !== null && stepOfUrl(here) === (intent === 'train' ? 'files' : 'predict-files')
    if (!alreadyThere) beginPathHere()
    await runExampleFlow(intent, {
      // The UI host (the button) streams the set-training state through the
      // progress channel; the agent sees the same as a progress note.
      onSetProgress: response => ctx.progress('Preparing the example models', response),
      cancelled: () => ctx.signal?.aborted ?? false,
    })
    if (!alreadyThere) ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'models.useModel',
  title: 'Predict new patients with a saved model',
  permission: Permissions.McpUse,
  mutating: true,
  aliases: ['use this model'],
  description:
    'Your models "Use": start the predict path for one saved model (by its id). Opens the step to add the patients to predict; the model is ticked on the merged model list once the file checks out. Back from that step returns to the page it was started from.',
  params: z.object({
    modelId: z.string().min(1).describe('The saved model id (from Your models).'),
    name: z.string().optional().describe('The model name the step shows.'),
  }),
  run: async ({ modelId, name }, ctx) => {
    assertCanStartPath()
    const { useTxrModelsStore } = await import('@/modules/txrmodels/stores/TxrModels.store')
    TxrIntake.setIntent('predict', 'saved')
    useTxrModelsStore.getState().setPendingUse(modelId)
    beginPathHere()
    const path =
      `${PREDICT_FILES_ROUTE}?use=${encodeURIComponent(modelId)}` +
      (name === undefined ? '' : `&name=${encodeURIComponent(name)}`)
    ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'history.useSettingsAgain',
  title: 'Use the settings of a past analysis again',
  permission: Permissions.McpUse,
  mutating: true,
  aliases: ['use these settings again'],
  description:
    'History "Use these settings again": copy the settings of a past analysis (by its run id) into the method choice and open it. The files of that analysis are not reused. Back from the method choice returns to the page it was started from.',
  params: z.object({
    runId: z.string().min(1).describe('The run id of the past analysis (from History).'),
  }),
  run: async ({ runId }, ctx) => {
    assertCanStartPath()
    const [{ TxrHistory, useTxrHistory }, { ApiClient }] = await Promise.all([
      import('@/modules/txrhistory/stores/TxrHistory.store'),
      import('@/api-client'),
    ])
    const shown = useTxrHistory.getState().detail
    const run =
      shown !== null && shown.id === runId
        ? shown
        : await ApiClient.History.getHistory({ id: runId })
    await TxrHistory.useSettingsAgain(run)
    beginPathHere()
    ctx.navigate(CHOOSE_METHODS_ROUTE)
    return { path: CHOOSE_METHODS_ROUTE }
  },
})
