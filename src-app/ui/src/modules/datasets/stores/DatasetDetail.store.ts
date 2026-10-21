import { ApiClient } from '@/api-client'
import {
  type DatasetWithFiles,
  type Datatype,
  type ForwardGraphDto,
  type Job,
  type JobLog,
  type JobMilestone,
  type MilestoneFrame,
} from '@/api-client/types'
import {
  Permissions,
} from '@/api-client/permissions'
import { hasPermissionNow } from '@/core/permissions'
import { echoLocalSync } from '@/core/sync/localEcho'
import { defineStore, registerLazyStore } from '@ziee/framework/store-kit'

/** Which detail tab is showing. */
export type DetailTab = 'contents' | 'supporting' | 'lineage'

/** The live process-job view (a dataset-scoped analysis run — DEC-5). */
export interface ProcessJobState {
  jobId: string
  name: string
  status: string
  logs: JobLog[]
  /** The user-facing step ticker (ITEM-24) — the manifest-declared steps the running
   *  converter reports, each with the finding it harvested (e.g. a `detect columns`
   *  step reporting `3 (alpha, beta)`), replayed on reload + streamed. */
  milestones: JobMilestone[]
  running: boolean
}

// Non-reactive refs (singleton store): the live jobs-SSE AbortController. Kept out
// of reactive state so per-frame log arrivals don't thrash unrelated subscribers.
let streamAbort: AbortController | null = null

/**
 * One dataset's detail view — its files (Contents), a dataset-scoped
 * processing pipeline (Pipeline, owner-scoped — NO project, DEC-5), and its forward
 * provenance lineage (Lineage). The page drives `loadDataset(id)` via a mount
 * effect (mirrors `ProjectDetail`); `init` only wires sync + does NOT auto-load
 * (it has no id). Streaming reuses the jobs SSE path (`Jobs.get` + `Jobs.stream`).
 */
