// LineagePane (ITEM-61 / ITEM-62) — the interactive artifact-lineage DAG as a dock
// pane. It RENDERS the provenance section's already-loaded-but-ignored `GraphDto`
// (today `ProvenancePanel` fetches `graph` and only reads `roots[0]`) as a pan/zoom
// node-link graph: nodes = artifacts + runs, edges = produced-by / consumed-by. Click a
// node → open its artifact / run review pane; "Export from here" on ANY node → the
// EXISTING export flow scoped to that node (ITEM-62, `ProvenanceExport.openFor`). Narrow
// (≤440px) or a large graph (>node cap) → a compact list fallback. Owner-scoped
// (`provenance::read`, already granted) — it reuses `Provenance` (self-gated,
// sync-refetched) so no new fetch path, and `ExportDrawer` for the export UI.

import { useEffect, useMemo, useRef } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Alert, Button, Empty, ErrorState, Popover, Result, ScrollArea, Spinner, Tabs, Tag } from '@txresbench/kit'
import { Check, Download, TriangleAlert } from 'lucide-react'
import { Provenance } from '@/modules/provenance/stores/Provenance.store'
import { ProvenanceExport } from '@/modules/provenance/stores/ProvenanceExport.store'
import { usePaneStateValue } from '@/modules/workbench/core'
import { Permissions } from '@/api-client/permissions'
import { usePermission } from '@/core/permissions'
import { cn } from '@/lib/utils'
import { ExportDrawer } from '@/modules/provenance/project-extension/components/ExportDrawer'
import { ReadinessChecklist } from '@/modules/provenance/project-extension/components/ReadinessChecklist'
import { RunsList } from '@/modules/provenance/project-extension/components/RunsList'
import { useWorkbench } from '../../core/shell/WorkbenchContext'
import { workbenchDockStore } from '../../core/shell/dock/WorkbenchDock.store'
import { revealPane } from '../../core/shell/regions/openPane'
import { runArtifactRef } from '../jobs/ArtifactPane'
import { type WorkbenchPane, PaneScroll } from '../../core/shell/dock/paneModel'
import {
  buildLineageModel,
  COMPACT_WIDTH_PX,
  layoutLineage,
  MAX_DAG_NODES,
  type LineageModel,
  type LineageNode,
} from './lineageGraph'

// ── xyflow custom node ────────────────────────────────────────────────────────────

interface LineageFlowNodeData extends Record<string, unknown> {
  node: LineageNode
  onOpen: (node: LineageNode) => void
  onExport: (node: LineageNode) => void
}

