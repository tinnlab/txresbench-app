/**
 * TxrHistoryDetailBlock — the expanded block of one K card (PROV-HIST-5):
 * the board's dl grid (Your files + the copies note, Settings, Methods,
 * Took, Made) + the action column (`TxrHistoryActions`, resolved over the
 * DETAIL's facts — the expanded block's capabilities are the loaded
 * record's).
 *
 * Composition rules (the board's own shapes — ITEM-4's composition, the
 * ITEM-3 drift anchor for the per-method duration):
 *
 * - Your files: the recorded file names (mono, ", " in the run's order)
 *   + the copies note — the board's "Copies are kept with this run so it
 *   can be repeated." ONLY when the run keeps copies (`copies.kept`);
 *   a copy-cleared run reads the honest negation "Copies are not kept
 *   with this run." (INV-2: the copies state is stated both ways — the
 *   provider plan's own "copies are not kept" words, never a silent
 *   absence);
 * - Settings: the board's comma line with each segment OMITTED when its
 *   fact is absent (the detail's `settings` is optional on cpus/seed/
 *   memory — never a fabricated number, INV-6): "landmark 56, horizon
 *   238, covariates on, seed 1, 4 CPUs, 16 GB";
 * - Methods: "<label> <version> (<duration>)" per method row, joined
 *   ", " — the method id mono (the catalogue id), the version + duration
 *   plain; the duration is `formatMethodDuration` (the board's compact
 *   "(2 min)" — DEC-9's recorded divergence from the word form), omitted
 *   with the parenthetical when the row recorded no duration;
 * - Took: the lib's `tookLine` (the word form + the estimate
 *   parenthetical); the row renders only when the run recorded a took
 *   figure (never a fabricated zero);
 * - Made: "N models" + the named set links + "and the predictions of
 *   both" per the board's two-model shape — the parenthetical lists the
 *   named saved sets as links (DEC-5, `txr-history-model-set-<setId>`;
 *   the page binds `modelsPath(setId)` at ITEM-5) and reads "and one
 *   more" for the models beyond the named sets; the sentence's "and the
 *   predictions of both" renders only for the board's two-produced-model
 *   shape with recorded predictions (never a false "both"); a run that
 *   made no models omits the row entirely.
 *
 * The block is reported, never executed: every control's click reports
 * the run/set id; the page owns the store calls and the builder
 * navigations.
 */
import type { CSSProperties } from 'react'
import type { TxrHistoryDetail, TxrHistoryModelsMade } from '@/api-client/types'
import { Button } from '@txresbench/kit'
import { tookLine } from '../lib/format'
import { modelLinks, type TxrModelSetLink } from '../lib/title'
import { TxrHistoryActions } from './TxrHistoryActions'

/** The expanded block's wrap layout + tint (the board's 28 px gap). */
const BLOCK: CSSProperties = {
  borderTop: '1px solid var(--txr-border-subtle)',
  padding: '14px 18px 16px',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 28,
  background: 'var(--txr-bg)',
  borderRadius: '0 0 8px 8px',
}

/** The dl grid (the board's 140 px label column). */
const DL: CSSProperties = {
  margin: 0,
  flex: '1 1 380px',
  display: 'grid',
  gridTemplateColumns: '140px minmax(0, 1fr)',
  gap: '4px 12px',
  fontSize: 14,
  alignContent: 'start',
}

const DT: CSSProperties = { color: 'var(--txr-muted)' }

const DD: CSSProperties = { margin: 0, minWidth: 0 }

/** The mono segments (the board's file names + method ids). */
const MONO: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12.5,
  wordBreak: 'break-word',
}

/** The copies note's quiet line. */
const NOTE: CSSProperties = { fontSize: 12.5, color: 'var(--txr-muted)', marginTop: 2 }

/** The in-line link look (the board's 14 px link inside the sentence). */
const LINK_INLINE: CSSProperties = { fontSize: 14, fontWeight: 400, padding: 0, height: 'auto' }