const DatasetDetailDef = defineStore('DatasetDetail', {
  state: {
    dataset: null as DatasetWithFiles | null,
    loading: false,
    error: null as string | null,
    tab: 'contents' as DetailTab,
    // Lineage (forward provenance).
    forward: null as ForwardGraphDto | null,
    lineageLoading: false,
    lineageError: null as string | null,
    // Pipeline (a running/finished dataset-scoped process job).
    processJob: null as ProcessJobState | null,
    processError: null as string | null,
    submitting: false,
    promoting: false,
    // Supporting files (ITEM-15): the `/datatypes` catalog (for axis lookup) +
    // the add-supporting-file mutation's transient state.
    datatypes: [] as Datatype[],
    addingSupporting: false,
    addSupportingPct: 0,
    addSupportingError: null as string | null,
  },
  actions: (set, get) => {
    const loadDataset = async (id: string) => {
      if (!hasPermissionNow(Permissions.ProjectsUse)) return
      set({ loading: true, error: null })
      try {
        const dataset = await ApiClient.Dataset.get({ id })
        set({ dataset, loading: false })
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load dataset',
        })
      }
    }

    /** Load the `/datatypes` catalog once (used to resolve a dataset's declared
     *  axes for the add-supporting-file form). Static + bounded — fetched lazily
     *  and cached; a failure just leaves the axis picker empty. */
    const loadDatatypes = async () => {
      if (get().datatypes.length > 0) return
      try {
        const datatypes = await ApiClient.Datatype.list()
        set({ datatypes })
      } catch {
        /* leave empty — the Add form self-guards on an available axis set */
      }
    }

    const loadLineage = async (id: string) => {
      if (!hasPermissionNow(Permissions.ProvenanceRead)) return
      set({ lineageLoading: true, lineageError: null })
      try {
        const forward = await ApiClient.Provenance.forward({ dataset_id: id })
        if (get().dataset?.id === id) set({ forward, lineageLoading: false })
      } catch (error) {
        set({
          lineageLoading: false,
          lineageError: error instanceof Error ? error.message : 'Failed to load lineage',
        })
      }
    }

    /** Attach a jobs-SSE stream to a submitted process job (logs + terminal
     *  status), mirroring the Jobs store's replay-then-stream pattern. */
    const streamJob = async (job: Job) => {
      const seen = new Set<number>()
      try {
        const detail = await ApiClient.Jobs.get({ id: job.id })
        detail.logs.forEach(l => seen.add(l.seq))
        set({
          processJob: {
            jobId: job.id,
            name: job.name,
            status: detail.job.status,
            logs: detail.logs,
            milestones: detail.milestones,
            running: detail.job.status === 'queued' || detail.job.status === 'running',
          },
        })
      } catch {
        /* the create succeeded; a detail fetch miss just skips the replay */
      }
      void ApiClient.Jobs.stream(
        { id: job.id },
        {
          SSE: (event: string, data: unknown) => {
            if (event === '__init') {
              streamAbort = (data as { abortController: AbortController }).abortController
              return
            }
            if (get().processJob?.jobId !== job.id) return
            if (event === 'log') {
              const l = data as JobLog
              if (seen.has(l.seq)) return
              seen.add(l.seq)
              set(s => ({
                processJob: s.processJob
                  ? { ...s.processJob, logs: [...s.processJob.logs, l] }
                  : s.processJob,
              }))
            } else if (event === 'milestone') {
              // A named step the running converter emitted. Upsert by step id so a
              // `started`→`done` transition updates one step, never duplicates it.
              const f = data as MilestoneFrame
              set(s => {
                if (!s.processJob) return s
                const step: JobMilestone = {
                  id: crypto.randomUUID(),
                  job_id: job.id,
                  milestone_id: f.id,
                  status: f.status,
                  detail: f.detail,
                  created_at: new Date().toISOString(),
                }
                const existing = s.processJob.milestones
                const at = existing.findIndex(m => m.milestone_id === f.id)
                const milestones =
                  at >= 0
                    ? existing.map((m, i) => (i === at ? { ...step, id: m.id } : m))
                    : [...existing, step]
                return { processJob: { ...s.processJob, milestones } }
              })
            } else if (event === 'status') {
              const status = (data as { status: string }).status
              set(s => ({
                processJob: s.processJob
                  ? {
                      ...s.processJob,
                      status,
                      running: status === 'queued' || status === 'running',
                    }
                  : s.processJob,
              }))
            }
          },
        },
      )
        .catch(() => {
          /* stream ended / aborted */
        })
        .finally(() => {
          set(s => ({
            processJob: s.processJob ? { ...s.processJob, running: false } : s.processJob,
          }))
          // A finished run may have produced promotable outputs — refresh lineage.
          const id = get().dataset?.id
          if (id) void loadLineage(id)
        })
    }

    return {
      setTab: (tab: DetailTab) => {
        set({ tab })
        const id = get().dataset?.id
        if (tab === 'lineage' && id && !get().forward && !get().lineageLoading) {
          void loadLineage(id)
        }
        if (tab === 'supporting') void loadDatatypes()
      },
      loadDataset,
      loadLineage,
      loadDatatypes,

      /** Add an axis-aligned supporting annotation table to a converted dataset
       *  (ITEM-14/15). Streams a multipart {file, axis, kind} to
       *  `POST /datasets/{id}/supporting-files`; the endpoint links it
       *  `role=supporting`, `integration_status=pending` and fires the integrate
       *  job. We refetch the dataset so the new pending row shows immediately;
       *  live status transitions arrive via the `sync:dataset` subscription. */
      addSupportingFile: async (
        datasetId: string,
        { file, axis, kind }: { file: File; axis: string; kind?: string },
      ): Promise<void> => {
        set({ addingSupporting: true, addSupportingPct: 0, addSupportingError: null })
        try {
          const form = new FormData()
          // The core replaces the `{id}` path capture from the FormData entry.
          form.append('id', datasetId)
          form.append('file', file, file.name)
          form.append('axis', axis)
          form.append('kind', kind ?? 'annotation_table')
          await ApiClient.Dataset.addSupportingFile(
            form as unknown as { id: string } & FormData,
            {
              fileUploadProgress: {
                onProgress: (_p: number, _i: number, overall: number) =>
                  set({ addSupportingPct: Math.round(overall) }),
              },
            },
          )
          set({ addingSupporting: false, addSupportingPct: 100 })
          // `add_supporting_file` (routes.rs:1525) publishes `Dataset`/`Update` to the
          // acting user with `origin` applied. Echoing it — instead of the inline
          // `loadDataset` this used to run — refreshes THIS pane through its own
          // `sync:dataset` subscription AND the library grid + workbench catalog, which
          // the private reload never reached.
          await echoLocalSync('dataset', 'update', datasetId)
        } catch (error) {
          set({
            addingSupporting: false,
            addSupportingError:
              error instanceof Error ? error.message : 'Failed to add supporting file',
          })
          throw error
        }
      },

      /** Submit a processor as a dataset-scoped analysis job. `spec` is the
       *  processor's `AnalysisSpec`-shaped compute spec; the backend appends the
       *  dataset's file(s) as inputs at `dataset_slot` (ITEM-23). */
      runProcessor: async (
        datasetId: string,
        spec: unknown,
        opts?: { name?: string; priorityClass?: string; datasetSlot?: string },
      ): Promise<void> => {
        if (streamAbort) {
          streamAbort.abort()
          streamAbort = null
        }
        set({ submitting: true, processError: null })
        try {
          const job = await ApiClient.Dataset.process({
            id: datasetId,
            spec,
            ...(opts?.name ? { name: opts.name } : {}),
            ...(opts?.priorityClass ? { priority_class: opts.priorityClass } : {}),
            ...(opts?.datasetSlot ? { dataset_slot: opts.datasetSlot } : {}),
          })
          set({ submitting: false })
          await streamJob(job)
        } catch (error) {
          set({
            submitting: false,
            processError: error instanceof Error ? error.message : 'Failed to start processing',
          })
          throw error
        }
      },

      /** Promote a run artifact (role='artifact') into a new owned dataset (DEC-7). */
      promote: async (artifactId: string, name?: string): Promise<DatasetWithFiles | undefined> => {
        set({ promoting: true, processError: null })
        try {
          const created = await ApiClient.Dataset.promote({
            artifact_id: artifactId,
            ...(name ? { name } : {}),
          })
          set({ promoting: false })
          // Previously this refreshed NOTHING — the dataset the user had just made out
          // of a run artifact was invisible in the acting tab's library until a reload,
          // while every other device showed it immediately. `promote_artifact`
          // (routes.rs:1764) publishes `Dataset`/`Create` for the NEW dataset id.
          await echoLocalSync('dataset', 'create', created.id)
          return created
        } catch (error) {
          set({
            promoting: false,
            processError: error instanceof Error ? error.message : 'Failed to promote artifact',
          })
          throw error
        }
      },

      reset: () => {
        if (streamAbort) {
          streamAbort.abort()
          streamAbort = null
        }
        set({
          dataset: null,
          error: null,
          tab: 'contents',
          forward: null,
          lineageError: null,
          processJob: null,
          processError: null,
          addingSupporting: false,
          addSupportingPct: 0,
          addSupportingError: null,
        })
      },
    }
  },
  init: ({ on, actions, onCleanup }) => {
    const reload = () => {
      const id = DatasetDetailDef.store.getState().dataset?.id
      if (id && hasPermissionNow(Permissions.ProjectsUse)) void actions.loadDataset(id)
    }
    on('sync:dataset', reload)
    on('sync:reconnect', reload)
    onCleanup(() => actions.reset())
  },
})

export const useDatasetDetailStore = DatasetDetailDef.store

/**
 * The reactive store PROXY — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under `'DatasetDetail'`, so a
 * `stores: [...]` entry (if any remains) REUSES this instance rather than building a
 * second one with an independent ref count — which would run `init` (and every
 * `sync:*` listener it registers) twice.
 */
export const DatasetDetail = registerLazyStore(DatasetDetailDef)
