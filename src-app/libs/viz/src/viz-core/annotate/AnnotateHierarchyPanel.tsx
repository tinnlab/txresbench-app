// AnnotateHierarchyPanel.tsx — the context-bound adapter that drives the pure `HierarchyTreePanel`
// from ITS OWN pane's `AnnotateStore` (ITEM-11). Mirrors how `AnnotateControls` consumes the
// `AnnotateProvider` context: reactive reads via `useAnnotate`, imperative actions via the raw
// store. The tree is over the cell's vector annotations (each carries `level` + `parentId`); the
// "Resolve hierarchy" action runs the containment resolve and reports "resolved N of M".

import { useMemo, useState } from 'react'
import { useAnnotate, useAnnotateStore } from './AnnotateContext'
import { HierarchyTreePanel, type HierarchyNode } from './HierarchyTreePanel'

export interface AnnotateHierarchyPanelProps {
  /** M6 — the owning pane, so N open docks get distinct testids + accessible names. */
  readonly paneId?: string
}

export function AnnotateHierarchyPanel({ paneId }: AnnotateHierarchyPanelProps = {}) {
  const store = useAnnotateStore()
  // The ACTIVE level is PER-PANE authoring intent (DEC-17, amended INV-11) — the workspace-shared
  // authoring store that used to intercept this write is deleted, so two open panes each describe
  // and filter their own tree.
  const setActiveLevel = (lvl: string | null) => store.getState().setActiveLevel(lvl)
  const byId = useAnnotate(s => s.byId)
  const ids = useAnnotate(s => s.ids)
  const classes = useAnnotate(s => s.classes)
  const levels = useAnnotate(s => s.levels)
  const activeLevel = useAnnotate(s => s.activeLevel)
  const selection = useAnnotate(s => s.selection)
  const [readout, setReadout] = useState<string | null>(null)

  const classColor = useMemo(() => {
    const m = new Map<string, readonly [number, number, number]>()
    for (const c of classes) m.set(c.id, c.color)
    return m
  }, [classes])

  const nodes = useMemo<HierarchyNode[]>(
    () =>
      ids.map(id => {
        const a = byId[id]
        return {
          id,
          label: a?.label ?? null,
          level: a?.level ?? null,
          parentId: a?.parentId ?? null,
          color: a?.classId ? classColor.get(a.classId) : undefined,
        }
      }),
    [ids, byId, classColor],
  )

  return (
    <HierarchyTreePanel
      testIdPrefix={paneId ? `viz-hierarchy-${paneId}` : 'viz-hierarchy'}
      paneLabel={paneId}
      nodes={nodes}
      levels={levels}
      activeLevel={activeLevel}
      onSetActiveLevel={lvl => setActiveLevel(lvl)}
      selectedIds={selection}
      onSelect={id => store.getState().select(id)}
      onResolve={() => {
        const total = store.getState().ids.length
        const changed = store.getState().resolveHierarchy()
        setReadout(`resolved ${changed} of ${total}`)
      }}
      resolveReadout={readout}
    />
  )
}
