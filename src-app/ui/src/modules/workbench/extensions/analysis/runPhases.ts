// The run TIMELINE reducer (ITEM-23), in its own module.
//
// It used to live in `AnalysisRunPanel.tsx`. It moved here when the run lifecycle moved
// into `runSession.ts`: the session reduces frames with no component mounted, so it
// needs this function, and the panel needs the session — importing it back out of the
// panel would be a cycle. It is pure and has always been unit-tested directly; the
// panel and `extensions/analysis/index.ts` both re-export it so no importer moved.

import type { RunPhase } from './RunProgressConsole'

/** Upsert a phase into the timeline (ITEM-23): a re-seen phase updates its pct; a NEW
 *  phase marks every prior phase done + appends itself active. */
export function upsertPhase(prev: RunPhase[], name: string, pct?: number): RunPhase[] {
  const idx = prev.findIndex(p => p.name === name)
  if (idx >= 0) {
    return prev.map((p, i) =>
      i === idx
        ? { name, pct: pct ?? p.pct, state: 'active' }
        : i < idx
          ? { ...p, state: 'done' }
          : p,
    )
  }
  return [...prev.map(p => ({ ...p, state: 'done' as const })), { name, pct, state: 'active' }]
}
