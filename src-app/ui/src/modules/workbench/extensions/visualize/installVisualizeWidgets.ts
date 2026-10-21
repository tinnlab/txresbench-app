// `installVisualizeWidgets()` (ITEM-23 / DEC-2) — the VISUALIZE extension's own widget
// registration, through the ORDINARY `registerWidget` path.
//
// Modelled on `extensions/canvas/installCanvasWidgets.ts`, and for the identical reason: core
// is the transport, a capability is an extension. `entry_list` is a visualize control — it
// speaks entries, sources and dispositions, none of which core has a concept of — so listing it
// in core's closed `WIDGET_KINDS` would put a capability's vocabulary in the transport layer,
// which is precisely what `core/render/registry.ts`'s own header says the open-kind seam exists
// to stop.
//
// Unlike the canvas installer this one imports its renderer STATICALLY. The canvas defers
// because its renderers drag deck.gl/luma/viv (a measured 339.7 kB off the preloaded path);
// `entry_list` is a checkbox list and an input, so a lazy boundary would buy nothing and cost a
// Suspense wrapper on the boot path.

import { registerWidget } from '@/modules/workbench/core/render/registry'
import { EntryListRenderer } from './EntryListWidget'
import { LineageRenderer } from './LineageWidget'

/** The widget `kind`s the visualize extension OWNS. Deliberately NOT part of core's
 *  `WIDGET_KINDS` (DEC-2). `lineage` is the frozen-artifact version-chain readout (INV-7 /
 *  DEC-11) — a DISPLAY widget, joined through the same open seam as `entry_list`. */
export const VISUALIZE_WIDGET_KINDS = ['entry_list', 'lineage'] as const
export type VisualizeWidgetKind = (typeof VISUALIZE_WIDGET_KINDS)[number]

let installed = false

/** Register the visualize widget renderers. No-op after the first call. */
export function installVisualizeWidgets(): void {
  if (installed) return
  registerWidget('entry_list', EntryListRenderer)
  registerWidget('lineage', LineageRenderer)
  installed = true
}

/** Test-only reset of the installed flag. The widget REGISTRY is cleared by
 *  `__clearWidgetsForTests`; this is the other half, or a re-install after a clear would be a
 *  silent no-op and every later test would render an unregistered kind. */
export function __resetVisualizeWidgetsForTests(): void {
  installed = false
}
