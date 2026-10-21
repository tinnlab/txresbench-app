// @vitest-environment jsdom
//
// TEST-7 [acceptance / INV-7] — the `lineage` widget renders the frozen-artifact VERSION CHAIN
// (`v2←v1`, current bold + superseded dimmed) and the per-set membership DELTA (+added −removed)
// between the current version and its parent. Domain-free: the fixture uses a NEUTRAL `values`
// member field (the widget speaks only "sets" and "members"; the domain noun rides in as a param).
//
// The widget fetches through `ApiClient` (the lineage chain + the two artifacts' structures), so
// the client is mocked and the assertions wait for the async resolve.

import * as React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'

const lineage = vi.fn(async (_p: { artifact_id: string }) => ({
  chain: [
    { artifact_id: 'art-v2', draft_id: 'd1', parent_artifact_id: 'art-v1', version: 2, created_at: '2026-02-01T00:00:00Z' },
    { artifact_id: 'art-v1', draft_id: 'd1', parent_artifact_id: null, version: 1, created_at: '2026-01-01T00:00:00Z' },
  ],
}))
const getArtifact = vi.fn(async (p: { id: string }) => ({
  structure: {
    sets:
      p.id === 'art-v2'
        ? [{ name: 'T', values: ['A', 'C', 'D'] }]
        : [{ name: 'T', values: ['A', 'B', 'C'] }],
  },
}))

vi.mock('@/api-client', () => ({
  ApiClient: {
    Draft: { lineage: (p: { artifact_id: string }) => lineage(p) },
    Workstore: { getArtifact: (p: { id: string }) => getArtifact(p) },
  },
}))

import { __clearWidgetsForTests } from '@/modules/workbench/core/render/registry'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import { installVisualizeWidgets, __resetVisualizeWidgetsForTests } from './installVisualizeWidgets'

beforeEach(() => {
  cleanup()
  lineage.mockClear()
  getArtifact.mockClear()
  __clearWidgetsForTests()
  __resetVisualizeWidgetsForTests()
  installVisualizeWidgets()
})
afterEach(cleanup)

const SPEC: WidgetSpec = {
  kind: 'lineage',
  id: 'lineage',
  label: 'Version history',
  artifact: '$state.selected_artifact_id',
  values_field: 'values',
} as WidgetSpec

function mount(selected: string | null) {
  const scope: Scope = {
    params: {},
    state: { selected_artifact_id: selected },
    derived: {},
    const: {},
    data: {},
  }
  return render(<WidgetList specs={[SPEC]} scope={scope} viewId="v" specId="t/spec" />)
}

describe('lineage widget', () => {
  it('renders the version chain v2←v1 with the current version bold and the older dimmed', async () => {
    mount('art-v2')
    await waitFor(() => expect(screen.getByTestId('widget-lineage-chain')).toBeTruthy())
    const v2 = screen.getByTestId('widget-lineage-v2')
    const v1 = screen.getByTestId('widget-lineage-v1')
    expect(v2.textContent).toBe('v2')
    expect(v1.textContent).toBe('v1')
    // current bold; superseded dimmed (opacity utility) — never hidden.
    expect(v2.className).toContain('font-bold')
    expect(v1.className).toContain('opacity-70')
  })

  it('renders the per-set membership delta (+added −removed) vs the parent version', async () => {
    mount('art-v2')
    const delta = await screen.findByTestId('widget-lineage-delta-T')
    // v2 = v1 + D − B in set "T".
    expect(delta.textContent).toContain('+D')
    expect(delta.textContent).toContain('−B') // U+2212 MINUS SIGN, not hyphen
    // the fetch resolved current + parent structures.
    expect(getArtifact).toHaveBeenCalledWith({ id: 'art-v2' })
    expect(getArtifact).toHaveBeenCalledWith({ id: 'art-v1' })
  })

  it('renders nothing when no collection is selected', () => {
    const { container } = mount(null)
    expect(container.querySelector('[data-testid="widget-lineage-chain"]')).toBeNull()
    expect(lineage).not.toHaveBeenCalled()
  })
})
