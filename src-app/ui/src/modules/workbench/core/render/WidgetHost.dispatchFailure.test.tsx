// @vitest-environment jsdom
//
// FINDING 8(b) — a declared action that REJECTS must be VISIBLE to the user.
//
// `cell-filter.yaml`'s `cf.run` places `call_action: provenance.record-selection`
// BEFORE its `toast: {success: "Keep-mask committed"}`. A rejection there aborts
// `interpretBody` before the toast, so the success message correctly does not
// render — but `WidgetHost.dispatch` only `console.error`ed the rejection, so the
// button appeared to do NOTHING after a real mask commit had already happened.
// Neither outcome told the user that provenance capture failed.
//
// The dispatch now routes the rejection to the host toast surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import * as React from 'react'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { registerWidget, __clearWidgetsForTests } from './registry'
import { WidgetList } from './WidgetHost'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { defineAction, markSurfaced } from '@/core/actions/defineAction'
import { z } from 'zod'

const scope: Scope = { params: {}, state: {}, derived: {}, const: {}, data: {} }

beforeEach(() => {
  __clearWidgetsForTests()
  cleanup()
  registerWidget('btn', (spec, rctx) => (
    <button
      type="button"
      data-testid="fire"
      onClick={() => rctx.dispatch((spec as { onClick?: string }).onClick, {})}
    >
      run
    </button>
  ))
})
afterEach(() => {
  __clearWidgetsForTests()
})

describe('WidgetHost dispatch surfaces a rejected action (FINDING 8b)', () => {
  it('toasts the failure instead of failing silently', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const toast = vi.fn()
    defineAction({
      id: 's::boom',
      title: 'boom',
      permission: 'jobs::use',
      mutating: true,
      params: z.object({}).passthrough(),
      run: async () => {
        throw new Error('provenance was NOT recorded')
      },
    })

    const specs: WidgetSpec[] = [
      { id: 'b', kind: 'btn', onClick: 'boom' } as unknown as WidgetSpec,
    ]
    render(
      <WidgetList
        specs={specs}
        scope={scope}
        viewId="v"
        specId="s"
        hostCtx={{ toast } as never}
      />,
    )

    fireEvent.click(screen.getByTestId('fire'))
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringMatching(/NOT recorded/) }),
      ),
    )
    errSpy.mockRestore()
  })

  // …but NOT twice. An action that already toasted its own (better-worded) message
  // marks the rejection; the dispatcher must still log + still abort the body, and
  // must NOT repeat the sentence. Before the mark the user saw two identical error
  // toasts for one failed capture.
  it('does not duplicate a toast the action already surfaced', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const toast = vi.fn()
    defineAction({
      id: 's::selfToast',
      title: 'selfToast',
      permission: 'jobs::use',
      mutating: true,
      params: z.object({}).passthrough(),
      run: async (_p, ctx) => {
        ;(ctx as unknown as { toast?: (m: { error: string }) => void }).toast?.({
          error: 'provenance was NOT recorded',
        })
        throw markSurfaced(new Error('provenance was NOT recorded'))
      },
    })

    const specs: WidgetSpec[] = [
      { id: 'b', kind: 'btn', onClick: 'selfToast' } as unknown as WidgetSpec,
    ]
    render(
      <WidgetList
        specs={specs}
        scope={scope}
        viewId="v"
        specId="s"
        hostCtx={{ toast } as never}
      />,
    )

    fireEvent.click(screen.getByTestId('fire'))
    // the dispatcher still LOGS the rejection (diagnosis is never dropped)…
    await waitFor(() => expect(errSpy).toHaveBeenCalled())
    // …and the user was told exactly once, by the action itself.
    expect(toast).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })
})
