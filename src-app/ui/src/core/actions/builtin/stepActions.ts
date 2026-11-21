import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { currentPathViaBridge } from '../navigateBridge'
import { getActiveEntity } from '../activeContext'
import { TxrIntake } from '@/modules/txrintake/stores/TxrIntake.store'
import { FLOW_ROUTES } from '@/modules/txrshell/lib/flowSteps'
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

/** The model step routes (the D and I screens). */
const PUBLISHED_MODELS_ROUTE = FLOW_ROUTES.pretrainedModels
const SAVED_MODELS_ROUTE = FLOW_ROUTES.savedModels

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
    'On the model step of a new analysis, show the other model list for the same checked file: "saved" for your saved models, "published" for the ready-made models (already trained by the TxResBench team). The new list takes the place of the current one in the steps, so Back still goes to the file step.',
  params: z.object({
    list: z
      .enum(['saved', 'published'])
      .describe('"saved" for your saved models, "published" for the ready-made models.'),
  }),
  run: ({ list }, ctx) => {
    const onScreen = useStepTrailStore.getState().current
    if (
      onScreen === null ||
      (onScreen.step !== 'pretrained-models' && onScreen.step !== 'saved-models')
    ) {
      throw new Error('Open the model step of a new analysis first.')
    }
    const current = assertCanLeaveStep()
    const path = list === 'saved' ? SAVED_MODELS_ROUTE : PUBLISHED_MODELS_ROUTE
    // Already on that list: nothing to switch.
    if ((current.step === 'saved-models') === (list === 'saved')) return { path }
    // The intent the Start cards set for the two lists; the checked file stays
    // (setIntent changes the intent and the mode only).
    TxrIntake.setIntent(list === 'saved' ? 'reuse' : 'pretrained')
    replaceCurrentStep(path)
    ctx.navigate(path)
    return { path }
  },
})

defineAction({
  id: 'flow.startPath',
  title: 'Start a new analysis',
  permission: Permissions.McpUse,
  mutating: true,
  aliases: ['learn from my data', 'predict with a ready-made model', 'predict with a pretrained model', 'use a model I saved'],
  description:
    'Pick one of the three ways of the Start screen: "pretrained" predicts with a ready-made model (already trained by the TxResBench team), "reuse" predicts with a model you saved, "train" learns from your own patients. Opens the first step of that way, its file step (the learn way asks its questions after the files); files already added are kept. Back from that step returns to the page it was started from. Refused while a run is starting or a dialog is open.',
  params: z.object({
    intent: z
      .enum(['pretrained', 'reuse', 'train'])
      .describe('"pretrained", "reuse" (a saved model) or "train" (learn from my data).'),
    startAtFiles: z
      .boolean()
      .optional()
      .describe('Open the file step directly (every path already starts with its file step; kept for older callers).'),
  }),
  run: ({ intent, startAtFiles }, ctx) => {
    assertCanStartPath()
    TxrIntake.setIntent(intent)
    beginPathHere()
    // Every path starts with its file step (the learn path's study questions
    // come after the files); `startAtFiles` changes nothing any more.
    void startAtFiles
    const path = intent !== 'train' ? PREDICT_FILES_ROUTE : FILES_ROUTE
    ctx.navigate(path)
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
    'Your models "Use": start the saved-model path for one saved model (by its id). Opens the step to add the patients to predict; the model is ticked on the saved list once the file checks out. Back from that step returns to the page it was started from.',
  params: z.object({
    modelId: z.string().min(1).describe('The saved model id (from Your models).'),
    name: z.string().optional().describe('The model name the step shows.'),
  }),
  run: async ({ modelId, name }, ctx) => {
    assertCanStartPath()
    const { useTxrModelsStore } = await import('@/modules/txrmodels/stores/TxrModels.store')
    TxrIntake.setIntent('reuse')
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
