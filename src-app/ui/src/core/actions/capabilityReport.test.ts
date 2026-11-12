import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The capability REPORT: what this session tells the backend it can be asked to
// do. The transport is stubbed at the module boundary (`callAsync`) rather than
// at `fetch`, so these assert the PROTOCOL — a full snapshot, correlated to the
// live connection, re-sent on every reconnect — not the HTTP plumbing.

const calls: { url: string; body: Record<string, unknown> }[] = []
let failNext = false

vi.mock('@txresbench/framework/api-client', () => ({
  callAsync: async (url: string, body: Record<string, unknown>) => {
    calls.push({ url, body })
    if (failNext) {
      failNext = false
      throw new Error('network down')
    }
    return { ok: true }
  },
}))

const {
  publishCapabilities,
  capabilitySnapshot,
  onAgentConnected,
  onAgentDisconnected,
  __resetCapabilityReportForTests,
} = await import('./capabilityReport')

type Capability = Parameters<typeof publishCapabilities>[0][number]

function capability(id: string, overrides: Partial<Capability> = {}): Capability {
  return {
    id,
    title: 'An action',
    kind: 'instance',
    mutating: true,
    stateful: false,
    context: 'global',
    permission: 'jobs::use',
    params_schema: { type: 'object' },
    ...overrides,
  }
}

/** Let the 50ms debounce fire. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60)
  await Promise.resolve()
}

function reportedIds(index: number): string[] {
  return (calls[index].body.capabilities as Capability[]).map(c => c.id)
}

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  failNext = false
  __resetCapabilityReportForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('capabilityReport', () => {
  it('reports nothing while no agent connection is bound', async () => {
    publishCapabilities([capability('demo.view::d.first')])
    await settle()
    expect(calls).toHaveLength(0)
    // …but the snapshot is retained, ready for the first connect.
    expect(capabilitySnapshot().map(c => c.id)).toEqual(['demo.view::d.first'])
  })

  it('reports the full snapshot to the live connection', async () => {
    publishCapabilities([capability('demo.view::d.first')])
    onAgentConnected('conn-1')
    await settle()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('POST /api/mcp/agent/capabilities')
    expect(calls[0].body.connection_id).toBe('conn-1')
    expect(reportedIds(0)).toEqual(['demo.view::d.first'])
  })

  it('connecting with nothing registered sends no report at all', async () => {
    onAgentConnected('conn-1')
    await settle()
    expect(calls).toHaveLength(0)
  })

  it('sends a FULL snapshot on each publish, never a delta', async () => {
    onAgentConnected('conn-1')
    await settle()
    calls.length = 0

    publishCapabilities([capability('demo.view::d.first')])
    await settle()
    publishCapabilities([capability('demo.view::d.second')])
    await settle()

    expect(reportedIds(0)).toEqual(['demo.view::d.first'])
    expect(reportedIds(1)).toEqual(['demo.view::d.first', 'demo.view::d.second'])
  })

  it('coalesces a burst of publishes into ONE report', async () => {
    onAgentConnected('conn-1')
    await settle()
    calls.length = 0

    publishCapabilities([capability('demo.view::d.first')])
    publishCapabilities([capability('demo.view::d.second')])
    publishCapabilities([capability('other.view::o.first')])
    await settle()

    expect(calls).toHaveLength(1)
    expect(reportedIds(0)).toEqual([
      'demo.view::d.first',
      'demo.view::d.second',
      'other.view::o.first',
    ])
  })

  it('re-publishing an already-reported id costs no report', async () => {
    onAgentConnected('conn-1')
    await settle()
    publishCapabilities([capability('demo.view::d.first')])
    await settle()
    const before = calls.length

    // A component re-mount replays the same registration.
    publishCapabilities([capability('demo.view::d.first')])
    await settle()
    expect(calls).toHaveLength(before)
  })

  /// The rule that keeps "advertised" and "invokable" in step in the OTHER
  /// direction: the server binds a fresh connection with an EMPTY set, and this
  /// page's registry survived the drop, so a reconnect must re-send everything.
  it('re-reports the whole snapshot on RECONNECT under the new connection id', async () => {
    onAgentConnected('conn-1')
    publishCapabilities([capability('demo.view::d.first')])
    await settle()
    calls.length = 0

    onAgentDisconnected()
    publishCapabilities([capability('demo.view::d.second')])
    await settle()
    expect(calls).toHaveLength(0)

    onAgentConnected('conn-2')
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0].body.connection_id).toBe('conn-2')
    expect(reportedIds(0)).toEqual(['demo.view::d.first', 'demo.view::d.second'])
  })

  it('reports the entry field-for-field as projected', async () => {
    onAgentConnected('conn-1')
    publishCapabilities([
      capability('demo.view::d.first', {
        title: 'First',
        stateful: true,
        context: 'workbench',
        permission: 'mcp::use',
        description: 'Does the first thing.',
        params_schema: { type: 'object', required: ['view_id'] },
      }),
    ])
    await settle()

    expect((calls[0].body.capabilities as Capability[])[0]).toEqual({
      id: 'demo.view::d.first',
      title: 'First',
      kind: 'instance',
      mutating: true,
      stateful: true,
      context: 'workbench',
      permission: 'mcp::use',
      description: 'Does the first thing.',
      params_schema: { type: 'object', required: ['view_id'] },
    })
  })

  it('survives a failed report and re-sends on the next connect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onAgentConnected('conn-1')
    publishCapabilities([capability('demo.view::d.first')])
    failNext = true
    await settle()
    expect(warn).toHaveBeenCalled()

    onAgentDisconnected()
    onAgentConnected('conn-2')
    await settle()
    const last = calls[calls.length - 1]
    expect(last.body.connection_id).toBe('conn-2')
    expect((last.body.capabilities as Capability[]).map(c => c.id)).toEqual([
      'demo.view::d.first',
    ])
    warn.mockRestore()
  })
})
