// The REAL `jobs` plane (ITEM-11) — `POST /api/jobs` + the jobs SSE, mapped to a
// `JobFrame`. Lifted verbatim out of the old `workbench/host/createHost.ts`
// (`createComputeHost`). The only file in `extensions/jobs` that touches the app's
// ApiClient, so `jobsCapability.ts` stays pure + node-testable.

import { ApiClient } from '@/api-client'
import { mapSseFrame } from './jobFrames.ts'
import type { ComputeHost, JobCreateRequest, JobFrame } from './contract.ts'
import type { Disposable } from '@/modules/workbench/core'

export function createJobsHost(): ComputeHost {
  return {
    createJob: async (req: JobCreateRequest) => {
      const job = await ApiClient.Jobs.create({
        job_type: req.job_type,
        name: req.name,
        project_id: req.project_id,
        priority_class: req.priority_class,
        params: req.params,
      })
      return { jobId: job.id }
    },
    streamJob: (jobId, onFrame) => {
      // The framework emits `__init` (carrying the AbortController) only AFTER its
      // internal `await fetch`, so a dispose() that lands before `__init` would find
      // `abort` unset and leak the stream. Latch a `disposed` flag: an early dispose
      // aborts as soon as `__init` arrives; a late dispose aborts immediately.
      let abort: AbortController | undefined
      let disposed = false
      void ApiClient.Jobs.stream(
        { id: jobId },
        {
          SSE: (event: string, data: unknown) => {
            if (event === '__init') {
              abort = (data as { abortController: AbortController }).abortController
              if (disposed) abort.abort()
              return
            }
            // Map the REAL jobs SSE vocabulary — status / progress / metric / log —
            // into a FE frame (ITEM-22). The `progress` frame (the real progress
            // driver) is no longer dropped; `metric`/`log` read the fields the
            // backend actually emits (`cpu_pct`/`mem_bytes`, `content`) instead of
            // the phantom `data.value`/`data.message`. `WorkbenchJobFrame` extends
            // `JobFrame`, so the extra typed payload rides the callback unchanged.
            const frame = mapSseFrame(event, data)
            if (frame) onFrame(frame)
          },
        },
      ).catch(() => {
        /* stream ended / aborted */
      })
      return {
        dispose: () => {
          disposed = true
          abort?.abort()
        },
      }
    },
  }
}

/** The seeded FAKE plane the gallery + unit-style e2e seams run against (no backend).
 *  Lifted verbatim from `makeFakeHost`'s inline `ComputeHost` literal. */
export function makeFakeJobsHost(): ComputeHost {
  return {
    createJob: async () => ({ jobId: 'fake-job' }),
    streamJob: (_id, onFrame): Disposable => {
      // Emit the REAL terminal jobs-status vocabulary (`completed`), which the run
      // lifecycle keys on — `'done'` fell outside it and hung the gallery/e2e Run.
      onFrame({ phase: 'running', pct: 50 } satisfies JobFrame)
      onFrame({ phase: 'completed', pct: 100 } satisfies JobFrame)
      return { dispose: () => {} }
    },
  }
}
