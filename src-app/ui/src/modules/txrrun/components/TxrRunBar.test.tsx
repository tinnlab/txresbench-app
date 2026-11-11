// @vitest-environment jsdom
/**
 * ITEM-2 (c) — the E screen's run bar (`components/TxrRunBar.tsx`): the
 * plan's two-line sticky bar — "6 methods selected · about 2 min (3 at a
 * time on 8 CPUs)", the save-the-trained-models switch with its one-line
 * meaning, the research notice once (small, line 2), and the Run button
 * disabled with the reason when nothing is selected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrRunBar } from './TxrRunBar'
import { RESEARCH_NOTICE } from '../lib/format'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrRunBar (ITEM-2 c)', () => {
  it('renders the count, the plan\u2019s time sentence, the save switch with its meaning and the notice once', () => {
    render(
      <TxrRunBar
        selectedCount={6}
        timeText="about 2 min (3 at a time on 8 CPUs)"
        atATime={3}
        saveModels={{ checked: false, onChange: () => undefined }}
        onRun={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-bar-count').textContent).toBe('6 methods selected')
    expect(screen.getByTestId('txr-run-bar-time').textContent).toBe(
      'about 2 min (3 at a time on 8 CPUs)',
    )
    expect(screen.getByTestId('txr-run-bar-notice').textContent).toBe(RESEARCH_NOTICE)
    expect(screen.getByTestId('txr-run-bar-save')).toBeTruthy()
    expect(screen.getByTestId('txr-run-bar-save').textContent).toContain(
      'Keeps each trained model so you can reuse it on new patients.',
    )
    expect(screen.getByTestId('txr-run-bar-run').textContent).toBe('Run 6 methods')
    expect(screen.queryByTestId('txr-run-bar-empty-reason')).toBeNull()
  })

  it('disables Run with the reason beside it when nothing is selected', () => {
    render(
      <TxrRunBar
        selectedCount={0}
        timeText="…"
        atATime={3}
        saveModels={{ checked: false, onChange: () => undefined }}
        onRun={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-bar-run').getAttribute('disabled')).not.toBeNull()
    expect(screen.getByTestId('txr-run-bar-empty-reason').textContent).toBe(
      'Select at least one method',
    )
    expect(screen.getByTestId('txr-run-bar-run').textContent).toBe('Run 0 methods')
  })

  it('reports the options up (the settings\u2019 lanes and the save toggle)', async () => {
    const onRun = vi.fn()
    render(
      <TxrRunBar
        selectedCount={6}
        timeText="about 2 min (3 at a time on 8 CPUs)"
        atATime={3}
        saveModels={{ checked: true, onChange: () => undefined }}
        onRun={onRun}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-bar-run'))
      await Promise.resolve()
    })
    expect(onRun).toHaveBeenCalledWith({ atATime: 3, saveModels: true })
  })
})
