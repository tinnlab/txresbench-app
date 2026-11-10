/**
 * HelpPage — the TxResBench Help screen (`/help`), rebuilt as product
 * documentation (qa-fixes2 ITEM-3, R2-H1/H2/H3/H4/H5/H6/H8/H9).
 *
 * Layout: desktop (>=1024 px) is a two-column grid — the sticky "On this
 * page" rail (240 px, scrolls independently, the current section
 * highlighted, never overlapping the article) and a content column capped
 * at 760 px (60-75 char lines), the grid centred in the window; under 1024
 * px the rail becomes a "Contents" disclosure at the top (collapsed) and a
 * floating "Back to top". The responsive/print half of the layout lives in
 * `index.css` against the `.txr-help-*` hooks (a media query cannot touch
 * an inline style — the shell header's device, repeated for this page).
 *
 * Top of page: title, one-line purpose, the search box (filters sections
 * and troubleshooting entries, highlights matches, a "no results" state)
 * and the Quick start row of three cards mirroring the Start screen.
 *
 * The content is data (`content.ts` + the committed validator catalogue);
 * this file has no prose of its own and no facts about codes. The status
 * vocabulary renders the SAME chips the app uses on the method list and
 * the running screen — the labels and tones ARE the sibling modules'
 * exported constants (`txrlist`'s three verdicts, `txrrun`'s eight
 * states), so they cannot drift; only the one-line meanings are authored
 * (in `content.ts`).
 *
 * Accessibility: one h1, ordered heading levels, nav/main/search
 * landmarks, a skip link, kit controls (their standard focus-visible ring),
 * smooth scrolling that respects `prefers-reduced-motion`, the document
 * title "Help — TxResBench", and a print stylesheet that hides the rail,
 * the search and the back-to-top control.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Button, Input, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ziee/kit'
import { FiAlertTriangle, FiArrowUp, FiCheckCircle, FiInfo } from 'react-icons/fi'
import { ApiClient } from '@/api-client'
import type { FileTableKind } from '@/api-client/types'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { STATE_LABEL, STATE_TONE } from '@/modules/txrrun/lib/format'
import { formatRunHeadline } from '@/modules/txrlist/lib/format'
import { TXRLIST_STATUS_COLORS } from '@/modules/txrlist/components/TxrListRow'
import {
  ELIGIBILITY_STATUSES,
  HELP_SECTIONS,
  PROBLEM_GROUPS,
  PROBLEM_HELP,
  PROBLEM_HELP_BY_CODE,
  QUICK_START,
  RUN_STATE_MEANINGS,
  problemGroupOf,
} from '../content'
import { helpPath } from '../routes'
import type { FileCardContent, HelpBlock, HelpProblemEntry, ProblemGroup, StepCard } from '../types'

/** The page shell (the app's own palette — R2-H6: the kit token layer's
 *  near-black dark background is NOT the app's page colour). */
const PAGE: CSSProperties = {
  flexGrow: 1,
  padding: '24px 24px 56px',
  background: 'var(--txr-surface)',
  color: 'var(--txr-text)',
  fontFamily: "'Source Sans 3', system-ui, sans-serif",
  fontSize: 14.5,
  lineHeight: 1.45,
}
const PAGE_INNER: CSSProperties = { maxWidth: 1096, margin: '0 auto' }

const EYEBROW: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-brand)',
}
const TITLE: CSSProperties = {
  margin: '2px 0 4px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 30,
  lineHeight: 1.2,
}
const PURPOSE: CSSProperties = { margin: '0 0 14px', color: 'var(--txr-text-2)', maxWidth: '62ch' }

