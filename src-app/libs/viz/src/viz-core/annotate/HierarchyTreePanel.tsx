// HierarchyTreePanel.tsx — the object-hierarchy tree + level panel (ITEM-11).
//
// Presentational only (viz-core purity — no store / deck / GL): the host wires every callback to
// the `AnnotateStore` hierarchy actions (`setActiveLevel`, `setParent`, `select`,
// `resolveHierarchy`). Renders a collapsible object tree grouped by the single-parent forest, a
// level picker + show-only-this-level filter, bidirectional select-in-tree ↔ select-on-canvas, and
// a "Resolve hierarchy" action with a determinate "resolved N of M" readout. Large trees are
// windowed past `virtualizeThreshold` visible rows (scale checklist — a WSI can carry 10⁴ cells).

import { useMemo, useState, type CSSProperties } from 'react'
import { buildForest, childIdsOf, type HierId } from './hierarchy'

/** One row the panel renders: an object's id + display + its level + parent. */
export interface HierarchyNode {
  readonly id: HierId
  /** display label (falls back to the id). */
  readonly label?: string | null
  /** hierarchy level tag (host-supplied open string); null ⇒ unleveled. */
  readonly level?: string | null
  readonly parentId?: HierId | null
  /** optional swatch color `[r,g,b]` (the object's class color). */
  readonly color?: readonly [number, number, number]
}

export interface HierarchyTreePanelProps {
  readonly nodes: readonly HierarchyNode[]
  /** host-supplied ordered level vocabulary (coarse→fine); empty ⇒ no level controls (DEC-8). */
  readonly levels: readonly string[]
  /** active authoring/filter level (null = all levels shown). */
  readonly activeLevel: string | null
  readonly onSetActiveLevel: (level: string | null) => void
  readonly selectedIds: ReadonlySet<HierId>
  readonly onSelect: (id: HierId) => void
  /** run the containment resolve; the host returns how many objects were re-parented. */
  readonly onResolve?: () => void
  /** last-resolve readout, e.g. "resolved 3 of 12" (null = never run / hide). */
  readonly resolveReadout?: string | null
  /** windowing threshold (visible rows) — default 500 (DEC-10). */
  readonly virtualizeThreshold?: number
  /**
   * BLIND-AUDIT M6 — testid prefix AND accessible-name qualifier. One of these panels renders per
   * OPEN annotate dock (INV-12), so fixed ids like `viz-hierarchy-tree` made every DOM assertion
   * ambiguous (silently asserting the FIRST pane — the single-pane blind spot this feature exists
   * to remove) and gave two panes the same accessible name. Hosts pass the pane id.
   */
  readonly testIdPrefix?: string
  /** Pane name appended to the group's accessible name, e.g. "Object hierarchy — Slide A". */
  readonly paneLabel?: string
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 12,
  fontSize: 12,
  minWidth: 200,
}
const sectionTitleStyle: CSSProperties = { fontWeight: 600, marginBottom: 4 }
const swatchStyle = (color?: readonly [number, number, number]): CSSProperties => ({
  width: 10,
  height: 10,
  borderRadius: 2,
  flex: '0 0 auto',
  background: color ? `rgb(${color[0]},${color[1]},${color[2]})` : 'transparent',
  border: '1px solid var(--border, rgba(0,0,0,0.2))',
})

function nodeLabel(n: HierarchyNode): string {
  return (n.label && n.label.length > 0 ? n.label : n.id).slice(0, 64)
}

/** One flattened, indented, visible tree row (post collapse + level filter). */
interface FlatRow {
  readonly id: HierId
  readonly depth: number
  readonly hasChildren: boolean
  readonly collapsed: boolean
  readonly node: HierarchyNode
}

