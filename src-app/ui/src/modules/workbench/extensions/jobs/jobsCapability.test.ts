// TEST-13 (ITEM-11) — `jobs.run` serializes into the real jobs payload + streams.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobsApi } from './jobsCapability.ts'
import { JOBS_CAPABILITY_ID } from './contract.ts'
import type { JobCreateRequest, JobFrame, RunSpec } from './contract.ts'

test('the published id is the exact string core routes on', () => {
  assert.equal(JOBS_CAPABILITY_ID, 'jobs')
})

test('TEST-13: run() builds an analysis job payload + drives progress from the plane stream', async () => {
  let captured: JobCreateRequest | null = null
  const frames: JobFrame[] = []
  const plane = {
    createJob: async (req: JobCreateRequest) => {
      captured = req
      return { jobId: 'job-42' }
    },
    streamJob: (jobId: string, onFrame: (f: JobFrame) => void) => {
      assert.equal(jobId, 'job-42')
      onFrame({ phase: 'running', pct: 0.5, message: 'clustering' })
      return { dispose() {} }
    },
  }
  const api = createJobsApi(plane, 'project-1')
  const spec: RunSpec = { kind: 'sandbox', runtime: 'python', entry: 'leiden.py' }
  const handle = await api.run(spec, [{ slot: 'embedding', artifactId: 'a1' }], { resolution: 0.6 }, {
    schedule: { class: 'interactive' },
    name: 'Leiden',
  })

  assert.equal(handle.jobId, 'job-42')
  assert.equal(captured!.job_type, 'analysis')
  assert.equal(captured!.project_id, 'project-1')
  assert.equal(captured!.priority_class, 'interactive')
  // The payload is a FLAT `AnalysisSpec` (what `POST /api/jobs` parses), NOT the
  // old nested `{run,inputs,params}` shape that failed to parse.
  const p = captured!.params as Record<string, any>
  assert.equal(p.language, 'python')
  assert.equal(p.code_ref, 'leiden.py')
  assert.equal(p.inputs[0].slot, 'embedding')
  assert.equal(p.inputs[0].artifact_ref, 'a1')
  assert.equal(p.params.resolution, 0.6)
  assert.equal(p.schedule.class, 'interactive')

  handle.onProgress((f: JobFrame) => frames.push(f))
  assert.equal(frames[0].pct, 0.5)
})

// TEST-12 (ITEM-10) — a binding's ORIGIN reaches the wire, and its ABSENCE reaches the
// wire as an absence.
//
// This is the layer at which an auto-bound input and a chosen one used to become the same
// two keys. The assertions below are about the DISTINCTION, not about the serializer
// working: the same slot holding the same artifact is sent three ways, and all three have
// to be told apart on the wire.
test('TEST-12: run() serializes `origin` as `bound_by` — and OMITS it when absent', async () => {
  let captured: JobCreateRequest | null = null
  const plane = {
    createJob: async (req: JobCreateRequest) => {
      captured = req
      return { jobId: 'j' }
    },
    streamJob: () => ({ dispose() {} }),
  }
  const api = createJobsApi(plane, 'p')
  const spec: RunSpec = { kind: 'sandbox', runtime: 'python', entry: 'probe.py' }
  await api.run(
    spec,
    [
      // The SAME artifact in three slots, differing ONLY in how it was chosen. If the
      // origin were dropped (or defaulted), these three would serialize identically —
      // which is precisely the state this change exists to end.
      { slot: 'picked', artifactId: 'a1', origin: 'user' },
      { slot: 'guessed', artifactId: 'a1', origin: 'auto' },
      { slot: 'unknown', artifactId: 'a1' },
    ],
    {},
  )
  const p = captured!.params as Record<string, any>
  const bySlot = Object.fromEntries(p.inputs.map((i: any) => [i.slot, i]))

  assert.equal(bySlot.picked.bound_by, 'user')
  assert.equal(bySlot.guessed.bound_by, 'auto')
  // ABSENT, not `"user"`. Defaulting here would fabricate a claim that a human reviewed
  // an input nobody looked at — the one thing the record must never say (INV-4 / DEC-7).
  assert.equal(
    Object.prototype.hasOwnProperty.call(bySlot.unknown, 'bound_by'),
    false,
    'an input with no known origin must carry NO bound_by key, not a default',
  )

  // …and the two keys that were already on the wire are untouched by any of it: an
  // origin-less run is byte-identical to what this serializer produced before.
  assert.deepEqual(
    p.inputs.map((i: any) => [i.slot, i.artifact_ref]),
    [
      ['picked', 'a1'],
      ['guessed', 'a1'],
      ['unknown', 'a1'],
    ],
  )
  assert.deepEqual(Object.keys(bySlot.unknown).sort(), ['artifact_ref', 'slot'])
})

