import { describe, expect, it, vi } from 'vitest'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import type { JobFrame, JobHandle, JobsApi } from '@/modules/workbench/extensions/jobs/contract'
import { createWorkbenchInterpreterCtx, waitForJob } from './hostCtx'
import { interpretBody } from './interpreter'
import type { InterpreterStore } from './interpreter'

/** A fake JobHandle whose `onProgress` replays a canned frame sequence synchronously. */
function fakeHandle(jobId: string, frames: JobFrame[]): JobHandle {
  return {
    jobId,
    onProgress(cb) {
      for (const f of frames) cb(f)
      return { dispose: () => {} }
    },
  }
}

interface FakeApiOpts {
  analyses?: Record<string, unknown>
  artifacts?: { id: string }[]
  run?: JobsApi['run']
  notify?: (msg: string, level?: string) => void
}

function fakeApi(opts: FakeApiOpts = {}): WorkbenchAPI {
  return {
    version: '1',
    extensionId: 'test',
    registry: {
      analyses: { get: (id: string) => opts.analyses?.[id], all: () => [], has: () => false },
    },
    capabilities: fakeCapabilities(opts),
    ui: { notify: opts.notify ?? (() => {}) },
  } as unknown as WorkbenchAPI
}

/** A REAL broker stocked with fake `data` + `jobs` implementations — the ctx resolves
 *  them by id exactly as it does in production. */
function fakeCapabilities(opts: FakeApiOpts) {
  const broker = createCapabilityBroker()
  broker.publish('data', '1.0.0', {
    artifacts: { query: async () => opts.artifacts ?? [] },
  } as unknown as DataApi)
  broker.publish('jobs', '1.0.0', {
    run: opts.run ?? (async () => fakeHandle('job-1', [{ phase: 'completed', pct: 100 }])),
  } as unknown as JobsApi)
  return broker
}

// The inputs are `appliesTo` SLOTS now; `params.fields` is gone from the contract (INV-1).
const DEMO_ANALYSIS = {
  id: 'demo.analysis',
  title: 'Run analysis',
  run: { kind: 'sandbox', runtime: 'python', entry: 'compute/demo-analysis.py' },
  schedule: { class: 'normal' },
  // ITEM-29f — DECLARES the launch-time auto-bind, because the specs below are about what
  // `resolveInputs` RESOLVES and what the job bag carries, not about the bind's own gate. That
  // gate is asserted separately (TEST-90) with an undeclared twin of this fixture.
  appliesTo: [{ slot: 'matrix', subtypes_of: 'demo/table', auto_bind_sole_candidate: true }],
}

