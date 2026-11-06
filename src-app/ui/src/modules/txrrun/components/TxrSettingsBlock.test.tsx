// @vitest-environment jsdom
/**
 * TEST-RUN-15 — the E screen's settings block
 * (`components/TxrSettingsBlock.tsx`, ITEM-7; PROV-UI-RUN-4): the four
 * board rows (Predict, Decision day, Look ahead to, Extra inputs) with
 * the board's labels + option sets, the Extra-inputs names line from the
 * resolved covariate facts, "More settings" expanding the CPU selector
 * (Auto/1..8, Auto = null), and the controlled change reporting (every
 * row change carries the new full `RunSettings`).
 *
 * The control-identity pin (kit only, `lint-native-controls`) reads the
 * RENDERED DOM: every native control element the block renders carries
 * the kit's `data-slot` stamp — a hand-rolled control never would. The
 * components under test are kit (`Segmented`/`Switch`/`Select`), so the
 * assertion is the same invariant the gallery's DOM walk enforces.
 *
 * Fixture discipline (INV-6): the settings value is the screen's own
 * small synthetic numbers; the board's example counts are never expected
 * values here. The names example "age, sex, stage" belongs to this TEST
 * file (a verification artifact — the module's copy scan excludes test
 * files): the component's source carries no name literal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TxrSettingsBlock } from './TxrSettingsBlock'
import type { TxrSettingsCovariates } from '../lib/covariates'
import { DEFAULT_RUN_SETTINGS, type RunSettings } from '../lib/settings'

// jsdom has no working PointerEvent constructor; Base UI's controls (the
// kit Switch/Segmented/Select) construct one on pointer interaction, which
// would throw and swallow the click. A MouseEvent subclass is the standard
// jsdom stand-in (the StudyPage test's shim, copied).
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

/** The fixture's settings value (every field distinct, synthetic). */
const fixtureValue: RunSettings = {
  endpoint: 'pfs',
  decision_day: 56,
  look_ahead_day: 238,
  covariates: false,
  at_a_time: 3,
  cpus: null,
  save_models: false,
}

/** The fixture's present covariates (the inspection's file-order names). */
const presentCovariates: TxrSettingsCovariates = {
  names: ['age', 'sex', 'stage'],
  availability: 'present',
}

/** Click a kit control (base-ui commits on the pointer/click sequence). */
async function clickKit(
  target: HTMLElement,
): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' })
    fireEvent.click(target)
    await Promise.resolve()
  })
}