/** The board's kept-copies promise (verbatim). */
const COPIES_KEPT_NOTE = 'Copies are kept with this run so it can be repeated.'

/** The copy-cleared run's honest statement (INV-2 — the promised state is
 *  stated both ways; the provider plan's own "copies are not kept" words). */
const COPIES_CLEARED_NOTE = 'Copies are not kept with this run.'

/**
 * A method duration in the board's compact row words: a whole number of
 * minutes; anything under a minute reads the K word family's shortest
 * form ("under a minute" — never a zero-minute figure); null for a row
 * that recorded no duration — the parenthetical omits, never a
 * fabricated figure.
 */
export function formatMethodDuration(secs: number | null | undefined): string | null {
  if (secs === undefined || secs === null || !Number.isFinite(secs) || secs < 0) return null
  if (secs < 60) return 'under a minute'
  const minutes = Math.round(secs / 60)
  return `${minutes} min`
}

/**
 * The Settings line: the board's comma sentence, each segment omitted
 * when its fact is absent (optional facts never fabricated). The absent
 * tests are `!= null` — the provider's `Option` fields serialize their
 * absent value as JSON `null`, while the generated types render them
 * optional-only (the RES-01 null-vs-undefined rule; an absent
 * `seed`/`cpus` must OMIT the segment, never print "seed null" /
 * "null CPUs").
 *
 * The host-memory segment is GONE (qa-fixes2 R2-09): the record's
 * `memory_total_bytes` is the MACHINE's RAM read at run start (DEC-12's
 * display-only fact) — a "3 TB" settings line next to the run's own
 * settings is a nonsense fact, and the API config carries no memory
 * field. A run setting it never was; the board's "16 GB" example is a
 * design byte, not a contract.
 */
export function settingsLine(settings: TxrHistoryDetail['settings']): string {
  const segments: string[] = [
    `landmark ${settings.decision_day}`,
    `horizon ${settings.look_ahead_day}`,
    `covariates ${settings.covariates ? 'on' : 'off'}`,
  ]
  if (settings.seed != null) segments.push(`seed ${settings.seed}`)
  if (settings.cpus != null) {
    segments.push(`${settings.cpus} ${settings.cpus === 1 ? 'CPU' : 'CPUs'}`)
  }
  return segments.join(', ')
}

/** One method's row words (the mono id + version + the compact duration). */
export function methodRow(row: TxrHistoryDetail['methods'][number]): string {
  const duration = formatMethodDuration(row.elapsed_secs)
  return `${row.label} ${row.version}${duration !== null ? ` (${duration})` : ''}`
}

/** The Made line's facts (the board's "N models (…)" shape). */
export interface TxrMadeFacts {
  /** The produced-model count (the row's "N models"). */
  count: number
  /** The named saved sets (links — a blank name is dropped, never fabricated). */
  named: TxrModelSetLink[]
  /** The produced models beyond the named sets' counts ("and one more"). */
  remainder: number
  /** Whether the run recorded predictions ("and the predictions of both"). */
  hasPredictions: boolean
}

/**
 * The Made row's facts. `null` when the run made no models — the row
 * omits (a run that produced nothing shows no row; the results entry
 * gate's honesty).
 */
export function madeFactsOf(detail: TxrHistoryDetail): TxrMadeFacts | null {
  if (detail.models_made.produced <= 0) return null
  const named = modelLinks(detail.models_made.saved_sets)
  const namedCount = named.reduce<number>((sum, link) => {
    const count = setCountOf(detail.models_made, link.setId)
    return sum + (count ?? 0)
  }, 0)
  const remainder = Math.max(0, detail.models_made.produced - namedCount)
  return {
    count: detail.models_made.produced,
    named,
    remainder,
    hasPredictions: (detail.predicted ?? 0) > 0,
  }
}

/** A named set's recorded model count (0 when the record lacks one). */
function setCountOf(models: TxrHistoryModelsMade, setId: string): number | null {
  for (const set of models.saved_sets) {
    if (set.set_id === setId) return set.model_count
  }
  return null
}

