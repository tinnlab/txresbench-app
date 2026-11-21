import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { InstanceHandlerMissingError, InstanceNotFoundError } from '../instanceErrors'
import { TxrIntake, useTxrIntakeStore } from '@/modules/txrintake/stores/TxrIntake.store'
import { TXR_STEP_CONTEXT, useStepTrailStore } from '@/modules/txrintake/lib/stepTrail'
import { drawDayError } from '@/modules/txrintake/lib/dayChoices'
import { RUN_SETTINGS_SET_DAY, TXR_RUN_SETTINGS_CONTEXT } from '@/modules/txrrun/lib/settings'

// The day choices of a new analysis: the questions step's "Last draw you will
// use" and step 4's decision day and look-ahead day. A suggested day button and
// a typed day run these actions, so the command palette and the AI take the
// same path as the person.
//
// `flow.setLastDrawDay` is a global action on the questions step: the last-draw
// answer lives in the intake store (it is also the file check's decision day,
// so the step checks the files again after it).
//
// `runSettings.setDay` is an INSTANCE action: step 4's settings belong to the
// choose-methods page, which joins the instance registry with `useAction`
// under the type `txr.run-settings` (the AI finds the `view_id` with
// `views.list`). `stateful: false`: the action sets one day, whatever the
// caller last read.
//
// `permission`: the step routes carry no route permission, so these use the
// permission the registered navigation action (`app.navigate`,
// `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrintake/module.tsx` (step 4's
// module depends on it).


/** The refusal away from the questions step. */
export const LAST_DRAW_NOT_ON_STEP = 'Open the questions step of a new analysis first.'

defineAction({
  id: 'flow.setLastDrawDay',
  title: 'Set the last draw you will use',
  permission: Permissions.McpUse,
  mutating: true,
  context: TXR_STEP_CONTEXT,
  aliases: ['last draw day', 'set the decision day'],
  description:
    'On the questions step of a new analysis, set "Last draw you will use": the day, counted from the start of treatment, of the last blood draw the analysis uses. It is also the decision day. A whole day from 1; the files are checked again for the new day.',
  params: z.object({
    day: z.number().int().describe('The day of the last draw, counted from the start of treatment.'),
  }),
  run: ({ day }) => {
    if (useStepTrailStore.getState().current?.step !== 'study') throw new Error(LAST_DRAW_NOT_ON_STEP)
    const facts = useTxrIntakeStore.getState().dayFacts
    const problem =
      facts === null
        ? day >= 1
          ? null
          : 'Choose a whole day from 1.'
        : drawDayError(day, facts.limits.look_ahead_day_max)
    if (problem !== null) throw new Error(problem)
    TxrIntake.patchStudy({ lastDrawDay: day })
    TxrIntake.patchParameters({ decision_day: day })
    return { day }
  },
})

defineAction({
  id: RUN_SETTINGS_SET_DAY,
  title: 'Set the decision day or the look-ahead day',
  permission: Permissions.McpUse,
  mutating: true,
  kind: 'instance',
  stateful: false,
  context: TXR_RUN_SETTINGS_CONTEXT,
  group: 'Analysis',
  aliases: ['set the look-ahead day', 'look ahead to', 'set the decision day'],
  description:
    'On the choose-methods step, set the decision day or the look-ahead day (the day the prediction is for), both counted from the start of treatment. The look-ahead day must be after the decision day and within the limit; a day where no patient has a known outcome is refused. With a ready-made or saved model the look-ahead is the model\'s own and cannot be set.',
  params: z.object({
    view_id: z.string().describe('The run settings (views.list, type txr.run-settings).'),
    field: z
      .enum(['decision_day', 'look_ahead_day'])
      .describe('"decision_day" or "look_ahead_day".'),
    day: z.number().int().describe('The day, counted from the start of treatment.'),
  }),
  run: ({ view_id, field, day }, ctx) => {
    const settings = ctx.instance(TXR_RUN_SETTINGS_CONTEXT, view_id)
    if (settings === undefined) throw new InstanceNotFoundError(view_id)
    const handler = settings.handlers[RUN_SETTINGS_SET_DAY]
    if (handler === undefined) throw new InstanceHandlerMissingError(view_id, RUN_SETTINGS_SET_DAY)
    return handler({ field, day }, ctx)
  },
})
