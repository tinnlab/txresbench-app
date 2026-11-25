/**
 * The step trail: what the Back button of each step view goes back to.
 *
 * The flow's step views (B Your study, C Your files, N Patients to predict,
 * E Choose methods, D Pretrained models, I Saved models) are reached by
 * several paths, and some paths skip steps (the Start pretrained card goes
 * straight to N, "Use example" goes straight to a file step, History goes
 * straight to E). Back goes to the step THIS path showed just before the
 * current one, and from a path's first step to where the path started
 * (Start, Help, Your models, History, a results page).
 *
 * The source is a trail of URLs (path + search), not the window history:
 * the history also holds the sidebar pages and the backward hops (E "Change
 * files" lands on C; a history Back from C would return to E), and it is
 * empty after a reload. A fixed map per intent is wrong too: the same step
 * is entered at different places of different paths.
 *
 * - An entry point starts a new trail with its origin (`beginPath`).
 * - Each step view, on mount, calls `enterStep(url)`: a step already in the
 *   trail cuts the trail after it (a backward hop) and keeps the new search;
 *   a new step is appended, unless it is a backward hop to a file step the
 *   trail does not hold (E "Change files" after History, D/I "Go to the
 *   measurements step" after a reload): then the trail keeps only its origin.
 * - Back marks the trail as leaving until the next step records itself, so a
 *   second Back during the route change does nothing.
 * - Back goes to the entry before the current one; with none (a reload or a
 *   deep link) the page's own fallback step.
 *
 * Memory only: the trail is never persisted (a `?name=` search carries a
 * model name, and the intake store persists only its small fields).
 */
import { create } from 'zustand'
import {
  isChoiceStep,
  isFileStep,
  stepOfUrl,
  stepPlace,
  type FlowStepId,
} from '@/modules/txrshell/lib/flowSteps'

/** The page context a step view declares while it is on screen (`flow.back` and
 *  `models.switchList` are offered and invokable only then). */
export const TXR_STEP_CONTEXT = 'txr.step'

/** The page context the model steps (D, I) add while on screen (`models.switchList`
 *  is offered and invokable only there). */
export const TXR_MODEL_STEP_CONTEXT = 'txr.modelStep'

/** The step views that show a Back button (the one list's step views). */
export type TxrStepId = FlowStepId

/** The step view on screen, as its Back button and the `flow.back` action see it. */
export interface TxrCurrentStep {
  step: TxrStepId
  /** The step's URL (path + search) as entered into the trail. */
  url: string
  /** Where Back goes when the trail has nothing before this step. */
  fallback: string
  /** Why Back is not possible right now (a run is starting), or null. */
  blockedReason: string | null
  /** A page dialog is open (Back from the palette or the AI refuses then). */
  dialogOpen: boolean
}

/** The refusal while a page dialog is open. */
export const STEP_BACK_DIALOG_OPEN = 'Close the open dialog first.'

/** The refusal with no step view on screen. */
export const STEP_BACK_NO_STEP = 'There is no step to go back from here.'

/** The refusal while a Back (or a list switch) is already leaving the step. */
export const STEP_BACK_LEAVING = 'Already leaving this step.'

