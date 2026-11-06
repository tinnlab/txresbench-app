/**
 * TxrAboutDialog — the E screen's method "About" card (ITEM-8,
 * PROV-UI-RUN-4, CONS-UI-RUN-5).
 *
 * Every row of the shared list carries an "About" slot; the host's dialog
 * opens the method's catalogue card — the facts are the catalogue's OWN
 * payload (`ApiClient.MethodCatalogue.detail` through `useMethodDetail`,
 * the ITEM-4 hook): the description lead, then the record's software,
 * licence, references, parameters, timing and performance facts via kit
 * `Descriptions`. Nothing is rebuilt here — the method card is a bounded
 * read of the provider's data (the factor to remember: a catalogue payload's
 * NUMBER facts — the benchmarked seconds, the c-index — are the method's own
 * facts; the formatters only shape them).
 *
 * States (TEST-RUN-16, all never-blank):
 *
 * - loading — the skeleton;
 * - `404 METHOD_NOT_FOUND` — the module's `METHOD_NOT_FOUND_LINE` (the
 *   constant the ITEM-4 hook ships; a method a stale row still points at is
 *   never a blank card);
 * - any other failure — the error line + Retry (the hook's own retry);
 * - a detail — the card facts.
 *
 * The dialog is controlled by `methodId` (null = closed, the hook's own
 * null-id rule: no request, no stale detail); Escape/backdrop close through
 * the kit Dialog's `onOpenChange`. The test-id convention is the module's
 * `txr-run-about-<method_id>`.
 */
import type { CSSProperties, ReactNode } from 'react'
import { Button, Descriptions, Dialog, Skeleton, type DescriptionsItem } from '@ziee/kit'
import type { Method, Performance, Software, Timing } from '@/api-client/types'
import { formatDurationShort } from '@/modules/txrlist'
import { METHOD_NOT_FOUND_LINE, useMethodDetail } from '../data/useMethodDetail'

/** The unknown-fact constant (the framework's unknown-span convention). */
const UNKNOWN = '—'

/** The lead paragraph's look (the board's muted body text). */
const LEAD: CSSProperties = {
  margin: '0 0 4px',
  fontSize: 13.5,
  lineHeight: 1.5,
  color: '#3a3a3a',
}

/** The multi-line value blocks (references / parameters). */
const BLOCK: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: '#3a3a3a',
}

/** The single-line values' look. */
const VALUE: CSSProperties = { fontSize: 12.5, color: '#3a3a3a' }

/** The error line's look (the dialog's own muted red). */
const ERROR_LINE: CSSProperties = { fontSize: 13.5, color: '#b3261e' }

/** The module's own fallback for a load failure (never a blank card). */
const ABOUT_ERROR_LINE = 'The method details could not be loaded.'

/** The software fact: the language + the package names it resolves to. */
function softwareText(software: Software): string {
  if (software.packages === null || typeof software.packages !== 'object') {
    return software.language
  }
  const names = Object.keys(software.packages as Record<string, unknown>)
  return names.length === 0 ? software.language : `${software.language} — ${names.join(', ')}`
}

/** The references list, one per line (never blank). */
function referencesText(references: string[]): ReactNode {
  if (references.length === 0) return UNKNOWN
  return <pre style={BLOCK}>{references.join('\n')}</pre>
}

/** The parameters fact: the record's structured params, pretty-printed. */
function paramsText(params: unknown): ReactNode {
  if (params === null || params === undefined) return UNKNOWN
  if (typeof params === 'object') return <pre style={BLOCK}>{JSON.stringify(params, null, 2)}</pre>
  return <span style={VALUE}>{String(params)}</span>
}

/** The timing fact: the benchmarked seconds per fold, shaped by the
 *  provider's own short-duration formatter — never a local format. */
function timingText(timing: Timing): string {
  return `${formatDurationShort(timing.base_seconds_per_fold)} per fold · ${timing.benchmarked_units} benchmark units`
}

/** The performance fact (present only when the benchmark evaluated it). */
function performanceText(performance: Performance): string {
  return `median c-index ${performance.c_index_median.toFixed(2)} · ${performance.n_datasets} benchmark sets · ${performance.n_units} units`
}

/** The card's fact rows: the plan's six record facts. */
function factsOf(method: Method): DescriptionsItem[] {
  const items: DescriptionsItem[] = [
    { key: 'software', label: 'Software', children: <span style={VALUE}>{softwareText(method.software)}</span> },
    { key: 'licence', label: 'Licence', children: <span style={VALUE}>{method.licence || UNKNOWN}</span> },
    { key: 'references', label: 'References', children: referencesText(method.references) },
    { key: 'params', label: 'Parameters', children: paramsText(method.params) },
    { key: 'timing', label: 'Timing', children: <span style={VALUE}>{timingText(method.timing)}</span> },
  ]
  if (method.performance !== undefined) {
    items.push({
      key: 'performance',
      label: 'Performance',
      children: <span style={VALUE}>{performanceText(method.performance)}</span>,
    })
  }
  return items
}

/** The loading skin's rows (the record card's place, never a blank flash). */
const SKELETON_ROWS = 3

export interface TxrAboutDialogProps {
  /** The method whose card opens; `null` is the closed dialog. */
  methodId: string | null
  /** The close request (Escape / backdrop / the corner ×). */
  onClose: () => void
}

export function TxrAboutDialog({ methodId, onClose }: TxrAboutDialogProps) {
  const { detail, loading, error, retry } = useMethodDetail(methodId)

  return (
    <Dialog
      data-testid={methodId === null ? 'txr-run-about' : `txr-run-about-${methodId}`}
      title={methodId === null ? 'About' : `About ${methodId}`}
      open={methodId !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      size="lg"
    >
      {error === 'not-found' ? (
        <p data-testid="txr-run-about-fallback" style={LEAD}>
          {METHOD_NOT_FOUND_LINE}
        </p>
      ) : error === 'network' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <span data-testid="txr-run-about-error" style={ERROR_LINE}>
            {ABOUT_ERROR_LINE}
          </span>
          <Button data-testid="txr-run-about-retry" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : detail !== null ? (
        <div data-testid="txr-run-about-body">
          <p data-testid="txr-run-about-description" style={LEAD}>
            {detail.description}
          </p>
          <Descriptions
            data-testid="txr-run-about-facts"
            column={1}
            bordered
            size="sm"
            items={factsOf(detail)}
          />
        </div>
      ) : loading ? (
        <div data-testid="txr-run-about-loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Skeleton key={i} style={{ height: 44, borderRadius: 8 }} />
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}