/** The one shared card look (the Start screen's cards). */
const CARD: CSSProperties = {
  boxSizing: 'border-box',
  borderRadius: 12,
  background: 'var(--txr-surface)',
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Smooth scrolling that respects reduced motion (the page's one scroll
 *  behaviour; the CSS `scroll-behavior` is deliberately NOT set globally). */
function scrollToElement(el: HTMLElement): void {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
}

/** The rail exists from 1024 px up (the `.txr-help-*` media rules in
 *  index.css). It is rendered CONDITIONALLY — a CSS-hidden rail would still
 *  be in the DOM, focusable and in the accessibility tree, on phones. */
const RAIL_BREAKPOINT = '(min-width: 1024px)'

function useRailVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof window === 'undefined' || !window.matchMedia
      ? true
      : window.matchMedia(RAIL_BREAKPOINT).matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(RAIL_BREAKPOINT)
    const onChange = () => setVisible(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return visible
}

/** The element that actually scrolls the help page: the nearest ancestor
 *  that is genuinely scrollable (an `auto|scroll|hidden` overflow AND a
 *  scrollable size — an `overflow: visible` element reports a tall
 *  scrollHeight without being able to scroll), falling back to the document.
 *  The back-to-top control, its visibility and the section highlight all use
 *  THIS element — in the app shell the pane scrolls, not the window. */
function isScrollable(el: Element): boolean {
  const ov = getComputedStyle(el).overflowY
  return (ov === 'auto' || ov === 'scroll' || ov === 'hidden') && el.scrollHeight - el.clientHeight > 1
}

function helpScroller(from: Element): Element {
  let node: Element | null = from
  while (node !== null) {
    if (isScrollable(node)) return node
    node = node.parentElement
  }
  return document.scrollingElement ?? document.documentElement
}

/** Highlight the query matches inside a text (the search's highlighter). */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (q.length === 0) return <>{text}</>
  const index = text.toLowerCase().indexOf(q.toLowerCase())
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark style={{ background: 'var(--txr-warning)', color: 'var(--txr-text)' }}>
        {text.slice(index, index + q.length)}
      </mark>
      {text.slice(index + q.length)}
    </>
  )
}

/** The page's one paragraph style (the measured 60-75 char line length). */
const PARAGRAPH: CSSProperties = { margin: '0 0 12px' }
/** The one bullet list style (visible markers, the board's dots). */
const BULLETS: CSSProperties = { margin: '0 0 12px', paddingLeft: 20, listStyle: 'disc' }
const BULLET: CSSProperties = { margin: '3px 0' }

// ─────────────────────────────────────────────────────────────────────────────
// Block kinds
// ─────────────────────────────────────────────────────────────────────────────

/** The pill shape (statuses, required/optional, screen chips). */
const PILL: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  padding: '2px 9px',
  borderRadius: 999,
  whiteSpace: 'nowrap',
}

/** One callout — Tip / Note / Watch out with an icon, a left accent bar and
 *  a tinted background that works in light and dark. */
const CALLOUT_TONES = {
  tip: {
    background: 'var(--txr-success-soft)',
    border: '1px solid var(--txr-success-border)',
    color: 'var(--txr-success-ink)',
    icon: <FiCheckCircle aria-hidden />,
    label: 'Tip',
  },
  note: {
    background: 'var(--txr-accent-soft)',
    border: '1px solid var(--txr-border-subtle)',
    color: 'var(--txr-brand-ink)',
    icon: <FiInfo aria-hidden />,
    label: 'Note',
  },
  watch: {
    background: 'var(--txr-danger-soft)',
    border: '1px solid var(--txr-danger-border)',
    color: 'var(--txr-danger)',
    icon: <FiAlertTriangle aria-hidden />,
    label: 'Watch out',
  },
} as const

function Callout({ tone, text, query }: { tone: 'tip' | 'note' | 'watch'; text: string; query: string }) {
  const t = CALLOUT_TONES[tone]
  return (
    <div
      role="note"
      data-testid={`txr-help-callout-${tone}`}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        margin: '0 0 10px',
        padding: '8px 12px',
        border: t.border,
        borderLeft: `3px solid ${t.color}`,
        borderRadius: 8,
        background: t.background,
        color: t.color,
        fontSize: 13.5,
      }}
    >
      <span style={{ fontSize: 16, lineHeight: '1.2', marginTop: 1 }}>{t.icon}</span>
      <p style={{ margin: 0 }}>
        <strong style={{ fontWeight: 700 }}>{t.label}: </strong>
        <Highlight text={text} query={query} />
      </p>
    </div>
  )
}

/** One column table with a sticky header, zebra rows, mono name chips and
 *  required/optional pills; scrolls inside its own box when wider (the
 *  browser tier asserts both). */
