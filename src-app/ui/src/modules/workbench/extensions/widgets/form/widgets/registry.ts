// The Tier-3 host-widget SEAM (ITEM-53). Formerly a CLOSED hardcoded `Record` that
// baked DOMAIN-specific widgets (an index-set selector, a feature selector) into the
// domain-agnostic shell; now an OPEN registration seam — `registerWidget(kind,
// component)` — mirroring the component-keyed `ViewHost.registerViewComponent` /
// `artifactRegistry.registerResultComponent` pattern (a plain id→component map with a
// register/resolve pair + a test-only reset). The DOMAIN widgets moved OUT of the
// shell AND out of the app builtin (ITEM-53); the host keeps only the SEAM + the generic
// `makeStubWidget` fallback.
//
// ZERO-REGISTRANT NOTE (ITEM-39). The seam currently has NO registrations: the four
// general dimension primitives that used to register at workbench boot are deleted (no
// shipping processor spec instantiated any of their widget kinds — a `widget:` grep over
// `packages/**/*.yaml` returns nothing), and the declarative `view_spec` engine has its
// OWN widget registry (`core/render/registry.ts`), which is where every shipping surface
// composes today. This registry stays because it is the open seam for a CODE-schema
// analysis's `type:'widget'` field, and `resolveWidget` still renders a labeled stub for
// any unregistered kind rather than crashing. If no code-schema widget field ever appears,
// delete this seam with `WidgetField` — do not re-populate it with app-side fixtures.

import type { ComponentType } from 'react'
import { makeStubWidget } from './StubWidget'

/**
 * The props every Tier-3 host widget receives from `WidgetField`. `value`/`onChange`
 * bind the widget to `value[field.id]`; `config` is the field's opaque per-widget
 * config (`WidgetField.config`).
 */
export interface HostWidgetProps {
  value: unknown
  onChange: (value: unknown) => void
  config?: Record<string, unknown>
  'data-testid'?: string
}

export type HostWidget = ComponentType<HostWidgetProps>

// The open id→component seam. A plain module singleton (matches `artifactRegistry` /
// `ViewHost` — a component seam, not a `Contribution` registry), so an extension's
// boot-time `registerWidget` populates the one map the shell resolves from.
const WIDGETS: Record<string, HostWidget> = {}

/** Register (or replace) a Tier-3 widget by its `WidgetField.widget` id. Called at
 *  discovery by a widget-contributing extension (last-wins, HMR-safe). */
export function registerWidget(kind: string, component: HostWidget): void {
  WIDGETS[kind] = component
}

/** Raw seam lookup — the registered component, or `undefined` when unregistered. */
export function getWidget(kind: string): HostWidget | undefined {
  return WIDGETS[kind]
}

/**
 * Resolve a widget for RENDERING: the registered component, or a labeled STUB
 * fallback for an unregistered kind — never `undefined`, never a throw (a visible
 * placeholder, à la `ViewHost`'s unresolved note). This is what keeps a schema that
 * names an unknown/not-yet-wired widget rendering cleanly instead of crashing.
 */
export function resolveWidget(kind: string): HostWidget {
  return WIDGETS[kind] ?? makeStubWidget(`Unknown widget “${kind}”`, 'not registered in this build')
}

/** The registered widget kinds (introspection / the e2e window seam), id-sorted. */
export function registeredWidgetKinds(): string[] {
  return Object.keys(WIDGETS).sort()
}

/** Test-only: clear the seam (test / HMR isolation). */
export function __resetWidgetRegistry(): void {
  for (const k of Object.keys(WIDGETS)) delete WIDGETS[k]
}

// The read-only e2e window seam (mirrors `discover.ts`'s `window.__workbenchRegistry`,
// which is out of this round's scope to extend — so the form seams get their own
// namespaced object). Merged (not replaced) so the field-renderer registry can add its
// own `fieldTypes()` accessor to the SAME object.
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __workbenchFormRegistry?: { widgets?: () => string[]; fieldTypes?: () => string[] }
  }
  w.__workbenchFormRegistry = { ...(w.__workbenchFormRegistry ?? {}), widgets: registeredWidgetKinds }
}
