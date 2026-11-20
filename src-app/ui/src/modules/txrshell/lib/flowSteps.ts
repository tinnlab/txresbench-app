/**
 * The one list of the new-analysis steps: every step route, and the order of
 * the steps on each path. The step line ("Step x of y"), the Back trail, the
 * pages' Continue targets, the route registrations and the Help text read the
 * routes and the numbers from here, never from their own copies.
 *
 * - Learn from my data: 1 Start, 2 Your files, 3 Your study, 4 Methods.
 * - Predict (a ready-made model or a saved model): 1 Start, 2 Patients to
 *   predict, 3 Models (the ready-made list or the saved list).
 *
 * The study questions opened from the predict file step are a side trip of
 * the predict path, not one of its numbered steps.
 *
 * Lives in `txrshell` because every flow module (txrintake, txrrun,
 * txrmodels, txrhelp) already depends on the shell, and txrhelp must not
 * import txrintake.
 */

/** The step routes of the flow (Start included). */
export const FLOW_ROUTES = {
  start: '/',
  files: '/files',
  study: '/study',
  methods: '/choose-methods',
  predictFiles: '/predict-files',
  pretrainedModels: '/pretrained-models',
  savedModels: '/saved-models',
} as const

/** The step views after Start (each has a Back button). */
export type FlowStepId =
  | 'files'
  | 'study'
  | 'choose-methods'
  | 'predict-files'
  | 'pretrained-models'
  | 'saved-models'

/** The two kinds of path: learn from my data, or predict with a model. */
export type FlowPath = 'learn' | 'predict'

/** One step view: its route and the heading its page shows. */
export interface FlowStep {
  id: FlowStepId
  route: string
  title: string
}

/** Every step view, with its route and heading. */
export const FLOW_STEPS: Readonly<Record<FlowStepId, FlowStep>> = {
  files: { id: 'files', route: FLOW_ROUTES.files, title: 'Add your files' },
  study: { id: 'study', route: FLOW_ROUTES.study, title: 'Tell us about your study' },
  'choose-methods': {
    id: 'choose-methods',
    route: FLOW_ROUTES.methods,
    title: 'Choose the methods and settings',
  },
  'predict-files': {
    id: 'predict-files',
    route: FLOW_ROUTES.predictFiles,
    title: 'Add the patients to predict',
  },
  'pretrained-models': {
    id: 'pretrained-models',
    route: FLOW_ROUTES.pretrainedModels,
    title: 'Choose the models to run',
  },
  'saved-models': {
    id: 'saved-models',
    route: FLOW_ROUTES.savedModels,
    title: 'Choose the saved models to run',
  },
}

/**
 * The numbered steps of each path after Start (step 1), in order. A list
 * entry with two ids is one step shown by either view (the ready-made and
 * the saved model lists are the same step 3).
 */
export const FLOW_PATHS: Readonly<Record<FlowPath, ReadonlyArray<readonly FlowStepId[]>>> = {
  learn: [['files'], ['study'], ['choose-methods']],
  predict: [['predict-files'], ['pretrained-models', 'saved-models']],
}

/** A step view's place on a path, as its step line shows it. */
export interface FlowStepPlace {
  step: number
  of: number
  title: string
}

/** The path a step view is numbered on (`study` is on the learn path only). */
export function pathOfStep(id: FlowStepId): FlowPath {
  return FLOW_PATHS.predict.some(ids => ids.includes(id)) ? 'predict' : 'learn'
}

/**
 * The place of a step view on `path` ("Step x of y" and the heading), or null
 * when the view is not a numbered step of that path (the study questions
 * opened from the predict file step).
 */
export function stepPlace(id: FlowStepId, path: FlowPath = pathOfStep(id)): FlowStepPlace | null {
  const steps = FLOW_PATHS[path]
  const at = steps.findIndex(ids => ids.includes(id))
  if (at === -1) return null
  return { step: at + 2, of: steps.length + 1, title: FLOW_STEPS[id].title }
}

/** The order of a step view within its own path (1 = the first step after Start). */
export function stepOrder(id: FlowStepId): number {
  const steps = FLOW_PATHS[pathOfStep(id)]
  return steps.findIndex(ids => ids.includes(id)) + 1
}

/** Is this view the file step of its path (the first step after Start)? */
export function isFileStep(id: FlowStepId): boolean {
  return FLOW_PATHS[pathOfStep(id)][0].includes(id)
}

/** Is this view the last step of its path (the method or model choice)? */
export function isChoiceStep(id: FlowStepId): boolean {
  const steps = FLOW_PATHS[pathOfStep(id)]
  return steps[steps.length - 1].includes(id)
}

/** The path (no search) of a URL. */
function routeOf(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/** The step view a URL shows, or null for any other page (Start included). */
export function stepOfUrl(url: string): FlowStepId | null {
  const route = routeOf(url)
  const step = (Object.values(FLOW_STEPS) as FlowStep[]).find(s => s.route === route)
  return step === undefined ? null : step.id
}

/** The route of the step after `id` on the learn path, or null after the last one. */
export function nextLearnRoute(id: FlowStepId): string | null {
  const steps = FLOW_PATHS.learn
  const at = steps.findIndex(ids => ids.includes(id))
  if (at === -1 || at + 1 >= steps.length) return null
  return FLOW_STEPS[steps[at + 1][0]].route
}

/** The route of the step before `id` on the learn path (Start before the first one). */
export function previousLearnRoute(id: FlowStepId): string {
  const steps = FLOW_PATHS.learn
  const at = steps.findIndex(ids => ids.includes(id))
  if (at <= 0) return FLOW_ROUTES.start
  return FLOW_STEPS[steps[at - 1][0]].route
}