function LineageFlowNode({ data }: NodeProps) {
  const { node, onOpen, onExport } = data as LineageFlowNodeData
  const isRun = node.type === 'run'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(node)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onOpen(node)
      }}
      data-testid={`workbench-lineage-node-${node.target}`}
      className={`flex w-[168px] cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1.5 shadow-sm ${
        isRun ? 'bg-secondary' : 'bg-card'
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{node.label}</div>
        {/* ITEM-9 — a run node states WHAT IT WAS RUN ON (its predicate) next to its
            status, so "what was filtered on?" is answerable from the graph itself.
            Truncated in the 168px node; the native title carries the full text. */}
        <div
          className="truncate text-xs text-muted-foreground"
          title={node.detail || undefined}
          data-testid={isRun ? `workbench-lineage-detail-${node.target}` : undefined}
        >
          {isRun
            ? [node.status || 'run', node.detail].filter(Boolean).join(' · ')
            : node.datatype || 'artifact'}
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        tooltip="Export from here"
        onClick={e => {
          e.stopPropagation()
          onExport(node)
        }}
        data-testid={`workbench-lineage-export-${node.target}`}
      >
        <Download className="size-3.5" aria-hidden="true" />
      </Button>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const NODE_TYPES: NodeTypes = { lineage: LineageFlowNode }

// ── Presentational view (backend-free; the gallery mounts this with a seeded model) ──

export interface LineageViewProps {
  paneId: string
  model: LineageModel
  /** Force the compact list (gallery / test override); otherwise derived from width. */
  narrow?: boolean
  onOpenNode: (node: LineageNode) => void
  onExportNode: (node: LineageNode) => void
}

/** A compact, scrollable node list — the ≤440px / large-graph fallback. Same click +
 *  export affordances as the DAG, so every node action works without pan/zoom. */
function LineageCompactList({ paneId, model, onOpenNode, onExportNode, capped }: LineageViewProps & { capped: boolean }) {
  return (
    <PaneScroll axis="y" className="min-h-0 flex-1" data-testid={`workbench-lineage-list-${paneId}`}>
     <div className="flex flex-col gap-1">
      {capped && (
        <div className="px-1 pb-1 text-xs text-muted-foreground" data-testid={`workbench-lineage-capped-${paneId}`}>
          Large graph — showing {model.nodes.length.toLocaleString()} nodes as a list.
        </div>
      )}
      {model.nodes.map(node => (
        <div
          key={node.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpenNode(node)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') onOpenNode(node)
          }}
          data-testid={`workbench-lineage-node-${node.target}`}
          className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1.5 hover:bg-muted/50"
        >
          <Tag
            tone={node.type === 'run' ? 'primary' : 'default'}
            variant="soft"
            data-testid={`workbench-lineage-type-${node.target}`}
          >
            {node.type}
          </Tag>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{node.label}</span>
            {node.detail && (
              <span
                className="truncate text-xs text-muted-foreground"
                title={node.detail}
                data-testid={`workbench-lineage-detail-${node.target}`}
              >
                {node.detail}
              </span>
            )}
          </div>
          <Button
            size="icon"
            variant="ghost"
            tooltip="Export from here"
            onClick={e => {
              e.stopPropagation()
              onExportNode(node)
            }}
            data-testid={`workbench-lineage-export-${node.target}`}
          >
            <Download className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ))}
     </div>
    </PaneScroll>
  )
}

export function LineageView({ paneId, model, narrow, onOpenNode, onExportNode }: LineageViewProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Kept by PANE id rather than in React state. The width is re-measured on every mount, so losing
  // it is not a loss of user input — it is a loss of the ANSWER: a remount starts at 0, which reads
  // as "wide", so a narrow pane mounts the pan/zoom DAG and only swaps to the compact list once the
  // observer fires. Remembering the last measurement makes the pane come back as it left.
  const [width, setWidth] = usePaneStateValue(paneId, 'lineageWidth', 0)

  // Measure the pane width (ResizeObserver, not a DOM-ready setTimeout hack) so a narrow
  // pane falls back to the compact list regardless of the viewport.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const tooMany = model.nodes.length > MAX_DAG_NODES
  const compact = narrow || tooMany || (width > 0 && width < COMPACT_WIDTH_PX)

  const flow = useMemo(() => {
    if (compact) return { nodes: [] as Node[], edges: [] as Edge[] }
    const positioned = layoutLineage(model)
    const nodes: Node[] = positioned.map(n => ({
      id: n.id,
      type: 'lineage',
      position: { x: n.x, y: n.y },
      data: { node: n, onOpen: onOpenNode, onExport: onExportNode } satisfies LineageFlowNodeData,
    }))
    const edges: Edge[] = model.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: e.relation === 'consumed',
    }))
    return { nodes, edges }
  }, [compact, model, onOpenNode, onExportNode])

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col" data-testid={`workbench-lineage-view-${paneId}`}>
      {compact ? (
        <LineageCompactList
          paneId={paneId}
          model={model}
          narrow={narrow}
          onOpenNode={onOpenNode}
          onExportNode={onExportNode}
          capped={tooMany}
        />
      ) : (
        <div className="min-h-0 flex-1" data-testid={`workbench-lineage-graph-${paneId}`}>
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={NODE_TYPES}
            fitView
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            nodesDraggable={false}
            edgesFocusable={false}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </div>
  )
}

// ── Data wrapper (the registered pane) ────────────────────────────────────────────

/** The reproducibility BADGE: ✓ Reproducible when every readiness flag passes, else
 *  ⚠ N issues — click for the full checklist (the same one the old Reproducibility
 *  panel showed). Consolidates readiness into a header affordance, not a tab. */
function ReadinessBadge() {
  const { readiness } = Provenance
  const flags = readiness
    ? [
        readiness.code_captured,
        readiness.env_pinned,
        readiness.inputs_checksummed,
        // ITEM-4 — must be counted here too, or a closure that is not-ready ONLY
        // because its params were dropped renders the nonsense "⚠ 0 issues".
        readiness.params_captured,
        readiness.roots_have_provenance,
        readiness.seeds_set,
      ]
    : []
  const issues = flags.filter(f => !f).length
  const ready = !!readiness?.ready
  return (
    <Popover
      side="bottom"
      align="start"
      className="w-72 p-2"
      content={<ReadinessChecklist readiness={readiness} />}
    >
      <button
        type="button"
        data-testid="provenance-readiness-badge"
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
          ready ? 'border-success text-success' : 'border-warning text-warning',
        )}
      >
        {ready ? (
          <>
            <Check className="size-3.5" /> Reproducible
          </>
        ) : (
          <>
            <TriangleAlert className="size-3.5" /> {issues} issue{issues === 1 ? '' : 's'}
          </>
        )}
      </button>
    </Popover>
  )
}

/**
 * The DEC-19 capture-failure banner — a save-time WRITE failure, not a failed load.
 *
 * F2-31: this used to be the kit `ErrorState`, whose title is the hardcoded
 * ``Couldn't load {resource}`` and whose only action renders as "Try again". It was
 * wired to `clearCaptureError` — a pure DISMISS. So the surface whose entire job is
 * truthful reproducibility claims described a WRITE failure as a load failure and
 * offered a button that read as a successful retry while the run stayed unrecorded
 * and irreproducible.
 *
 * Both halves are fixed here: the wording names the CAPTURE ("Selection provenance
 * was not recorded"), and the primary action genuinely re-posts the retained recipe
 * (`Provenance.retryCapture`), which clears the banner ONLY on success. The
 * dismiss is a separate, honestly-labelled affordance. Raw error text stays behind a
 * "Details" disclosure, per the kit's own error-state convention.
 */
export function CaptureFailureBanner({
  paneId,
  message,
  canRetry,
  retrying,
  onRetry,
  onDismiss,
  'data-testid': testid,
}: {
  /** The hosting pane — the disclosure below is remembered against it. */
  paneId: string
  message: string
  canRetry: boolean
  retrying: boolean
  onRetry: () => void
  onDismiss: () => void
  'data-testid': string
}) {
  // A user who opened the raw error is mid-diagnosis. The region renders only its active tab, so in
  // React state this closed itself the moment they looked at anything else in the same region.
  const [showDetails, setShowDetails] = usePaneStateValue(paneId, 'captureDetailsOpen', false)
  return (
    <Alert
      tone="error"
      title="Selection provenance was not recorded"
      description="The keep-mask was committed, but its recipe was NOT recorded — that run is not reproducible until it is captured again."
      onClose={onDismiss}
      closeLabel="Dismiss this warning"
      data-testid={testid}
    >
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canRetry ? (
          <Button
            variant="outline"
            onClick={onRetry}
            disabled={retrying}
            data-testid={`${testid}-retry`}
          >
            {retrying ? 'Recording…' : 'Record it again'}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() => setShowDetails(v => !v)}
          aria-expanded={showDetails}
          data-testid={`${testid}-details-toggle`}
        >
          {showDetails ? 'Hide details' : 'Details'}
        </Button>
      </div>
      {showDetails ? (
        <ScrollArea className="mt-2 max-h-40">
          <pre className="whitespace-pre-wrap text-xs" data-testid={`${testid}-details`}>
            {message}
          </pre>
        </ScrollArea>
      ) : null}
    </Alert>
  )
}

/**
 * The consolidated PROVENANCE pane — one pane for the whole provenance/reproducibility
 * story (it replaces the former separate History / Reproducibility / Lineage panes,
 * which were all views of `Provenance`). The BODY is the interactive lineage
 * graph (run/artifact nodes; click a run → open its artifact; "export from here" per
 * node); the HEADER carries the reproducibility badge (readiness checklist) + the
 * project-level Export-bundle button.
 *
 * PERMISSION-GATED on `provenance::read` (R4C-05). This pane replaced a `detail_panels`
 * project-extension section, which inherited the registry's `evaluatePermission` filtering
 * for free; a directly-registered pane renderer inherits nothing, so the gate is asserted
 * HERE — the pane is reachable by paths that never pass through the "+" menu's filter (a
 * restored/persisted layout, `revealPane`, the `window.__workbenchPanes` seam), so the
 * menu filter alone would not be a gate.
 *
 * The denied surface is deliberately the app's 403 `Result`, NOT the pane's own empty
 * state: `Provenance` self-gates its fetch, so a denied user previously fell
 * through to "No provenance yet — run an analysis to build a provenance graph", which is
 * a FALSE claim (the project may have provenance; this user may not see it). The backend
 * gate holds either way — `GET /api/provenance/runs` answers 403 — so this is a
 * UI-honesty fix, not a data-leak fix.
 */
export function ProvenancePane({ pane }: { pane: WorkbenchPane }) {
  const { projectId } = useWorkbench()
  const canRead = usePermission(Permissions.ProvenanceRead)
  // `provenance::export` is a SEPARATE backend permission (handlers.rs export /
  // download_export / verify all take `RequirePermissions<(ProvenanceExport,)>`), so a
  // `provenance::read`-only user offered "Export bundle" can only ever get a 403.
  const canExport = usePermission(Permissions.ProvenanceExport)
  const [tab, setTab] = usePaneStateValue(pane.id, 'provenanceTab', 'graph')
  const { graph, loading, error, captureError, lastCapture, recording } = Provenance

  // Reuse the provenance store's graph (self-gated on `provenance::read`, sync-refetched)
  // — mirrors the old panel's mount effect; skip when it already holds this project.
  useEffect(() => {
    if (canRead && projectId && Provenance.$.loadedProjectId !== projectId) {
      void Provenance.load(projectId)
    }
  }, [canRead, projectId])

  const model = useMemo(() => buildLineageModel(graph), [graph])

  const onOpenNode = (node: LineageNode) => {
    const ref =
      node.type === 'run' && node.runId
        ? runArtifactRef(node.runId)
        : `${node.datatype ?? 'artifact'}::${node.artifactId ?? node.target}`
    revealPane('artifact', ref)
  }
  const onExportNode = (node: LineageNode) => {
    // Export scoped to this node's target (single/set/project scope chosen in the drawer).
    ProvenanceExport.openFor(projectId, node.target)
  }
  // The header "Export bundle" exports the whole project's reproducibility bundle.
  const onExportBundle = () => ProvenanceExport.openFor(projectId, null)

  // After every hook (the gate must not change hook order between renders — permissions
  // are reactive and can flip mid-session on a group edit).
  if (!canRead) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
        <Result
          data-testid={`workbench-provenance-pane-forbidden-${pane.id}`}
          status="403"
          title="Not authorized"
          subtitle="You don't have permission to view this project's provenance."
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`workbench-provenance-pane-${pane.id}`}>
      {/* A save-time CAPTURE failure is a DIFFERENT subsystem from a failed graph
          LOAD. They used to share one `error` slot, so a failed `recordCapture`
          blanked the whole lineage view under "the graph could not be loaded" —
          diagnosing the wrong thing and hiding a graph that was fine. The capture
          error is now an inline banner ABOVE the graph, which keeps rendering. */}
      {captureError ? (
        <div className="pb-2">
          <CaptureFailureBanner
            paneId={pane.id}
            message={captureError}
            canRetry={lastCapture != null}
            retrying={recording}
            onRetry={() => void Provenance.retryCapture()}
            onDismiss={() => Provenance.clearCaptureError()}
            data-testid={`workbench-provenance-capture-error-${pane.id}`}
          />
        </div>
      ) : null}
      {error ? (
        <div className="pb-2">
          <ErrorState
            resource="provenance"
            description="The project's provenance graph could not be loaded."
            details={error}
            onRetry={() => void Provenance.reloadCurrent()}
            data-testid={`workbench-provenance-error-${pane.id}`}
          />
        </div>
      ) : loading && !graph ? (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner label="Loading provenance…" data-testid={`workbench-provenance-loading-${pane.id}`} />
        </div>
      ) : model.nodes.length === 0 ? (
        // R4C-06 — the EMPTY graph still offers "Export bundle". The retired project-detail
        // provenance panel rendered `provenance-open-export` unconditionally, and a
        // whole-project export of a project with no captured runs is a legitimate, working
        // operation (the backend builds a valid bundle — that is exactly what the export
        // e2e asserts). Folding the export affordance into the non-empty branch when the
        // panel became this pane silently removed the capability for every project that has
        // not run an analysis yet, and took its e2e coverage with it.
        <Empty
          data-testid={`workbench-provenance-pane-empty-${pane.id}`}
          title="No provenance yet"
          description="Run an analysis to build a provenance graph of its inputs, runs, and outputs."
        >
          {canExport ? (
            <Button
              variant="outline"
              icon={<Download className="size-3.5" />}
              onClick={onExportBundle}
              data-testid={`provenance-export-bundle-${pane.id}`}
            >
              Export bundle
            </Button>
          ) : null}
        </Empty>
      ) : (
        <>
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
            <ReadinessBadge />
            {canExport ? (
              <Button
                variant="outline"
                icon={<Download className="size-3.5" />}
                onClick={onExportBundle}
                data-testid={`provenance-export-bundle-${pane.id}`}
              >
                Export bundle
              </Button>
            ) : null}
          </div>
          {/* ITEM-9 disposition. DEC-5 specified a "Predicate" column on `RunsList`,
              but `RunsList` had NO production consumer after the project-detail
              provenance panel was retired — so the column, its Tooltip and its
              `provenance-run-predicate-*` testids shipped UNREACHABLE (dead code,
              CODING_GUIDELINES §15). Rather than delete a complete, working surface
              or leave it unreconciled, the pane gains a second TAB: the graph
              answers "how did this come about?", the table answers "what exactly was
              filtered on, and when?" — the reviewer question DEC-5 was written for.
              `variant="line"` per the design system (a pane is a narrow, dense
              container; a boxed strip reads as heavy chrome there). Both views read
              the SAME already-loaded store, so there is no new fetch path. */}
          <Tabs
            data-testid={`workbench-provenance-tabs-${pane.id}`}
            // CONTROLLED off pane state, not `defaultValue`: an uncontrolled tab strip inside a pane
            // resets to its default on every remount, and a region remounts its pane on every tab
            // switch — so a user reading the Runs table dropped back to the Graph for looking away.
            value={tab}
            onValueChange={setTab}
            variant="line"
            fill
            size="sm"
            tabStripClassName="px-2"
            items={[
              {
                key: 'graph',
                label: 'Graph',
                children: (
                  <div className="flex min-h-0 flex-1 flex-col pt-2">
                    <LineageView
                      paneId={pane.id}
                      model={model}
                      onOpenNode={onOpenNode}
                      onExportNode={onExportNode}
                    />
                  </div>
                ),
              },
              {
                key: 'runs',
                label: 'Runs',
                children: (
                  <PaneScroll axis="y" className="min-h-0 flex-1">
                    <div className="pt-2">
                      <RunsList />
                    </div>
                  </PaneScroll>
                ),
              },
            ]}
          />
        </>
      )}
      <ExportDrawer />
    </div>
  )
}
