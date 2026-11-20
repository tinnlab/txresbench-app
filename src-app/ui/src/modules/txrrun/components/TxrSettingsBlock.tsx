/**
 * TxrSettingsBlock — the E screen's "What do you want to predict?" card
 * (qa-fixes3 ITEM-2 (b); ITEM-7's rows kept as the row contract):
 *
 * - the card carries its title and a LIVE sentence at the top —
 *   "Progression or death by day 238 of treatment, from the blood draws up to day
 *   56." — built from the row values (`settingsSentence`, the ONE
 *   formatter, unit-tested), so the sentence can never drift from the
 *   selection;
 * - the four rows keep the board's option sets (PROV-UI-RUN-2) and gain
 *   one line of plain help each (the plan's words);
 * - "Extra inputs" is the covariates switch + the names line; an inspected
 *   file with NO covariate column shows the absent line and the switch is
 *   DISABLED with the reason (the plan's "disabled with the reason when
 *   the file has none" — a switch for nothing is a dead control);
 * - "More settings" opens in place: CPUs (Auto = the engine's
 *   detect-at-run-start, DEC-7), "How many run at once" (the lanes — moved
 *   here from the bar; the bar now READ the lanes), the fixed-seed fact
 *   (the engine contract pins ONE seed — no seed knob exists; DRIFT-1
 *   ITEM-2) and the estimate explained (where the time numbers come from);
 * - at the app's phone width the card is COLLAPSIBLE (collapsed by
 *   default) with the live sentence as its one-line summary; the rows are
 *   the same controls either way (only the chrome changes). The app-shell's
 *   short shell windows (720/768 px) use the same compact form via the
 *   `collapsed` prop (less to scroll past on the E page).
 *
 * The block is CONTROLLED and presentational (the ITEM-7 rule): the rows
 * render `value`, every change reports the new full `RunSettings` up, the
 * More-settings controls report the fields they changed, and the expander
 * states (more-settings open, phone collapse) are the block's own.
 */
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Segmented, Select, Switch } from '@txresbench/kit'
import type { SegmentedOption } from '@txresbench/kit'
import {
  COVARIATES_DISABLED_REASON,
  SETTING_HELP,
  SETTING_OPTIONS,
  settingsSentence,
  type RunSettings,
} from '../lib/settings'
import { ESTIMATE_EXPLAINED, FIXED_SEED_FACT } from '../lib/runBar'
import type { TxrSettingsCovariates } from '../lib/covariates'
import { useNarrow } from '../lib/useNarrow'
import type { FileTimeline } from '@/api-client/types'
import { TxrDayField } from '@/modules/txrintake/components/TxrDayField'
import {
  checkLookAhead,
  drawCoverageLine,
  drawDayError,
  drawDayWarning,
  knownOutcomeLine,
  lookAheadSuggestions,
  monthsText,
  suggestDrawDays,
} from '@/modules/txrintake/lib/dayChoices'

/** The settings-value changed (one row; the full new value). */
export interface TxrSettingsBlockProps {
  /** The rows' current value. */
  value: RunSettings
  /** The Extra-inputs names line facts (the patients inspection), or null
   *  when the screen has no patients file (the predict-mode render). */
  covariates: TxrSettingsCovariates | null
  /** A row changed — `next` is the full new settings value. */
  onChange(next: RunSettings): void
  /** The More-settings controls changed (CPUs / lanes). */
  onMoreSettings(next: Partial<Pick<RunSettings, 'cpus' | 'at_a_time'>>): void
  /** app-shell ITEM-2: a SHORT shell window renders the card collapsed by
   *  default (the audit's fixed-top byte — the one-line summary form the
   *  phone width already uses); `undefined` keeps the width-driven state. */
  collapsed?: boolean
  /** The Extra-inputs help line once the method list is known ("Used by 1
   *  of the 5 methods that can run.", `covariatesUseLine`): it replaces the
   *  general help. The disabled reason still wins when the file has no
   *  extra-input columns. `null`/omitted keeps the general help. */
  covariatesHelp?: string | null
  /** demo-mode ITEM-6: the demo offers only the recorded configuration —
   *  the rows are shown with their recorded values and LOCKED (the spec's
   *  "other controls are shown, disabled"), the More-settings (CPUs /
   *  at-a-time) controls are hidden (no real compute), and the caller
   *  renders the demo reason line under the card. */
  locked?: boolean
  /** The day facts of the checked files (suggestions + coverage lines), or null. */
  dayFacts?: FileTimeline | null
  /** A day was chosen (a suggestion or a typed day): runs `runSettings.setDay`. */
  onChooseDay?(field: 'decision_day' | 'look_ahead_day', day: number): void
}

/** The card's look (the board's settings card, with the block's own title). */
const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 16px',
  border: '1px solid var(--txr-border)',
  borderRadius: 10,
  minWidth: 0,
}

