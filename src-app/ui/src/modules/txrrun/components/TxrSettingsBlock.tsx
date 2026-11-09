/**
 * TxrSettingsBlock — the E screen's four setting rows + "More settings"
 * (board `Busy.dc.html`, ITEM-7; PROV-UI-RUN-4).
 *
 * The board's settings card (the bordered row between the file slots and
 * the method list) is: a "Predict" outcome pick, a "Decision day" pick,
 * a "Look ahead to" pick, an "Extra inputs" switch with the file's
 * covariate names, and the "More settings" link the CPU selector expands
 * from (DEC-7 — CPUs only, the one knob the board hints at and every
 * other knob stays at the engine's defaults).
 *
 * Board-copy facts of this layout:
 * - the row labels are the board's own words ("Predict", "Decision day",
 *   "Look ahead to", "Extra inputs", "More settings");
 * - the option sets are PROV-UI-RUN-2's `SETTING_OPTIONS` (the outcome's
 *   two values, the decision days in the board's order — Day 56 first —
 *   and the horizons), each chip labeled with the board's "Day N" form;
 *   a value OUTSIDE an option set (a restored sticky day, the engine's
 *   own numbers) renders as its own current-value chip — the board's own
 *   framing for the at-a-time presets, applied to every numeric row of
 *   this block, because a pick with nothing selected is a dead control;
 * - "Extra inputs" is the covariates switch + the names line: the names
 *   are DATA (the patients file's resolved covariate column names through
 *   `buildCovariates`), the board's "age, sex, stage" is a design example
 *   and never a constant; an inspected file without one shows the
 *   absent line, an unresolved inspection shows the pending mark (the
 *   bottom bar's "…" idiom) — never a stale or guessed name;
 * - the CPU selector (the expanded More-settings state, DEC-7) offers
 *   Auto (= the engine's detect-at-run-start, `cpus: null`) and 1..8.
 *
 * The block is CONTROLLED and presentational: the rows render `value` and
 * every change reports the new full `RunSettings` up (`onChange`); the
 * CPU selector reports through `onMoreSettings` (its change is a
 * settings-level option, the page routes it to the same sticky write).
 * The expander's open state is the block's own.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Segmented, Select, Switch } from '@ziee/kit'
import type { SegmentedOption } from '@ziee/kit'
import { SETTING_OPTIONS, type RunSettings } from '../lib/settings'
import type { TxrSettingsCovariates } from '../lib/covariates'

/** The settings-value changed (one row; the full new value). */
export interface TxrSettingsBlockProps {
  /** The rows' current value. */
  value: RunSettings
  /** The Extra-inputs names line facts (the patients inspection), or null
   *  when the screen has no patients file (the predict-mode render). */
  covariates: TxrSettingsCovariates | null
  /** A row changed — `next` is the full new settings value. */
  onChange(next: RunSettings): void
  /** The More-settings CPU selector changed. */
  onMoreSettings(next: { cpus: number | null }): void
}

/** The board's settings card (flex-wrap, 16 gap, 12×16 padding, radius 10). */
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 16px',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
}

/** The board's settings row (the card's single flex-wrap line). */
const ROWS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  alignItems: 'flex-end',
}

/** One setting: the board's label above the control. */
const ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

/** The board's 13px/600 label. */
const LABEL: CSSProperties = { fontSize: 13, fontWeight: 600 }

/** The board's extra-inputs inline row (switch + names). */
const INPUTS_LINE: CSSProperties = {
  fontSize: 14,
  display: 'flex',
  flexDirection: 'row',
  gap: 6,
  alignItems: 'center',
  minHeight: 32,
}

/** The names line's muted color (the board's `var(--txr-muted)`). */
const NAMES_LINE: CSSProperties = { color: 'var(--txr-muted)' }

/** The absent/pending line's muted color. */
const FACTS_LINE: CSSProperties = { color: 'var(--txr-muted)', fontSize: 13.5 }

/** The card's "More settings" spot (right end, the board's link role). */
const MORE: CSSProperties = { flexGrow: 1, alignSelf: 'flex-end', fontSize: 13.5 }

