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

const text = (m: TxrModelsEmptyMessage): string => [m.title, m.body].filter(Boolean).join(' ')
const buttons = (m: { actions: { label: string }[] }): string[] => m.actions.map(a => a.label)

describe('D: no published model at all, by your saved models', () => {
  it('saved models loading: says it checks them, names no number, offers nothing', () => {
    for (const saved of [loading, counting(3)]) {
      const m = noPublishedMessage(saved)
      expect(text(m)).toBe('No published models are available yet. Checking your saved models…')
      expect(text(m)).not.toMatch(/\d/)
      expect(m.actions).toEqual([])
    }
  })

  it('S saved, F > 0 can run: the counts and "Use my saved models"', () => {
    const m = noPublishedMessage(facts(3, 2))
    expect(text(m)).toBe(
      'No published models are available yet. You have 3 saved models; 2 can run on this file.',
    )
    expect(buttons(m)).toEqual(['Use my saved models', 'Go to Your models'])
    expect(text(noPublishedMessage(facts(1, 1)))).toBe(
      'No published models are available yet. You have 1 saved model; 1 can run on this file.',
    )
  })

  it('S saved, none can run: says the rows say what is missing, and "See my saved models"', () => {
    const m = noPublishedMessage(facts(3, 0))
    expect(text(m)).toBe(
      'No published models are available yet. You have 3 saved models, but none can run on this file: each row on the saved list says what is missing.',
    )
    expect(buttons(m)).toEqual(['See my saved models', 'Go to Your models'])
    expect(text(noPublishedMessage(facts(1, 0)))).toBe(
      'No published models are available yet. You have 1 saved model, but it cannot run on this file: its row on the saved list says what is missing.',
    )
  })

  it('no saved model either: how to get a model, "Learn from my data"', () => {
    const m = noPublishedMessage(facts(0, 0))
    expect(text(m)).toBe(
      'No published models are available yet, and you have no saved models. To predict, learn models from patients with known outcomes, or open a model file in Your models.',
    )
    expect(buttons(m)).toEqual(['Learn from my data', 'Go to Your models'])
  })

  it('the saved models failed to load: says so, with Retry', () => {
    const m = noPublishedMessage(failed)
    expect(text(m)).toBe(
      'No published models are available yet. Your saved models could not be loaded.',
    )
    expect(buttons(m)).toEqual(['Retry', 'Go to Your models'])
  })
})

describe('D list: none of the P published models can run', () => {
  it('the line, with no saved clause while the saved models load or when none can run', () => {
    for (const saved of [loading, counting(2), facts(2, 0), failed]) {
      const line = noPublishedCanRunLine(7, saved)
      expect(line.text).toBe(
        'None of the 7 published models can run on this file. Each row says what is missing.',
      )
      expect(line.actions).toEqual([])
    }
    expect(noPublishedCanRunLine(1, loading).text).toBe(
      'The 1 published model cannot run on this file. Its row says what is missing.',
    )
  })

  it('names the saved models that can run, with "Use my saved models"', () => {
    const line = noPublishedCanRunLine(7, facts(4, 2))
    expect(line.text).toBe(
      'None of the 7 published models can run on this file. Each row says what is missing. 2 of your saved models can run on it.',
    )
    expect(buttons(line)).toEqual(['Use my saved models'])
  })
})

describe('I: no saved model at all, by the published models', () => {
  it('published models loading: says it checks them, names no number', () => {
    for (const published of [loading, counting(5)]) {
      const m = noSavedMessage(published)
      expect(text(m)).toBe('You have no saved models yet. Checking the published models…')
      expect(text(m)).not.toMatch(/\d/)
      expect(m.actions).toEqual([])
    }
  })

  it('F of P published can run: the counts and "Use the published models"', () => {
    const m = noSavedMessage(facts(5, 3))
    expect(text(m)).toBe('You have no saved models yet. 3 of the 5 published models can run on this file.')
    expect(buttons(m)).toEqual(['Use the published models'])
    expect(text(noSavedMessage(facts(1, 1)))).toBe(
      'You have no saved models yet. The 1 published model can run on this file.',
    )
  })

  it('P published, none can run: says so, with "See the published models"', () => {
    const m = noSavedMessage(facts(5, 0))
    expect(text(m)).toBe(
      'You have no saved models yet, and none of the 5 published models can run on this file.',
    )
    expect(buttons(m)).toEqual(['See the published models', 'Go to Your models'])
    expect(text(noSavedMessage(facts(1, 0)))).toBe(
      'You have no saved models yet, and the 1 published model cannot run on this file.',
    )
  })

  it('no published model (or its load failed): how to get a model, "Learn from my data"', () => {
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
      'None of your 3 saved models can run on this file. Each row says what is missing. 2 published models can run on it.',
    )
    expect(buttons(line)).toEqual(['Use the published models'])
    expect(noSavedCanRunLine(3, facts(5, 1)).text).toContain('1 published model can run on it.')
  })
})

it('I list hidden by the search or the filters: its own line', () => {
  expect(SAVED_FILTERED_EMPTY).toBe('No saved models match the search or the filters.')
})