describe('createWorkbenchInterpreterCtx.runProcessor (ITEM-10)', () => {
  it('resolves the analysis + auto-picks the sole input + submits via compute.run', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-42', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-1' }], run }),
    })
    const handle = (await ctx.runProcessor!('demo.analysis', { metrics: [], mode: 'fast' })) as JobHandle
    expect(handle.jobId).toBe('job-42')
    expect(run).toHaveBeenCalledTimes(1)
    const [spec, inputs, params, launchOpts] = run.mock.calls[0]
    expect((spec as { entry: string }).entry).toBe('compute/demo-analysis.py')
    // `origin: 'auto'` is binding-origin ITEM-11: this is the HEADLESS bind — the caller
    // supplied nothing and cannot be asked — so the fact that nobody looked at this input is
    // precisely what has to survive into the run's record.
    expect(inputs).toEqual([{ slot: 'matrix', artifactId: 'art-1', origin: 'auto' }])
    expect((params as Record<string, unknown>).mode).toBe('fast')
    expect((launchOpts as { analysisId: string }).analysisId).toBe('demo.analysis')
    // …and a PARAM is never mistaken for an artifact input. `mode: 'fast'` is a plain
    // value; when inputs were resolved off the params bag it bound as `{slot:'mode',
    // artifactId:'fast'}` — a phantom slot pointing at a nonexistent artifact.
    expect(inputs).not.toContainEqual(expect.objectContaining({ slot: 'mode' }))
  })

  it('binds the DECLARED inputs, and only those (INV-4)', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-43', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      // TWO candidates: an auto-pick is impossible, so anything bound came from the
      // declaration rather than the catalog.
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'a' }, { id: 'b' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', { metrics: [] }, { matrix: 'chosen-1', extra: 'other-art' })
    const [, inputs, params] = run.mock.calls[0]
    // `extra` is bound even though `appliesTo` does not name it — every entry there is
    // required (DEC-5), so an OPTIONAL input has no entry and never could have one. That
    // is the shape of a view-declared optional input, and iterating `appliesTo` alone
    // dropped it.
    expect(inputs).toEqual([
      { slot: 'matrix', artifactId: 'chosen-1' },
      { slot: 'extra', artifactId: 'other-art' },
    ])
    expect(params).toEqual({ metrics: [] })
  })

  // ── TEST-43 (ITEM-35, DEC-D) — the MIDDLE link: a fused pick's member set becomes an ───
  // array-valued binding. TEST-43's two ends already hold (jobsCapability maps N bindings to
  // N wire entries; the recorder records N `used` edges); this is the link between them that
  // Option D adds — `resolveInputs` reads the store member-set sidecar (5th arg) and binds
  // EVERY member on the one slot, PRIMARY first, while the stored value stays the one id.
  it('binds EVERY member of a fused pick — not just the stored primary (TEST-43 end-to-end)', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-43e', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'a' }, { id: 'b' }], run }),
    })
    // Stored VALUE is the ONE primary id `colour-a1` (INV-4); the fused member set travels in
    // the 5th `inputArtifacts` arg, primary first.
    await ctx.runProcessor!(
      'demo.analysis',
      { metrics: [] },
      { colour: 'colour-a1' },
      { colour: 'user' },
      { colour: ['colour-a1', 'colour-b1'] },
    )
    const [, inputs] = run.mock.calls[0]
    expect(inputs, 'both members recorded as inputs on the one slot, primary first, origin carried').toEqual([
      { slot: 'colour', artifactId: 'colour-a1', origin: 'user' },
      { slot: 'colour', artifactId: 'colour-b1', origin: 'user' },
    ])
  })

  it('a MIXED multi-select binds the fused members AND the unfused pick — nothing dropped (FIX_ROUND-1)', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-43e-mix', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'a' }, { id: 'b' }], run }),
    })
    // Value = the picked ids ['a1','x1'] (a1 fused → [a1,b1], x1 unfused). The member set the
    // widget produced is the FULL expansion [a1,b1,x1]; the run must bind all three, not drop x1.
    await ctx.runProcessor!(
      'demo.analysis',
      { metrics: [] },
      { colour: ['a1', 'x1'] },
      { colour: 'user' },
      { colour: ['a1', 'b1', 'x1'] },
    )
    const [, inputs] = run.mock.calls[0]
    expect(inputs).toEqual([
      { slot: 'colour', artifactId: 'a1', origin: 'user' },
      { slot: 'colour', artifactId: 'b1', origin: 'user' },
      { slot: 'colour', artifactId: 'x1', origin: 'user' },
    ])
  })

  it('an UNFUSED pick (no member set) binds exactly the one stored id — negative control', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-43e-nc', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'a' }, { id: 'b' }], run }),
    })
    // Same call, member-set map ABSENT: the single-dataset path binds the one primary and nothing
    // more — the fused arm must not fabricate members from a value that stood for one artifact.
    await ctx.runProcessor!('demo.analysis', { metrics: [] }, { colour: 'colour-a1' }, { colour: 'user' })
    const [, inputs] = run.mock.calls[0]
    expect(inputs).toEqual([{ slot: 'colour', artifactId: 'colour-a1', origin: 'user' }])
  })

  // ── TEST-90 (ITEM-29f) — the launch-time half of R2/INV-3 ─────────────────────────
  //
  // Reaching this path means a caller that supplied nothing and CANNOT BE ASKED — an agent or
  // an MCP call. R2's remedy for a sole candidate is a declared affordance "so the form shows
  // what it bound"; there is no form here, so the only half of the rule that can hold is the
  // declaration, and it holds absolutely. Undeclared, the slot stays unbound and the compute
  // reports it BY NAME — which the shipped comment beside this code already argues is the
  // better error.
  it('does NOT auto-bind a sole candidate for a slot that did not DECLARE it', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-90', [{ phase: 'completed' }]))
    const undeclared = {
      ...DEMO_ANALYSIS,
      appliesTo: [{ slot: 'matrix', subtypes_of: 'demo/table' }],
    }
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': undeclared }, artifacts: [{ id: 'art-1' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', {})
    const [, inputs] = run.mock.calls[0]
    expect(inputs, 'an undeclared slot is left for the compute to report by name').toEqual([])
  })

  it('a CALLER-SUPPLIED binding is unaffected by the declaration — it was never a guess', async () => {
    // The positive control for the rule's SCOPE. The gate is about auto-binding, not about
    // binding: what the caller decided is what the caller decided, declaration or not.
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-91', [{ phase: 'completed' }]))
    const undeclared = {
      ...DEMO_ANALYSIS,
      appliesTo: [{ slot: 'matrix', subtypes_of: 'demo/table' }],
    }
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': undeclared }, artifacts: [{ id: 'art-1' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', {}, { matrix: 'chosen-1' })
    const [, inputs] = run.mock.calls[0]
    expect(inputs).toEqual([{ slot: 'matrix', artifactId: 'chosen-1' }])
  })

  it('throws for an unknown analysis id', async () => {
    const ctx = createWorkbenchInterpreterCtx({ api: fakeApi({ analyses: {} }) })
    await expect(ctx.runProcessor!('nope', {})).rejects.toThrow(/unknown analysis/)
  })

  // Was: "throws when a required input has no sole compatible artifact". The THROW is gone
  // by design — it was a launch-time failure the user had no way to prevent, because the
  // input was never on screen to be chosen (`found ${options.length}`). The view now shows
  // the input and blocks Run on it, so an ambiguous slot reaching here means a caller that
  // supplied nothing and cannot be asked (an agent, the fallback form).
  //
  // What must NOT be lost is the half that was actually protecting the run: an ambiguous
  // required input is never GUESSED. That property is re-expressed against the new
  // mechanism — the slot is simply left unbound, and the compute names it.
  it('leaves an ambiguous required input UNBOUND rather than guessing one', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-1', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'a' }, { id: 'b' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', {})
    expect(run.mock.calls[0][1]).toEqual([])
  })
})