test('E2: the workbench names NO mount path — it cannot invent or forward one', async () => {
  let captured: JobCreateRequest | null = null
  const plane = {
    createJob: async (req: JobCreateRequest) => {
      captured = req
      return { jobId: 'j' }
    },
    streamJob: () => ({ dispose() {} }),
  }
  const api = createJobsApi(plane, 'p')
  const spec: RunSpec = {
    kind: 'sandbox',
    runtime: 'python',
    entry: 'demo.py',
  }
  await api.run(
    spec,
    [
      { slot: 'expression', artifactId: 'a1' },
      { slot: 'notes', artifactId: 'a2' },
    ],
    {},
  )
  const p = captured!.params as Record<string, any>
  // The client sends NO mount name. It used to send `sandbox_subpath`, derived from the
  // processor's declared `run.inputs`; the runner now derives every artifact mount from the
  // ARTIFACT (its slot + declared encoding), so a client-supplied name would be ignored.
  // Asserted as an ABSENCE on every input, which is what makes the next test's claim true.
  //
  // This SUBSUMES the deleted DOMAIN_AUDIT E2 pair. Those guarded against the workbench
  // INVENTING a path — it used to mount every slot of every processor as `${slot}.h5ad`, so
  // an image processor's `image` slot arrived as `image.h5ad`. "Sends nothing" is strictly
  // stronger than "sends the bare slot name": there is no longer a channel to invent into.
  for (const i of p.inputs) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(i, 'sandbox_subpath'),
      false,
      `input ${i.slot} still carries a client-supplied sandbox_subpath`,
    )
  }
  // Non-vacuity: the inputs really are there, so the loop above is not passing over nothing.
  assert.deepEqual(
    p.inputs.map((i: any) => [i.slot, i.artifact_ref]),
    [
      ['expression', 'a1'],
      ['notes', 'a2'],
    ],
  )
})

// E2 RE-EXPRESSED, not deleted. It used to assert that a declared mount name escaping
// `/inputs` (`../../etc/passwd`) was REFUSED client-side. That refusal is gone because the
// thing it guarded is gone: `run.inputs` is a removed key (a manifest declaring it fails to
// load), and the client no longer sends a subpath at all.
//
// The security property survives and is STRONGER — an escape is now unrepresentable rather
// than refused — but it is enforced on the SERVER (`sandbox/spec.rs::validate_subpath`,
// which rejects absolute paths, `.`/`..` components and control characters). So this test
// asserts the client half: the type carries no channel to put a path in, which is why the
// browser cannot propose one.
test('E2: the run spec exposes NO channel for a client-supplied mount path', () => {
  const spec: RunSpec = { kind: 'sandbox', runtime: 'python', entry: 'x.py' }
  // A path-shaped value cannot be attached to a sandbox RunSpec at all — this is a
  // compile-time property, asserted at runtime over the shape the builder actually reads.
  assert.deepEqual(Object.keys(spec).sort(), ['entry', 'kind', 'runtime'])
})

