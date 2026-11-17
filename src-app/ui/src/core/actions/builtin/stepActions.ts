import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { takeStepBack, TXR_STEP_CONTEXT } from '@/modules/txrintake/lib/stepTrail'

// The step-flow actions of a new analysis: the Back button of each step view.
// Registered once so the button, the command palette and the AI take the same
// path.
//
// `permission`: the step routes carry no route permission
// (`modules/txrintake/module.tsx`), so these use the permission the
// registered navigation action (`app.navigate`, `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrintake/module.tsx`.

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
