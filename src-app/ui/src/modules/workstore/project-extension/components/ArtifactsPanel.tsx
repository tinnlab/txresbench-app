import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ListedArtifact } from '@/api-client/types'
import { datatypeRegistry } from '@/core/datatypes'
import { listArtifacts } from '@/core/workstore'
import { datasetPreviewRegistry, type SummaryDeps } from '@/modules/dataset/project-extension/preview'
import { ProjectDetail } from '@/modules/project/stores/ProjectDetail.store'
import { Empty, Tag } from '@txresbench/kit'
import { CircleHelp, Database, FileBox } from 'lucide-react'
import { describeArtifactStatus, missingSourceNote } from '../artifactStatus'

/**
 * One artifact's status, as a TONED tag carrying its remedy (ITEM-41).
 *
 * This row used to render `{a.status}` as a bare grey word. That reads identically for
 * `ready`, `failed` and `unresolvable` — so a user could not tell a usable artifact from
 * one whose data is wrong from one whose SOURCE is gone, and the last two need opposite
 * actions (delete/re-run vs restore the source; see `../artifactStatus`).
 *
 * `ready` stays quiet on purpose: it is the overwhelming majority of rows and the panel
 * would become a wall of green chips that no longer signals anything. The tag appears
 * only when there is something to say — which is also what makes an appearing tag
 * meaningful rather than decorative.
 */
function ArtifactStatusTag({
  status,
  artifactId,
  meta,
}: {
  status: string
  artifactId: string
  meta: unknown
}) {
  const d = describeArtifactStatus(status)
  if (d.usable) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground" data-testid={`project-artifact-status-${artifactId}`}>
        {d.label}
      </span>
    )
  }
  return (
    <Tag
      tone={d.tone}
      className="shrink-0"
      // The remedy is the whole value of the tag; without it the user knows something is
      // wrong and not what to do, which for `unresolvable` is the difference between
      // restoring a source and deleting intact work.
      title={d.remedy || undefined}
      data-testid={`project-artifact-status-${artifactId}`}
      data-status={d.status}
    >
      {d.label}
    </Tag>
  )
}

/**
 * The row for an artifact that cannot be read, with the missing source NAMED (INV-9).
 *
 * The tag alone satisfies "say something is wrong"; the invariant is stricter — invalidate
 * loudly, *naming the missing or changed source*. A user with forty datasets who reads only
 * "Source missing" has been handed a search. So the name renders as visible text on the row,
 * not only in a `title` a pointer has to find (and a touch device never will).
 */
function MissingSourceLine({ artifactId, meta }: { artifactId: string; meta: unknown }) {
  return (
    <span
      className="truncate ps-6 text-xs text-muted-foreground"
      data-testid={`project-artifact-missing-source-${artifactId}`}
    >
      {missingSourceNote(meta)}
    </span>
  )
}
import { UNASSIGNED_SCOPE_LABEL, describeTypeSections, groupArtifactsByScope } from '../grouping'
import { alignmentCoverage, alignmentCoverageLabel } from '../alignmentCoverage'

/**
 * The project's Artifacts (workstore catalog) section — a project-extension detail
 * panel (P1 · ITEM-11). Zero-prop (reads `ProjectDetail`, like the datasets panel).
 * Lists the project's cataloged typed artifacts via the JSON control plane
 * (`listArtifacts`); the raw typed-binary data plane rides the hand-written
 * `@/core/workstore` binary client.
 *
 * It reads as a TREE, because the catalog is one. A flat list of rows labelled with
 * internal ids was the wrong shape twice over:
 *
 *   · the read returns TWO populations — the rows scoped to each attached dataset and
 *     the rows this project's own runs produced — and flattening them hid the one
 *     distinction a reader is actually looking for. `groupArtifactsByScope` restores it
 *     (and gives the two rows the schema permits but the convention forbids — both
 *     scopes set, or neither — a defined home rather than a crash or a disappearance);
 *   · every row printed `a.datatype` VERBATIM, so users met a slash-separated internal
 *     id where a display title was declared for exactly this purpose. Each type is now
 *     headed by its DECLARED title plus the sentence its OWNING PACKAGE contributes
 *     (`packages/*​/dataset-preview.yaml`), resolved through the same registry the
 *     dataset-attach picker's holdings line resolves through. This app contributes no
 *     wording of its own beyond the count-and-title fallback for a datatype nobody
 *     declared a phrase for.
 *
 * The pane stays titled "Artifacts": the storage noun is right where the surface IS the
 * store, and the rename that removed it from the dataset holdings line was scoped there.
 *
 * Empty until a dataset is attached or an analysis run produces outputs, so the empty
 * state is a common first render.
 */

