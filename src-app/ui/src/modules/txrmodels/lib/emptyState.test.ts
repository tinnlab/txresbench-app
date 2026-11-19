/**
 * The model step's dynamic messages (`./emptyState.ts`): every row of the
 * step Back plan's message table, singular and plural, and no number while
 * its data is loading.
 */
import { describe, expect, it } from 'vitest'
import {
  noPublishedCanRunLine,
  noPublishedMessage,
  noSavedCanRunLine,
  noSavedMessage,
  SAVED_FILTERED_EMPTY,
  type TxrModelListFacts,
  type TxrModelsEmptyMessage,
} from './emptyState'

const loading: TxrModelListFacts = { failed: false, total: null, canRun: null }
const counting = (total: number): TxrModelListFacts => ({ failed: false, total, canRun: null })
const facts = (total: number, canRun: number): TxrModelListFacts => ({
  failed: false,
  total,
  canRun,
})
const failed: TxrModelListFacts = { failed: true, total: null, canRun: null }

const text = (m: TxrModelsEmptyMessage): string => [m.title, m.intro, m.body].filter(Boolean).join(' ')
const buttons = (m: { actions: { label: string }[] }): string[] => m.actions.map(a => a.label)

describe('D: no ready-made model at all, by your saved models', () => {
  const INTRO =
    'Ready-made models are already trained by the TxResBench team, so they predict without learning from your data. None have been released yet.'

  it('every D message names what ready-made models are, and that none are released', () => {
    for (const saved of [loading, counting(3), facts(3, 2), facts(3, 0), facts(0, 0), failed]) {
      const m = noPublishedMessage(saved)
      expect(m.title).toBe('No ready-made models yet')
      expect(m.intro).toBe(INTRO)
      expect(text(m)).not.toMatch(/published|pretrained/i)
    }
  })

  it('saved models loading: says it checks them, names no number, offers nothing', () => {
    for (const saved of [loading, counting(3)]) {
      const m = noPublishedMessage(saved)
      expect(m.body).toBe('Checking your saved models…')
      expect(m.body).not.toMatch(/\d/)
      expect(m.actions).toEqual([])
    }
  })

  it('S saved, F > 0 can run: "predict with your own saved models instead", the counts and "Use my saved models"', () => {
    const m = noPublishedMessage(facts(3, 2))
    expect(m.body).toBe(
      'You can predict with your own saved models instead: 2 of your 3 saved models can run on this file.',
    )
    expect(buttons(m)).toEqual(['Use my saved models', 'Go to Your models'])
    expect(noPublishedMessage(facts(3, 3)).body).toBe(
      'You can predict with your own saved models instead: 3 of your 3 saved models can run on this file.',
    )
    expect(noPublishedMessage(facts(1, 1)).body).toBe(
      'You can predict with your own saved model instead: it can run on this file.',
    )
  })

  it('S saved, none can run: says the rows say what is missing, and "See my saved models"', () => {
    const m = noPublishedMessage(facts(3, 0))
    expect(m.body).toBe(
      'You have 3 saved models, but none can run on this file: each row on the saved list says what is missing.',
    )
    expect(buttons(m)).toEqual(['See my saved models', 'Go to Your models'])
    expect(noPublishedMessage(facts(1, 0)).body).toBe(
      'You have 1 saved model, but it cannot run on this file: its row on the saved list says what is missing.',
    )
  })

  it('no saved model either: how to make one, "Learn from my data"', () => {
    const m = noPublishedMessage(facts(0, 0))
    expect(m.body).toBe(
      "You don't have any saved models yet. To make some, learn from patients whose outcomes you know.",
    )
    // "Go to Your models" stays: it is where a model file is opened.
    expect(buttons(m)).toEqual(['Learn from my data', 'Go to Your models'])
  })

  it('the saved models failed to load: says so, with Retry', () => {
    const m = noPublishedMessage(failed)
    expect(m.body).toBe('Your saved models could not be loaded.')
    expect(buttons(m)).toEqual(['Retry', 'Go to Your models'])
  })
})

