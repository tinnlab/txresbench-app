// @vitest-environment node
/**
 * The one list of the new-analysis steps (`lib/flowSteps.ts`): the order of
 * each path, the step line's numbers and headings, and the route lookups the
 * pages and the Back trail read.
 */
import { describe, expect, it } from 'vitest'
import {
  FLOW_PATHS,
  FLOW_ROUTES,
  FLOW_STEPS,
  nextLearnRoute,
  pathOfStep,
  previousLearnRoute,
  stepOfUrl,
  stepOrder,
  stepPlace,
  type FlowStepId,
} from './flowSteps'

describe('the order of the paths', () => {
  it('learn from my data: Start, Your files, Your study, Methods', () => {
    expect(FLOW_PATHS.learn).toEqual([['files'], ['study'], ['choose-methods']])
    expect(stepPlace('files')).toEqual({ step: 2, of: 4, title: 'Add your files' })
    expect(stepPlace('study')).toEqual({ step: 3, of: 4, title: 'Tell us about your study' })
    expect(stepPlace('choose-methods')).toEqual({
      step: 4,
      of: 4,
      title: 'Choose the methods and settings',
    })
  })

  it('predict with a model: Start, Patients to predict, Models (three steps)', () => {
    expect(stepPlace('predict-files')).toEqual({
      step: 2,
      of: 3,
      title: 'Add the patients to predict',
    })
    expect(stepPlace('pretrained-models')).toEqual({ step: 3, of: 3, title: 'Choose the models to run' })
    expect(stepPlace('saved-models')).toEqual({
      step: 3,
      of: 3,
      title: 'Choose the saved models to run',
    })
  })

  it('the study questions are a side trip of the predict path, not a numbered step', () => {
    expect(stepPlace('study', 'predict')).toBeNull()
    expect(pathOfStep('study')).toBe('learn')
  })

  it('orders each step within its path', () => {
    expect(stepOrder('files')).toBe(1)
    expect(stepOrder('study')).toBe(2)
    expect(stepOrder('choose-methods')).toBe(3)
    expect(stepOrder('predict-files')).toBe(1)
    expect(stepOrder('saved-models')).toBe(2)
  })
})

describe('the routes', () => {
  it('names every step route once', () => {
    const routes = Object.values(FLOW_ROUTES)
    expect(new Set(routes).size).toBe(routes.length)
    for (const step of Object.values(FLOW_STEPS)) {
      expect(routes).toContain(step.route)
    }
  })

  it('finds the step a URL shows (the search ignored), and none for Start or other pages', () => {
    const ids = Object.keys(FLOW_STEPS) as FlowStepId[]
    for (const id of ids) expect(stepOfUrl(FLOW_STEPS[id].route)).toBe(id)
    expect(stepOfUrl('/predict-files?use=m1&name=a')).toBe('predict-files')
    expect(stepOfUrl('/')).toBeNull()
    expect(stepOfUrl('/history')).toBeNull()
  })

  it('goes forward and back along the learn path', () => {
    expect(nextLearnRoute('files')).toBe('/study')
    expect(nextLearnRoute('study')).toBe('/choose-methods')
    expect(nextLearnRoute('choose-methods')).toBeNull()
    expect(previousLearnRoute('files')).toBe('/')
    expect(previousLearnRoute('study')).toBe('/files')
    expect(previousLearnRoute('choose-methods')).toBe('/study')
  })
})