/** The card title (the ITEM-2 heading). */
const CARD_TITLE: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--txr-text)',
}

/** The live sentence (the plan's one-line summary of the selection). */
const SENTENCE: CSSProperties = { margin: 0, fontSize: 13.5, color: 'var(--txr-text-2)' }

/** The rows' wrap line (the board's flex-wrap row). */
const ROWS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  alignItems: 'flex-end',
}

/** One setting: the label + help above the control. */
const ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}

/** The board's 13px/600 label. */
const LABEL: CSSProperties = { fontSize: 13, fontWeight: 600 }

/** One row's one-line help (the plan's words, quiet). */
const HELP: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)', maxWidth: '30ch' }

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

/** The More-settings quiet facts (the estimate + the fixed seed). */
const MORE_FACTS: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 12.5,
  color: 'var(--txr-muted)',
  paddingTop: 2,
}

/** The disabled reason's tone (the plan's named reason, plain). */
const DISABLED_REASON: CSSProperties = { color: 'var(--txr-muted)', fontSize: 12.5 }

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

/**
 * The look-ahead suggestions as buttons: the default, then the furthest days
 * where three quarters / half of the patients have a known outcome (a day
 * already listed keeps its first label).
 */
function lookAheadChoices(
  facts: FileTimeline | null,
  decisionDay: number,
  endpoint: RunSettings['endpoint'],
): Array<{ day: number; label: string }> {
  if (facts === null || facts.outcomes.length === 0) return []
  const s = lookAheadSuggestions(facts, decisionDay, endpoint)
  const out: Array<{ day: number; label: string }> = [{ day: s.default, label: `Day ${s.default}` }]
  const add = (day: number | null, label: string): void => {
    if (day !== null && !out.some(o => o.day === day)) out.push({ day, label })
  }
  add(s.threeQuarters, `Day ${s.threeQuarters ?? ''}: 3 in 4 known`)
  add(s.half, `Day ${s.half ?? ''}: half known`)
  return out
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
  collapsed,
  locked = false,
  covariatesHelp = null,
  dayFacts = null,
  onChooseDay,
}: TxrSettingsBlockProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const narrow = useNarrow()
  /** The compact (one-line) form: phone width, or a SHORT shell window. */
  const compact = narrow || collapsed === true
  const [phoneOpen, setPhoneOpen] = useState(false)
  const names = factsLine(covariates)
  const sentence = useMemo(
    () => settingsSentence(value),
    [value.endpoint, value.decision_day, value.look_ahead_day], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const covariatesDisabled = covariates?.availability === 'absent'
  const chooseDay = (field: 'decision_day' | 'look_ahead_day', day: number): void => {
    if (onChooseDay !== undefined) onChooseDay(field, day)
    else onChange({ ...value, [field]: day })
  }
  const drawSuggestions = useMemo(
    () => (dayFacts === null ? [] : suggestDrawDays(dayFacts)),
    [dayFacts],
  )
  const lookAheadMax = dayFacts?.limits.look_ahead_day_max ?? Number.POSITIVE_INFINITY
  const lookAheadDays = useMemo(
    () => lookAheadChoices(dayFacts, value.decision_day, value.endpoint),
    [dayFacts, value.decision_day, value.endpoint],
  )
  const lookAheadCheck = checkLookAhead(
    dayFacts,
    value.decision_day,
    value.look_ahead_day,
    value.endpoint,
    lookAheadMax,
  )

  const rows = (
    <div style={ROWS}>
      <div style={ROW}>
        <span style={LABEL}>Predict</span>
        <Segmented
          data-testid="txr-run-settings-endpoint"
          aria-label="Predict"
          size="sm"
          disabled={locked}
          value={value.endpoint}
          onValueChange={endpoint => onChange({ ...value, endpoint: endpoint as RunSettings['endpoint'] })}
          options={SETTING_OPTIONS.endpoint.map(option => ({
            value: option.v,
            label: option.label,
          }))}
        />
        <span style={HELP}>{SETTING_HELP.endpoint}</span>
      </div>
      <div style={ROW}>
        <span style={LABEL}>Decision day</span>
        <TxrDayField
          testId="txr-run-settings-decision-day"
          label="Decision day"
          value={value.decision_day}
          suggestions={drawSuggestions}
          locked={locked}
          onChoose={day => chooseDay('decision_day', day)}
          check={day =>
            dayFacts === null
              ? Number.isInteger(day) && day >= 1
                ? null
                : 'Choose a whole day from 1.'
              : drawDayError(day, dayFacts.limits.look_ahead_day_max)
          }
          coverage={dayFacts === null ? null : drawCoverageLine(dayFacts, value.decision_day)}
          warning={dayFacts === null ? null : drawDayWarning(dayFacts, value.decision_day)}
        />
        <span style={HELP}>{SETTING_HELP.decision_day}</span>
      </div>
      <div style={ROW}>
        <span style={LABEL}>Look ahead to</span>
        <TxrDayField
          testId="txr-run-settings-look-ahead"
          label="Look ahead to"
          value={value.look_ahead_day}
          suggestions={lookAheadDays.map(s => s.day)}
          suggestionLabel={day => lookAheadDays.find(s => s.day === day)?.label ?? `Day ${day}`}
          locked={locked}
          onChoose={day => chooseDay('look_ahead_day', day)}
          check={day =>
            checkLookAhead(dayFacts, value.decision_day, day, value.endpoint, lookAheadMax).error
          }
          beside={monthsText(value.look_ahead_day)}
          coverage={
            dayFacts === null || dayFacts.outcomes.length === 0
              ? null
              : knownOutcomeLine(dayFacts, value.decision_day, value.look_ahead_day, value.endpoint)
          }
          blocked={lookAheadCheck.error}
          warning={lookAheadCheck.warning}
        />
        <span style={HELP}>{SETTING_HELP.look_ahead_day}</span>
      </div>
      <div style={ROW}>
        <span style={LABEL}>Extra inputs</span>
        <div style={INPUTS_LINE}>
          <Switch
            data-testid="txr-run-settings-covariates"
            className="txr-settings-switch"
            aria-label="Extra inputs"
            checked={value.covariates}
            disabled={locked || covariatesDisabled}
            onCheckedChange={checked => onChange({ ...value, covariates: checked })}
          />
          {names !== null ? (
            <span style={NAMES_LINE} data-testid="txr-run-settings-covariate-names">
              {names}
            </span>
          ) : null}
        </div>
        {covariatesDisabled ? (
          <span style={DISABLED_REASON} data-testid="txr-run-settings-covariates-disabled-reason">
            {COVARIATES_DISABLED_REASON}
          </span>
        ) : (
          <span style={HELP} data-testid="txr-run-settings-covariates-help">
            {covariatesHelp ?? SETTING_HELP.covariates}
          </span>
        )}
      </div>
      {locked ? null : (
        <span style={MORE}>
          <Button
            variant="link"
            data-testid="txr-run-settings-more"
            aria-expanded={moreOpen}
            style={{ fontSize: 13.5, padding: '2px 4px' }}
            onClick={() => setMoreOpen(open => !open)}
          >
            More settings
          </Button>
        </span>
      )}
    </div>
  )

  const moreSettings = (
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
      <div style={ROW}>
        <span style={LABEL}>How many run at once</span>
        <Segmented
          data-testid="txr-run-settings-at-a-time"
          aria-label="How many run at once"
          size="sm"
          value={String(value.at_a_time)}
          onValueChange={lanes => onMoreSettings({ at_a_time: Number(lanes) })}
          options={numericOptions(value.at_a_time, SETTING_OPTIONS.at_a_time)}
        />
      </div>
      <div style={MORE_FACTS}>
        <span data-testid="txr-run-settings-estimate-explained">{ESTIMATE_EXPLAINED}</span>
        <span data-testid="txr-run-settings-seed-fact">{FIXED_SEED_FACT}</span>
      </div>
    </div>
  )

  if (compact && !phoneOpen) {
    return (
      <div style={CARD} data-testid="txr-run-settings" data-narrow="true">
        <Button
          variant="outline"
          data-testid="txr-run-settings-toggle"
          aria-expanded={false}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 2,
            padding: '8px 10px',
            border: 'none',
            background: 'transparent',
            height: 'auto',
            minHeight: 44,
            // The kit button's default is nowrap — the summary lines must
            // WRAP on a narrow card (the 390 sweep's byte).
            whiteSpace: 'normal',
          }}
          onClick={() => setPhoneOpen(true)}
        >
          <span style={CARD_TITLE}>What do you want to predict?</span>
          <span style={SENTENCE}>{sentence}</span>
        </Button>
      </div>
    )
  }

  return (
    <div style={CARD} data-testid="txr-run-settings" data-narrow={compact ? 'true' : 'false'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <h2 data-testid="txr-run-settings-title" style={CARD_TITLE}>
          What do you want to predict?
        </h2>
        <p style={SENTENCE} data-testid="txr-run-settings-sentence">
          {sentence}
        </p>
      </div>
      {compact ? (
        <Button
          variant="outline"
          data-testid="txr-run-settings-toggle"
          aria-expanded={true}
          style={{ alignSelf: 'flex-start', minHeight: 44 }}
          onClick={() => setPhoneOpen(false)}
        >
          Hide the settings
        </Button>
      ) : null}
      {rows}
      {moreOpen ? moreSettings : null}
    </div>
  )
}