/** The path of a URL (the search and the hash dropped). */
export function pathOf(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/** Is this URL a step view of the flow (the one list of steps, `txrshell/lib/flowSteps.ts`)? */
export function isStepUrl(url: string): boolean {
  return stepOfUrl(url) !== null
}

function indexOfPath(trail: readonly string[], url: string): number {
  const path = pathOf(url)
  return trail.findIndex(entry => pathOf(entry) === path)
}

/** A new trail that starts at an entry point's origin. */
export function beginTrail(origin: string): string[] {
  return [origin]
}

/**
 * A step view entered: when its path is already in the trail, the trail is
 * cut after it and the entry takes the new URL (its search may differ).
 * A file step (C, N) entered from the method or model step while the trail
 * holds no file step is a backward hop too (E "Change files" after History,
 * D/I "Go to the measurements step" after a reload): the trail keeps only its
 * origin, so Back from the file step never goes forward again. Otherwise the
 * URL is appended (the files step entered from the study questions of the
 * Start side trip goes forward; the study questions entered from N are the
 * predict side trip, appended: Back from them is N).
 */
export function enterStep(trail: readonly string[], url: string): string[] {
  const at = indexOfPath(trail, url)
  if (at !== -1) return [...trail.slice(0, at), url]
  const step = stepOfUrl(url)
  const last = trail[trail.length - 1]
  const lastStep = last === undefined ? null : stepOfUrl(last)
  if (step !== null && isFileStep(step) && lastStep !== null && isChoiceStep(lastStep)) {
    return [...trail.filter(entry => stepOfUrl(entry) === null), url]
  }
  return [...trail, url]
}

/** Where Back goes from `url`: the entry before it, or null at the start of the trail. */
export function backTarget(trail: readonly string[], url: string): string | null {
  const at = indexOfPath(trail, url)
  if (at <= 0) return null
  return trail[at - 1] ?? null
}

/** The trail after Back from `url`: the step and everything after it are cut. */
export function leaveStep(trail: readonly string[], url: string): string[] {
  const at = indexOfPath(trail, url)
  if (at === -1) return [...trail]
  return trail.slice(0, at)
}

/**
 * Replace the step at `from` with `to` (the model-list switch used to take
 * the place of the old D/I list in the trail; round 3 — a model-list
 * switch never moves between steps any more, so nothing calls this).
 * With `from` not in the trail, `to` is appended.
 */
export function replaceCurrent(trail: readonly string[], from: string, to: string): string[] {
  const at = indexOfPath(trail, from)
  if (at === -1) return [...trail, to]
  return [...trail.slice(0, at), to]
}

interface StepTrailState {
  trail: string[]
  current: TxrCurrentStep | null
  /** A Back (or a list switch) left the current step; the route has not changed yet. */
  leaving: boolean
}

/**
 * The trail and the step view on screen. A plain zustand store: memory only,
 * never persisted, and with no store-kit teardown (the trail must outlive
 * the pages that read it).
 */
export const useStepTrailStore = create<StepTrailState>(() => ({
  trail: [],
  current: null,
  leaving: false,
}))

/** An entry point starts a new trail (Start, Help, Your models, History, a results page). */
export function beginPath(origin: string): void {
  useStepTrailStore.setState({ trail: beginTrail(origin), leaving: false })
}

/** Record a step view entered (its mount, or a search change). */
export function recordStep(url: string): void {
  const { trail } = useStepTrailStore.getState()
  useStepTrailStore.setState({ trail: enterStep(trail, url), leaving: false })
}

/** Where Back goes from the step on screen, or null with no step view. */
export function currentBackTarget(): string | null {
  const { trail, current } = useStepTrailStore.getState()
  if (current === null) return null
  return backTarget(trail, current.url) ?? current.fallback
}

/**
 * The step on screen may be left now: throws with no step view, while a Back
 * or a list switch is already leaving it, while a run is starting, or while a
 * page dialog is open.
 */
export function assertCanLeaveStep(): TxrCurrentStep {
  const { current, leaving } = useStepTrailStore.getState()
  if (current === null) throw new Error(STEP_BACK_NO_STEP)
  if (leaving) throw new Error(STEP_BACK_LEAVING)
  if (current.blockedReason !== null) throw new Error(current.blockedReason)
  if (current.dialogOpen) throw new Error(STEP_BACK_DIALOG_OPEN)
  return current
}

/**
 * Take one step back: refuses as `assertCanLeaveStep` does; otherwise cuts
 * the current step from the trail, marks the step as being left and returns
 * the URL to navigate to.
 */
export function takeStepBack(): string {
  const current = assertCanLeaveStep()
  const { trail } = useStepTrailStore.getState()
  const target = backTarget(trail, current.url) ?? current.fallback
  useStepTrailStore.setState({ trail: leaveStep(trail, current.url), leaving: true })
  return target
}

/**
 * The page context Help declares while it was opened from a step view and
 * that step can still be returned to (`help.backToStep` is offered and
 * invokable only then). Its entity is the step's URL.
 */
export const TXR_HELP_FROM_STEP_CONTEXT = 'txr.helpFromStep'

/** The refusal when Help was not opened from a step, or that step is gone. */
export const HELP_BACK_NO_STEP = 'Help was not opened from a step that is still open.'

/** A step view's place in its path, as its step line shows it, and its heading. */
export interface TxrStepPlace {
  step: number
  title: string
}

/**
 * The place of a step view URL, or null for any other URL. The step number
 * and the heading come from the one list of steps (`txrshell/lib/flowSteps.ts`,
 * `stepPlace` on its own path — the study step is the learn path's step 3).
 * A URL that is no step view, or a step view that is no numbered step of its
 * path, has no place.
 */
export function stepPlaceOf(url: string): TxrStepPlace | null {
  const id = stepOfUrl(url)
  if (id === null) return null
  const place = stepPlace(id)
  if (place === null) return null
  return { step: place.step, title: place.title }
}

/**
 * Where Help's "Back to step" goes: the step URL Help was opened from, when
 * it is still the last step of the trail (the step the user left for Help).
 * Null for anything else: no origin, not a step URL, or a trail that has
 * moved on since (a new path was started, a reload emptied it).
 */
export function helpReturnTarget(
  origin: unknown,
  trail: readonly string[] = useStepTrailStore.getState().trail,
): string | null {
  if (typeof origin !== 'string' || !isStepUrl(origin)) return null
  return trail[trail.length - 1] === origin ? origin : null
}

/** An entry point starts a new trail (Start, Help, Your models, History, a results page). */
