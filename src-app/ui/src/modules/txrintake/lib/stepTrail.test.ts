/**
 * The step trail (the Back button's source): every row of the plan's flow
 * map, walked as the pages walk it (an entry point's `beginPath`, each step
 * view's `recordStep` on mount, `takeStepBack` for Back), plus the pure
 * helpers on their own.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { stepOfUrl } from '@/modules/txrshell/lib/flowSteps'
import {
  backTarget,
  beginPath,
  beginTrail,
  currentBackTarget,
  enterStep,
  helpReturnTarget,
  leaveStep,
  pathOf,
  recordStep,
  replaceCurrent,
  STEP_BACK_DIALOG_OPEN,
  STEP_BACK_LEAVING,
  STEP_BACK_NO_STEP,
  stepPlaceOf,
  takeStepBack,
  useStepTrailStore,
  type TxrStepId,
} from './stepTrail'

const START = '/'
const STUDY = '/study'
const FILES = '/files'
const PREDICT = '/predict-files'
const METHODS = '/choose-methods'
const CHOOSE = '/choose-models'

/** The fallback each step page declares (the plan's row 13). */
// The pages' own fallbacks: the step before on the learn path
// (Start, files, study, methods).
const FALLBACK: Record<TxrStepId, string> = {
  study: FILES,
  files: START,
  'predict-files': START,
  'choose-methods': STUDY,
  'choose-models': PREDICT,
}

const STEP_OF: Record<string, TxrStepId> = {
  [STUDY]: 'study',
  [FILES]: 'files',
  [PREDICT]: 'predict-files',
  [METHODS]: 'choose-methods',
  [CHOOSE]: 'choose-models',
}

/** A step view mounts: the trail records it and it becomes the current step. */
function show(url: string, fallback?: string): void {
  const step = STEP_OF[pathOf(url)]
  if (step === undefined) throw new Error(`not a step: ${url}`)
  recordStep(url)
  useStepTrailStore.setState({
    current: {
      step,
      url,
      fallback: fallback ?? FALLBACK[step],
      blockedReason: null,
      dialogOpen: false,
    },
  })
}

/** A non-step page mounts (Start, Help, ...): the step unmounted, no current step. */
function leaveToPage(): void {
  useStepTrailStore.setState({ current: null, leaving: false })
}

/** Back from the current step: the URL it lands on. */
function back(): string {
  const target = takeStepBack()
  if (STEP_OF[pathOf(target)] !== undefined) show(target)
  else leaveToPage()
  return target
}

beforeEach(() => {
  useStepTrailStore.setState({ trail: [], current: null, leaving: false })
})

describe('the pure helpers', () => {
  it('pathOf drops the search and the hash', () => {
    expect(pathOf('/predict-files?use=m1&name=x')).toBe('/predict-files')
    expect(pathOf('/help#start')).toBe('/help')
    expect(pathOf('/files')).toBe('/files')
  })

  it('enterStep appends a new step and cuts after a step already in the trail, keeping the new search', () => {
    expect(enterStep([START], PREDICT)).toEqual([START, PREDICT])
    expect(enterStep([START, STUDY, FILES, METHODS], FILES)).toEqual([START, STUDY, FILES])
    expect(enterStep(['/models', `${PREDICT}?use=a`], `${PREDICT}?use=b`)).toEqual([
      '/models',
      `${PREDICT}?use=b`,
    ])
  })

  it('backTarget is the entry before the step, null at the start of the trail or when absent', () => {
    expect(backTarget([START, PREDICT, CHOOSE], CHOOSE)).toBe(PREDICT)
    expect(backTarget([START, PREDICT], PREDICT)).toBe(START)
    expect(backTarget([PREDICT], PREDICT)).toBeNull()
    expect(backTarget([START], FILES)).toBeNull()
  })

  it('leaveStep cuts the step and everything after it', () => {
    expect(leaveStep([START, STUDY, FILES], FILES)).toEqual([START, STUDY])
    expect(leaveStep([START], FILES)).toEqual([START])
  })

  it('replaceCurrent swaps the step for another (or appends when absent)', () => {
    expect(replaceCurrent([START, PREDICT, CHOOSE], CHOOSE, PREDICT)).toEqual([
      START,
      PREDICT,
      PREDICT,
    ])
    expect(replaceCurrent([START, PREDICT], CHOOSE, PREDICT)).toEqual([START, PREDICT, PREDICT])
  })

  it('beginTrail starts at the origin', () => {
    expect(beginTrail('/help')).toEqual(['/help'])
  })
})

