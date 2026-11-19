/**
 * The model step's empty and none-can-run messages (screens D and I): what
 * the page says when its own list has no model to run, given what the OTHER
 * list holds for the same checked file.
 *
 * The D screen lists the ready-made models (the models the TxResBench team
 * trained and released: the pretrained catalogue), the I screen your saved
 * models. The UI calls the D list "ready-made models" everywhere, so a user
 * can tell them from the methods (which learn from your data) and from their
 * own saved models.
 * When the screen's list is empty (or none of its models can run), the
 * message names the other list: how many models it has and how many can run
 * on this file ("can run" = fit + some, the D header's rule), with the button
 * that switches to it. A number is never shown while its data is loading:
 * the message says what it is checking instead.
 *
 * Pure: the pages compute the facts from the store and the hooks they
 * already use; this module only words them.
 */

/** What the page knows about one model list for the checked file. */
export interface TxrModelListFacts {
  /** The list (or its verdicts) failed to load. */
  failed: boolean
  /** How many models the list has; null while it loads. */
  total: number | null
  /** How many of them can run on this file (fit + some); null while the verdicts load. */
  canRun: number | null
}

/** The message buttons (each page maps an id to its registered action). */
export type TxrModelsEmptyActionId =
  | 'use-saved'
  | 'see-saved'
  | 'use-published'
  | 'see-published'
  | 'learn'
  | 'your-models'
  | 'retry'

export interface TxrModelsEmptyAction {
  id: TxrModelsEmptyActionId
  label: string
}

/** A whole-page message (the list is empty): a lead line, an optional
 *  intro (what this list is), a body, the buttons. */
export interface TxrModelsEmptyMessage {
  title: string
  /** What the screen's list is, before the body (D only: what ready-made models are). */
  intro: string | null
  body: string | null
  actions: TxrModelsEmptyAction[]
}

/** A line above a list none of whose models can run, with its buttons. */
export interface TxrModelsNoneCanRunLine {
  text: string
  actions: TxrModelsEmptyAction[]
}

const ACTION_LABELS: Record<TxrModelsEmptyActionId, string> = {
  'use-saved': 'Use my saved models',
  'see-saved': 'See my saved models',
  'use-published': 'Use the ready-made models',
  'see-published': 'See the ready-made models',
  learn: 'Learn from my data',
  'your-models': 'Go to Your models',
  retry: 'Retry',
}

function actions(...ids: TxrModelsEmptyActionId[]): TxrModelsEmptyAction[] {
  return ids.map(id => ({ id, label: ACTION_LABELS[id] }))
}

/** "1 saved model" / "3 saved models". */
function savedModels(n: number): string {
  return n === 1 ? '1 saved model' : `${n} saved models`
}

/** The text of the I screen's search/filter empty list. */
export const SAVED_FILTERED_EMPTY = 'No saved models match the search or the filters.'

const NO_PUBLISHED = 'No ready-made models yet'

/** What ready-made models are, and that none are released (D's empty intro). */
export const NO_PUBLISHED_INTRO =
  'Ready-made models are already trained by the TxResBench team, so they predict without learning from your data. None have been released yet.'

/** Screen D with no ready-made model at all, by what your saved models hold. */
export function noPublishedMessage(saved: TxrModelListFacts): TxrModelsEmptyMessage {
  const message = (body: string | null, ids: TxrModelsEmptyActionId[]): TxrModelsEmptyMessage => ({
    title: NO_PUBLISHED,
    intro: NO_PUBLISHED_INTRO,
    body,
    actions: actions(...ids),
  })
  if (saved.failed) {
    return message('Your saved models could not be loaded.', ['retry', 'your-models'])
  }
  if (saved.total === 0) {
    return message(
      "You don't have any saved models yet. To make some, learn from patients whose outcomes you know.",
      ['learn', 'your-models'],
    )
  }
  if (saved.total === null || saved.canRun === null) {
    return message('Checking your saved models…', [])
  }
  if (saved.canRun > 0) {
    return message(
      saved.total === 1
        ? 'You can predict with your own saved model instead: it can run on this file.'
        : `You can predict with your own saved models instead: ${saved.canRun} of your ${saved.total} saved models can run on this file.`,
      ['use-saved', 'your-models'],
    )
  }
  return message(
    saved.total === 1
      ? 'You have 1 saved model, but it cannot run on this file: its row on the saved list says what is missing.'
      : `You have ${savedModels(saved.total)}, but none can run on this file: each row on the saved list says what is missing.`,
    ['see-saved', 'your-models'],
  )
}

const NO_SAVED = 'You have no saved models yet.'

/** Screen I with no saved model at all, by what the ready-made models hold. */
export function noSavedMessage(published: TxrModelListFacts): TxrModelsEmptyMessage {
  if (published.failed || published.total === 0) {
    return {
      title: NO_SAVED,
      intro: null,
      body: 'Save models from an analysis that learns from your data, or open a model file in Your models.',
      actions: actions('learn', 'your-models'),
    }
  }
  if (published.total === null || published.canRun === null) {
    return { title: NO_SAVED, intro: null, body: 'Checking the ready-made models…', actions: [] }
  }
  if (published.canRun > 0) {
    return {
      title: NO_SAVED,
      intro: null,
      body:
        published.total === 1
          ? 'The 1 ready-made model can run on this file.'
          : `${published.canRun} of the ${published.total} ready-made models can run on this file.`,
      actions: actions('use-published'),
    }
  }
  return {
    title:
      published.total === 1
        ? 'You have no saved models yet, and the 1 ready-made model cannot run on this file.'
        : `You have no saved models yet, and none of the ${published.total} ready-made models can run on this file.`,
    intro: null,
    body: null,
    actions: actions('see-published', 'your-models'),
  }
}

/**
 * Screen D's list when none of its `total` ready-made models can run on this
 * file: the line, plus your saved models that can (once that is known).
 */
export function noPublishedCanRunLine(
  total: number,
  saved: TxrModelListFacts,
): TxrModelsNoneCanRunLine {
  const lead =
    total === 1
      ? 'The 1 ready-made model cannot run on this file. Its row says what is missing.'
      : `None of the ${total} ready-made models can run on this file. Each row says what is missing.`
  if (!saved.failed && saved.canRun !== null && saved.canRun > 0) {
    return {
      text: `${lead} ${saved.canRun} of your saved models can run on it.`,
      actions: actions('use-saved'),
    }
  }
  return { text: lead, actions: [] }
}

/**
 * Screen I's list when none of your `total` saved models can run on this
 * file: the line, plus the ready-made models that can (once that is known).
 */
export function noSavedCanRunLine(
  total: number,
  published: TxrModelListFacts,
): TxrModelsNoneCanRunLine {
  const lead =
    total === 1
      ? 'Your 1 saved model cannot run on this file. Its row says what is missing.'
      : `None of your ${total} saved models can run on this file. Each row says what is missing.`
  if (!published.failed && published.canRun !== null && published.canRun > 0) {
    return {
      text: `${lead} ${published.canRun} ready-made ${published.canRun === 1 ? 'model' : 'models'} can run on it.`,
      actions: actions('use-published'),
    }
  }
  return { text: lead, actions: [] }
}
