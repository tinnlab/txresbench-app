// TEST-305 (ITEM-22) — the host's SSE→frame mapping. `streamJob` used to (a) DROP
// the `progress` frame entirely (the real progress driver), (b) read a phantom
// `metric.data.value` (the backend emits `cpu_pct`/`mem_bytes`, no `value`), and
// (c) read a phantom `log.data.message` (the backend emits `content`). This pins the
// mapper (`mapSseFrame`) to the REAL jobs SSE vocabulary in
// `server/src/modules/jobs/sse.rs::SSEJobEvent`.

import { describe, expect, it } from 'vitest'
import { mapSseFrame, type WorkbenchJobFrame } from './jobFrames'

describe('mapSseFrame — the real jobs SSE vocabulary (ITEM-22)', () => {
  it('progress drives phase + pct (no longer dropped)', () => {
    const f = mapSseFrame('progress', { phase: 'clustering', pct: 40, message: 'leiden' })
    expect(f).toEqual<WorkbenchJobFrame>({
      kind: 'progress',
      phase: 'clustering',
      pct: 40,
      message: 'leiden',
    })
  })

  it('progress with no pct keeps phase (a phase-only progress frame)', () => {
    const f = mapSseFrame('progress', { phase: 'loading' })
    expect(f?.kind).toBe('progress')
    expect(f?.phase).toBe('loading')
    expect(f?.pct).toBeUndefined()
  })

  it('metric reads cpu_pct / mem_bytes (NOT the phantom data.value)', () => {
    const f = mapSseFrame('metric', {
      cpu_pct: 12.5,
      mem_bytes: 1048576,
      mem_peak_bytes: 2097152,
      pids_current: 3,
    })
    expect(f?.kind).toBe('metric')
    // The old bug read `data.value` and stuffed it into `pct` — assert we DON'T.
    expect(f?.pct).toBeUndefined()
    expect(f?.metric).toEqual({
      cpuPct: 12.5,
      memBytes: 1048576,
      memPeakBytes: 2097152,
      pidsCurrent: 3,
    })
  })

  it('metric tolerates the ProcSampler fallback (null peak / pids)', () => {
    const f = mapSseFrame('metric', { cpu_pct: 1, mem_bytes: 2 })
    expect(f?.metric).toEqual({ cpuPct: 1, memBytes: 2, memPeakBytes: null, pidsCurrent: null })
  })

  it('log reads content + stream (NOT the phantom data.message)', () => {
    const f = mapSseFrame('log', { seq: 7, stream: 'stderr', content: 'boom' })
    expect(f?.kind).toBe('log')
    expect(f?.message).toBe('boom') // JobFrame view for the shared run logic
    expect(f?.log).toEqual({ seq: 7, stream: 'stderr', content: 'boom' })
  })

  it('status maps to the lifecycle phase the run logic keys on', () => {
    expect(mapSseFrame('status', { status: 'completed' })).toEqual({
      kind: 'status',
      phase: 'completed',
    })
    expect(mapSseFrame('status', { status: 'failed' })?.phase).toBe('failed')
  })

  it('drops the __init control event and any unknown event', () => {
    expect(mapSseFrame('__init', { abortController: new AbortController() })).toBeNull()
    expect(mapSseFrame('heartbeat', {})).toBeNull()
  })
})