describe('the flow map (each row: Back from each step of the path)', () => {
  it('row 1: the ONE predict card (or its "Use example"): A → N → the model step; model step → N, N → A', () => {
    beginPath(START)
    show(PREDICT)
    show(CHOOSE)
    expect(back()).toBe(PREDICT)
    expect(back()).toBe(START)
  })

  it('row 2: the old D/I addresses are no longer steps (round 3 — they redirect to the ONE list)', () => {
    // The redirects live in txrmodels (`module.tsx`), never in the step
    // trail: the old addresses are ordinary pages to the trail, so a step
    // visit is never recorded under them.
    expect(stepOfUrl('/pretrained-models')).toBeNull()
    expect(stepOfUrl('/saved-models')).toBeNull()
    expect(stepOfUrl(CHOOSE)).toBe('choose-models')
  })

  it('row 3: the train card "Add my data": A → C → B → E; E→B, B→C, C→A', () => {
    beginPath(START)
    show(FILES)
    show(STUDY)
    show(METHODS)
    expect(back()).toBe(STUDY)
    expect(back()).toBe(FILES)
    expect(back()).toBe(START)
  })

  it('row 4: the train "Use example" on Start: A → C → B → E (the same steps as row 3)', () => {
    beginPath(START)
    show(FILES)
    show(STUDY)
    show(METHODS)
    expect(back()).toBe(STUDY)
    expect(back()).toBe(FILES)
    expect(back()).toBe(START)
  })

  it('row 5: "Not sure which fits?": A → B, then C (no files yet) or N; C→B, N→B, B→A', () => {
    beginPath(START)
    show(STUDY)
    show(FILES) // B Continue with no files yet goes forward to the files step
    expect(useStepTrailStore.getState().trail).toEqual([START, STUDY, FILES])
    expect(back()).toBe(STUDY)
    show(PREDICT)
    expect(back()).toBe(STUDY)
    expect(back()).toBe(START)
  })

  it('row 6: C Continue to B, then B Continue to E; Back runs the same steps in reverse', () => {
    beginPath(START)
    show(FILES)
    show(STUDY)
    expect(currentBackTarget()).toBe(FILES)
    show(METHODS)
    expect(back()).toBe(STUDY)
  })

  it('row 7: N study link then B Continue: N → B → N; B→N, then N→its first Back target', () => {
    beginPath(START)
    show(PREDICT)
    show(STUDY)
    expect(currentBackTarget()).toBe(PREDICT)
    show(PREDICT) // B Continue lands on N again: the trail is cut back to N
    expect(back()).toBe(START)
  })

  it('row 8: the Help quick-start cards: the first step goes back to Help', () => {
    beginPath('/help')
    show(PREDICT)
    expect(currentBackTarget()).toBe('/help')
    beginPath('/help')
    show(FILES) // "Add my data" and its "Use example" both land on C
    show(STUDY)
    show(METHODS)
    expect(back()).toBe(STUDY)
    expect(back()).toBe(FILES)
    expect(back()).toBe('/help')
  })

  it('row 9: Your models "Use": N(?use=) → the model step; the model step → N with the search, N → Your models', () => {
    beginPath('/models')
    const withUse = `${PREDICT}?use=m1&name=Model%201`
    show(withUse, '/models')
    show(CHOOSE)
    expect(back()).toBe(withUse)
    expect(back()).toBe('/models')
  })

  it('row 10: History "Use these settings again": E only; E→History', () => {
    beginPath('/history')
    show(METHODS)
    expect(back()).toBe('/history')
  })

  it('row 11: backward hops cut the trail there (E "Change files" → C; the model step "Go to the measurements step" → N)', () => {
    beginPath(START)
    show(FILES)
    show(STUDY)
    show(METHODS)
    show(FILES) // "Change files" — a backward hop, not a forward step
    expect(useStepTrailStore.getState().trail).toEqual([START, FILES])
    expect(back()).toBe(START)

    beginPath(START)
    show(PREDICT)
    show(CHOOSE)
    show(PREDICT) // "Go to the measurements step" / the model step "Use example"
    expect(back()).toBe(START)
  })

  it('row 11 — a backward hop into a step the trail does not hold cuts back to the origin, never forward', () => {
    // History "Use these settings again" → E, then "Change files" → C (or N
    // on a predict path): Back from the file step is History, not E.
    beginPath('/history')
    show(METHODS)
    show(FILES)
    expect(useStepTrailStore.getState().trail).toEqual(['/history', FILES])
    expect(back()).toBe('/history')

    beginPath('/history')
    show(METHODS, PREDICT)
    show(PREDICT)
    expect(useStepTrailStore.getState().trail).toEqual(['/history', PREDICT])
    expect(back()).toBe('/history')
  })

  it('row 11 + 13 — after a reload on the model step, "Go to the measurements step" lands on N, whose Back is Start', () => {
    useStepTrailStore.setState({ trail: [], current: null })
    show(CHOOSE) // the reload: the trail holds only the model step
    show(PREDICT)
    expect(useStepTrailStore.getState().trail).toEqual([PREDICT])
    expect(back()).toBe(START)
  })

  it('a detour to B from a later step is not a backward hop (N study link, row 7): B goes back to N', () => {
    beginPath(START)
    show(PREDICT)
    show(STUDY)
    expect(useStepTrailStore.getState().trail).toEqual([START, PREDICT, STUDY])
  })

  it('row 13: a reload or a deep link (no trail): each step goes to its fallback', () => {
    for (const [url, expected] of [
      [STUDY, FILES],
      [FILES, START],
      [PREDICT, START],
      [METHODS, STUDY],
      [CHOOSE, PREDICT],
    ] as const) {
      useStepTrailStore.setState({ trail: [], current: null })
      show(url)
      expect(back()).toBe(expected)
    }
    // N with the "Use" search falls back to Your models; E on the predict
    // mode falls back to N.
    useStepTrailStore.setState({ trail: [], current: null })
    show(`${PREDICT}?use=m1`, '/models')
    expect(back()).toBe('/models')
    useStepTrailStore.setState({ trail: [], current: null })
    show(METHODS, PREDICT)
    expect(back()).toBe(PREDICT)
  })

  it('after a fallback Back, the next Back keeps going down the fallbacks', () => {
    show(METHODS)
    expect(back()).toBe(STUDY)
    expect(back()).toBe(FILES)
    expect(back()).toBe(START)
  })
})

