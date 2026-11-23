import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { InstanceHandlerMissingError, InstanceNotFoundError } from '../instanceErrors'
import {
  METHODS_SET_TICKED,
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
// `views.list`. The preset buttons call the same handler. Until the
// picker's method list has loaded (the first load, or a first load that
// failed) the buttons are not on screen and the handler refuses with
// `UNAVAILABLE` (the snapshot's `loading` / `load_error` say why): a preset
// applied to an empty list would select nothing and stop the page's
// recommended selection.
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
    'On the choose-methods page, select the methods of one preset: recommended, all that can run, fast only (under 1 min each), or none. It replaces the current selection. Refused until the method list has loaded.',
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

// The card-checkbox tick (AOC part 2): a card click calls it with ONE key,
// and the choose-methods page's automatic steps (untick-on-manual-off) call
// it with the required methods' keys. Same instance / context / permission
// shape as `methods.applyPreset`; `stateful: false` — the tick is atomic
// and the result does not depend on the selection the caller last read.
defineAction({
  id: METHODS_SET_TICKED,
  title: 'Tick or untick methods',
  permission: Permissions.McpUse,
  mutating: true,
  kind: 'instance',
  stateful: false,
  context: TXR_METHOD_PICKER_CONTEXT,
  group: 'Analysis',
  aliases: ['select a method', 'deselect a method', 'tick a method'],
  keywords: ['methods', 'tick', 'selected methods'],
  description:
    "On the choose-methods page, tick or untick the named methods (one key per click; the Extra-inputs switch's automatic untick passes all of them at once). Refused until the method list has loaded, and refused for a method that cannot run with these files.",
  params: z.object({
    view_id: z.string().describe('The method picker (views.list, type txr.method-picker).'),
    keys: z.array(z.string()).describe('The method keys to tick or untick.'),
    ticked: z.boolean().describe('Tick (true) or untick (false).'),
  }),
  run: ({ view_id, keys, ticked }, ctx) => {
    const picker = ctx.instance(TXR_METHOD_PICKER_CONTEXT, view_id)
    if (picker === undefined) throw new InstanceNotFoundError(view_id)
    const handler = picker.handlers[METHODS_SET_TICKED]
    if (handler === undefined) throw new InstanceHandlerMissingError(view_id, METHODS_SET_TICKED)
    return handler({ keys, ticked }, ctx)
  },
})