/** The registry-backed dependencies each type section's summary resolves through —
 *  the same shape, and the same singleton registry, the datasets panel injects. */
const SUMMARY_DEPS: SummaryDeps = {
  lattice: { ancestors: (id: string) => datatypeRegistry.ancestors(id) },
  title: (id: string) => datatypeRegistry.get(id)?.title ?? id,
  registry: datasetPreviewRegistry,
}

export function ArtifactsPanel() {
  const { project } = ProjectDetail
  const projectId = project?.id
  const [artifacts, setArtifacts] = useState<ListedArtifact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The datatype registry is populated from `GET /api/datatypes` AFTER first paint, and
  // every heading on this pane is a title read out of it. Without this subscription the
  // pane would render the raw ids once and never correct itself — which is the very bug
  // it exists to fix, arriving by a different route.
  const registryVersion = useSyncExternalStore(datatypeRegistry.subscribe, datatypeRegistry.getVersion)

  useEffect(() => {
    if (!projectId) return
    let live = true
    setError(null)
    void listArtifacts(projectId)
      .then(items => {
        if (live) setArtifacts(items)
      })
      .catch(e => {
        if (live) {
          setArtifacts([])
          setError(e instanceof Error ? e.message : 'Failed to load artifacts')
        }
      })
    return () => {
      live = false
    }
  }, [projectId])

  // Resolved once per response (and once per registry replacement) rather than per
  // render: a contribution is third-party display code and should not run again because
  // a parent re-rendered.
  const groups = useMemo(
    () =>
      (artifacts ?? []).length === 0
        ? []
        : groupArtifactsByScope(artifacts ?? []).map(group => ({
            ...group,
            sections: describeTypeSections(group.artifacts, SUMMARY_DEPS),
          })),
    // `registryVersion` is deliberately a dep that the body never reads: it is the
    // invalidation signal for the titles `SUMMARY_DEPS.title` resolves INSIDE
    // `describeTypeSections`, which a dependency scan cannot see through.
    [artifacts, registryVersion],
  )

  // ITEM-21 — the A3 EXIT METRIC. The Visualize pane offers artifacts whose producer declared
  // no alignment and MARKS them, which is right while the declaration spreads and becomes noise
  // the moment it is permanent: *"a migration state with no progress indicator becomes
  // permanent, and the marker becomes noise everyone learns to skip."* This is the indicator,
  // computed from the catalog this panel has already fetched. Absent — not zero — for a project
  // the question does not apply to.
  const coverage = useMemo(() => alignmentCoverage(artifacts ?? []), [artifacts])

  if (!project) return null

  return (
    <div className="flex flex-col" data-testid="project-artifacts-card">
      {error ? (
        <div className="mb-3 text-xs text-destructive" data-testid="project-artifacts-error">
          {error}
        </div>
      ) : null}

      {coverage.ratio !== null ? (
        <div
          className="mb-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          data-testid="project-artifacts-alignment-coverage"
        >
          <Tag variant="outline" className="shrink-0" data-testid="project-artifacts-alignment-coverage-value">
            {alignmentCoverageLabel(coverage)}
          </Tag>
          <span className="truncate">
            declare which rows they line up with. Until an artifact says so, a picture made from it
            rests on an assumption nobody checked.
          </span>
        </div>
      ) : null}

      {artifacts === null ? (
        <div
          className="py-6 text-center text-sm text-muted-foreground"
          data-testid="project-artifacts-loading"
        >
          Loading artifacts…
        </div>
      ) : artifacts.length === 0 ? (
        <Empty
          description="No artifacts yet — attach a dataset or run an analysis to produce them"
          data-testid="project-artifacts-empty"
        />
      ) : (
        <div className="flex flex-col gap-4" data-testid="project-artifacts-list">
          {groups.map(group => (
            <section
              key={group.key}
              className="flex flex-col gap-2"
              data-testid={`project-artifacts-scope-${group.key}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                {/* ITEM-48 — the empty bucket is an ABSENCE, not a peer category. The
                    icon says so before the words do: a box (a kind of thing) became a
                    question mark (a thing we cannot answer). */}
                {group.datasetId ? (
                  <Database className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <CircleHelp className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-sm font-medium">{group.label}</span>
                {/* A bare count: the pane's own title supplies the noun, so nothing here
                    has to invent one. */}
                <Tag
                  variant="outline"
                  className="shrink-0"
                  data-testid={`project-artifacts-scope-count-${group.key}`}
                >
                  {group.artifacts.length}
                </Tag>
              </div>

              {/* ITEM-47/48 — said once, under the heading that needs it. The heading
                  states the absence; this states what a reader should conclude from it,
                  because "No dataset recorded" alone still reads as though it might be a
                  KIND of artifact. Rendered only for the unassigned group, so it never
                  becomes chrome a reader learns to skip. */}
              {group.datasetId === null ? (
                <p
                  className="ps-6 text-xs text-muted-foreground"
                  data-testid="project-artifacts-unassigned-note"
                >
                  These could not be traced to a dataset — nothing here says what they are
                  about.
                </p>
              ) : null}

              {group.sections.map(section => (
                <div
                  key={section.datatype}
                  className="flex flex-col gap-0.5 ps-6"
                  data-testid={`project-artifacts-type-${group.key}-${section.datatype}`}
                >
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span
                      className="truncate text-sm"
                      data-testid={`project-artifacts-type-title-${group.key}-${section.datatype}`}
                    >
                      {section.title}
                    </span>
                    <span
                      className="truncate text-xs text-muted-foreground"
                      data-testid={`project-artifacts-type-summary-${group.key}-${section.datatype}`}
                    >
                      {section.summary}
                    </span>
                    {/* WHY this count and the dataset summary's count differ, said where
                        the difference is visible. Rendered only when the rows are NOT all
                        usable — when they are, the two numbers agree and there is nothing
                        to account for, so the qualifier's presence IS the signal. The
                        wording is the pane's arithmetic, never a package's phrase: the
                        contributed `{count}` template stays untouched. */}
                    {section.readiness.text ? (
                      <span
                        className="truncate text-xs text-muted-foreground"
                        title={section.readiness.detail ?? undefined}
                        data-testid={`project-artifacts-type-readiness-${group.key}-${section.datatype}`}
                      >
                        ({section.readiness.text})
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-col divide-y">
                    {section.artifacts.map(a => (
                      <div
                        key={a.id}
                        className="flex flex-col gap-0.5 py-1.5"
                        data-testid={`project-artifact-row-${a.id}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <FileBox className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm">{a.output_id}</span>
                          </div>
                          <ArtifactStatusTag status={a.status} artifactId={a.id} meta={a.meta} />
                        </div>
                        {a.status === 'unresolvable' ? (
                          <MissingSourceLine artifactId={a.id} meta={a.meta} />
                        ) : null}
                        <div className="flex shrink-0 items-center gap-2">
                          {/* WHO MADE IT (ITEM-48) — `generator_id` is the producing
                              ANALYSIS id, the same id an analysis contributes under; the
                              row's `run_id` answers "which execution" and is a UUID, which
                              is the internal id this pane already learned not to print.
                              NULL means NOT ATTRIBUTABLE (an import, an upload, a seeded
                              row, or a run that recorded no provenance) — so nothing is
                              rendered at all. An "unknown" chip would be this pane's own
                              "Produced in this project": a placeholder read as a fact.

                              RESIDUE, named rather than absorbed: a declared TITLE for the
                              analysis would beat its id, matching what this pane did for
                              datatypes. The titles exist, but only inside the workbench
                              module (`workbench/core/runtime/loadProcessors.ts`), and
                              reaching across for them is a coupling decision wider than
                              ITEM-48. The id is dotted and readable (`<package>.<analysis>`),
                              never a UUID, so it is honest in the meantime. */}
                          {a.generator_id ? (
                            <Tag
                              variant="outline"
                              data-testid={`project-artifact-producer-${a.id}`}
                            >
                              {a.generator_id}
                            </Tag>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
