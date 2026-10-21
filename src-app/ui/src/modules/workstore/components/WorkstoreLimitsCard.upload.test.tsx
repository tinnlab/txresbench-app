// @vitest-environment jsdom
//
// uncapped-uploads TEST-21 — what the card actually PUTs for the upload ceiling.
//
// This is a RENDER test on purpose. The previous TEST-21 asserted only the pure
// display helper plus arithmetic over its own constants, and a blind audit showed it
// stayed green when the submit's `max_upload_body_bytes` was replaced with the
// constant `999` — the submit conversion had no behavioural coverage at all, pinned
// only by a source-string match. Three separate fail-open defects reached this control
// through exactly that gap, so the payload is asserted here against a real render.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { WorkstoreLimitsCard } from './WorkstoreLimitsCard'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

type UpdatePayload = Record<string, number | boolean>
const runAction = vi.fn(async (_action: string, _payload: UpdatePayload) => true)
vi.mock('@/core/actions/defineAction', () => ({
  runAction: (action: string, payload: UpdatePayload) => runAction(action, payload),
}))
vi.mock('@/core/permissions', () => ({ usePermission: () => true }))

let row: Record<string, unknown>
vi.mock('@/modules/workstore/stores/WorkstoreSettings.store', () => ({
  WorkstoreSettings: {
    get settings() {
      return row
    },
    saving: false,
    $: { error: null },
  },
}))

// jsdom has no ResizeObserver; the kit's inputs observe their container.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO

const baseRow = {
  gc_enabled: true,
  gc_interval_hours: 6,
  gc_grace_secs: 3600,
  max_output_file_bytes: 8 * GIB,
  max_multifile_total_bytes: 32 * GIB,
  max_upload_body_bytes: 64 * GIB,
  max_upload_parts: 1024,
}

// The component is imported STATICALLY and the row is swapped through the mock's
// getter. An earlier version used `vi.resetModules()` + a dynamic import to vary the
// row; that passed in isolation and timed out in the full suite, taking an unrelated
// store test down with it — resetting the module registry mid-run invalidates module
// state other suites in the same worker are relying on. Never reach for
// `resetModules` to parameterise a fixture.
function renderCard(overrides: Partial<typeof baseRow> = {}) {
  row = { ...baseRow, ...overrides }
  render(<WorkstoreLimitsCard />)
  return screen.getByTestId('workstore-max-upload-body') as HTMLInputElement
}

/** The `max_upload_body_bytes` of the single `workstore.updateSettings` call. */
function putCeiling(): number {
  expect(runAction).toHaveBeenCalledTimes(1)
  const [action, payload] = runAction.mock.calls[0]
  expect(action).toBe('workstore.updateSettings')
  return payload.max_upload_body_bytes as number
}

beforeEach(() => {
  runAction.mockClear()
})
afterEach(() => cleanup())

describe('WorkstoreLimitsCard — the upload ceiling it PUTs (uncapped-uploads TEST-21)', () => {
  it('seeds the field in MiB, exactly, from the stored bytes', async () => {
    const input = renderCard()
    expect(input.value).toBe(String(64 * 1024)) // 64 GiB == 65536 MiB
  })

  it('PUTs the typed ceiling — the LOWERING case three earlier versions got wrong', async () => {
    // A stored 2.4 GiB. Under the old GiB field this displayed as `2`, so an admin
    // typing `2` to lower it produced no change, the form never became dirty, Save
    // stayed disabled, and the ceiling silently stayed at 2.4 GiB. In MiB the stored
    // value shows as 2458 and typing 2048 is a real edit.
    const input = renderCard({ max_upload_body_bytes: Math.round(2.4 * GIB) })
    expect(input.value).toBe('2458')

    fireEvent.change(input, { target: { value: '2048' } })
    fireEvent.click(screen.getByTestId('workstore-limits-save'))

    await waitFor(() => expect(runAction).toHaveBeenCalled())
    expect(putCeiling()).toBe(2 * GIB)
  })

  it('does NOT widen a ceiling stored at the server floor when another field is saved', async () => {
    // The regression this test exists for: with a 1 MiB ceiling the GiB field rendered
    // `1` (clamped) and wrote back 1 GiB — a 1024x loosening of a SaaS security ceiling,
    // triggered by saving an unrelated field and reported as success.
    const input = renderCard({ max_upload_body_bytes: 1 * MIB })
    expect(input.value).toBe('1')

    // Touch an unrelated field so the form is dirty and Save is enabled.
    fireEvent.change(screen.getByTestId('workstore-gc-interval'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('workstore-limits-save'))

    await waitFor(() => expect(runAction).toHaveBeenCalled())
    expect(putCeiling()).toBe(1 * MIB)
  })

  it('round-trips an untouched ordinary ceiling byte-for-byte', async () => {
    renderCard()
    fireEvent.change(screen.getByTestId('workstore-gc-interval'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('workstore-limits-save'))

    await waitFor(() => expect(runAction).toHaveBeenCalled())
    expect(putCeiling()).toBe(64 * GIB)
  })
})
