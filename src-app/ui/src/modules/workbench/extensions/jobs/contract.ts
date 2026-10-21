// `extensions/jobs` — the PUBLISHED CONTRACT of the `jobs` capability (ITEM-11):
// run-a-processor-with-params, plus the run's status/progress stream.
//
// This is a RELOCATION of the working `compute` facade, not a new capability: the
// contract below is the former `core/api/compute.ts` `ComputeApi`, the plane is the
// former `createHost.ts` `createComputeHost` (`ApiClient.Jobs.create`/`.stream`), and
// the frame mapping is `./jobFrames.ts`. It now lives with the extension that owns it;
// core routes to it by id alone (INV-6).
//
// P5 DEFINES the FE `RunSpec`/`JobHandle` types (DEC-5: no such Rust type exists);
// `run` serializes a path-agnostic analysis spec into the REAL jobs path
// (`POST /api/jobs`, `job_type:"analysis"`, streamed via `GET /api/jobs/{id}/stream`).
// Content-addressed code + a path-agnostic `inputs.json` is kept regardless of backend,
// so a run IS a provenance node by construction (§0.6).

import type { BindingOrigin, Disposable, RunSpec, ScheduleSpec } from '@/modules/workbench/core'

/** The broker id this extension publishes under. */
export const JOBS_CAPABILITY_ID = 'jobs'
/** The published version. */
export const JOBS_CAPABILITY_VERSION = '1.0.0'
/** The range every in-tree consumer asks for. */
export const JOBS_CAPABILITY_RANGE = '^1'

/** A declared input mount (an artifact bound to a stable sandbox path). */
export interface RunInput {
  slot: string
  artifactId: string
  /**
   * How this binding was CHOSEN (ITEM-10) — `user` if a human picked it, `auto` if the
   * system did (sole candidacy, under a DECLARED `auto_bind_sole_candidate`).
   *
   * ABSENT means UNKNOWN, and unknown is never coerced to `'user'` (INV-4). A builder
   * that does not track origins (or a slot bound from a channel no picker writes) omits
   * it, and the wire omits the key with it — defaulting here would fabricate a claim
   * that a human reviewed the input.
   */
  origin?: BindingOrigin
}

/** The wire payload the plane turns into a `POST /api/jobs` analysis job. Its
 *  `params` is the FLAT backend `AnalysisSpec` (`language` + `code_ref` + typed
 *  `inputs` + processor `params` + `schedule`) — the exact shape
 *  `POST /api/jobs` parses. (It previously nested `{run,inputs,params,schedule}`,
 *  which did NOT match `AnalysisSpec` and failed to parse, so the run never ran.) */
export interface JobCreateRequest {
  job_type: 'analysis'
  project_id: string
  name?: string
  priority_class?: 'interactive' | 'normal' | 'batch'
  /** the FLAT `AnalysisSpec` serialized into the job `params`. */
  params: Record<string, unknown>
}

/** A streamed progress frame (mirrors the jobs SSE `ProgressFrame`). */
export interface JobFrame {
  phase: string
  pct?: number
  message?: string
}

/** A handle on a submitted job — its id + a progress subscription. */
export interface JobHandle {
  jobId: string
  onProgress(cb: (f: JobFrame) => void): Disposable
}

/** The BACKEND this capability is bound to (P3 jobs + SSE). The shell may inject one
 *  through `WorkbenchHost.planes['jobs']` (the gallery/e2e fake); otherwise the
 *  extension builds the real one. */
export interface ComputeHost {
  createJob(req: JobCreateRequest): Promise<{ jobId: string }>
  streamJob(jobId: string, onFrame: (f: JobFrame) => void): Disposable
}

/** The `jobs` capability an extension resolves out of the broker. */
export interface JobsApi {
  run(
    spec: RunSpec,
    inputs: RunInput[],
    params: Record<string, unknown>,
    opts?: { schedule?: ScheduleSpec; name?: string; analysisId?: string },
  ): Promise<JobHandle>
}

export type { RunSpec, ScheduleSpec }
