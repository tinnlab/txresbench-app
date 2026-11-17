import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { TxrIntake } from '@/modules/txrintake/stores/TxrIntake.store'
import {
  beginPath,
  assertCanLeaveStep,
  replaceCurrentStep,
  takeStepBack,
  TXR_STEP_CONTEXT,
  useStepTrailStore,
} from '@/modules/txrintake/lib/stepTrail'

// The step-flow actions of a new analysis: the Back button of each step view,
// the switch between the published and the saved model lists on the model
// step, and the start of a path (the Start screen's cards). Registered once so
// the button, the command palette and the AI take the same path.
//
// `permission`: the step routes carry no route permission
// (`modules/txrintake/module.tsx`), so these use the permission the
// registered navigation action (`app.navigate`, `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrintake/module.tsx`.

/** The model step routes (the D and I screens). */
const PUBLISHED_MODELS_ROUTE = '/pretrained-models'
const SAVED_MODELS_ROUTE = '/saved-models'

/** The first route of each path (Start's card picker: train → B, the predict paths → N). */
const STUDY_ROUTE = '/study'
const PREDICT_FILES_ROUTE = '/predict-files'

/** Where every path starts (the Start screen, step 1 of each path). */
const START_ROUTE = '/'

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
  id: 'models.switchList',
  title: 'Switch between the published models and your saved models',
  permission: Permissions.McpUse,
  mutating: true,
  context: TXR_STEP_CONTEXT,
  aliases: ['use my saved models', 'use the published models'],
  description:
    'On the model step of a new analysis, show the other model list for the same checked file: "saved" for your saved models, "published" for the published models. The new list takes the place of the current one in the steps, so Back still goes to the file step.',
  params: z.object({
    list: z
      .enum(['saved', 'published'])
      .describe('"saved" for your saved models, "published" for the published models.'),
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
  aliases: ['learn from my data', 'predict with a pretrained model', 'use a model I saved'],
  description:
    'Pick one of the three ways of the Start screen: "pretrained" predicts with a published model, "reuse" predicts with a model you saved, "train" learns from your own patients. Opens the first step of that way; files already added are kept.',
  params: z.object({
    intent: z
      .enum(['pretrained', 'reuse', 'train'])
      .describe('"pretrained", "reuse" (a saved model) or "train" (learn from my data).'),
  }),
  run: ({ intent }, ctx) => {
    TxrIntake.setIntent(intent)
    // A new path: its first step goes back to the Start screen.
    beginPath(START_ROUTE)
    const path = intent === 'train' ? STUDY_ROUTE : PREDICT_FILES_ROUTE
    ctx.navigate(path)
    return { path }
  },
})
