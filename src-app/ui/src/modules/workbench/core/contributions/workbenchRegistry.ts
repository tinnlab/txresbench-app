// The FOUR contribution registries + the `Contributions` object + the process-wide
// `workbenchRegistry` singleton (ITEM-8). Parallel typed singletons (the
// `ChatExtensionRegistry` parallel-Maps model, package-export-friendly) over the
// app-internal `Slots` declaration-merge seam.
//
// The set was nine. ITEM-9 deleted `selectionActions` with the selection feature;
// ITEM-33/34/35 deleted the remaining five ZERO-CONTRIBUTOR slots (`fieldProviders`,
// `plotTypes`, `resultRenderers`, `commands`, `collections`) — the rationale per slot is
// in `types.ts`. What survives is the set that actually HAS production contributors:
// analyses (the declarative processor packages), views (the shell canvas + declarative
// processor surfaces) and statusBarItems (the shell's own indicators). ITEM-1 ADDS a
// fourth — `sections`, the Visualize-pane blocks — which is a NEW slot precisely so a
// section is unreachable from the view/docking path (DEC-1).

import { Registry } from './registry.ts'
import { globalSingleton } from '../internal/globalSingleton.ts'
import type {
  AnalysisContribution,
  SectionContribution,
  StatusBarItemContribution,
  ViewContribution,
} from './types.ts'

/** The fixed set of contribution points the shell owns (§1). */
export interface Contributions {
  analyses: Registry<AnalysisContribution>
  views: Registry<ViewContribution>
  statusBarItems: Registry<StatusBarItemContribution>
  /** ITEM-1 — Visualize-pane SECTIONS. A separate slot from `views` on purpose: a
   *  section registered here can never reach the docking/placement path. */
  sections: Registry<SectionContribution>
}

function createContributions(): Contributions {
  return {
    analyses: new Registry<AnalysisContribution>('analyses'),
    views: new Registry<ViewContribution>('views'),
    statusBarItems: new Registry<StatusBarItemContribution>('statusBarItems'),
    sections: new Registry<SectionContribution>('sections'),
  }
}

/**
 * The process-wide contribution registry singleton — the single object built-ins
 * register into and the shell renders from. Pinned on `globalThis` (via the shared
 * `globalSingleton` helper, same guard every package singleton uses) so an HMR
 * reload / duplicate module instance shares ONE registry.
 */
export const workbenchRegistry: Contributions = globalSingleton('__txr_workbench_registry__', createContributions)

/** The registry keys, for iteration (MCP projection, discovery). */
export const CONTRIBUTION_KINDS = ['analyses', 'views', 'statusBarItems', 'sections'] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

/** Test-only: reset every registry (test isolation). */
export function resetWorkbenchRegistry(): void {
  for (const kind of CONTRIBUTION_KINDS) {
    workbenchRegistry[kind].clear()
  }
}
