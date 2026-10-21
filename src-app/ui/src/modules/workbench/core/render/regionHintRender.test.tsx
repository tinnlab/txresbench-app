// @vitest-environment jsdom
import * as React from 'react'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { DeclarativeRegion } from './DeclarativeRegion'
import { createViewStore } from '@/modules/workbench/core/runtime/store'
import { registerViewStore, __resetViewStoresForTests } from '@/modules/workbench/core/runtime/viewStores'
import { peekStore } from './declarativeMount'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { makeFakeDataHost } from '@/modules/workbench/extensions/data/dataHost'

// T1d — THE LAST LINK OF THE CHAIN.
//
// A mutation audit severed the hint at four points. Three are now killed by a test that drives a
// real resolve into the real store. This is the fourth and it is the one nearest the eye:
// deleting `hint={store.dataHint}` from the region's own `<RegionStatus>` call site. Nothing
// caught it, because one test drove the store and stopped there while another handed
// `RegionStatus` a literal prop — the join between them was exactly the untested part.
//
// So this renders the REGION over a store carrying the hint, and asserts the missing source
// reaches the screen. It is the smallest mount that spans the join.

const MISSING = 'source-dataset-alpha'
const SENTENCE = `the alignment can no longer be resolved — missing or changed source: ${MISSING}. restore or re-attach that source.`

const spec = {
  id: 'v.hint',
  title: 'Test view',
  permission: 'jobs::use',
  state: {},
  actions: [],
  widgets: [],
  data: {},
} as unknown as ViewSpec

const VIEW_ID = 'hint-region'

function mountWith(status: 'unreadable' | 'error', error?: string, hint?: string) {
  const store = createViewStore(spec, VIEW_ID)
  registerViewStore(VIEW_ID, store)
  const api = createWorkbenchApi(makeFakeDataHost({ projectId: 'p1', artifacts: [], axes: [], isA: () => false }) as never, 'hint-test')
  render(
    <WorkbenchProvider api={api} projectId="p1" viewId="wb" canEdit>
      <DeclarativeRegion view={{ view_id: VIEW_ID, view_spec: spec } as never} />
    </WorkbenchProvider>,
  )
  // AFTER mount: the region resolves its own (empty) slice set on mount and lands `ready`, so a
  // status set beforehand is overwritten by the thing under test. Setting it here is also the
  // honest ordering — this is a resolve COMPLETING, which is when the real one arrives.
  const live = peekStore(VIEW_ID) ?? store
  act(() => {
    live.setDataStatus(status, error, hint)
  })
}

describe('the region passes the store hint through to what the user reads', () => {
  beforeEach(() => {
    __resetViewStoresForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the missing source NAMED, from the store, on the unreadable surface', () => {
    mountWith('unreadable', 'Could not read "jq" (data/opaque): …', SENTENCE)
    const surface = screen.getByTestId(`declarative-status-unreadable-${VIEW_ID}`)
    // The join. Severing the prop leaves the surface rendering its generic sentence, which is
    // plausible, complete, and missing the only fact the reader needs.
    expect(surface.textContent ?? '').toContain(MISSING)
  })

  // POSITIVE CONTROL: without a hint the region still renders the surface, so the assertion
  // above is about the HINT reaching it and not about the surface existing.
  it('without a hint the same surface renders its generic sentence instead', () => {
    mountWith('unreadable', 'Could not read "jq" (data/opaque): …')
    const surface = screen.getByTestId(`declarative-status-unreadable-${VIEW_ID}`)
    expect(surface.textContent ?? '').not.toContain(MISSING)
    expect((surface.textContent ?? '').length, 'still not blank').toBeGreaterThan(40)
  })
})
