// The `jobs` capability IMPLEMENTATION (ITEM-11) — a PURE bind of the published
// `JobsApi` contract onto a project-bound plane. Verbatim relocation of the former
// `core/api/compute.ts` `createComputeApi`; the real plane wiring lives in
// `./jobsHost.ts` so this unit stays runnable in the `node --test` runner.

import type { ComputeHost, JobCreateRequest, JobsApi } from './contract.ts'

/**
 * E2 (DOMAIN_AUDIT) — the mount name a slot gets under `/inputs`.
 *
 * DECLARED by the processor (`run.inputs[slot]`), falling back to the BARE slot name.
 * This used to be `${slot}.h5ad`, unconditionally, for every slot of every processor:
 * the workbench inventing a single-cell file format on a format-neutral backend, in the
 * ONE place the FE names an input file (so no processor could override it). The name
 * matters only to a processor that sniffs its own input by suffix, and that processor
 * now says so in its manifest.
 *
 * A declared name is a plain FILE NAME. Anything that could escape `/inputs` (a
 * separator, `..`, an absolute path, a leading dot) is REFUSED here rather than
 * forwarded — the server's `validate_subpath` rejects it too, but a run that fails at
 * the sandbox boundary is a much worse diagnostic than a refusal at the call site.
 */

export function createJobsApi(host: ComputeHost, projectId: string): JobsApi {
  return {
    async run(spec, inputs, params, opts) {
      const priority = opts?.schedule?.class ?? 'normal'
      // Serialize a FLAT `AnalysisSpec` (what `POST /api/jobs` parses): the baked
      // builtin processor (`language` + `code_ref`), the artifact inputs mapped to
      // `InputDecl`s (slot → `artifact_ref` + a `sandbox_subpath`), the processor
      // `params` (written to /inputs/params.json), and the schedule.
      const analysisSpec: Record<string, unknown> = {
        params,
        // ITEM-10 — `origin` rides out as the wire key `bound_by`, and is OMITTED when
        // the builder did not know it. This is the ONE site that maps a `RunInput` onto
        // the wire, so the spread is the whole of the rule: an absent origin leaves the
        // payload byte-identical to what it was before this change, rather than
        // asserting `"user"` about a binding nobody reviewed (INV-4 / DEC-7).
        inputs: inputs.map(i => ({
          slot: i.slot,
          artifact_ref: i.artifactId,
          ...(i.origin ? { bound_by: i.origin } : {}),
        })),
      }
      if (spec.kind === 'sandbox') {
        analysisSpec.language = spec.runtime
        analysisSpec.code_ref = spec.entry
        if (spec.timeout != null) analysisSpec.timeout_secs = spec.timeout
      }
      if (opts?.schedule?.class) analysisSpec.schedule = { class: opts.schedule.class }
      // The producing analysis id (e.g. `demo.dependent`) — recorded as the run node's
      // `generator_id` so the review's "Re-run" affordance can resolve the analysis back
      // out of the provenance node (ITEM-63) instead of a hardcoded placeholder.
      if (opts?.analysisId) analysisSpec.analysis_id = opts.analysisId
      const req: JobCreateRequest = {
        job_type: 'analysis',
        project_id: projectId,
        name: opts?.name,
        priority_class: priority,
        params: analysisSpec,
      }
      const { jobId } = await host.createJob(req)
      return {
        jobId,
        onProgress: cb => host.streamJob(jobId, cb),
      }
    },
  }
}
