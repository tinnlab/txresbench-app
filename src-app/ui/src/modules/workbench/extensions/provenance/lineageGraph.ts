// lineageGraph (ITEM-61) — the pure GraphDto → node-link DAG transform + a dagre
// layout pass. The provenance `GraphDto` (roots = artifacts, runs = run nodes each
// carrying `inputs: UsedEdgeDto[]`) is today fetched but only `roots[0]` is read; this
// turns the WHOLE graph into an artifact-centric DAG: nodes = artifacts + runs, edges =
// produced-by (run → artifact) + consumed-by (artifact → run). Pure (no React / xyflow)
// so the unit test drives it in the node env (mirrors `analysis/runHistory.ts`); the
// pane maps the positioned nodes/edges onto `@xyflow/react`.

import dagre from 'dagre'
import type { ArtifactNodeDto, GraphDto, RunNodeDto } from '@/api-client/types'
import { artifactLabel as sharedArtifactLabel, shortArtifactId } from '@/core/workstore'
// The provenance module's pure filter-narration helper (the same one the runs
// trust-view cell uses), imported the way this pane already imports `ReadinessChecklist`.
import { criteriaPreview } from '@/modules/provenance/project-extension/components/criteriaPreview'

/** Beyond this node count the pane falls back to the compact list (the DAG's node cap). */
export const MAX_DAG_NODES = 80

/** Below this pane width the DAG is unusable → the compact-list fallback (390px design). */
export const COMPACT_WIDTH_PX = 440

export type LineageNodeType = 'artifact' | 'run'

/** A DAG node: a project artifact or a run. `target` is what its actions act on — the
 *  artifact id / run id passed to open-artifact + export-from-here (ITEM-62). */
export interface LineageNode {
  /** Prefixed so an artifact id and a run id never collide (`art:` / `run:`). */
  id: string
  type: LineageNodeType
  label: string
  /** The open/export target: artifact id (artifact node) or run id (run node). */
  target: string
  datatype?: string
  status?: string
  /** run node: its run id; artifact node: its producing run id (if any). */
  runId?: string
  artifactId?: string
  /** ITEM-9 — a run node's FILTER preview ("what was filtered on?"), truncated
   *  for the node chrome; empty/absent when the run recorded no scientific params. */
  detail?: string
}

/** A directed edge: `produced` (run → artifact) or `consumed` (artifact → run). */
export interface LineageEdge {
  id: string
  source: string
  target: string
  relation: 'produced' | 'consumed'
}

export interface LineageModel {
  nodes: LineageNode[]
  edges: LineageEdge[]
}

/** A node positioned by the layout pass (xyflow `position` is the top-left corner). */
export interface PositionedLineageNode extends LineageNode {
  x: number
  y: number
  width: number
  height: number
}

const artNodeId = (id: string) => `art:${id}`
const runNodeId = (id: string) => `run:${id}`
const shortId = shortArtifactId

// A DAG node's artifact label is the SHARED derivation (`@/core/workstore/artifactLabel`), not
// this module's own. It used to be its own — `${datatype || 'artifact'} · ${id8}` — while the
// artifact PICKERS spelled the same fact `datatype · dims · when`, so one artifact read two ways
// depending on which surface a user opened. A provenance node carries neither a declared
// structure nor a `created_at`, so the shared function lands on its last-resort segment and this
// node's text is byte-for-byte what it drew before; what changed is that there is one rule.
function artifactLabel(a: ArtifactNodeDto): string {
  return sharedArtifactLabel({ id: a.id, datatype: a.datatype })
}
function runLabel(r: RunNodeDto): string {
  return `${r.generator_id || r.kind || 'run'} · ${shortId(r.run_id)}`
}

/**
 * Build the artifact-centric DAG from a provenance `GraphDto`. Every root artifact and
 * every run becomes a node; a producing `run_id` makes a `produced` edge (run →
 * artifact) and every `inputs[].ref_id` (kind `artifact`) makes a `consumed` edge
 * (artifact → run). An input artifact not among the roots is synthesized as a minimal
 * intermediate node so no edge endpoint dangles. A malformed/absent graph → empty.
 */
export function buildLineageModel(graph: GraphDto | null | undefined): LineageModel {
  if (!graph || !Array.isArray(graph.roots)) return { nodes: [], edges: [] }
  const artifacts = graph.roots
  const runs = Array.isArray(graph.runs) ? graph.runs : []

  const nodeMap = new Map<string, LineageNode>()
  for (const a of artifacts) {
    nodeMap.set(artNodeId(a.id), {
      id: artNodeId(a.id),
      type: 'artifact',
      label: artifactLabel(a),
      target: a.id,
      datatype: a.datatype,
      runId: a.run_id,
      artifactId: a.id,
    })
  }
  for (const r of runs) {
    nodeMap.set(runNodeId(r.run_id), {
      id: runNodeId(r.run_id),
      type: 'run',
      label: runLabel(r),
      target: r.run_id,
      status: r.status,
      runId: r.run_id,
      detail: criteriaPreview(r) || undefined,
    })
  }

  const edges: LineageEdge[] = []
  const edgeIds = new Set<string>()
  const pushEdge = (source: string, target: string, relation: LineageEdge['relation']) => {
    const id = `${relation}:${source}->${target}`
    if (edgeIds.has(id)) return
    edgeIds.add(id)
    edges.push({ id, source, target, relation })
  }

  // produced-by: the run that produced an artifact → the artifact.
  for (const a of artifacts) {
    if (a.run_id && nodeMap.has(runNodeId(a.run_id))) {
      pushEdge(runNodeId(a.run_id), artNodeId(a.id), 'produced')
    }
  }
  // consumed-by: an input artifact → the run that consumed it.
  for (const r of runs) {
    const inputs = Array.isArray(r.inputs) ? r.inputs : []
    for (const inp of inputs) {
      if (inp.kind !== 'artifact' || !inp.ref_id) continue
      const aId = artNodeId(inp.ref_id)
      if (!nodeMap.has(aId)) {
        nodeMap.set(aId, {
          id: aId,
          type: 'artifact',
          label: shortId(inp.ref_id),
          target: inp.ref_id,
          artifactId: inp.ref_id,
        })
      }
      pushEdge(aId, runNodeId(r.run_id), 'consumed')
    }
  }

  return { nodes: [...nodeMap.values()], edges }
}

/**
 * Position the DAG left-to-right with dagre. Pure (dagre runs headless in node), so the
 * layout is unit-testable; the pane feeds the result straight to `@xyflow/react` (whose
 * `position` is a node's top-left corner, hence the half-size shift off dagre's centers).
 */
export function layoutLineage(
  model: LineageModel,
  opts?: { nodeWidth?: number; nodeHeight?: number },
): PositionedLineageNode[] {
  const width = opts?.nodeWidth ?? 168
  const height = opts?.nodeHeight ?? 46
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 64, marginx: 12, marginy: 12 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of model.nodes) g.setNode(n.id, { width, height })
  for (const e of model.edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return model.nodes.map(n => {
    const p = g.node(n.id)
    const cx = Number.isFinite(p?.x) ? p.x : 0
    const cy = Number.isFinite(p?.y) ? p.y : 0
    return { ...n, x: cx - width / 2, y: cy - height / 2, width, height }
  })
}
