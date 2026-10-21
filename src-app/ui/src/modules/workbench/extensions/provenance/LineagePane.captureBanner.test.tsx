// @vitest-environment jsdom
// F2-31 — the DEC-19 capture-failure banner. A save-time WRITE failure must not be
// dressed as a failed LOAD, and its primary action must actually RE-RUN the capture:
// the previous banner rendered the kit `ErrorState` (title: "Couldn't load selection
// provenance") whose "Try again" button called `clearCaptureError`, a pure dismiss —
// so clicking it read as a successful retry while the run stayed unrecorded.

import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { __resetPaneState } from '../../core/shell/dock/paneState'
import { CaptureFailureBanner } from './LineagePane'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never
})

afterEach(cleanup)
// The Details disclosure is remembered against the PANE (it must survive a tab switch — see
// `LineagePane.tabSwitch.test.tsx`), so each case starts from a clean pane-state map.
beforeEach(() => __resetPaneState())

const TESTID = 'workbench-provenance-capture-error-p1'

function renderBanner(over: Partial<Parameters<typeof CaptureFailureBanner>[0]> = {}) {
  const onRetry = vi.fn()
  const onDismiss = vi.fn()
  render(
    <CaptureFailureBanner
      paneId="p1"
      message="403 forbidden"
      canRetry
      retrying={false}
      onRetry={onRetry}
      onDismiss={onDismiss}
      data-testid={TESTID}
      {...over}
    />,
  )
  return { onRetry, onDismiss }
}

describe('CaptureFailureBanner (F2-31)', () => {
  it('names a CAPTURE failure, never a failed load', () => {
    renderBanner()
    const banner = screen.getByTestId(TESTID)
    expect(banner.textContent).toContain('Selection provenance was not recorded')
    // The kit ErrorState's hardcoded title described this WRITE failure as a read one.
    expect(banner.textContent).not.toContain("Couldn't load")
    expect(banner.textContent).toContain('not reproducible')
  })

  it('its primary action RE-RUNS the capture — it is not a relabelled dismiss', () => {
    const { onRetry, onDismiss } = renderBanner()
    const retry = screen.getByTestId(`${TESTID}-retry`)
    // The label must promise a record, not a generic "Try again" that only dismisses.
    expect(retry.textContent).toMatch(/record/i)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    // …and it must NOT dismiss: the banner clears only when the capture succeeds.
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('offers a SEPARATE, honestly-labelled dismiss', () => {
    const { onRetry, onDismiss } = renderBanner()
    fireEvent.click(screen.getByTestId(`${TESTID}-close`))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('offers NO retry when there is no retained attempt to re-run', () => {
    renderBanner({ canRetry: false })
    expect(screen.queryByTestId(`${TESTID}-retry`)).toBeNull()
    // …but the failure is still reported and still dismissible.
    expect(screen.getByTestId(TESTID).textContent).toContain('Selection provenance was not recorded')
    expect(screen.getByTestId(`${TESTID}-close`)).toBeTruthy()
  })

  it('disables the retry while a capture is in flight (no double-post)', () => {
    renderBanner({ retrying: true })
    expect((screen.getByTestId(`${TESTID}-retry`) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the raw error behind a Details disclosure, never inline', () => {
    renderBanner()
    expect(screen.queryByTestId(`${TESTID}-details`)).toBeNull()
    fireEvent.click(screen.getByTestId(`${TESTID}-details-toggle`))
    expect(screen.getByTestId(`${TESTID}-details`).textContent).toBe('403 forbidden')
  })
})
