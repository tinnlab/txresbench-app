import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { InstanceHandlerMissingError, InstanceNotFoundError } from '../instanceErrors'
import {
  METHODS_APPLY_PRESET,
  TXR_METHOD_PICKER_CONTEXT,
  TXRMETHOD_PRESETS,
} from '@/modules/txrlist/lib/methodPicker'

// The method picker's actions (the choose-methods page, step 4 of a new
// analysis): a control a human can use is a registered, permissioned action
// that the command palette and the AI agent drive through the same handler.
//
// `methods.applyPreset` is an INSTANCE action. It targets one mounted
// `TxrMethodPicker` (its `view_id`), which joins the instance registry with
// `useAction` under the type `txr.method-picker` and declares the same page
// context while it is mounted (`useActiveContext`). The palette offers the
// action against that live picker; the AI finds the `view_id` with
// `views.list`. The preset buttons call the same handler.
//
// `stateful: false`: a preset REPLACES the selection with its own set, so the
// result does not depend on the selection the caller last read, and no
// `expected` state token is required. The picker still stamps a
// `_state_token` on its snapshot, moved by every selection change (a click, a
// tick, this action), for the world-model reads.
//
// `permission`: the choose-methods route carries no route permission, so this
// uses the permission the registered navigation action (`app.navigate`,
// `./appActions.ts`) uses.
//
// Sole runtime import site: `src/modules/txrlist/module.tsx` (the module that
// owns the picker).

defineAction({
  id: 'methods.applyPreset',
  title: 'Choose a method preset',
  permission: Permissions.McpUse,
  mutating: true,
  kind: 'instance',
  stateful: false,
  context: TXR_METHOD_PICKER_CONTEXT,
  group: 'Analysis',
  description:
    'On the choose-methods page, select the methods of one preset: recommended, all that can run, fast only (under 1 min each), or none. It replaces the current selection.',
  aliases: [
    'select recommended methods',
    'select all methods',
    'select fast methods',
    'clear the method selection',
  ],
  keywords: ['preset', 'methods'],
  params: z.object({
    view_id: z.string().describe('The method picker (views.list, type txr.method-picker).'),
    preset: z.enum(TXRMETHOD_PRESETS).describe('Preset: recommended, all, fast or none'),
  }),
  run: ({ view_id, preset }, ctx) => {
    const picker = ctx.instance(TXR_METHOD_PICKER_CONTEXT, view_id)
    if (picker === undefined) throw new InstanceNotFoundError(view_id)
    const handler = picker.handlers[METHODS_APPLY_PRESET]
    if (handler === undefined) throw new InstanceHandlerMissingError(view_id, METHODS_APPLY_PRESET)
    return handler({ preset }, ctx)
  },
})
