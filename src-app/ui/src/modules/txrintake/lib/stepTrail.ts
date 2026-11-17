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
 *   a new step is appended.
 * - Back goes to the entry before the current one; with none (a reload or a
 *   deep link) the page's own fallback step.
 *
 * Memory only: the trail is never persisted (a `?name=` search carries a
 * model name, and the intake store persists only its small fields).
 */
import { create } from 'zustand'

/** The page context a step view declares while it is on screen (`flow.back` and
 *  `models.switchList` are offered and invokable only then). */
export const TXR_STEP_CONTEXT = 'txr.step'

/** The step views that show a Back button. */
export type TxrStepId =
  | 'study'
  | 'files'
  | 'predict-files'
  | 'choose-methods'
  | 'pretrained-models'
  | 'saved-models'

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

/** The path of a URL (the search and the hash dropped). */
export function pathOf(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
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
 * cut after it and the entry takes the new URL (its search may differ);
 * otherwise the URL is appended.
 */
export function enterStep(trail: readonly string[], url: string): string[] {
  const at = indexOfPath(trail, url)
  if (at === -1) return [...trail, url]
  return [...trail.slice(0, at), url]
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
 * Replace the step at `from` with `to` (the D/I switch: "Use my saved
 * models" takes the place of the empty published list, so Back from the
 * saved list goes to the file step). With `from` not in the trail, `to` is
 * appended.
 */
export function replaceCurrent(trail: readonly string[], from: string, to: string): string[] {
  const at = indexOfPath(trail, from)
  if (at === -1) return [...trail, to]
  return [...trail.slice(0, at), to]
}

interface StepTrailState {
  trail: string[]
  current: TxrCurrentStep | null
}

/**
 * The trail and the step view on screen. A plain zustand store: memory only,
 * never persisted, and with no store-kit teardown (the trail must outlive
 * the pages that read it).
 */
export const useStepTrailStore = create<StepTrailState>(() => ({ trail: [], current: null }))

/** An entry point starts a new trail (Start, Help, Your models, History, a results page). */
export function beginPath(origin: string): void {
  useStepTrailStore.setState({ trail: beginTrail(origin) })
}

/** Record a step view entered (its mount, or a search change). */
export function recordStep(url: string): void {
  const { trail } = useStepTrailStore.getState()
  useStepTrailStore.setState({ trail: enterStep(trail, url) })
}

/** Where Back goes from the step on screen, or null with no step view. */
export function currentBackTarget(): string | null {
  const { trail, current } = useStepTrailStore.getState()
  if (current === null) return null
  return backTarget(trail, current.url) ?? current.fallback
}

/**
 * Take one step back: refuses (throws) with no step view, while a run is
 * starting, or while a page dialog is open; otherwise cuts the current step
 * from the trail and returns the URL to navigate to.
 */
export function takeStepBack(): string {
  const { trail, current } = useStepTrailStore.getState()
  if (current === null) throw new Error(STEP_BACK_NO_STEP)
  if (current.blockedReason !== null) throw new Error(current.blockedReason)
  if (current.dialogOpen) throw new Error(STEP_BACK_DIALOG_OPEN)
  const target = backTarget(trail, current.url) ?? current.fallback
  useStepTrailStore.setState({ trail: leaveStep(trail, current.url) })
  return target
}

/** Swap the step on screen for another one in the trail (the D/I switch). */
export function replaceCurrentStep(to: string): void {
  const { trail, current } = useStepTrailStore.getState()
  if (current === null) {
    useStepTrailStore.setState({ trail: [...trail, to] })
    return
  }
  useStepTrailStore.setState({ trail: replaceCurrent(trail, current.url, to) })
}
