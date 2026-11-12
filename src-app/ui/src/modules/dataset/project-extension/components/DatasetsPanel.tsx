import { useEffect, useMemo, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { DependentCount } from '@/api-client/types'
import type {
  DatasetArtifactSummary,
  DatasetListItem,
  ProjectDatasetSummary,
} from '@/api-client/types'
import { datatypeRegistry } from '@/core/datatypes'
import { useAction } from '@/core/actions/useAction'
import { useAffordance, getAffordance } from '@/core/actions/affordances'
import { prefersReducedMotion } from '@/core/actions/choreography'
import { useCanEdit } from '@/modules/project/context/ProjectScope'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import {
  Alert,
  Button,
  Confirm,
  Empty,
  Select,
  type SelectOption,
  type SelectOptionGroup,
  Tag,
  Text,
  message,
} from '@txresbench/kit'
import { Database, Plus } from 'lucide-react'
import { isReady, mergeAttachCandidates, notReadyNote, type AttachCandidate } from './attachOptions'
import { buildAttachOption } from './attachOptionRow'
import {
  datasetPreviewRegistry,
  describeSummary,
  holdingsFor,
  projectHoldings,
  type SummaryDeps,
} from '../preview'
import { useDatasetPanelEpoch } from './usePanelSync'

/**
 * The project's datasets section — a project-extension detail panel. Zero-prop (reads
 * `ProjectDetail`). Under DEC-4 a project **LINKS** datasets M:N (it does not
 * own them): attach/detach are link operations, so detaching removes only the link
 * and the (owner-scoped) dataset itself survives. The attach picker is share-aware
 * (DEC-3): it lists the user's OWNED ∪ SHARED datasets, and many-to-one is allowed
 * (a dataset may be linked to several projects). Each dataset shows its P2 datatype
 * (DEC-1 type-metadata — no cell/gene counts).
 *
 * Each candidate ALSO shows whether its ingest is ready (a not-ready one is marked,
 * never removed) and what it holds — one line composed of the phrases each datatype's
 * OWN package contributes, in the order those packages declared. The app sorts and
 * joins them; it supplies no wording beyond a count-and-title fallback for a datatype
 * nobody contributed for. See `docs/design/dataset-attach-readiness-and-preview.md`.
 */

/** Human label for a P2 datatype id (registry title, falling back to the raw id). */
function datatypeLabel(datatype?: string): string {
  if (!datatype) return 'Untyped'
  return datatypeRegistry.get(datatype)?.title ?? datatype
}

/** The registry-backed dependencies the summary renderer resolves through. */
const SUMMARY_DEPS: SummaryDeps = {
  lattice: { ancestors: (id: string) => datatypeRegistry.ancestors(id) },
  title: (id: string) => datatypeRegistry.get(id)?.title ?? id,
  registry: datasetPreviewRegistry,
}

/**
 * The dependent-analysis sentence, or NOTHING — never a number this cannot stand behind.
 *
 * ── THE ASYMMETRY THIS HOLDS, AND WHY IT IS NOT AN INCONSISTENCY ────────────────────────
 *
 * `cannot_compute` renders NO COUNT here and lets the detach proceed, while the same
 * unknown in ITEM-40 REFUSES. That is deliberate and the two are not the same question:
 *
 *   · ITEM-39 is a WARNING before a PERMITTED action. A derived artifact's data is still
 *     valid after detach — only its reachability changes — so the worst case of a missing
 *     warning is a recoverable surprise, and blocking would make detach unusable in exactly
 *     the case where someone is tidying up.
 *   · ITEM-40 is a GATE on a CORRECTNESS failure. An integrated dataset's data does not
 *     exist without its sources, so proceeding under uncertainty destroys something.
 *
 * A visibility question may proceed while unknown; a correctness one may not. Anyone
 * "simplifying" one of these to match the other should read this paragraph first.
 *
 * ── WHAT MUST NEVER HAPPEN ─────────────────────────────────────────────────────────────
 *
 * `cannot_compute` must not become `0`. This is a destructive-action confirmation, and
 * "0 analyses used this dataset" reads as a SAFETY CLEARANCE in front of a user about to
 * remove a dataset three analyses depend on. The server makes that inexpressible — the
 * response is a discriminated union, so a client must branch on `kind` before reaching a
 * number, and `count ?? 0` does not compile against it. This function is the branch.
 *
 * A real `0` also renders nothing: "no analyses used this" is a true fact, but it is not a
 * WARNING, and dressing it as one trains users to click past the sentence that matters.
 */
export type DependentSilence = 'pending' | 'unavailable' | 'cannot_compute' | 'zero'

/** What `dependentWarning` decided, with the SILENCE typed rather than collapsed to `null`.
 *
 *  ── WHY `silence` EXISTS, and it was forced by a surviving mutation ───────────────────
 *
 *  The plan names one control as the one that matters: *"hardcode `0` → the test goes red …
 *  an always-zero count renders IDENTICALLY to a correct one in the empty case."* Replaying
 *  it proved the point against my own first version — treating `cannot_compute` as
 *  `{count: 0}` changed nothing observable, because both render nothing, and every
 *  output-level assertion passed.
 *
 *  That is H10 exactly: a test must distinguish two channels, and the channels agree by
 *  construction. No amount of asserting on the rendered node can fix it — the distinction
 *  has to EXIST at a boundary the test can see. So the decision is returned beside the node.
 *
 *  It is not test-only scaffolding: a surface offering "retry" needs `unavailable` apart
 *  from `cannot_compute`, and that is the same distinction. */
export interface DependentWarning {
  node: React.ReactNode
  /** `null` when a real warning was rendered. */
  silence: DependentSilence | null
}

export function dependentWarning(
  state: DependentCount | 'loading' | 'unavailable' | undefined,
): DependentWarning {
  if (state === undefined || state === 'loading') return { node: null, silence: 'pending' }
  // Both unknowns render no number. They are NOT merged: a failed request is retryable and a
  // project with no recorded runs is not.
  if (state === 'unavailable') return { node: null, silence: 'unavailable' }
  if (state.kind === 'cannot_compute') return { node: null, silence: 'cannot_compute' }
  if (state.count < 1) return { node: null, silence: 'zero' }
  return { silence: null, node: (
    <>
      {' '}
      <strong data-testid="detach-dependent-warning">
        {state.count === 1
          ? '1 analysis in this project used this dataset.'
          : `${state.count} analyses in this project used this dataset.`}
      </strong>{' '}
      They are kept, not deleted — they stay valid and become reachable again if you re-attach
      it.
    </>
  ) }
}

export function DatasetsPanel() {
  // `availableDatasets` = the user's OWNED datasets (loaded + kept fresh by the
  // page/store across attach/detach). We fetch the SHARED-with-me list here to make
  // the picker share-aware without reaching into the project store.
  const { project, datasets, datasetsTotal, availableDatasets, loadingMore } = ProjectDetail
  const [toAttach, setToAttach] = useState<string>('')
  const [attaching, setAttaching] = useState(false)
  const [summary, setSummary] = useState<ProjectDatasetSummary | null>(null)
  const [shared, setShared] = useState<DatasetListItem[]>([])
  const [sharedLoading, setSharedLoading] = useState(false)
  const [sharedError, setSharedError] = useState<string | null>(null)
  // Artifact summaries for every dataset the user can see, keyed by id. `null` = not
  // loaded; a MISSING key on a loaded map means "outside the read's cap" and renders
  // nothing, which is why the server sends a zero row for a dataset it did count.
  const [artifacts, setArtifacts] = useState<Map<string, DatasetArtifactSummary> | null>(null)

  // The panel's three server reads are refreshed by the REALTIME CHANNEL, not only by
  // `datasetsTotal` — a count that moves on attach/detach and on nothing else, leaving a
  // rename, a new share, or a run's fresh artifacts invisible until a reload. See
  // `usePanelSync.ts`. `datasetsTotal` stays in the deps because attach/detach publishes
  // `Project`/`Update`, which this hook deliberately does not subscribe to (the project
  // store already reacts to it, and re-reading on every project edit would be broader
  // than the panel needs).
  const syncEpoch = useDatasetPanelEpoch()
  const projectId = project?.id
  // `canEdit` from the project-scope provider (ProjectDetailPage wraps the panel slot
  // in it) — a Viewer sees this panel read-only.
  const canEdit = useCanEdit()
  const hasMore = datasets.length < datasetsTotal
  // Only THIS project's existing links prune the picker; a dataset linked to OTHER
  // projects stays selectable (M:N, many-to-one).
  const attachedIds = new Set(datasets.map(d => d.id))
  // `availableDatasets` is fetched from `Dataset.listMine`, whose rows ARE list items
  // (the store's declared element type is the narrower `Dataset`, which is assignable
  // — the two extra fields are optional — so the status travels either way).
  const candidates = mergeAttachCandidates(availableDatasets, shared, attachedIds)
  const selected = candidates.find(c => c.id === toAttach)
  const selectedNote = selected ? notReadyNote(selected) : null

  // Refresh the seam-route summary on mount and whenever the linked count changes.
  useEffect(() => {
    if (!projectId) return
    let live = true
    void ApiClient.Project.datasetSummary({ id: projectId })
      .then(s => {
        if (live) setSummary(s)
      })
      .catch(() => {
        if (live) setSummary(null)
      })
    return () => {
      live = false
    }
  }, [projectId, datasetsTotal, syncEpoch])

  // The share-aware half of the picker: datasets shared WITH the user (DEC-3).
  // Fetched once per project (editors only); attach/detach reactivity is client-side
  // via `attachedIds`, so a link change needs no refetch.
  useEffect(() => {
    if (!projectId || !canEdit) return
    let live = true
    setSharedLoading(true)
    setSharedError(null)
    void ApiClient.Dataset.listShared({ per_page: 500 })
      .then(list => {
        if (!live) return
        setShared(list.items)
        setSharedLoading(false)
      })
      .catch(err => {
        if (!live) return
        setSharedError(err instanceof Error ? err.message : 'Failed to load shared datasets')
        setSharedLoading(false)
      })
    return () => {
      live = false
    }
  }, [projectId, canEdit, syncEpoch])

  // ONE batched read for "what is in each dataset" — every dataset the user can see,
  // in a single request and a single query (never per row). Refreshed when the linked
  // set changes, since a just-processed dataset gains artifacts. A failure leaves the
  // map null: the summary line disappears, nothing else does.
  useEffect(() => {
    if (!projectId) return
    let live = true
    void ApiClient.Dataset.artifactSummaries()
      .then(res => {
        if (!live) return
        setArtifacts(new Map(res.summaries.map(s => [s.dataset_id, s])))
      })
      .catch(() => {
        if (live) setArtifacts(null)
      })
    return () => {
      live = false
    }
  }, [projectId, datasetsTotal, syncEpoch])

  // The holdings line per dataset id, resolved once per response rather than per
  // render — typing in the picker re-renders, and a contribution should not run again
  // for every keystroke.
  const holdings = useMemo(() => {
    const out = new Map<string, { text: string; detail: string } | null>()
    if (!artifacts) return out
    for (const id of artifacts.keys()) out.set(id, holdingsFor(artifacts, id, SUMMARY_DEPS))
    return out
  }, [artifacts])
  /** What this dataset holds, or `null` — which renders as no line at all. */
  const holdingsText = (id: string) => holdings.get(id) ?? null

  // What the PROJECT holds — the same per-dataset groups the rows use, rolled up and
  // composed by the same declared machinery. Not a second vocabulary: the header used
  // to print `N datasets linked` and stop there, an inventory count in this app's own
  // storage noun, because it was built on a wire summary that carried nothing else and
  // was never re-pointed at the contribution seam when that seam was built.
  //
  // The two decisions this needs — roll up only the LINKED datasets out of a read that
  // covers every visible one, and refuse a PARTIAL page — are in `projectHoldings`,
  // where they are unit-tested. A panel is the wrong place to make a choice nobody can
  // check by reading the render.
  const projectLine = useMemo(
    () =>
      describeSummary(
        projectHoldings(artifacts, datasets.map(d => d.id), datasetsTotal),
        SUMMARY_DEPS,
      ),
    [artifacts, datasets, datasetsTotal],
  )

  // The one attach implementation, shared by the human Attach click (`onAttach`)
  // AND the choreographed `attach` affordance handler the AI drives (richer-actions
  // ITEM-10) — "one implementation, two callers" so the AI's attach is byte-for-byte
  // the human's.
  // Returns whether the link succeeded, so the choreographed `attach` handler can
  // report the REAL outcome to the AI (never a false "ok" on a failed link).
  const attachId = async (id: string): Promise<boolean> => {
    if (!id) return false
    setAttaching(true)
    try {
      await ProjectDetail.attachDataset(id)
      message.success('Dataset linked to this project')
      setToAttach('')
      return true
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to link dataset')
      return false
    } finally {
      setAttaching(false)
    }
  }
  const onAttach = () => attachId(toAttach)

  // Expose this datasets pane as a live `datasets` instance + spotlightable
  // affordances so a choreographed action (`dataset.add` / `dataset.add.byId`) can
  // VISIBLY reveal the picker, pick a dataset, and press Attach — the same controls
  // the user sees. Handlers are read live via `useAction`'s ref (latest state).
  // ── ITEM-39 — the dependent-analysis count, fetched WHEN THE PROMPT OPENS ────────────
  //
  // Per dataset, and lazily. Fetching for every row on panel render would issue one request
  // per dataset merely because the panel was drawn — the "cheap once and ruinous forty times"
  // affordance this tree has already refused once, in writing. The count is only needed at the
  // moment a user is deciding, so that is when it is asked for.
  //
  // `undefined` = never asked, `'loading'` = in flight, `'unavailable'` = the request FAILED.
  // That last one is deliberately distinct from the server's `cannot_compute`: one is "we could
  // not ask", the other is "the project has no recorded runs". Neither may render as a number,
  // and collapsing them would lose which of the two a retry could fix.
  const [dependents, setDependents] = useState<
    Record<string, DependentCount | 'loading' | 'unavailable' | undefined>
  >({})

  const loadDependents = (datasetId: string) => {
    if (!projectId || dependents[datasetId] !== undefined) return
    setDependents(prev => ({ ...prev, [datasetId]: 'loading' }))
    void ApiClient.Workstore.getDependentAnalyses({ project_id: projectId, dataset_id: datasetId })
      .then(res => setDependents(prev => ({ ...prev, [datasetId]: res.dependents })))
      // A FAILED request must not read as "nothing depends on this". It renders no number at
      // all — see `dependentWarning`.
      .catch(() => setDependents(prev => ({ ...prev, [datasetId]: 'unavailable' })))
  }

  const [dsViewId] = useState(() => crypto.randomUUID())
  const pickerRef = useAffordance('datasets:picker')
  const attachRef = useAffordance('datasets:attach-button')
  useAction(dsViewId, {
    type: 'datasets',
    handlers: {
      revealPicker: () => {
        const el = getAffordance('datasets:picker')?.el
        el?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
        el?.querySelector<HTMLElement>('button, input, [role="combobox"]')?.focus()
        return { ok: true }
      },
      selectDataset: params => {
        setToAttach((params as { dataset_id: string }).dataset_id)
        return { ok: true }
      },
      attach: async params => {
        const ok = await attachId((params as { dataset_id: string }).dataset_id)
        return { ok }
      },
      // dataset.list (ITEM-13) — the AI's id-resolution read: the same attach
      // candidates the picker shows, INCLUDING their readiness. The human is told
      // before they click; a driver that could not see the status would attach a
      // failed import and report success.
      listCandidates: () => ({
        ok: true,
        candidates: candidates.map(c => ({
          id: c.id,
          name: c.name,
          datatype: c.datatype,
          processing_status: c.processingStatus,
          ready: isReady(c),
        })),
      }),
    },
    // Mirror the sibling WorkbenchSection.useWorkbenchInstance: a plain snapshot,
    // no hand-rolled _state_token (these actions aren't mutating+stateful).
    getSnapshot: () => ({ projectId: projectId ?? '', canEdit }),
  })

  const onDetach = async (id: string, name: string) => {
    try {
      await ProjectDetail.detachDataset(id)
      message.success(`Unlinked "${name}" from this project`)
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to unlink dataset')
    }
  }

  const optionRow = (c: AttachCandidate): SelectOption =>
    buildAttachOption(c, { typeLabel: datatypeLabel(c.datatype), holdings: holdingsText(c.id) })
  const ownedOpts = candidates.filter(c => c.source === 'owned').map(optionRow)
  const sharedOpts = candidates.filter(c => c.source === 'shared').map(optionRow)
  // Group into "My datasets" / "Shared with me" only when both kinds are present;
  // a single kind renders as a flat list (no redundant lone group header).
  const options: (SelectOption | SelectOptionGroup)[] = sharedOpts.length
    ? [
        ...(ownedOpts.length ? [{ label: 'My datasets', options: ownedOpts }] : []),
        { label: 'Shared with me', options: sharedOpts },
      ]
    : ownedOpts

  const placeholder = sharedLoading
    ? 'Loading datasets…'
    : candidates.length
      ? 'Select a dataset to link'
      : 'No datasets available to link'

  return (
    <div className="flex flex-col" data-testid="project-datasets-card">
      {summary ? (
        <div
          className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
          data-testid="project-datasets-summary"
        >
          <span>
            {summary.dataset_count} {summary.dataset_count === 1 ? 'dataset' : 'datasets'} linked
          </span>
          {projectLine ? (
            <span
              className="min-w-0 truncate"
              title={projectLine.detail}
              data-testid="project-datasets-holdings"
            >
              {projectLine.line}
            </span>
          ) : null}
        </div>
      ) : null}

      {canEdit ? (
        <div className="mb-3 flex flex-col gap-2" data-testid="project-attach-row">
          <Text tone="muted" className="text-xs">
            Link an existing dataset (yours or shared with you)
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            <div ref={pickerRef} className="min-w-0 flex-1 sm:min-w-56">
              <Select
                className="w-full"
                placeholder={placeholder}
                value={toAttach}
                onChange={v => setToAttach(v as string)}
                loading={sharedLoading}
                disabled={!sharedLoading && candidates.length === 0}
                aria-label="Dataset to link to this project"
                data-testid="project-attach-select"
                searchPlaceholder="Search datasets…"
                emptyText="No dataset matches that name"
                options={options}
              />
            </div>
            <div ref={attachRef} className="shrink-0">
              <Button
                disabled={!toAttach}
                loading={attaching}
                icon={<Plus className="size-4" />}
                onClick={() => void onAttach()}
                data-testid="project-attach-button"
              >
                Attach
              </Button>
            </div>
          </div>
          {/* The consequence of linking the SELECTED not-ready dataset, stated before
              the click rather than discovered after it. It never blocks the link. */}
          {selectedNote ? (
            <Alert
              tone="warning"
              description={selectedNote}
              className="mt-1"
              data-testid="project-attach-not-ready"
            />
          ) : null}
          {sharedError ? (
            <Alert
              tone="error"
              description={sharedError}
              className="mt-1"
              data-testid="project-attach-error"
            />
          ) : null}
        </div>
      ) : null}

      {datasets.length === 0 ? (
        <Empty description="No datasets linked to this project yet" data-testid="project-datasets-empty" />
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {datasets.map(d => {
            const holdings = holdingsText(d.id)
            return (
            <div
              key={d.id}
              className="flex items-center justify-between gap-2 py-2"
              data-testid={`project-dataset-row-${d.id}`}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Database className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">{d.name}</span>
                  <Tag variant="outline" className="shrink-0" data-testid={`project-dataset-type-${d.id}`}>
                    {datatypeLabel(d.datatype)}
                  </Tag>
                </div>
                {holdings ? (
                  <span
                    className="truncate ps-6 text-xs text-muted-foreground"
                    title={holdings.detail}
                    data-testid={`project-dataset-holdings-${d.id}`}
                  >
                    {holdings.text}
                  </span>
                ) : null}
              </div>
              {canEdit ? (
                // ITEM-38 — detach ASKS FIRST. Until this landed the button fired the
                // mutation on click with nothing said beforehand; the only pre-click text
                // was the `title` below and the only post-hoc text was a toast, by which
                // point the link was already gone.
                //
                // The confirmation is not decoration: it is the PLACE the two consequence
                // rules speak (INV-10). ITEM-39 will add the dependent-artifact warning to
                // `description` and ITEM-40 will turn this prompt into a REFUSAL when the
                // dataset is a source of an integrated dataset. Neither has anything to
                // attach to without a step between the click and the mutation.
                //
                // Deliberately NOT here yet: any count of dependent analyses. That count
                // cannot be computed today (artifact scope is project XOR dataset), and a
                // fabricated or always-zero number is worse than none — so this copy says
                // only what is true.
                //
                // Mirrors `datasets/pages/DatasetsLibraryPage.tsx`'s Confirm-wraps-trigger
                // idiom, not a second confirmation idiom.
                <Confirm
                  title={`Detach "${d.name}" from this project?`}
                  // ITEM-39 — WARN, then ALLOW. The warning is additive: the base sentence is
                  // always true and the count is added only when there IS one.
                  description={
                    <>
                      The dataset itself is not deleted — it stays in your library and can be
                      attached again later.
                      {dependentWarning(dependents[d.id]).node}
                    </>
                  }
                  onOpenChange={open => {
                    if (open) loadDependents(d.id)
                  }}
                  okText="Detach"
                  cancelText="Cancel"
                  onConfirm={() => onDetach(d.id, d.name)}
                  data-testid={`project-dataset-detach-confirm-${d.id}`}
                >
                  <Button
                    variant="ghost"
                    data-testid={`project-detach-${d.id}`}
                    title="Remove this dataset from the project — the dataset itself is not deleted"
                  >
                    Detach
                  </Button>
                </Confirm>
              ) : null}
            </div>
            )
          })}
        </div>
      )}

      {hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button
            variant="outline"
            loading={loadingMore}
            onClick={() => void ProjectDetail.loadMoreDatasets()}
            data-testid="project-datasets-load-more"
          >
            Show more ({datasets.length} of {datasetsTotal})
          </Button>
        </div>
      ) : null}
    </div>
  )
}
