// registryTail (ITEM-60) — the "tail" registry gap the shell audit flagged, resolved
// through a REGISTRY lookup instead of a hardcoded list:
//   · `LAYOUT_OPTIONS` — the canvas single/split control is driven by this registry so a
//     new canvas layout mode plugs in (or a viz view-layout contribution folds into it),
//     rather than the toolbar hardcoding `['single','split']`.
// Pure + framework-free (node-safe) so the lookups are unit-testable (TEST-527).
//
// ITEM-35 deleted the second half (`listCollections` over the `collections` registry).
// The registry had ZERO contributors, its own header conceded the surface "is provisioned
// by the BE host (slice-2) … no runtime surface", that BE surface never landed, and the
// reader's only importer was a test — a deferred gap that had been deferred long enough
// to be a dead descriptor.

import type { PlotLayout } from './types'

// ── canvas layout options (single / split, registry-driven) ──────────────────

export interface LayoutOption {
  value: PlotLayout
  label: string
  order: number
}

const LAYOUT_REGISTRY = new Map<PlotLayout, LayoutOption>()

export function registerLayoutOption(opt: LayoutOption): void {
  LAYOUT_REGISTRY.set(opt.value, opt)
}

/** The ordered canvas-layout options (the toolbar's Segmented reads THIS, not a literal). */
export function layoutOptions(): LayoutOption[] {
  return [...LAYOUT_REGISTRY.values()].sort((a, b) => a.order - b.order || a.value.localeCompare(b.value))
}

// Seed the two built-in canvas layouts (single hero / linked split).
registerLayoutOption({ value: 'single', label: 'Single', order: 0 })
registerLayoutOption({ value: 'split', label: 'Split', order: 1 })
