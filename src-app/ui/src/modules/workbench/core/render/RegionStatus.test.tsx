// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { RegionStatus, REGION_STATUS_COPY } from './RegionStatus'

// TEST-4 (ITEM-4) — the region-level failure-surface vocabulary (F3). Each of the four
// `DataStatus` values gets its OWN surface; before Slice 2 all of `loading` / `empty` /
// `error` rendered the same blank form.

beforeEach(() => {
  cleanup()
})

describe('RegionStatus (declarative-rendering-hardening ITEM-4)', () => {
  it('ready → renders NOTHING (the region paints its widgets alone)', () => {
    const { container } = render(<RegionStatus status="ready" viewId="v1" />)
    expect(container.innerHTML).toBe('')
  })

  it('loading → skeleton bars, announced as a status with real TEXT for AT', () => {
    render(<RegionStatus status="loading" viewId="v1" />)
    const box = screen.getByTestId('declarative-status-loading-v1')
    expect(box.getAttribute('role')).toBe('status')
    // A live region with only decorative skeletons announces nothing — it needs text.
    expect(box.textContent).toContain(REGION_STATUS_COPY.loadingLabel)
    expect(box.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(1)
    expect(screen.queryByTestId('declarative-status-error-v1')).toBeNull()
    expect(screen.queryByTestId('declarative-status-empty-v1')).toBeNull()
  })

  // REPLACES "the fanned regions each get their OWN loading id, and only ONE announces".
  //
  // That test's subject was the region fan: one view mounted as up to three components
  // sharing a `view_id`, so the loading skeleton needed a `region` suffix to keep its test
  // id unique and an `announce` flag to elect exactly one speaker for a single shared
  // fetch. INV-3 collapses the view to ONE pane, so there is nothing left to disambiguate
  // or elect — and keeping the old test would assert a shape the engine no longer has.
  //
  // What the old test was PROTECTING survives and is asserted here instead: one fetch is
  // announced to assistive tech exactly once. It is now a structural property (one pane
  // ⇒ one status) rather than a negotiated one, and this pins it: render the status for
  // one view and there is exactly one live region, unconditionally.
  it('one view = ONE announced status surface (a single fetch is never announced twice)', () => {
    render(<RegionStatus status="loading" viewId="v1" />)
    expect(screen.getAllByTestId('declarative-status-loading-v1')).toHaveLength(1)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    // No opt-out remains: the surface cannot be rendered silent, so a pane can never be
    // left with a skeleton nobody announces.
    expect(screen.getByRole('status').textContent).toContain(REGION_STATUS_COPY.loadingLabel)
  })

  it('error → names the RESOURCE, gives a human line, and keeps the raw text behind Details', () => {
    render(
      <RegionStatus
        status="error"
        error="artifacts.query failed for &quot;obs&quot; (report/qc): 403 Forbidden"
        resource="Cell filter"
        viewId="v1"
        onRetry={() => {}}
      />,
    )
    const box = screen.getByTestId('declarative-status-error-v1')
    // The kit contract: name the resource + a HUMAN one-liner…
    expect(box.textContent).toContain('Cell filter')
    expect(box.textContent).toContain(REGION_STATUS_COPY.errorDescription)
    // …and NEVER the raw error inline.
    expect(box.textContent).not.toContain('403 Forbidden')
    // It is not the empty state — the whole point of F3.
    expect(screen.queryByTestId('declarative-status-empty-v1')).toBeNull()

    // The raw text is reachable behind the disclosure.
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.getByTestId('declarative-status-error-v1').textContent).toContain('403 Forbidden')
  })

  it('error → the Try-again action fires onRetry', () => {
    const onRetry = vi.fn()
    render(<RegionStatus status="error" error="boom" viewId="v1" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: REGION_STATUS_COPY.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('error with no resource → still names something concrete, never a bare "failed"', () => {
    render(<RegionStatus status="error" viewId="v1" onRetry={() => {}} />)
    expect(screen.getByTestId('declarative-status-error-v1').textContent).toContain(
      REGION_STATUS_COPY.errorResourceFallback,
    )
  })

  it('error without an onRetry → no Try-again button is rendered (never a dead control)', () => {
    render(<RegionStatus status="error" error="x" viewId="v1" />)
    expect(screen.queryByRole('button', { name: REGION_STATUS_COPY.retry })).toBeNull()
  })

  it('empty → the no-data state, NOT an error (an untouched project is not a fault)', () => {
    render(<RegionStatus status="empty" viewId="v1" />)
    const empty = screen.getByTestId('declarative-status-empty-v1')
    expect(empty.textContent).toContain(REGION_STATUS_COPY.emptyTitle)
    expect(screen.queryByTestId('declarative-status-error-v1')).toBeNull()
    expect(screen.queryByTestId('declarative-status-loading-v1')).toBeNull()
  })

  // ITEM-1 — the fifth value. `empty` and `unreadable` are both "no rows here", and until
  // now they rendered the SAME sentence: "Nothing has been produced for this view yet. Run
  // the analysis that produces its input" — advice that is simply wrong when the input was
  // produced and this client could not read it.
  it('unreadable → its OWN surface, saying the data is present and could not be read', () => {
    render(
      <RegionStatus
        status="unreadable"
        error="Could not read any of the 3 source(s) behind &quot;rowmeta&quot;"
        resource="Filter"
        viewId="v1"
        onRetry={() => {}}
      />,
    )
    const box = screen.getByTestId('declarative-status-unreadable-v1')
    expect(box.textContent).toContain('Filter')
    expect(box.textContent).toContain(REGION_STATUS_COPY.unreadableDescription)
    // NOT the no-data sentence: that one tells the user to go and produce the input, which
    // is the one thing that would not help here.
    expect(box.textContent).not.toContain(REGION_STATUS_COPY.emptyDescription)
    expect(screen.queryByTestId('declarative-status-empty-v1')).toBeNull()
    expect(screen.queryByTestId('declarative-status-error-v1')).toBeNull()
    // Raw resolver text stays behind the disclosure, like every other fault surface.
    expect(box.textContent).not.toContain('Could not read any of the 3')
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.getByTestId('declarative-status-unreadable-v1').textContent).toContain(
      'Could not read any of the 3',
    )
  })

  it('unreadable → the Try-again action fires onRetry (a re-read is the user`s move)', () => {
    const onRetry = vi.fn()
    render(<RegionStatus status="unreadable" error="boom" viewId="v1" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole('button', { name: REGION_STATUS_COPY.retry }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('unreadable with no resource → still names something concrete', () => {
    render(<RegionStatus status="unreadable" viewId="v1" onRetry={() => {}} />)
    expect(screen.getByTestId('declarative-status-unreadable-v1').textContent).toContain(
      REGION_STATUS_COPY.errorResourceFallback,
    )
  })

  it('all user-facing copy uses straight quotes only (curly quotes break assertions + kit voice)', () => {
    for (const [k, v] of Object.entries(REGION_STATUS_COPY)) {
      expect(v, `${k} contains a curly quote`).not.toMatch(/[‘’“”]/)
    }
  })

  it('the test ids are per-view, so two mounted views never collide', () => {
    render(
      <>
        <RegionStatus status="empty" viewId="alpha" />
        <RegionStatus status="error" error="e" viewId="beta" onRetry={() => {}} />
      </>,
    )
    expect(screen.getByTestId('declarative-status-empty-alpha')).not.toBeNull()
    expect(screen.getByTestId('declarative-status-error-beta')).not.toBeNull()
  })
})