/** Click a kit select's option (base-ui commits on pointer/down/click). */
async function clickOption(
  target: HTMLElement,
): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(target, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(target, { button: 0 })
    fireEvent.click(target)
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TxrSettingsBlock (E settings rows, TEST-RUN-15)', () => {
  it('renders the four board rows with the board labels and option sets', () => {
    const onChange = vi.fn()
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={onChange}
        onMoreSettings={() => undefined}
      />,
    )

    expect(screen.getByText('Predict')).toBeTruthy()
    expect(screen.getByText('Decision day')).toBeTruthy()
    expect(screen.getByText('Look ahead to')).toBeTruthy()
    expect(screen.getByText('Extra inputs')).toBeTruthy()
    expect(screen.getByText('More settings')).toBeTruthy()

    // The outcome row: the board's two options.
    expect(screen.getByTestId('txr-run-settings-endpoint-opt-pfs')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-endpoint-opt-os')).toBeTruthy()

    // The decision-day row: four options in the board's order (Day 56 first).
    const dayRow = screen.getByTestId('txr-run-settings-decision-day')
    const dayOptions = dayRow.querySelectorAll('[data-testid^="txr-run-settings-decision-day-opt-"]')
    expect(Array.from(dayOptions).map(el => (el as HTMLElement).dataset.testid)).toEqual([
      'txr-run-settings-decision-day-opt-56',
      'txr-run-settings-decision-day-opt-28',
      'txr-run-settings-decision-day-opt-42',
      'txr-run-settings-decision-day-opt-84',
    ])

    // The horizon row: three options.
    expect(screen.getByTestId('txr-run-settings-look-ahead-opt-238')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-look-ahead-opt-180')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-look-ahead-opt-365')).toBeTruthy()

    // The extra-inputs row carries the resolved names line.
    expect(screen.getByTestId('txr-run-settings-covariate-names').textContent).toBe(
      'age, sex, stage',
    )
  })

  it('reports a row change as the full new RunSettings', async () => {
    const onChange = vi.fn()
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={onChange}
        onMoreSettings={() => undefined}
      />,
    )

    await clickKit(screen.getByTestId('txr-run-settings-endpoint-opt-os'))
    expect(onChange).toHaveBeenCalledWith({ ...fixtureValue, endpoint: 'os' })

    await clickKit(screen.getByTestId('txr-run-settings-decision-day-opt-84'))
    expect(onChange).toHaveBeenLastCalledWith({ ...fixtureValue, decision_day: 84 })
  })

  it('the Extra-inputs switch toggles covariates', async () => {
    const onChange = vi.fn()
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={onChange}
        onMoreSettings={() => undefined}
      />,
    )
    await clickKit(screen.getByTestId('txr-run-settings-covariates'))
    expect(onChange).toHaveBeenCalledWith({ ...fixtureValue, covariates: true })
  })

  it('renders a numeric value outside the presets as its own current-value chip', () => {
    render(
      <TxrSettingsBlock
        value={{ ...fixtureValue, decision_day: 100 }}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    const chip = screen.getByTestId('txr-run-settings-decision-day-opt-100')
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('data-state')).toBe('on')
  })

  it('renders the Extra-inputs states: absent line, pending mark, no file line', () => {
    const { rerender } = render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={{ names: [], availability: 'absent' }}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-settings-covariate-names').textContent).toBe(
      'no extra inputs in your file',
    )

    rerender(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={{ names: [], availability: 'unknown' }}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-settings-covariate-names').textContent).toBe('…')

    // No patients file at all: the row shows the switch alone, no names line.
    rerender(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={null}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    expect(screen.queryByTestId('txr-run-settings-covariate-names')).toBeNull()
  })

  it('More settings expands the CPU selector; Auto = null, 1..8 = the number', async () => {
    const onMoreSettings = vi.fn()
    render(
      <TxrSettingsBlock
        value={{ ...fixtureValue, cpus: 2 }}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={onMoreSettings}
      />,
    )
    expect(screen.queryByTestId('txr-run-settings-cpus')).toBeNull()
    await clickKit(screen.getByTestId('txr-run-settings-more'))
    const select = screen.getByTestId('txr-run-settings-cpus')
    expect(select).toBeTruthy()
    // The current value is shown (the trigger label); the option list
    // appears when the popup opens and carries Auto + 1..8.
    await clickKit(select)
    expect(select.textContent).toBe('2')
    for (const [value, label] of [
      ['auto', 'Auto'],
      ['1', '1'],
      ['8', '8'],
    ]) {
      const option = screen.getByTestId(`txr-run-settings-cpus-opt-${value}`)
      expect(option.textContent).toBe(label)
    }

    await clickOption(screen.getByTestId('txr-run-settings-cpus-opt-4'))
    expect(onMoreSettings).toHaveBeenCalledWith({ cpus: 4 })

    await clickKit(select)
    await clickOption(screen.getByTestId('txr-run-settings-cpus-opt-auto'))
    expect(onMoreSettings).toHaveBeenLastCalledWith({ cpus: null })
  })

  it('every native control rendered is a kit control (data-slot stamped)', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    // The gallery DOM walk's exact allowances: the kit's own form shims
    // (hidden inputs — Base UI's Switch carries one for form POSTs) and
    // aria-hidden internals are not user-facing controls.
    const natives = document.querySelectorAll('button, input, select, textarea')
    for (const node of natives) {
      if (node.getAttribute('aria-hidden') === 'true') continue
      if ((node as HTMLInputElement).type === 'hidden') continue
      expect(node.getAttribute('data-slot'), `native control ${node.tagName} unstamped`).toBeTruthy()
    }
  })
})
