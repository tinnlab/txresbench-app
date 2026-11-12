// `installWidgets()` (PLAN.md ITEM-7/ITEM-8) — the FORM-CONTROL widget bootstrap of the
// builtin `widgets` extension, mirroring `@txresbench/viz`'s `installBuiltins()`. Registers a
// renderer for every core `WIDGET_KIND`. Idempotent: safe to call from any mount path.
//
// ITEM-36 / DEC-A: the five PLOT kinds (scatter/violin/bar/histogram/image) are no longer
// registered here. They are OWNED by `extensions/canvas`, which registers them through the
// same ordinary `registerWidget` seam (`canvas/installCanvasWidgets.ts`). Call
// `installBuiltinWidgets()` from `@/modules/workbench/extensions` to install BOTH — that is
// the behavioural equivalent of what this function used to do alone.

import { WIDGET_KINDS } from '@/modules/workbench/core'
// `artifact_ref` is CORE's own control (it reads the catalog channel core publishes and
// drives core's own resolver), so core PUBLISHES its renderer from the widget registry —
// the module whose job is renderer registration, and the one this installer already binds
// to. It cannot come off `core/index.ts`: `core/index.test.ts` pins that the public barrel
// loads under `node --test --experimental-strip-types`, which parses neither `.tsx` nor
// the parameter-property syntax in `@/core/workstore` that the resolver reaches through.
// Registration is otherwise ordinary, so the complete-by-kind guarantee below covers it
// exactly like every other core kind.
import {
  registerWidget,
  hasWidget,
  __clearWidgetsForTests,
  ArtifactRefRenderer,
} from '@/modules/workbench/core/render/registry'
import {
  AlertRenderer,
  ButtonRenderer,
  DatasetPickerRenderer,
  GroupRenderer,
  ListEditorRenderer,
  MultiSelectRenderer,
  RangeSliderRenderer,
  SelectRenderer,
  StatRenderer,
  TableRenderer,
  TabsRenderer,
  TextRenderer,
  TokenInputRenderer,
} from './renderers'
let installed = false

/** Register the builtin widget renderers. No-op after the first call. */
export function installWidgets(): void {
  if (installed) return
  registerWidget('select', SelectRenderer)
  registerWidget('text', TextRenderer)
  registerWidget('multiselect', MultiSelectRenderer)
  registerWidget('range_slider', RangeSliderRenderer)
  registerWidget('list-editor', ListEditorRenderer)
  registerWidget('tabs', TabsRenderer)
  registerWidget('token-input', TokenInputRenderer)
  registerWidget('table', TableRenderer)
  registerWidget('button', ButtonRenderer)
  registerWidget('alert', AlertRenderer)
  registerWidget('stat', StatRenderer)
  registerWidget('group', GroupRenderer)
  registerWidget('dataset-picker', DatasetPickerRenderer)
  registerWidget('artifact_ref', ArtifactRefRenderer)
  installed = true
}

/** Whether every CORE `WIDGET_KIND` has a registered renderer — the complete-by-kind
 *  invariant `installWidgets` guarantees for the form-control vocabulary. Extension-owned
 *  kinds (canvas' plots) are outside this check by construction (DEC-A). */
export function widgetsInstalledComplete(): boolean {
  installWidgets()
  return WIDGET_KINDS.every(kind => hasWidget(kind))
}

/** Test-only reset (clears the registry + the installed flag). */
export function __resetInstallWidgetsForTests(): void {
  installed = false
  __clearWidgetsForTests()
}