describe('waitForJob (ITEM-10)', () => {
  it('resolves on the completed frame', async () => {
    await expect(waitForJob(fakeHandle('j', [{ phase: 'running' }, { phase: 'completed' }]), 'completed')).resolves.toMatchObject({
      phase: 'completed',
    })
  })

  it('rejects on a failed frame with the message', async () => {
    await expect(
      waitForJob(fakeHandle('j', [{ phase: 'failed', message: 'boom' }]), 'completed'),
    ).rejects.toThrow('boom')
  })

  it('calls onComplete when the run completes', async () => {
    const onComplete = vi.fn()
    await waitForJob(fakeHandle('j', [{ phase: 'completed' }]), undefined, onComplete)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('rejects after the max-duration timeout when no terminal frame ever arrives (FE7)', async () => {
    vi.useFakeTimers()
    try {
      // A handle that subscribes but NEVER emits a terminal frame (dropped SSE / stuck job).
      const stuck: JobHandle = { jobId: 'stuck', onProgress: () => ({ dispose: () => {} }) }
      const p = waitForJob(stuck, 'completed', undefined, 1000)
      const assertion = expect(p).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('a non-terminal stream does NOT trip the timeout once it completes in time', async () => {
    vi.useFakeTimers()
    try {
      // Completes synchronously on subscribe → the armed timer is cleared, no spurious reject.
      const p = waitForJob(fakeHandle('j', [{ phase: 'running' }, { phase: 'completed' }]), 'completed', undefined, 1000)
      await expect(p).resolves.toMatchObject({ phase: 'completed' })
      await vi.advanceTimersByTimeAsync(2000) // no unhandled rejection after settle
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('toast op', () => {
  it('routes a string / success / error message to notify', () => {
    const notify = vi.fn()
    const ctx = createWorkbenchInterpreterCtx({ api: fakeApi({ notify }) })
    ctx.toast!('hi')
    ctx.toast!({ success: 'ok' })
    ctx.toast!({ error: 'bad' })
    expect(notify).toHaveBeenNthCalledWith(1, 'hi', 'success')
    expect(notify).toHaveBeenNthCalledWith(2, 'ok', 'success')
    expect(notify).toHaveBeenNthCalledWith(3, 'bad', 'error')
  })
})

describe('end-to-end: the Run body interprets over the wired ctx', () => {
  it('run_processor → wait_for → toast runs against the real interpreter', async () => {
    const notify = vi.fn()
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-9', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-1' }], run, notify }),
    })
    // A minimal store exposing the state the body's params reference.
    const store: InterpreterStore = {
      state: { metrics: [{ name: 'metric_a' }], mode: 'fast' },
      derived: {},
      token: 't',
      set: () => {},
    }
    const bodyCtx = { ...ctx, viewStore: () => store }
    const body = [
      { run_processor: { id: 'demo.analysis', params: { metrics: '$state.metrics', mode: '$state.mode' }, into: 'demoJob' } },
      { wait_for: { job: '$demoJob', until: 'completed' } },
      { toast: { success: 'Analysis complete' } },
    ]
    const bag = await interpretBody(body as never, { view_id: 'v1' }, bodyCtx)
    expect(run).toHaveBeenCalledTimes(1)
    expect((run.mock.calls[0][2] as Record<string, unknown>).mode).toBe('fast')
    expect((bag.demoJob as JobHandle).jobId).toBe('job-9')
    expect(notify).toHaveBeenCalledWith('Analysis complete', 'success')
  })
})

// ── the `into:` CARRIER the save path depends on (DEC-6, Carrier A) ────────────

describe('runProcessor `into:` bag — the save-path carrier', () => {
  // A contributed manifest's `run` action addresses `$filterJob.projectId` and
  // `$filterJob.inputs[0].artifactId` when it calls `provenance.record-selection`.
  // Both come from the spread bag `runProcessor` returns (`{...handle, inputs,
  // projectId}`) — and that spread was entirely UNCOVERED: `hostCtx.test.ts` never
  // exercised it, that surface's own test asserts only YAML string literals,
  // and `actions.test.ts` calls the action directly. A regression there would send
  // `undefined` ids to the chokepoint (a 400) with no test failing.
  it('carries projectId + the RESOLVED inputs alongside the job handle', async () => {
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-7' }] }),
      projectId: 'proj-9',
    })
    const bag = (await ctx.runProcessor?.('demo.analysis', {})) as {
      jobId: string
      projectId?: string
      inputs?: { slot: string; artifactId: string; origin?: string }[]
      onProgress?: unknown
    }
    expect(bag.projectId).toBe('proj-9')
    expect(bag.inputs).toEqual([{ slot: 'matrix', artifactId: 'art-7', origin: 'auto' }])
    // …and the handle's own surface still spreads through (`wait_for` reads these).
    expect(typeof bag.jobId).toBe('string')
    expect(typeof bag.onProgress).toBe('function')
  })

  it('the bag is addressable by the exact `$job.projectId` / `$job.inputs[0].artifactId` paths the YAML uses', async () => {
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-7' }] }),
      projectId: 'proj-9',
    })
    const seen: Record<string, unknown>[] = []
    const withCapture = {
      ...ctx,
      // stand in for `call_action` so the test reads the EVALUATED params.
      api: async (_call: string, args?: Record<string, unknown>) => {
        seen.push(args ?? {})
        return undefined
      },
    }
    await interpretBody(
      [
        { run_processor: { id: 'demo.analysis', params: {}, into: 'filterJob' } },
        {
          api: {
            call: 'noop',
            args: {
              project_id: '$filterJob.projectId',
              input_artifact_id: '$filterJob.inputs[0].artifactId',
            },
          },
        },
      ] as never,
      {},
      withCapture as never,
    )
    expect(seen[0]).toEqual({ project_id: 'proj-9', input_artifact_id: 'art-7' })
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// binding-origin — site 2, the LAUNCH-time bind. This is the worse of the two headless ones
// because of WHO reaches it: a caller that supplied nothing and cannot be asked (an agent or
// an MCP call). There is no form here, so "show what it bound" has nowhere to happen, and the
// record is the only place the fact can survive.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe('TEST-10 (binding-origin / ITEM-11) — resolveInputs stamps the origin it knows', () => {
  it("a caller-supplied slot carries the CALLER'S origin, not a default", async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-1', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-1' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', {}, { matrix: 'art-supplied' }, { matrix: 'user' })
    expect(run.mock.calls[0][1]).toEqual([{ slot: 'matrix', artifactId: 'art-supplied', origin: 'user' }])
  })

  it('a caller-supplied slot with NO stated origin carries none — absent is not user', async () => {
    // Recording a review the caller never claimed to have performed is the one error this
    // whole change exists to make impossible (INV-4).
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-2', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-1' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', {}, { matrix: 'art-supplied' })
    expect(run.mock.calls[0][1]).toEqual([{ slot: 'matrix', artifactId: 'art-supplied' }])
  })

  it('a LIST slot stamps every entry it produced from the one declaration', async () => {
    const run = vi.fn<JobsApi['run']>(async () => fakeHandle('job-3', [{ phase: 'completed' }]))
    const ctx = createWorkbenchInterpreterCtx({
      api: fakeApi({ analyses: { 'demo.analysis': DEMO_ANALYSIS }, artifacts: [{ id: 'art-1' }], run }),
    })
    await ctx.runProcessor!('demo.analysis', {}, { matrix: ['a', 'b'] }, { matrix: 'auto' })
    expect(run.mock.calls[0][1]).toEqual([
      { slot: 'matrix', artifactId: 'a', origin: 'auto' },
      { slot: 'matrix', artifactId: 'b', origin: 'auto' },
    ])
  })
})

describe('TEST-11 (binding-origin / ITEM-11, ITEM-10) — [acceptance] [invariant: INV-3] the two launches differ ONLY in origin', () => {
  it('the SAME artifact in the SAME slot, supplied vs headless-auto, differs in nothing else', async () => {
    // The acceptance proof, and it is deliberately built so that a regression cannot hide: if
    // the stamping were removed, both `RunInput[]` would be byte-identical and the final
    // assertion — that they are NOT equal — would fail. That is the negative control.
    const runSupplied = vi.fn<JobsApi['run']>(async () => fakeHandle('j1', [{ phase: 'completed' }]))
    const runHeadless = vi.fn<JobsApi['run']>(async () => fakeHandle('j2', [{ phase: 'completed' }]))

    const supplied = createWorkbenchInterpreterCtx({
      api: fakeApi({
        analyses: { 'demo.analysis': DEMO_ANALYSIS },
        artifacts: [{ id: 'art-1' }],
        run: runSupplied,
      }),
    })
    // A human chose it, and said so.
    await supplied.runProcessor!('demo.analysis', {}, { matrix: 'art-1' }, { matrix: 'user' })

    const headless = createWorkbenchInterpreterCtx({
      api: fakeApi({
        analyses: { 'demo.analysis': DEMO_ANALYSIS },
        artifacts: [{ id: 'art-1' }],
        run: runHeadless,
      }),
    })
    // Nobody chose it. Same artifact, same slot, same analysis — an agent supplied nothing and
    // the sole candidate was bound between click and job.
    await headless.runProcessor!('demo.analysis', {})

    const a = runSupplied.mock.calls[0][1]
    const b = runHeadless.mock.calls[0][1]

    // Same artifact, same slot…
    expect(a.map(i => [i.slot, i.artifactId])).toEqual(b.map(i => [i.slot, i.artifactId]))
    // …and told apart.
    expect(a).toEqual([{ slot: 'matrix', artifactId: 'art-1', origin: 'user' }])
    expect(b).toEqual([{ slot: 'matrix', artifactId: 'art-1', origin: 'auto' }])
    expect(a).not.toEqual(b)
  })
})
