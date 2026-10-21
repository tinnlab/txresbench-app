import { runAction } from './defineAction'
import { createActionContext } from './ctx'
import { instancesOfType } from './instanceRegistry'
import { abortActiveChoreography } from './choreography'

// A thin `window.__actions` drive-seam (richer-actions) — the e2e analog of
// `window.__workbench`: it lets a spec invoke an action exactly as the AI engine
// (`./engine.ts`) does (`runAction`) and resolve the focused workbench/datasets
// `view_id`. This grants NO capability beyond what the ⌘K palette + the AI agent
// already have: `runAction` runs the SAME permission-gated code path (the backend
// is authoritative), so a same-origin authenticated session could already do all of
// this. It exists so an e2e can prove the AI-only `dataset.add.byId` / `dataset.list`
// actions drive the visible choreography, which no palette-only path can reach.

export function installActionsSeam(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __actions?: unknown }).__actions = {
    /** Run an action as the AI engine would. `opts.abortAfterMs` supplies a
     *  `ctx.signal` that aborts after N ms (to prove mid-run interruption). */
    run: (id: string, params: Record<string, unknown>, opts?: { abortAfterMs?: number }) => {
      if (opts?.abortAfterMs != null) {
        const ac = new AbortController()
        setTimeout(() => ac.abort(), opts.abortAfterMs)
        return runAction(id, params, createActionContext({ signal: ac.signal }))
      }
      return runAction(id, params)
    },
    /** Interrupt the running choreography (the "stop / take over" affordance). */
    abortActive: () => abortActiveChoreography(),
    workbenchViewId: () => instancesOfType('workbench')[0]?.id,
    datasetsViewId: () => instancesOfType('datasets')[0]?.id,
  }
}
