// @vitest-environment jsdom
/**
 * txrrun — the step-4 gallery stories THROUGH the gallery mock layer
 * (single-marker-choice round 2c): the E screen's page mounted exactly as
 * the `txr-run-e` story mounts it (the same seed, the module cassettes the
 * dev gallery merges), with the REAL api-client over the mock's fetch
 * interceptor — never a `vi.mock`, so an unseeded endpoint answers with the
 * mock's own crash-safe shape.
 *
 * Pinned behaviors (round 2c):
 *
 * - `txr-run-e` renders the heading and the method picker when the ranking
 *   route is answered (the module cassette's fixture answer); the ranking's
 *   `top` is the SEEDED FILE's own markers (the intake fixture's `ldh` +
 *   `cea` columns), so the line and the cards never name a marker the file
 *   does not carry.
 * - An UNANSWERED ranking call (the cassette entry removed — the mock then
 *   answers its crash-safe `[]`, exactly what an unseeded endpoint serves)
 *   must never stop the page from rendering: the method list does not wait
 *   for the ranking, and the line shows nothing (brief-2: the ranked line
 *   reads only the route's answer; a failure keeps today's count rule).
 *   Before round 2c this malformed answer threw inside `planBlockOf`
 *   (`response.top.length` on an array) during render, so the WHOLE page
 *   unmounted — the gallery-e2e's "element(s) not found".
 *
 * The E stories are the only surfaces that mount the ranking call (step 3's
 * `useStudyPreview` rides the one-provider `MethodCatalogue.eligibility`
 * route, already owned by the `txrlist` cassette, and its new `inventory` /
 * `marker_plan` fields are answered by the same responder — no new route).
 */
import { Suspense } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  configureMockApi,
  extendCassette,
  installMockApi,
  uninstallMockApi,
} from '@txresbench/gallery'
import { ApiClient } from '@/api-client'
import { ApiEndpoints } from '@/api-client/apiEndpoints'
import { gallery as txrrunGallery } from './gallery'
import { gallery as txrlistGallery } from '@/modules/txrlist/gallery'
import { gallery as txrintakeGallery } from '@/modules/txrintake/gallery'
import '@/core/actions/builtin/stepActions'
import '@/core/actions/builtin/methodActions'
import '@/core/actions/builtin/dayActions'
import '@/core/actions/builtin/worldModel'
import { __resetFetchCacheForTests } from '@/modules/txrintake/data/fetchCache'
import { __resetMethodListRevisionForTests } from '@/lib/txr-method-list/revision'
import { resetDemoMode } from '@/modules/demo/test-utils/demoSeed'

// jsdom has no working PointerEvent constructor; Base UI's controls construct
// one on pointer interaction (the kit Switch/Segmented/Select). A MouseEvent
// subclass is the standard jsdom stand-in (the StudyPage test's shim).
{
  const w = window as unknown as {
    PointerEvent?: new (type: string, init?: MouseEventInit) => MouseEvent
  }
  try {
    void new (w.PointerEvent as new (type: string, init?: MouseEventInit) => MouseEvent)('probe')
  } catch {
    w.PointerEvent = class extends MouseEvent {}
  }
}

// ── jsdom has no layout, and the shared picker is a VIRTUALIZED window ──
// (the ChooseMethodsPage suite's own idiom: a tall viewport, every item
// measuring the row height the list estimates).
const VIEWPORT_H = 1200
const ROW_H = 56

const isViewport = (el: HTMLElement): boolean =>
  el.hasAttribute('data-overlayscrollbars-viewport')

let restoreLayout: (() => void) | null = null

function statedLayout(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  const saved = ['offsetHeight', 'clientHeight', 'scrollHeight'].map(
    k => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  )
  const define = (key: string, get: (el: HTMLElement) => number): void => {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement): number {
        return get(this)
      },
    })
  }
  define('offsetHeight', el =>
    isViewport(el) ? VIEWPORT_H : el.hasAttribute('data-index') ? ROW_H : 0,
  )
  define('clientHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  define('scrollHeight', el => (isViewport(el) ? VIEWPORT_H : 0))
  restoreLayout = () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d)
      else delete proto[k]
    }
  }
}

/** The merged module cassettes: the SAME merge the dev gallery performs
 *  (registry-core's one-owner-per-endpoint rule — every module seeds only
 *  its own keys). The E story's own reads come from `txrrun`, the shared
 *  `MethodCatalogue.*` keys from `txrlist`, the filter-options/markers
 *  vocabulary from `txrintake`. */
function mergedCassette(): Record<string, unknown> {
  return {
    ...txrrunGallery.cassette,
    ...txrlistGallery.cassette,
    ...txrintakeGallery.cassette,
  }
}