export function HierarchyTreePanel({
  nodes,
  levels,
  activeLevel,
  onSetActiveLevel,
  selectedIds,
  onSelect,
  onResolve,
  resolveReadout,
  virtualizeThreshold = 500,
  testIdPrefix = 'viz-hierarchy',
  paneLabel,
}: HierarchyTreePanelProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<HierId>>(() => new Set())

  const byId = useMemo(() => {
    const m = new Map<HierId, HierarchyNode>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])

  const forest = useMemo(() => {
    const order = nodes.map(n => n.id)
    const parentOf = new Map<HierId, HierId | null>()
    for (const n of nodes) parentOf.set(n.id, n.parentId ?? null)
    return buildForest(order, parentOf)
  }, [nodes])

  // Flatten to visible rows: pre-order DFS, skipping subtrees under a collapsed node. A level
  // filter (activeLevel) hides rows NOT on that level but keeps their descendants reachable, so
  // "show only cells" still shows the cells (the common review filter).
  const rows = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = []
    const levelFilter = activeLevel
    const walk = (id: HierId, depth: number): void => {
      const node = byId.get(id)
      if (!node) return
      const kids = childIdsOf(forest, id)
      const isCollapsed = collapsed.has(id)
      const passesFilter = levelFilter == null || (node.level ?? null) === levelFilter
      if (passesFilter) {
        out.push({ id, depth, hasChildren: kids.length > 0, collapsed: isCollapsed, node })
      }
      // Honor collapse only for a node that is itself a VISIBLE row. Under an active level filter a
      // filtered-OUT ancestor (e.g. a collapsed coarse "tissue" node while filtering to "cell") must
      // still be traversed, or its filtered-in descendants vanish → a false "No objects at level X".
      const honorCollapse = isCollapsed && (levelFilter == null || passesFilter)
      if (!honorCollapse) for (const c of kids) walk(c, passesFilter ? depth + 1 : depth)
    }
    for (const r of forest.roots) walk(r, 0)
    return out
  }, [forest, byId, collapsed, activeLevel])

  const toggle = (id: HierId): void =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Windowing: past the threshold, cap rendered rows (a real virtualizer would swap in a windowed
  // list — here we bound the DOM so a 10⁴-node tree never renders 10⁴ rows at once).
  const windowed = rows.length > virtualizeThreshold
  const shown = windowed ? rows.slice(0, virtualizeThreshold) : rows

  return (
    <div style={panelStyle} data-testid={`${testIdPrefix}-panel`} role="group" aria-label={paneLabel ? `Object hierarchy — ${paneLabel}` : 'Object hierarchy'}>
      {/* ── Level picker + filter ────────────────────────────────────────────────────────── */}
      {levels.length > 0 && (
        <div>
          <div style={sectionTitleStyle}>Level</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => onSetActiveLevel(null)}
              aria-pressed={activeLevel == null}
              data-testid={`${testIdPrefix}-level-all`}
              style={{ fontWeight: activeLevel == null ? 700 : 400 }}
            >
              All
            </button>
            {levels.map(lvl => {
              const active = activeLevel === lvl
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => onSetActiveLevel(active ? null : lvl)}
                  aria-pressed={active}
                  data-testid={`${testIdPrefix}-level-${lvl}`}
                  style={{ fontWeight: active ? 700 : 400 }}
                >
                  {lvl}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Resolve action + readout ─────────────────────────────────────────────────────── */}
      {onResolve && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" onClick={onResolve} data-testid={`${testIdPrefix}-resolve`}>
            Resolve hierarchy
          </button>
          {resolveReadout && (
            <span data-testid={`${testIdPrefix}-resolve-readout`} style={{ opacity: 0.75 }}>
              {resolveReadout}
            </span>
          )}
        </div>
      )}

      {/* ── Tree ─────────────────────────────────────────────────────────────────────────── */}
      <div>
        <div style={sectionTitleStyle}>
          Objects <span style={{ opacity: 0.6, fontWeight: 400 }}>({nodes.length})</span>
        </div>
        {shown.length === 0 ? (
          <div data-testid={`${testIdPrefix}-empty`} style={{ opacity: 0.6 }}>
            No objects{activeLevel ? ` at level "${activeLevel}"` : ''}.
          </div>
        ) : (
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}
            data-testid={`${testIdPrefix}-tree`}
          >
            {shown.map(row => {
              const selected = selectedIds.has(row.id)
              const name = nodeLabel(row.node)
              // One string serves as BOTH the accessible name and the hover text.
              const toggleLabel = row.collapsed ? `Expand ${name}` : `Collapse ${name}`
              return (
                <li
                  key={row.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, paddingInlineStart: row.depth * 14 }}
                >
                  {row.hasChildren ? (
                    <button
                      type="button"
                      onClick={() => toggle(row.id)}
                      aria-label={toggleLabel}
                      title={toggleLabel}
                      aria-expanded={!row.collapsed}
                      data-testid={`${testIdPrefix}-toggle-${row.id}`}
                      style={{ width: 16, flex: '0 0 auto' }}
                    >
                      {row.collapsed ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span style={{ width: 16, flex: '0 0 auto' }} aria-hidden="true" />
                  )}
                  <span style={swatchStyle(row.node.color)} aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => onSelect(row.id)}
                    aria-pressed={selected}
                    data-testid={`${testIdPrefix}-node-${row.id}`}
                    style={{
                      flex: '1 1 auto',
                      textAlign: 'start',
                      fontWeight: selected ? 700 : 400,
                      // theme-aware subtle highlight (design-system `--accent` = "active subtle
                      // highlight"), not a hardcoded blue — respects accent + dark mode, matches the
                      // adjacent kit-styled AnnotateControls dock.
                      background: selected ? 'var(--accent)' : 'transparent',
                      color: selected ? 'var(--accent-foreground)' : undefined,
                      border: 'none',
                      cursor: 'pointer',
                      padding: '1px 4px',
                    }}
                  >
                    {name}
                    {row.node.level ? <span style={{ opacity: 0.5 }}> · {row.node.level}</span> : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {windowed && (
          <div data-testid="viz-hierarchy-windowed" style={{ opacity: 0.6, marginTop: 4 }}>
            Showing {shown.length} of {rows.length}
          </div>
        )}
      </div>
    </div>
  )
}