/** The board's "and the predictions of both" tail (the two-model shape).
 *
 * The board's sentence reads "both" for its two models; with any other
 * produced count a "both" would be a false word, so the tail renders
 * only at the board's exact shape (recorded in the item's drift ledger —
 * the plan's "when produced and predictions" reads as the board's
 * case). */
export function madeTail(facts: TxrMadeFacts): string {
  if (facts.count === 2 && facts.hasPredictions) return ' and the predictions of both'
  return ''
}

export interface TxrHistoryDetailBlockProps {
  /** The expanded run's detail (the store's `detail` of `expandedId`). */
  detail: TxrHistoryDetail
  isDesktop: boolean
  onOpenResults?: (runId: string) => void
  onOpenRunning?: (runId: string) => void
  onRerun?: (runId: string) => void
  onSettingsAgain?: (runId: string) => void
  onDownload?: (runId: string) => void
  onReveal?: (runId: string) => void
  onLog?: (runId: string) => void
  /** A named set link clicked (the page navigates `modelsPath(setId)`). */
  onOpenSet?: (setId: string) => void
  /** "Delete this run" clicked (qa-fixes4 ITEM-2 (f) — desktop-gated). */
  onDelete?: (runId: string) => void
}

export function TxrHistoryDetailBlock({
  detail,
  isDesktop,
  onOpenResults,
  onOpenRunning,
  onRerun,
  onSettingsAgain,
  onDownload,
  onReveal,
  onLog,
  onOpenSet,
  onDelete,
}: TxrHistoryDetailBlockProps) {
  const filesText = detail.file_names.join(', ')
  const copiesNote = detail.copies.kept ? COPIES_KEPT_NOTE : COPIES_CLEARED_NOTE
  const methodsText = detail.methods.map(methodRow).join(', ')
  const took = tookLine(detail.elapsed_secs, detail.use_estimate?.total_seconds)
  const made = madeFactsOf(detail)
  return (
    <div data-testid={`txr-history-detail-${detail.id}`} style={BLOCK}>
      <dl style={DL}>
        <dt style={DT}>Your files</dt>
        <dd style={DD}>
          {filesText.length > 0 ? <span style={MONO}>{filesText}</span> : null}
          <div style={NOTE}>{copiesNote}</div>
        </dd>
        <dt style={DT}>Settings</dt>
        <dd style={DD}>{settingsLine(detail.settings)}</dd>
        <dt style={DT}>Methods</dt>
        <dd style={DD}>
          {detail.methods.length > 0 ? <span style={MONO}>{methodsText}</span> : null}
        </dd>
        {took !== null ? (
          <>
            <dt style={DT}>Took</dt>
            <dd style={DD}>{took}</dd>
          </>
        ) : null}
        {made !== null ? (
          <>
            <dt style={DT}>Made</dt>
            <dd style={DD}>
              {made.count} {made.count === 1 ? 'model' : 'models'}
              {made.named.length > 0 ? ' (' : null}
              {made.named.map((link, index) => (
                <span key={link.setId}>
                  {index > 0 ? ', ' : null}
                  <Button
                    data-testid={`txr-history-model-set-${link.setId}`}
                    variant="link"
                    className="txr-history-model-set"
                    style={LINK_INLINE}
                    onClick={() => onOpenSet?.(link.setId)}
                  >
                    {link.setName}
                  </Button>
                </span>
              ))}
              {made.named.length > 0 && made.remainder > 0 ? ' and one more' : null}
              {made.named.length > 0 ? ')' : null}
              {madeTail(made)}
            </dd>
          </>
        ) : null}
      </dl>
      <TxrHistoryActions
        item={detail}
        runId={detail.id}
        isDesktop={isDesktop}
        onOpenResults={onOpenResults}
        onOpenRunning={onOpenRunning}
        onRerun={onRerun}
        onSettingsAgain={onSettingsAgain}
        onDownload={onDownload}
        onReveal={onReveal}
        onLog={onLog}
        onDelete={onDelete}
      />
    </div>
  )
}