function ColumnTable({ card, query }: { card: FileCardContent; query: string }) {
  return (
    <div
      data-testid={`txr-help-filetable-${card.file}`}
      tabIndex={0}
      aria-label={`${card.title} column table`}
      style={{ overflowX: 'auto', maxWidth: '100%', marginBottom: 10, borderRadius: 8 }}
    >
      <table
        style={{
          borderCollapse: 'collapse',
          border: '1px solid var(--txr-border)',
          fontSize: 13,
          minWidth: 560,
          width: '100%',
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                position: 'sticky',
                top: 0,
                textAlign: 'left',
                padding: '6px 12px',
                background: 'var(--txr-surface-dim)',
                borderBottom: '1px solid var(--txr-border)',
                fontWeight: 700,
                color: 'var(--txr-text)',
                fontSize: 12.5,
              }}
            >
              Column
            </th>
            <th
              style={{
                textAlign: 'left',
                padding: '6px 12px',
                background: 'var(--txr-surface-dim)',
                borderBottom: '1px solid var(--txr-border)',
                fontWeight: 700,
                color: 'var(--txr-text)',
                fontSize: 12.5,
              }}
            >
              Needed
            </th>
            <th
              style={{
                textAlign: 'left',
                padding: '6px 12px',
                background: 'var(--txr-surface-dim)',
                borderBottom: '1px solid var(--txr-border)',
                fontWeight: 700,
                color: 'var(--txr-text)',
                fontSize: 12.5,
              }}
            >
              Meaning
            </th>
            <th
              style={{
                textAlign: 'left',
                padding: '6px 12px',
                background: 'var(--txr-surface-dim)',
                borderBottom: '1px solid var(--txr-border)',
                fontWeight: 700,
                color: 'var(--txr-text)',
                fontSize: 12.5,
              }}
            >
              Example
            </th>
          </tr>
        </thead>
        <tbody>
          {card.columns.map((column, index) => (
            <tr
              key={column.name}
              style={{
                background: index % 2 === 1 ? 'var(--txr-surface-dim)' : 'transparent',
              }}
            >
              <td
                style={{
                  padding: '4px 12px',
                  borderBottom: '1px solid var(--txr-border-subtle)',
                  fontFamily: "'Source Code Pro', monospace",
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  color: 'var(--txr-brand-ink)',
                }}
              >
                <Highlight text={column.name} query={query} />
              </td>
              <td style={{ padding: '4px 12px', borderBottom: '1px solid var(--txr-border-subtle)' }}>
                <span
                  data-testid={`txr-help-column-${column.name.replace(/[^a-z0-9]+/gi, '-')}-${column.required ? 'required' : 'optional'}`}
                  style={{
                    ...PILL,
                    background: column.required ? 'var(--txr-accent-soft)' : 'var(--txr-bg)',
                    color: column.required ? 'var(--txr-brand-ink)' : 'var(--txr-muted)',
                    border: column.required ? 'none' : '1px solid var(--txr-border-subtle)',
                  }}
                >
                  {column.required ? 'required' : 'optional'}
                </span>
              </td>
              <td style={{ padding: '4px 12px', borderBottom: '1px solid var(--txr-border-subtle)', color: 'var(--txr-text-2)' }}>
                <Highlight text={column.meaning} query={query} />
              </td>
              <td
                style={{
                  padding: '4px 12px',
                  borderBottom: '1px solid var(--txr-border-subtle)',
                  fontFamily: "'Source Code Pro', monospace",
                  fontSize: 12,
                  color: 'var(--txr-muted)',
                }}
              >
                {column.example}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One file card: a one-line summary, the column table, "Copy example
 *  rows" and the template download (the app's own template endpoint). */
function FileCard({ card }: { card: FileCardContent }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyExampleRows = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(card.exampleRows)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }, [card.exampleRows])

  const downloadTemplate = useCallback(async (kind: FileTableKind) => {
    try {
      const body = (await ApiClient.FileValidation.template({ kind })) as unknown as string
      if (typeof body !== 'string' || body.length === 0) {
        throw new Error('empty template body')
      }
      const blob = new Blob([body], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${kind}_template.csv`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setCopyState('idle')
    } catch {
      setCopyState('failed')
    }
  }, [])

  return (
    <section
      data-testid={`txr-help-filecard-${card.file}`}
      style={{
        ...CARD,
        border: '1px solid var(--txr-border)',
        padding: '12px 16px',
        margin: '0 0 12px',
      }}
    >
      <h3 style={{ margin: '0 0 2px', fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 600, fontSize: 16.5 }}>
        {card.title}
      </h3>
      <p style={{ margin: '0 0 12px', color: 'var(--txr-text-2)', fontSize: 13.5 }}>{card.summary}</p>
      <ColumnTable card={card} query="" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Button
          variant="outline"
          data-testid={`txr-help-copy-example-${card.file}`}
          onClick={() => void copyExampleRows()}
        >
          {copyState === 'copied' ? 'Copied' : 'Copy example rows'}
        </Button>
        <Button
          variant="ghost"
          data-testid={`txr-help-download-template-${card.file}`}
          onClick={() => void downloadTemplate(card.file)}
        >
          Download the template (CSV)
        </Button>
        <span role="status" style={{ fontSize: 12.5, color: 'var(--txr-muted)' }}>
          {copyState === 'copied'
            ? 'The first rows are on your clipboard.'
            : copyState === 'failed'
              ? 'Could not copy or download here — use the Files screen.'
              : ''}
        </span>
      </div>
    </section>
  )
}

/** The numbered visual stepper (the four steps): four cards in a row on
 *  desktop, stacked at phone width; details expand under each card. */
function Stepper({ steps, query }: { steps: StepCard[]; query: string }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div
      data-testid="txr-help-stepper"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, margin: '0 0 10px' }}
    >
      {steps.map(step => {
        const expanded = open === step.number
        return (
          <div
            key={step.number}
            data-testid={`txr-help-step-${step.number}`}
            style={{
              ...CARD,
              border: '1px solid var(--txr-border)',
              padding: '14px 14px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                aria-hidden
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--txr-brand)',
                  color: 'var(--txr-on-brand)',
                  fontWeight: 700,
                  fontSize: 15,
                  flexShrink: 0,
                }}
              >
                {step.number}
              </span>
              <h3 style={{ margin: 0, fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 600, fontSize: 16, lineHeight: 1.25 }}>
                <Highlight text={step.name} query={query} />
              </h3>
            </div>
            <p style={{ margin: 0, color: 'var(--txr-text-2)', fontSize: 13 }}>{step.lines[0]}</p>
            <p style={{ margin: 0, color: 'var(--txr-text-2)', fontSize: 13 }}>{step.lines[1]}</p>
            <span
              data-testid={`txr-help-step-screen-${step.number}`}
              style={{
                ...PILL,
                alignSelf: 'flex-start',
                background: 'var(--txr-accent-soft)',
                color: 'var(--txr-brand-ink)',
                fontSize: 11,
              }}
            >
              {step.screen}
            </span>
            <Collapsible
              open={expanded}
              onOpenChange={next => setOpen(next ? step.number : null)}
              style={{ marginTop: 'auto' }}
            >
              <CollapsibleTrigger
                className="txr-help-accordion-trigger"
                data-testid={`txr-help-step-details-${step.number}`}
                style={{ padding: '4px 0', fontSize: 12.5, color: 'var(--txr-brand)' }}
              >
                {expanded ? 'Fewer details' : 'More details'}
              </CollapsibleTrigger>
              <CollapsibleContent style={{ fontSize: 13 }}>
                {step.details.map((block, index) => (
                  <Block key={index} block={block} query={query} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          </div>
        )
      })}
    </div>
  )
}

/** The status vocabulary: the SAME chips the method list and the running
 *  screen use, each with its one-line meaning. */
function Statuses() {
  return (
    <div data-testid="txr-help-statuses" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h3 style={STATUS_GROUP_HEADING}>Can a method or model run on your files?</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ELIGIBILITY_STATUSES.map(item => (
            <div key={item.status} style={STATUS_LINE}>
              <span
                data-testid={`txr-help-status-eligibility-${item.status}`}
                style={{
                  ...PILL,
                  minWidth: 150,
                  textAlign: 'center',
                  border: '1px solid var(--txr-border-subtle)',
                  color: TXRLIST_STATUS_COLORS[item.status],
                  background: 'var(--txr-bg)',
                }}
              >
                {formatRunHeadline(item.status)}
              </span>
              <span style={{ color: 'var(--txr-text-2)', fontSize: 13.5 }}>{item.meaning}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 style={STATUS_GROUP_HEADING}>What a method\'s row says while a run is going</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {RUN_STATE_MEANINGS.map(item => (
            <div key={item.state} style={STATUS_LINE}>
              <span
                data-testid={`txr-help-status-state-${item.state}`}
                style={{
                  ...PILL,
                  minWidth: 150,
                  textAlign: 'center',
                  border: '1px solid var(--txr-border-subtle)',
                  color: STATE_TONE[item.state as keyof typeof STATE_TONE],
                  background: 'var(--txr-bg)',
                }}
              >
                {STATE_LABEL[item.state as keyof typeof STATE_LABEL]}
              </span>
              <span style={{ color: 'var(--txr-text-2)', fontSize: 13.5 }}>{item.meaning}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const STATUS_GROUP_HEADING: CSSProperties = {
  margin: '0 0 8px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 15,
}
const STATUS_LINE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }

/** One authored block (the closed HelpBlock union — no fallback arm). */
function Block({ block, query }: { block: HelpBlock; query: string }) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p style={PARAGRAPH}>
          <Highlight text={block.text} query={query} />
        </p>
      )
    case 'caption':
      return <p style={{ margin: '14px 0 4px', fontWeight: 700, fontSize: 13 }}>{block.text}</p>
    case 'bullets':
      return (
        <ul style={BULLETS}>
          {block.items.map((item, index) => (
            <li key={index} style={BULLET}>
              <Highlight text={item} query={query} />
            </li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div style={{ overflowX: 'auto', maxWidth: '100%', marginBottom: 8 }}>
          <table
            style={{
              borderCollapse: 'collapse',
              border: '1px solid var(--txr-border)',
              borderRadius: 8,
              fontSize: 13,
              minWidth: 480,
            }}
          >
            <thead>
              <tr>
                {block.head.map((head, index) => (
                  <th
                    key={index}
                    style={{
                      textAlign: 'left',
                      padding: '6px 12px',
                      background: 'var(--txr-surface-dim)',
                      borderBottom: '1px solid var(--txr-border)',
                      fontWeight: 700,
                      color: 'var(--txr-text)',
                    }}
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index} style={{ background: index % 2 === 1 ? 'var(--txr-surface-dim)' : 'transparent' }}>
                  {row.map((entry, col) => (
                    <td
                      key={col}
                      style={{
                        padding: '4px 12px',
                        borderBottom: '1px solid var(--txr-border-subtle)',
                        verticalAlign: 'top',
                        color: col === 0 ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
                        fontFamily: col === 0 ? "'Source Code Pro', monospace" : undefined,
                        fontSize: col === 0 ? 12 : 13,
                        whiteSpace: col === 0 ? 'nowrap' : undefined,
                      }}
                    >
                      {entry}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'callout':
      return <Callout tone={block.tone} text={block.text} query={query} />
    case 'stepper':
      return <Stepper steps={block.steps} query={query} />
    case 'fileCard':
      return <FileCard card={block.card} />
    case 'statuses':
      return <Statuses />
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The section + the troubleshooting accordion
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEADING: CSSProperties = {
  margin: '0 0 8px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 21,
  lineHeight: 1.25,
}

function Section({
  section,
  query,
  children,
}: {
  section: (typeof HELP_SECTIONS)[number]
  query: string
  children?: ReactNode
}) {
  return (
    <section
      id={section.id}
      data-testid={`txr-help-section-${section.id}`}
      style={{ scrollMarginTop: 84, marginBottom: 26 }}
    >
      <h2 style={SECTION_HEADING}>
        <Highlight text={section.title} query={query} />
      </h2>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} query={query} />
      ))}
      {children}
    </section>
  )
}

/** One accordion entry: the code chip + the plain title, then "What it
 *  means" / "What to do" in two short lines; anchored `#problem-<code>`. */
function ProblemEntry({
  entry,
  query,
  open,
  onToggle,
}: {
  entry: HelpProblemEntry
  query: string
  open: boolean
  onToggle: (code: string) => void
}) {
  const group = problemGroupOf(entry.code)
  const tone =
    group === 'error'
      ? 'var(--txr-danger)'
      : group === 'warning'
        ? 'var(--txr-warning)'
        : group === 'error_or_warning'
          ? 'var(--txr-warning)'
          : 'var(--txr-muted)'
  return (
    <div
      id={entry.anchor}
      data-testid={`txr-help-problem-${entry.anchor}`}
      style={{ scrollMarginTop: 84, borderLeft: `3px solid ${tone}`, margin: '0 0 6px' }}
    >
      <Collapsible open={open} onOpenChange={() => onToggle(entry.code)}>
        <CollapsibleTrigger
          className="txr-help-accordion-trigger"
          data-testid={`txr-help-accordion-trigger-${entry.code}`}
          style={{ padding: '4px 12px' }}
        >
          <span
            data-testid={`txr-help-code-chip-${entry.code}`}
            style={{
              ...PILL,
              background: 'var(--txr-surface-dim)',
              color: tone,
              border: '1px solid var(--txr-border-subtle)',
              fontFamily: "'Source Code Pro', monospace",
            }}
          >
            {entry.code}
          </span>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            <Highlight text={entry.title} query={query} />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted style={{ padding: '0 12px 12px 12px' }}>
          <p style={{ margin: '0 0 6px', color: 'var(--txr-text-2)', fontSize: 13.5 }}>
            <strong style={{ fontWeight: 700, color: 'var(--txr-text)' }}>What it means: </strong>
            <Highlight text={entry.meaning} query={query} />
          </p>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            <strong style={{ fontWeight: 700, color: 'var(--txr-text)' }}>What to do: </strong>
            <Highlight text={entry.action} query={query} />
          </p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** The troubleshooting accordion: grouped by severity (error, warning,
 *  error-or-warning, not reported) — the groups ARE the catalogue's facts.
 *  The search query narrows the entries; a deep link expands its entry. */
function Troubleshooting({
  query,
  expanded,
  onToggle,
}: {
  query: string
  expanded: ReadonlySet<string>
  onToggle: (code: string) => void
}) {
  const q = query.trim().toLowerCase()
  const visible = PROBLEM_HELP.filter(entry => {
    if (q === '') return true
    return (
      entry.code.toLowerCase().includes(q) ||
      entry.title.toLowerCase().includes(q) ||
      entry.meaning.toLowerCase().includes(q) ||
      entry.action.toLowerCase().includes(q)
    )
  })
  const byGroup = (group: ProblemGroup) => visible.filter(entry => problemGroupOf(entry.code) === group)
  return (
    <div data-testid="txr-help-accordion" style={{ marginTop: 4 }}>
      {PROBLEM_GROUPS.map(({ group, label }) => {
        const entries = byGroup(group)
        if (entries.length === 0) return null
        return (
          <div key={group} style={{ marginBottom: 12 }}>
            <h3 style={STATUS_GROUP_HEADING}>{label}</h3>
            {entries.map(entry => (
              <ProblemEntry
                key={entry.code}
                entry={entry}
                query={query}
                open={expanded.has(entry.code)}
                onToggle={onToggle}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

/** The section text used by the search filter (the block kinds' own words). */
function sectionText(section: (typeof HELP_SECTIONS)[number]): string {
  const texts: string[] = [section.title]
  for (const block of section.blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'caption':
        texts.push(block.text)
        break
      case 'bullets':
        texts.push(...block.items)
        break
      case 'table':
        texts.push(...block.head, ...block.rows.flat())
        break
      case 'callout':
        texts.push(block.text)
        break
      case 'stepper':
        for (const step of block.steps) {
          texts.push(step.name, step.lines[0], step.lines[1], step.screen)
        }
        break
      case 'fileCard':
        texts.push(block.card.title, block.card.summary)
        for (const column of block.card.columns) {
          texts.push(column.name, column.meaning)
        }
        break
      case 'statuses':
        for (const item of ELIGIBILITY_STATUSES) texts.push(item.meaning)
        for (const item of RUN_STATE_MEANINGS) texts.push(item.meaning)
        break
    }
  }
  // The troubleshooting section's searchable words include its entries (the
  // accordion's codes, titles, meanings and actions) — a query like
  // "duplicate rows" must keep the section, and its matched entries.
  if (section.id === 'troubleshooting') {
    for (const entry of PROBLEM_HELP) {
      texts.push(entry.code, entry.title, entry.meaning, entry.action)
    }
  }
  return texts.join('\n').toLowerCase()
}

export function HelpPage() {
  const location = useLocation()
  // The per-route title system (R2-G1) — ITEM-3's local effect is now the
  // shell's one hook: the same "Help — TxResBench" byte, with the previous
  // title restored on unmount like every other route.
  useDocumentTitle('Help')

  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState(HELP_SECTIONS[0].id)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [showBackTop, setShowBackTop] = useState(false)
  const [contentsOpen, setContentsOpen] = useState(false)
  const mainRef = useRef<HTMLElement | null>(null)

  const q = query.trim().toLowerCase()

  const sectionsVisible = useMemo(
    () =>
      q === ''
        ? HELP_SECTIONS
        : HELP_SECTIONS.filter(section => sectionText(section).includes(q)),
    [q],
  )

  const toggleProblem = useCallback((code: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(code)) {
        next.delete(code)
      } else {
        next.add(code)
      }
      return next
    })
  }, [])

  // The deep link (the intake problems list): scroll to the entry below the
  // header, expand it, and keep the rail/section highlight in step. The
  // browser's hash is read as well as the router's: the real app keeps them
  // identical, and the gallery tier surfaces the page inside a MemoryRouter
  // where only the document hash exists (the hash comes in with the URL).
  const [documentHash, setDocumentHash] = useState<string>(() =>
    typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, ''),
  )
  useEffect(() => {
    const onChange = () => setDocumentHash(window.location.hash.replace(/^#/, ''))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  useEffect(() => {
    const hash = location.hash.replace(/^#/, '') || documentHash
    if (hash.length === 0) return
    const target = document.getElementById(hash)
    if (target === null) return
    const code = hash.match(/^problem-(r\d\d|a\d\d)$/)?.[1]?.toUpperCase()
    if (code !== undefined && PROBLEM_HELP_BY_CODE[code] !== undefined) {
      setExpanded(previous => (previous.has(code) ? previous : new Set([...previous, code])))
    }
    setContentsOpen(false)
    // The hash may change while already on the page (a second link click).
    scrollToElement(target)
    const section = target.closest('section')
    if (section !== null) setActiveSection(section.id)
  }, [location.hash, documentHash])

  // The rail's current-section highlight (a scroll listener, rAF-throttled).
  // Captured: inner scroll containers (the app-shell pane, the gallery tier's
  // bounded frame) do not bubble scroll events to the window.
  useEffect(() => {
    const threshold = 120
    let frame: number | null = null
    const update = () => {
      frame = null
      const scroller = mainRef.current !== null ? helpScroller(mainRef.current) : null
      const scrollTop = scroller !== null ? scroller.scrollTop : window.scrollY
      setShowBackTop(scrollTop > 600)
      let current = HELP_SECTIONS[0].id
      for (const section of HELP_SECTIONS) {
        const el = document.getElementById(section.id)
        if (el !== null && el.getBoundingClientRect().top <= threshold) {
          current = section.id
        }
      }
      setActiveSection(current)
    }
    const onScroll = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  const railVisible = useRailVisible()

  const scrollToTop = useCallback(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    const scroller = mainRef.current !== null ? helpScroller(mainRef.current) : null
    if (scroller instanceof HTMLElement) {
      scroller.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    } else {
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    }
  }, [])

  const quickStartVisible = q === '' || QUICK_START.some(card => card.title.toLowerCase().includes(q))

  return (
    <main ref={mainRef} style={PAGE} data-testid="txr-help">
      <a
        href="#txr-help-content"
        className="txr-help-skip-link"
        style={{
          position: 'absolute',
          left: -9999,
          top: 0,
          background: 'var(--txr-brand)',
          color: 'var(--txr-on-brand)',
          padding: '8px 14px',
          borderRadius: 8,
          zIndex: 60,
        }}
      >
        Skip to content
      </a>
      <div style={PAGE_INNER} id="txr-help-content">
        <div style={EYEBROW}>TxResBench</div>
        <h1 style={TITLE}>Help</h1>
        <p data-testid="txr-help-purpose" style={PURPOSE}>
          How TxResBench works, what each screen does, and what to do when a file is flagged.
        </p>

        <form
          role="search"
          className="txr-help-search"
          onSubmit={event => event.preventDefault()}
          style={{ margin: '0 0 14px', maxWidth: 420 }}
        >
          <Input
            data-testid="txr-help-search-input"
            aria-label="Search help"
            placeholder="Search help — try “duplicate rows”"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </form>

        {quickStartVisible ? (
          <div
            data-testid="txr-help-quickstart"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, margin: '0 0 18px' }}
          >
            {QUICK_START.map(card => (
              <section
                key={card.id}
                data-testid={`txr-help-quickstart-${card.id}`}
                style={{
                  ...CARD,
                  border: '1px solid var(--txr-border)',
                  padding: '11px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--txr-muted)' }}>
                  {card.eyebrow}
                </div>
                <h2 style={{ margin: 0, fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 600, fontSize: 16.5, lineHeight: 1.25 }}>
                  {card.title}
                </h2>
                <p style={{ margin: 0, color: 'var(--txr-text-2)', fontSize: 13 }}>{card.text}</p>
                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
                  <span
                    style={{
                      ...PILL,
                      alignSelf: 'flex-start',
                      background: 'var(--txr-accent-soft)',
                      color: 'var(--txr-brand-ink)',
                    }}
                  >
                    {card.screen}
                  </span>
                  <Link to={card.route} data-testid={`txr-help-quickstart-cta-${card.id}`} style={{ color: 'var(--txr-brand)', fontWeight: 600, fontSize: 13.5 }}>
                    {card.cta} →
                  </Link>
                </div>
              </section>
            ))}
          </div>
        ) : null}

        <div className="txr-help-grid">
          {railVisible ? (
            <nav aria-label="On this page" className="txr-help-rail" data-testid="txr-help-rail">
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--txr-muted)' }}>
                On this page
              </p>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: 0, padding: 0, listStyle: 'none' }}>
                {HELP_SECTIONS.map(section => (
                  <li key={section.id}>
                    <Link
                      to={helpPath(section.id)}
                      data-testid={`txr-help-toc-${section.id}`}
                      onClick={() => setContentsOpen(false)}
                      style={{
                        display: 'block',
                        padding: '4px 8px',
                        borderRadius: 6,
                        fontSize: 13,
                        color: activeSection === section.id ? 'var(--txr-brand-ink)' : 'var(--txr-text-2)',
                        fontWeight: activeSection === section.id ? 700 : 400,
                        textDecoration: 'none',
                        background: activeSection === section.id ? 'var(--txr-accent-soft)' : 'transparent',
                      }}
                    >
                      {section.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <div className="txr-help-content-column">
            {!railVisible ? (
              <div className="txr-help-contents-toggle">
                <Collapsible open={contentsOpen} onOpenChange={setContentsOpen}>
                  <CollapsibleTrigger
                    className="txr-help-accordion-trigger"
                    data-testid="txr-help-contents-toggle"
                    style={{ padding: '8px 12px', border: '1px solid var(--txr-border)', borderRadius: 8, background: 'var(--txr-surface-dim)' }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13.5 }}>Contents</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: '6px 0 0', padding: '6px 8px', listStyle: 'none', border: '1px solid var(--txr-border)', borderRadius: 8, background: 'var(--txr-surface)' }}>
                      {HELP_SECTIONS.map(section => (
                        <li key={section.id}>
                          <Link
                            to={helpPath(section.id)}
                            data-testid={`txr-help-contents-link-${section.id}`}
                            onClick={() => setContentsOpen(false)}
                            style={{ display: 'block', padding: '4px 8px', borderRadius: 6, fontSize: 13, color: 'var(--txr-text-2)', textDecoration: 'none' }}
                          >
                            {section.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            ) : null}

            {sectionsVisible.map(section =>
              section.id === 'troubleshooting' ? (
                <Section key={section.id} section={section} query={query}>
                  <Troubleshooting query={query} expanded={expanded} onToggle={toggleProblem} />
                </Section>
              ) : (
                <Section key={section.id} section={section} query={query} />
              ),
            )}

            {sectionsVisible.length === 0 ? (
              <div
                data-testid="txr-help-no-results"
                style={{
                  padding: '18px 16px',
                  border: '1px dashed var(--txr-border)',
                  borderRadius: 10,
                  background: 'var(--txr-bg)',
                  color: 'var(--txr-text-2)',
                }}
              >
                No match for “{query}” in the Help pages.{' '}
                <Button variant="link" data-testid="txr-help-clear-search" onClick={() => setQuery('')}>
                  Clear the search
                </Button>
                . Try a problem code such as R07, or a word like “duplicate”.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {showBackTop ? (
        <Button
          variant="secondary"
          className="txr-help-backtop"
          data-testid="txr-help-backtop"
          aria-label="Back to top"
          onClick={scrollToTop}
          style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 50 }}
        >
          <FiArrowUp aria-hidden /> Top
        </Button>
      ) : null}
    </main>
  )
}