describe('D list: none of the P ready-made models can run', () => {
  it('the line, with no saved clause while the saved models load or when none can run', () => {
    for (const saved of [loading, counting(2), facts(2, 0), failed]) {
      const line = noPublishedCanRunLine(7, saved)
      expect(line.text).toBe(
        'None of the 7 ready-made models can run on this file. Each row says what is missing.',
      )
      expect(line.actions).toEqual([])
    }
    expect(noPublishedCanRunLine(1, loading).text).toBe(
      'The 1 ready-made model cannot run on this file. Its row says what is missing.',
    )
  })

  it('names the saved models that can run, with "Use my saved models"', () => {
    const line = noPublishedCanRunLine(7, facts(4, 2))
    expect(line.text).toBe(
      'None of the 7 ready-made models can run on this file. Each row says what is missing. 2 of your saved models can run on it.',
    )
    expect(buttons(line)).toEqual(['Use my saved models'])
  })
})

describe('I: no saved model at all, by the ready-made models', () => {
  it('ready-made models loading: says it checks them, names no number', () => {
    for (const published of [loading, counting(5)]) {
      const m = noSavedMessage(published)
      expect(text(m)).toBe('You have no saved models yet. Checking the ready-made models…')
      expect(text(m)).not.toMatch(/\d/)
      expect(m.actions).toEqual([])
    }
  })

  it('F of P ready-made can run: the counts and "Use the ready-made models"', () => {
    const m = noSavedMessage(facts(5, 3))
    expect(text(m)).toBe('You have no saved models yet. 3 of the 5 ready-made models can run on this file.')
    expect(buttons(m)).toEqual(['Use the ready-made models'])
    expect(text(noSavedMessage(facts(1, 1)))).toBe(
      'You have no saved models yet. The 1 ready-made model can run on this file.',
    )
  })

  it('P ready-made, none can run: says so, with "See the ready-made models"', () => {
    const m = noSavedMessage(facts(5, 0))
    expect(text(m)).toBe(
      'You have no saved models yet, and none of the 5 ready-made models can run on this file.',
    )
    expect(buttons(m)).toEqual(['See the ready-made models', 'Go to Your models'])
    expect(text(noSavedMessage(facts(1, 0)))).toBe(
      'You have no saved models yet, and the 1 ready-made model cannot run on this file.',
    )
  })

  it('no ready-made model (or its load failed): how to get a model, "Learn from my data"', () => {
    for (const published of [facts(0, 0), failed]) {
      const m = noSavedMessage(published)
      expect(text(m)).toBe(
        'You have no saved models yet. Save models from an analysis that learns from your data, or open a model file in Your models.',
      )
      expect(buttons(m)).toEqual(['Learn from my data', 'Go to Your models'])
    }
  })
})

describe('I list: none of the S saved models can run', () => {
  it('the line, with no published clause while those load or when none can run', () => {
    for (const published of [loading, counting(5), facts(5, 0), failed]) {
      const line = noSavedCanRunLine(3, published)
      expect(line.text).toBe(
        'None of your 3 saved models can run on this file. Each row says what is missing.',
      )
      expect(line.actions).toEqual([])
    }
    expect(noSavedCanRunLine(1, loading).text).toBe(
      'Your 1 saved model cannot run on this file. Its row says what is missing.',
    )
  })

  it('names the published models that can run, with "Use the published models"', () => {
    const line = noSavedCanRunLine(3, facts(5, 2))
    expect(line.text).toBe(
      'None of your 3 saved models can run on this file. Each row says what is missing. 2 ready-made models can run on it.',
    )
    expect(buttons(line)).toEqual(['Use the ready-made models'])
    expect(noSavedCanRunLine(3, facts(5, 1)).text).toContain('1 ready-made model can run on it.')
  })
})

it('I list hidden by the search or the filters: its own line', () => {
  expect(SAVED_FILTERED_EMPTY).toBe('No saved models match the search or the filters.')
})