/** Mount one story's component the way `SeededSurfaceFrame` does: the real
 *  page under its own MemoryRouter, with the mock API installed. */
async function renderStory(slug: string): Promise<void> {
  const entry = (txrrunGallery.seeded ?? []).find(story => story.slug === slug)
  if (entry === undefined) throw new Error(`no story ${slug}`)
  render(
    <MemoryRouter initialEntries={[entry.initialPath]}>
      <Routes>
        <Route
          path={entry.path}
          element={
            <Suspense fallback={<div data-testid="gallery-loading" />}>
              <entry.component />
            </Suspense>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
  // The lazy story component resolves, the SeedGate seeds the intake, the
  // page mounts and its fetches (the ranking debounce included) settle.
  // Rounds: the ranking is debounced 200 ms per request-content change (the
  // sticky config lands after the first answer), so one wall-clock slide is
  // not enough — keep sliding until the ranking has settled.
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    if (screen.queryByTestId('txr-run-single-marker-line')?.textContent !== 'Ranking your markers…') {
      break
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  configureMockApi({ apiEndpoints: ApiEndpoints as unknown as Record<string, string> })
  __resetFetchCacheForTests()
  __resetMethodListRevisionForTests()
  resetDemoMode()
  statedLayout()
})

afterEach(() => {
  uninstallMockApi()
  cleanup()
  restoreLayout?.()
  restoreLayout = null
  vi.useRealTimers()
  resetDemoMode()
  vi.restoreAllMocks()
})

describe('ChooseMethodsPage gallery stories through the mock layer (single-marker-choice round 2c)', () => {
  it('the txrrun cassette answers Txr.markerRanking with the seeded file\'s own markers', async () => {
    installMockApi(mergedCassette())
    const answer = await ApiClient.Txr.markerRanking({
      decision_day: 56,
      endpoint: 'pfs',
      measurements: {
        columns: ['patient', 'day', 'marker', 'value', 'unit'],
        header_row: 1,
        rows: [],
        source: { name: 'fixture-measurements.csv', format: 'csv' },
      },
    })
    // The file the E story seeds carries the `ldh` and `cea` columns — the
    // ranking names exactly those, never a marker the story's file lacks.
    expect(answer.top).toEqual(['ldh', 'cea'])
    expect(answer.offered).toEqual(['ldh', 'cea'])
    expect(answer.error).toBeUndefined()
  })

  it('txr-run-e renders the heading and the method picker; the ranking answer names the seeded file\'s markers', async () => {
    installMockApi(mergedCassette())
    await renderStory('txr-run-e')

    expect(
      screen.getByRole('heading', { name: /^Choose the methods and settings$/ }),
    ).toBeTruthy()
    expect(screen.getByTestId('txr-method-picker')).toBeTruthy()

    // The line above the list is the ranked sentence for the fixture's own
    // markers (the seeded measurements table carries the `ldh` and `cea`
    // columns — never a board example, never a marker the file lacks).
    const line = screen.getByTestId('txr-run-single-marker-line')
    expect(line.textContent).toContain('use the top 3: ldh and cea')
    expect(line.textContent).toContain('Change it in step 3')
  })

  it('an unanswered ranking call (the mock answers its crash-safe empty shape) never stops the page from rendering', async () => {
    const cassette = mergedCassette()
    // The unseeded endpoint: the gallery mock answers `[]` (the no-cassette
    // default). Before round 2c that malformed answer threw in the page's
    // render (`response.top.length`), unmounting the whole page.
    delete cassette['Txr.markerRanking' as keyof typeof cassette]
    installMockApi(cassette)
    await renderStory('txr-run-e')

    expect(
      screen.getByRole('heading', { name: /^Choose the methods and settings$/ }),
    ).toBeTruthy()
    expect(screen.getByTestId('txr-method-picker')).toBeTruthy()
    // No fabricated sentence: the ranking has no answer, so the line shows
    // nothing (the method list keeps today's verdicts).
    expect(screen.queryByTestId('txr-run-single-marker-line')).toBeNull()
  })

  it('a ranking call that rejects still renders the page', async () => {
    installMockApi(mergedCassette())
    // The failing responder BEFORE the story mounts the page (the extension
    // is the mock layer's public path for a per-surface failure).
    extendCassette({
      'Txr.markerRanking': () => {
        throw new Error('fixture ranking failure')
      },
    })
    await renderStory('txr-run-e')

    expect(
      screen.getByRole('heading', { name: /^Choose the methods and settings$/ }),
    ).toBeTruthy()
    expect(screen.getByTestId('txr-method-picker')).toBeTruthy()
    expect(screen.queryByTestId('txr-run-single-marker-line')).toBeNull()
  })
})
