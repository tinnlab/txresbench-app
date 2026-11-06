/**
 * txrrun — the E screen's settings layer (PROV-UI-RUN-2; ITEM-3).
 *
 * Screen E (`Busy.dc.html`) holds four setting rows — the outcome, the
 * decision day, the look-ahead horizon, the extra inputs — plus the bar's
 * run-at-a-time and save-models choices and the "More settings" CPU
 * selector. Every one of them is a field the engine's PROV-EE-2
 * `RunConfig` already defines, so this layer is ONE vocabulary: the
 * module's `RunSettings` (the screen's current choices) and its mapping
 * into the generated `RunConfig` (the wire the run is created with).
 *
 * The mount-time merge precedence (DEC-6, over PROV-EE-8's sticky
 * store): the intake store's CURRENT parameters first — a just-answered
 * outcome question is never overridden by an older run's stored config —
 * then the engine's sticky analysis-config (the last-used settings, the
 * owner rule "Start -> ... -> E restores the last-used analysis config"),
 * then the engine's own defaults (PROV-EE-2) as the last resort. The
 * defaults listed here are the ENGINE's, never a copy of a board row:
 * no client-side timing exists in this file (INV-4 — the bar's total is
 * the estimate response, never a local sum).
 */
import type { RunConfig, TxrAppConfig, TxrEndpoint } from '@/api-client/types'

/**
 * The E screen's settings — the engine-shaped view of the four rows and
 * the bar's choices, every field one the run's `RunConfig` carries
 * (PROV-EE-2). `cpus: null` is the engine's "detect at run start" (the
 * CPU selector's Auto option).
 */
export interface RunSettings {
  endpoint: TxrEndpoint
  decision_day: number
  look_ahead_day: number
  covariates: boolean
  at_a_time: number
  cpus: number | null
  save_models: boolean
}

/**
 * The engine's own defaults for the config fields, verbatim from
 * PROV-EE-2: endpoint pfs, decision day 56, horizon 238, covariates off,
 * three at a time, detect CPUs, no saved models. `label_day` is
 * deliberately absent from the screen settings: it is NOT a setting
 * (DEC-7 — it stays null, the engine's "derive from the file's
 * response_day column").
 */
export const DEFAULT_RUN_SETTINGS: RunSettings = {
  endpoint: 'pfs',
  decision_day: 56,
  look_ahead_day: 238,
  covariates: false,
  at_a_time: 3,
  cpus: null,
  save_models: false,
}

/** One choice of the outcome row: the wire value + the board's label. */
export interface TxrEndpointOption {
  v: TxrEndpoint
  label: string
}

/**
 * The option lists the setting rows render — the boards' option sets,
 * verbatim: the outcome's two values (the "Predict" row), the decision
 * days in the board's own order (Busy.dc.html's select reads Day 56 |
 * Day 28 | Day 42 | Day 84 — settled at ITEM-7's rows, where the order
 * question recorded by PLAN ITEM-3 note (c) was decided), the horizon
 * values, and the bar's at-a-time presets. A value OUTSIDE a list (the
 * engine default 3, or a restored sticky value) renders as the
 * current-value chip — the board's own framing — never as a
 * silently-added option.
 */
export const SETTING_OPTIONS = {
  endpoint: [
    { v: 'pfs' as TxrEndpoint, label: 'Progression or death' },
    { v: 'os' as TxrEndpoint, label: 'Death only' },
  ],
  decision_day: [56, 28, 42, 84] as const,
  look_ahead_day: [238, 180, 365] as const,
  at_a_time: [1, 2, 4] as const,
}

/**
 * The mount-time settings of screen E (DEC-6's three sources, in order
 * of freshness): the intake parameters' `decision_day` (the answer the
 * user just gave on the outcome screen — its value belongs to THIS
 * analysis, so it beats any stored config), then the engine's sticky
 * config for every OTHER field (its decision day applies only when the
 * intake carries none — the entry path without a fresh answer), then the
 * engine's defaults. `baseline_max_day` rides on the intake parameters
 * (fix 0, the contract rule) for shape compatibility; it is not a
 * screen setting, so it stops here.
 */
export function mergeRunSettings(
  engine: TxrAppConfig | null,
  params: { decision_day: number | null; baseline_max_day: number } | null,
): RunSettings {
  const config = engine?.config ?? null
  return {
    endpoint: config?.endpoint ?? DEFAULT_RUN_SETTINGS.endpoint,
    decision_day:
      params?.decision_day ?? config?.decision_day ?? DEFAULT_RUN_SETTINGS.decision_day,
    look_ahead_day: config?.look_ahead_day ?? DEFAULT_RUN_SETTINGS.look_ahead_day,
    covariates: config?.covariates ?? DEFAULT_RUN_SETTINGS.covariates,
    at_a_time: config?.at_a_time ?? DEFAULT_RUN_SETTINGS.at_a_time,
    cpus: config?.cpus ?? DEFAULT_RUN_SETTINGS.cpus,
    save_models: config?.save_models ?? DEFAULT_RUN_SETTINGS.save_models,
  }
}

/**
 * `RunSettings` -> the generated `RunConfig` (the create body and the
 * sticky PUT body of ITEM-4's hook), with `label_day` extra and null by
 * default: the engine derives the label day from the file's
 * response_day column unless a screen explicitly names one (DEC-7 — no
 * such control exists on E, so the wire always carries the derivation
 * marker).
 *
 * The `unknown` bridge: the generated client's `RunConfig` types `cpus`
 * and `label_day` as plain optionals (`cpus?: number`, `label_day?:
 * number`) — the provider regen collapses a nullable-and-optional
 * OpenAPI field — while the engine contract carries `cpus: null` and
 * `label_day: null` explicitly and this node's pins require the exact
 * bytes (TEST-RUN-06's exact-shape row). The bytes emitted are exactly
 * the engine's, and the bridge is type-level only — the same class the
 * intake's engine-table bridge documents (DRIFT-1 ITEM-3).
 */
export function toRunConfig(
  settings: RunSettings,
  labelDay: number | null = null,
): RunConfig {
  return {
    endpoint: settings.endpoint,
    decision_day: settings.decision_day,
    look_ahead_day: settings.look_ahead_day,
    covariates: settings.covariates,
    at_a_time: settings.at_a_time,
    cpus: settings.cpus,
    save_models: settings.save_models,
    label_day: labelDay,
  } as unknown as RunConfig
}