describe('the refusals', () => {
  it('a second Back while the first is still leaving does nothing (the trail was already cut)', () => {
    beginPath('/history')
    show(METHODS)
    expect(takeStepBack()).toBe('/history')
    // The router has not committed the new route yet: the step is still on screen.
    expect(() => takeStepBack()).toThrow(STEP_BACK_LEAVING)
    expect(useStepTrailStore.getState().trail).toEqual(['/history'])
    // The next step that records itself ends the leaving state.
    show(FILES)
    expect(() => takeStepBack()).not.toThrow()
  })

  it('refuses with no step view on screen', () => {
    expect(() => takeStepBack()).toThrow(STEP_BACK_NO_STEP)
  })

  it('refuses with the blocked reason (a run is starting) and leaves the trail alone', () => {
    beginPath(START)
    show(PREDICT)
    show(CHOOSE)
    useStepTrailStore.setState(s => ({
      current: s.current && { ...s.current, blockedReason: 'Starting the run…' },
    }))
    expect(() => takeStepBack()).toThrow('Starting the run…')
    expect(useStepTrailStore.getState().trail).toEqual([START, PREDICT, CHOOSE])
  })

  it('refuses while a page dialog is open', () => {
    beginPath(START)
    show(PREDICT)
    show(CHOOSE)
    useStepTrailStore.setState(s => ({ current: s.current && { ...s.current, dialogOpen: true } }))
    expect(() => takeStepBack()).toThrow(STEP_BACK_DIALOG_OPEN)
    expect(useStepTrailStore.getState().trail).toEqual([START, PREDICT, CHOOSE])
  })
})

describe('the way back from Help to a step', () => {
  beforeEach(() => {
    useStepTrailStore.setState({ trail: [], current: null, leaving: false })
  })

  it('names each step view by its step line number and its heading', () => {
    expect(stepPlaceOf(STUDY)).toEqual({ step: 3, title: 'Tell us about your study' })
    expect(stepPlaceOf(FILES)).toEqual({ step: 2, title: 'Add your files' })
    expect(stepPlaceOf(`${PREDICT}?use=m1&name=Model%201`)).toEqual({
      step: 2,
      title: 'Add the patients to predict',
    })
    expect(stepPlaceOf('/choose-methods')).toEqual({ step: 4, title: 'Choose the methods and settings' })
    // The ONE model step: the old D/I addresses are no longer steps (the
    // redirects land here — round 3).
    expect(stepPlaceOf('/choose-models')).toEqual({ step: 3, title: 'Choose the models to run' })
    expect(stepPlaceOf('/pretrained-models')).toBeNull()
    expect(stepPlaceOf('/saved-models')).toBeNull()
    expect(stepPlaceOf(START)).toBeNull()
    expect(stepPlaceOf('/help')).toBeNull()
  })

  it('returns to the step Help was opened from while it is the last step of the trail', () => {
    beginPath(START)
    recordStep(STUDY)
    recordStep(FILES)
    expect(helpReturnTarget(FILES)).toBe(FILES)
    const withUse = `${PREDICT}?use=m1`
    beginPath('/models')
    recordStep(withUse)
    expect(helpReturnTarget(withUse)).toBe(withUse)
  })

  it('has no way back for an unknown origin: none, not a string, not a step view', () => {
    beginPath(START)
    recordStep(FILES)
    expect(helpReturnTarget(null)).toBeNull()
    expect(helpReturnTarget(undefined)).toBeNull()
    expect(helpReturnTarget(42)).toBeNull()
    expect(helpReturnTarget('/models')).toBeNull()
    expect(helpReturnTarget(START)).toBeNull()
  })

  it('has no way back for a stale origin: a new path started, an earlier step, or an empty trail', () => {
    expect(helpReturnTarget(FILES)).toBeNull()
    beginPath(START)
    recordStep(STUDY)
    recordStep(FILES)
    expect(helpReturnTarget(STUDY)).toBeNull()
    beginPath('/help')
    expect(helpReturnTarget(FILES)).toBeNull()
    // The same step with another search is another place.
    beginPath(START)
    recordStep(`${PREDICT}?use=m2`)
    expect(helpReturnTarget(`${PREDICT}?use=m1`)).toBeNull()
  })
})