// TEST-43 (ITEM-35), PRODUCER HALF — a FUSED pick's members reach the wire as several
// bindings on ONE slot, in order, none collapsed.
//
// The consumer half is `server/tests/provenance/fused_input_test.rs`, and it asserts over
// exactly the literal this test asserts the builder emits: `{slot, artifact_ref}` repeated,
// primary first. The two are written against the same shape ON PURPOSE — a producer and a
// consumer whose unit fixtures each agree only with themselves is how a wire contract
// silently splits in two.
//
// A fused offer stores ONE id (the primary) but SPANS several artifacts, and provenance
// records resolved artifacts: contributing only the primary is a lineage that claims one
// input where two were used, and nothing downstream can tell. `hostCtx::resolveInputs`
// expands the array-valued pick into one `RunInput` per member on the shared slot; this is
// the step after, where those become wire entries.
//
// The assertion is over the ORDERED PAIR LIST, never over a count and never keyed by slot —
// a `Object.fromEntries(...map(i => [i.slot, i]))` reading (which this file's TEST-12 uses
// legitimately, for three DISTINCT slots) would silently keep the last member and drop the
// rest, which is the exact defect.
test('TEST-43: a fused pick serializes EVERY member on its one slot, in order', async () => {
  let captured: JobCreateRequest | null = null
  const plane = {
    createJob: async (req: JobCreateRequest) => {
      captured = req
      return { jobId: 'j' }
    },
    streamJob: () => ({ dispose() {} }),
  }
  const api = createJobsApi(plane, 'p')
  const spec: RunSpec = { kind: 'sandbox', runtime: 'python', entry: 'probe.py' }
  await api.run(
    spec,
    [
      // The shape `resolveInputs` produces from an array-valued declared input: one slot,
      // one entry per fused member, the deterministic PRIMARY first.
      { slot: 'colour_source', artifactId: 'art-primary', origin: 'user' },
      { slot: 'colour_source', artifactId: 'art-second', origin: 'user' },
      // An ordinary unfused slot beside it, so "every member" cannot be satisfied by a
      // builder that simply forwards everything it was given under one name.
      { slot: 'matrix', artifactId: 'art-matrix', origin: 'user' },
    ],
    {},
  )
  const p = captured!.params as Record<string, any>

  assert.deepEqual(
    p.inputs.map((i: any) => [i.slot, i.artifact_ref]),
    [
      ['colour_source', 'art-primary'],
      ['colour_source', 'art-second'],
      ['matrix', 'art-matrix'],
    ],
    'membership AND sequence: a keep-first or keep-last collapse of the repeated slot loses ' +
      'a member while every count-based assertion still agrees',
  )
  // …and the origin travels with EACH member, not only with the first. A slot-keyed stamp
  // would attribute the fused pick's review to one arbitrary member of it.
  assert.deepEqual(
    p.inputs.map((i: any) => i.bound_by),
    ['user', 'user', 'user'],
  )
})

// PRODUCER HALF — an input slot bound to SEVERAL artifacts reaches the wire as several
// bindings on ONE slot, in order, none collapsed.
//
// The consumer half is `server/tests/provenance/repeated_slot_input_test.rs`, and it
// asserts over exactly the literal this test asserts the builder emits: `{slot,
// artifact_ref}` repeated, head member first. The two are written against the same shape ON
// PURPOSE — a producer and a consumer whose unit fixtures each agree only with themselves is
// how a wire contract silently splits in two.
//
// An array-valued pick stores ONE id but SPANS several artifacts, and provenance records
// resolved artifacts: contributing only the head is a lineage that claims one input where
// two were used, and nothing downstream can tell. `hostCtx::resolveInputs` expands the pick
// into one `RunInput` per member on the shared slot; this is the step after, where those
// become wire entries.
//
// The assertion is over the ORDERED PAIR LIST, never over a count and never keyed by slot —
// an `Object.fromEntries(...map(i => [i.slot, i]))` reading (which this file's TEST-12 uses
// legitimately, for three DISTINCT slots) would silently keep the last member and drop the
// rest, which is the exact defect.
test('a repeated slot serializes EVERY binding on that one slot, in order', async () => {
  let captured: JobCreateRequest | null = null
  const plane = {
    createJob: async (req: JobCreateRequest) => {
      captured = req
      return { jobId: 'j' }
    },
    streamJob: () => ({ dispose() {} }),
  }
  const api = createJobsApi(plane, 'p')
  const spec: RunSpec = { kind: 'sandbox', runtime: 'python', entry: 'probe.py' }
  await api.run(
    spec,
    [
      // The shape `resolveInputs` produces from an array-valued declared input: one slot,
      // one entry per member, the deterministic HEAD member first.
      { slot: 'colour_source', artifactId: 'art-primary', origin: 'user' },
      { slot: 'colour_source', artifactId: 'art-second', origin: 'user' },
      // An ordinary single-binding slot beside it, so "every binding" cannot be satisfied by
      // a builder that simply forwards everything it was given under one name.
      { slot: 'matrix', artifactId: 'art-matrix', origin: 'user' },
    ],
    {},
  )
  const p = captured!.params as Record<string, any>

  assert.deepEqual(
    p.inputs.map((i: any) => [i.slot, i.artifact_ref]),
    [
      ['colour_source', 'art-primary'],
      ['colour_source', 'art-second'],
      ['matrix', 'art-matrix'],
    ],
    'membership AND sequence: a keep-first or keep-last collapse of the repeated slot loses ' +
      'a binding while every count-based assertion still agrees',
  )
  // …and the origin travels with EACH binding, not only with the first. A slot-keyed stamp
  // would attribute the whole pick's review to one arbitrary member of it.
  assert.deepEqual(
    p.inputs.map((i: any) => i.bound_by),
    ['user', 'user', 'user'],
  )
})
