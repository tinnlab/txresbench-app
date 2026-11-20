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
import type { FileTimeline } from '@/api-client/types'

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

/**
 * Day facts of 12 patients: draws on days 28 and 56; 3 with the event at day
 * 300, 3 at day 400, and 6 followed to day 500 without it (so the known
 * outcomes stay 12 until day 500, then fall to 6).
 */
const DAY_FACTS: FileTimeline = {
  draw_days: Array.from({ length: 12 }, () => [28, 56]),
  outcomes: [
    ...Array.from({ length: 3 }, () => ({ pfs: { days: 300, event: 1 } })),
    ...Array.from({ length: 3 }, () => ({ pfs: { days: 400, event: 1 } })),
    ...Array.from({ length: 6 }, () => ({ pfs: { days: 500, event: 0 } })),
  ],
  limits: { baseline_max_day: 0, look_ahead_day_max: 730, min_training_patients: 10 },
}

/** 12 patients all followed to day 100 without the event (none known later). */
const ALL_CENSORED: FileTimeline = {
  ...DAY_FACTS,
  outcomes: Array.from({ length: 12 }, () => ({ pfs: { days: 100, event: 0 } })),
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

    // The decision day and the look-ahead are number fields (no fixed day
    // lists); with no day facts there are no suggestions.
    expect(
      (screen.getByTestId('txr-run-settings-decision-day-input') as HTMLInputElement).value,
    ).toBe('56')
    expect(screen.queryByTestId('txr-run-settings-decision-day-suggestions')).toBeNull()
    expect(
      (screen.getByTestId('txr-run-settings-look-ahead-input') as HTMLInputElement).value,
    ).toBe('238')
    expect(screen.getByTestId('txr-run-settings-look-ahead-beside').textContent).toBe(
      '238 days ≈ 7.8 months',
    )

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

    const input = screen.getByTestId('txr-run-settings-decision-day-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: '84' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await Promise.resolve()
    })
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

  it('suggests the days of the checked files, with the coverage lines, and reports a choice', async () => {
    const onChooseDay = vi.fn()
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        dayFacts={DAY_FACTS}
        onChooseDay={onChooseDay}
      />,
    )
    expect(
      Array.from(
        screen
          .getByTestId('txr-run-settings-decision-day-suggestions')
          .querySelectorAll('button'),
      ).map(b => b.textContent),
    ).toEqual(['Day 28', 'Day 56'])
    expect(screen.getByTestId('txr-run-settings-decision-day-coverage').textContent).toBe(
      'Day 56: 12 of 12 patients have a draw during treatment by this day',
    )
    // The look-ahead: the default, then the three-quarters and half days.
    expect(
      Array.from(
        screen.getByTestId('txr-run-settings-look-ahead-suggestions').querySelectorAll('button'),
      ).map(b => b.textContent),
    ).toEqual(['Day 238', 'Day 499: 3 in 4 known', 'Day 730: half known'])
    expect(screen.getByTestId('txr-run-settings-look-ahead-coverage').textContent).toBe(
      'Day 238: 12 of 12 patients have a known outcome',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('txr-run-settings-decision-day-suggestion-28'))
      fireEvent.click(screen.getByTestId('txr-run-settings-look-ahead-suggestion-499'))
      await Promise.resolve()
    })
    expect(onChooseDay).toHaveBeenNthCalledWith(1, 'decision_day', 28)
    expect(onChooseDay).toHaveBeenNthCalledWith(2, 'look_ahead_day', 499)
  })

  it('says why a look-ahead day cannot be used, and warns about a risky one', async () => {
    const { rerender } = render(
      <TxrSettingsBlock
        value={{ ...fixtureValue, look_ahead_day: 600 }}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        dayFacts={ALL_CENSORED}
      />,
    )
    // Every patient's follow-up ends at day 100 without the event: none known at 600.
    expect(screen.getByTestId('txr-run-settings-look-ahead-blocked').textContent).toBe(
      'No patient has a known outcome by day 600, so the chance cannot be worked out. Choose an earlier day.',
    )
    rerender(
      <TxrSettingsBlock
        value={{ ...fixtureValue, look_ahead_day: 600 }}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        dayFacts={DAY_FACTS}
      />,
    )
    expect(screen.queryByTestId('txr-run-settings-look-ahead-blocked')).toBeNull()
    expect(screen.getByTestId('txr-run-settings-look-ahead-warning').textContent).toBe(
      'Only 6 patients have a known outcome by day 600. Methods learn an outcome from at least 10.',
    )
    // A typed day before the decision day is refused in place.
    const input = screen.getByTestId('txr-run-settings-look-ahead-input')
    await act(async () => {
      fireEvent.change(input, { target: { value: '40' } })
      fireEvent.blur(input)
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-settings-look-ahead-error').textContent).toBe(
      'Choose a day after the decision day (day 56).',
    )
    rerender(
      <TxrSettingsBlock
        value={{ ...fixtureValue, look_ahead_day: 450 }}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        dayFacts={DAY_FACTS}
      />,
    )
    await act(async () => {
      fireEvent.change(input, { target: { value: '731' } })
      fireEvent.blur(input)
      await Promise.resolve()
    })
    expect(screen.getByTestId('txr-run-settings-look-ahead-error').textContent).toBe(
      'Choose day 730 or earlier.',
    )
  })

  it('the demo keeps the recorded days: no suggestions, the boxes read only', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        dayFacts={DAY_FACTS}
        locked
      />,
    )
    expect(screen.queryByTestId('txr-run-settings-decision-day-suggestions')).toBeNull()
    expect(screen.queryByTestId('txr-run-settings-look-ahead-suggestions')).toBeNull()
    expect(
      (screen.getByTestId('txr-run-settings-look-ahead-input') as HTMLInputElement).readOnly,
    ).toBe(true)
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

describe('TxrSettingsBlock ITEM-2 — the "What do you want to predict?" card', () => {
  it('renders the card title, the live sentence and the four one-line helps', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-settings-title').textContent).toBe(
      'What do you want to predict?',
    )
    expect(screen.getByTestId('txr-run-settings-sentence').textContent).toBe(
      'Progression or death by day 238 of treatment, from the blood draws up to day 56.',
    )
    for (const help of [
      'The day you decide, counted from the start of treatment.',
      'The day the prediction is for, counted from the start of treatment.',
      'Other columns of your file the methods may use.',
    ]) {
      expect(screen.getByText(help)).toBeTruthy()
    }
  })

  it('the sentence follows the row values (Death only + day 365 + day 84)', () => {
    render(
      <TxrSettingsBlock
        value={{ ...fixtureValue, endpoint: 'os', decision_day: 84, look_ahead_day: 365 }}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    expect(screen.getByTestId('txr-run-settings-sentence').textContent).toBe(
      'Death by day 365 of treatment, from the blood draws up to day 84.',
    )
  })

  it('the Extra-inputs switch is disabled with the reason when the file has no covariate column', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={{ names: [], availability: 'absent' }}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    const switchEl = screen.getByTestId('txr-run-settings-covariates')
    const switchControl = (
      switchEl.matches('[role="switch"]') ? switchEl : switchEl.querySelector('[role="switch"]')
    ) as HTMLElement | null
    expect(switchControl).toBeTruthy()
    // Base UI marks the disabled state on the native control / its root.
    expect(switchControl!.hasAttribute('data-disabled') || switchControl!.hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByTestId('txr-run-settings-covariates-disabled-reason').textContent,
    ).toBe('your file has no extra-input columns')
    expect(screen.getByTestId('txr-run-settings-covariate-names').textContent).toBe(
      'no extra inputs in your file',
    )
  })

  it('the Extra-inputs help line prop replaces the general help (step-4 fix)', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        covariatesHelp="Used by 1 of the 5 methods that can run."
      />,
    )
    expect(screen.getByTestId('txr-run-settings-covariates-help').textContent).toBe(
      'Used by 1 of the 5 methods that can run.',
    )
    expect(screen.queryByText('Other columns of your file the methods may use.')).toBeNull()
  })

  it('a null help line keeps the general help', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        covariatesHelp={null}
      />,
    )
    expect(screen.getByTestId('txr-run-settings-covariates-help').textContent).toBe(
      'Other columns of your file the methods may use.',
    )
  })

  it('the disabled reason still wins over the help line when the file has no covariate column', () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={{ names: [], availability: 'absent' }}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
        covariatesHelp="Used by 1 of the 5 methods that can run."
      />,
    )
    expect(
      screen.getByTestId('txr-run-settings-covariates-disabled-reason').textContent,
    ).toBe('your file has no extra-input columns')
    expect(screen.queryByTestId('txr-run-settings-covariates-help')).toBeNull()
    expect(screen.queryByText('Used by 1 of the 5 methods that can run.')).toBeNull()
  })

  it('More settings opens in place: CPUs, the lanes and the two quiet facts', async () => {
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={() => undefined}
      />,
    )
    await clickKit(screen.getByTestId('txr-run-settings-more'))
    expect(screen.getByTestId('txr-run-settings-at-a-time')).toBeTruthy()
    expect(screen.getByTestId('txr-run-settings-at-a-time-opt-3').getAttribute('data-state')).toBe('on')
    expect(screen.getByTestId('txr-run-settings-estimate-explained').textContent).toContain(
      'measured benchmark run times',
    )
    expect(screen.getByTestId('txr-run-settings-seed-fact').textContent).toContain('fixed seed')
  })

  it('the lanes control reports through onMoreSettings', async () => {
    const onMoreSettings = vi.fn()
    render(
      <TxrSettingsBlock
        value={fixtureValue}
        covariates={presentCovariates}
        onChange={() => undefined}
        onMoreSettings={onMoreSettings}
      />,
    )
    await clickKit(screen.getByTestId('txr-run-settings-more'))
    await clickKit(screen.getByTestId('txr-run-settings-at-a-time-opt-2'))
    expect(onMoreSettings).toHaveBeenLastCalledWith({ at_a_time: 2 })
  })
})
