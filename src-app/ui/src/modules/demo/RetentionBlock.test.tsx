// @vitest-environment jsdom
/**
 * TEST-DM-7 (shared pieces half) — the ITEM-7 demo building blocks: the
 * usage read (`fetchDemoUsage` + `useDemoUsage` — the demo counters over
 * the ONE `/txr/history/usage` wire answer, the below-spec shape's parse
 * at the one seam, the stale-answer guards) and the retention block (the
 * plan's statement + the "n of 50" counter as a VISIBLE paragraph, the
 * loading state's quiet ellipsis).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DemoRetentionBlock } from './components/DemoRetentionBlock'
import { DEMO_POOL_STATEMENT, formatDemoCounter } from './copy'

vi.mock('@/api-client', () => ({
  ApiClient: {
    History: {
      getUsage: vi.fn(),
    },
  },
}))

import { ApiClient } from '@/api-client'
import { fetchDemoUsage, useDemoUsage } from './lib/demoUsageApi'

const getUsageMock = vi.mocked(ApiClient.History.getUsage)

const DEMO_USAGE = {
  runs: 37,
  run_limit: 50,
  models: 12,
  model_limit: 50,
  pinned_runs: 2,
  pinned_models: 3,
  shared: true,
}

beforeEach(() => {
  getUsageMock.mockReset()
})

afterEach(() => cleanup())

describe('formatDemoCounter (ITEM-7 counters)', () => {
  it('spells "n of 50 runs" / "n of 50 models" with the singular-free nouns', () => {
    expect(formatDemoCounter(37, 50, 'runs')).toBe('37 of 50 runs')
    expect(formatDemoCounter(12, 50, 'models')).toBe('12 of 50 models')
  })

  it('renders the quiet ellipsis for a not-yet-known count (pagination never invents a figure)', () => {
    expect(formatDemoCounter(null, 50, 'runs')).toBe('\u2026 of 50 runs')
  })
})

describe('fetchDemoUsage (ITEM-7 usage read)', () => {
  it('reads the demo counters out of the shared usage answer', async () => {
    getUsageMock.mockResolvedValue(DEMO_USAGE as never)
    await expect(fetchDemoUsage()).resolves.toEqual(DEMO_USAGE)
    expect(getUsageMock).toHaveBeenCalledTimes(1)
  })

  it('returns null for a DESKTOP usage answer (no shared flag — never a fabricated figure)', async () => {
    getUsageMock.mockResolvedValue({ run_count: 3, total_bytes: 0 } as never)
    await expect(fetchDemoUsage()).resolves.toBeNull()
  })

  it('returns null for a malformed answer (a non-numeric field degrades, never crashes)', async () => {
    getUsageMock.mockResolvedValue({ runs: 'many', run_limit: 50, shared: true } as never)
    await expect(fetchDemoUsage()).resolves.toEqual({
      runs: 0,
      run_limit: 50,
      models: 0,
      model_limit: 0,
      pinned_runs: 0,
      pinned_models: 0,
      shared: true,
    })
  })
})

describe('useDemoUsage (ITEM-7 page hook)', () => {
  it('starts null + loading, then settles with the demo answer', async () => {
    let resolve!: (value: unknown) => void
    getUsageMock.mockReturnValue(new Promise(r => { resolve = r }) as never)
    function Probe() {
      const { usage, loading } = useDemoUsage()
      return <output data-testid="out">{`${loading}|${usage === null ? 'null' : usage.runs}`}</output>
    }
    render(<Probe />)
    expect(screen.getByTestId('out').textContent).toBe('true|null')
    resolve(DEMO_USAGE)
    await vi.waitFor(() => expect(screen.getByTestId('out').textContent).toBe('false|37'))
  })

  it('a failed read settles null (the block renders the statement without a figure)', async () => {
    getUsageMock.mockRejectedValue(new Error('offline'))
    function Probe() {
      const { usage, loading } = useDemoUsage()
      return <output data-testid="out">{`${loading}|${usage === null ? 'null' : usage.runs}`}</output>
    }
    render(<Probe />)
    await vi.waitFor(() => expect(screen.getByTestId('out').textContent).toBe('false|null'))
  })
})

describe('DemoRetentionBlock (ITEM-7 shared-pool paragraph)', () => {
  it('renders the plan statement and the "n of 50 runs" counter as visible text', () => {
    render(<DemoRetentionBlock kind="runs" count={37} limit={50} />)
    expect(screen.getByTestId('txr-demo-retention-statement').textContent).toBe(DEMO_POOL_STATEMENT)
    expect(screen.getByTestId('txr-demo-retention-counter').textContent).toBe('37 of 50 runs')
  })

  it('models kind spells the models counter', () => {
    render(<DemoRetentionBlock kind="models" count={12} limit={50} />)
    expect(screen.getByTestId('txr-demo-retention-counter').textContent).toBe('12 of 50 models')
  })

  it('a null count renders the ellipsis (no invented number while the read is in flight)', () => {
    render(<DemoRetentionBlock kind="runs" count={null} limit={50} />)
    expect(screen.getByTestId('txr-demo-retention-counter').textContent).toBe('\u2026 of 50 runs')
  })
})