/** The "Day N" label of a numeric day option (the board's wording). */
const dayLabel = (day: number): string => `Day ${day}`

/**
 * The option set a numeric row renders: the board's presets, plus the
 * CURRENT value as its own chip when the value sits outside them (the
 * at-a-time chip rule of PROV-UI-RUN-2, extended to every numeric row —
 * a pick with the current value selected nowhere is a dead control).
 */
function numericOptions(
  value: number,
  presets: readonly number[],
): SegmentedOption[] {
  const options: SegmentedOption[] = presets.map(day => ({
    value: String(day),
    label: dayLabel(day),
  }))
  if (!presets.includes(value)) {
    options.push({ value: String(value), label: dayLabel(value) })
  }
  return options
}

/** The CPU select's options: Auto (= null) + 1..8 (DEC-7). */
const CPU_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  ...Array.from({ length: 8 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
]

/** The Extra-inputs facts line (names, absent line, or the pending mark). */
function factsLine(covariates: TxrSettingsCovariates | null): string | null {
  if (covariates === null) return null
  if (covariates.availability === 'present') return covariates.names.join(', ')
  if (covariates.availability === 'absent') return 'no extra inputs in your file'
  return '…'
}

export function TxrSettingsBlock({
  value,
  covariates,
  onChange,
  onMoreSettings,
}: TxrSettingsBlockProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const names = factsLine(covariates)
  return (
    <div style={CARD} data-testid="txr-run-settings">
      <div style={ROWS}>
        <div style={ROW}>
          <span style={LABEL}>Predict</span>
          <Segmented
            data-testid="txr-run-settings-endpoint"
            aria-label="Predict"
            size="sm"
            value={value.endpoint}
            onValueChange={endpoint => onChange({ ...value, endpoint: endpoint as RunSettings['endpoint'] })}
            options={SETTING_OPTIONS.endpoint.map(option => ({
              value: option.v,
              label: option.label,
            }))}
          />
        </div>
        <div style={ROW}>
          <span style={LABEL}>Decision day</span>
          <Segmented
            data-testid="txr-run-settings-decision-day"
            aria-label="Decision day"
            size="sm"
            value={String(value.decision_day)}
            onValueChange={day => onChange({ ...value, decision_day: Number(day) })}
            options={numericOptions(value.decision_day, SETTING_OPTIONS.decision_day)}
          />
        </div>
        <div style={ROW}>
          <span style={LABEL}>Look ahead to</span>
          <Segmented
            data-testid="txr-run-settings-look-ahead"
            aria-label="Look ahead to"
            size="sm"
            value={String(value.look_ahead_day)}
            onValueChange={day => onChange({ ...value, look_ahead_day: Number(day) })}
            options={numericOptions(value.look_ahead_day, SETTING_OPTIONS.look_ahead_day)}
          />
        </div>
        <div style={ROW}>
          <span style={LABEL}>Extra inputs</span>
          <div style={INPUTS_LINE}>
            <Switch
              data-testid="txr-run-settings-covariates"
              className="txr-settings-switch"
              aria-label="Extra inputs"
              checked={value.covariates}
              onCheckedChange={checked => onChange({ ...value, covariates: checked })}
            />
            {names !== null ? (
              <span style={NAMES_LINE} data-testid="txr-run-settings-covariate-names">
                {names}
              </span>
            ) : null}
          </div>
        </div>
        <span style={MORE}>
          <Button
            variant="link"
            data-testid="txr-run-settings-more"
            style={{ fontSize: 13.5, padding: '2px 4px' }}
            onClick={() => setMoreOpen(open => !open)}
          >
            More settings
          </Button>
        </span>
      </div>
      {moreOpen ? (
        <div style={ROWS}>
          <div style={ROW}>
            <span style={LABEL}>CPUs</span>
            <Select
              data-testid="txr-run-settings-cpus"
              aria-label="CPUs"
              size="sm"
              value={value.cpus === null ? 'auto' : String(value.cpus)}
              onValueChange={cpus =>
                onMoreSettings({ cpus: cpus === 'auto' ? null : Number(cpus) })
              }
              options={CPU_OPTIONS}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
