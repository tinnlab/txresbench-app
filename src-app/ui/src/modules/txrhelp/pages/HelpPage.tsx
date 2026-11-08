/**
 * HelpPage — the TxResBench Help screen (`/help`, the content page the
 * txrshell scaffold used to render): a table of contents and
 * one section per authored block, driven entirely by the typed content in
 * `content.ts` (the renderer has no prose of its own). Anchors: each
 * section's `id`, and each problem-code entry's `anchor` (the deep links
 * the intake problem lists bind).
 *
 * Theming: the page uses the kit token layer's CSS variables
 * (`--background`, `--foreground`, `--muted-foreground`, `--border`,
 * `--primary`, `--muted`, `--card`, `--destructive`, `--warning`) so it
 * renders correctly in light and dark without a page-local palette —
 * deliberate for this content screen (the file/analysis screens keep the
 * boards' fixed palettes; long help text must be readable on either
 * theme).
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { HELP_SECTIONS, PROBLEM_HELP } from '../content'
import { helpPath } from '../routes'

const PAGE: CSSProperties = {
  flexGrow: 1,
  padding: '32px 24px 64px',
  background: 'var(--background)',
  color: 'var(--foreground)',
  fontFamily: "'Source Sans 3', system-ui, sans-serif",
  fontSize: 15,
  lineHeight: 1.5,
}
const PAGE_INNER: CSSProperties = { maxWidth: 1020, margin: '0 auto' }
const EYEBROW: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--primary)',
}
const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}
const SUBTITLE: CSSProperties = { margin: '0 0 26px', color: 'var(--muted-foreground)', fontSize: 15 }

/** The TOC + body two-column layout (wraps below 960 px). */
const LAYOUT: CSSProperties = {
  display: 'flex',
  gap: 36,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
}
const TOC: CSSProperties = {
  width: 220,
  flexGrow: 0,
  flexShrink: 0,
  position: 'sticky',
  top: 24,
  alignSelf: 'flex-start',
}
const TOC_TITLE: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--muted-foreground)',
}
const TOC_LIST: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  margin: 0,
  padding: 0,
  listStyle: 'none',
}
const TOC_LINK: CSSProperties = {
  display: 'block',
  padding: '5px 8px',
  borderRadius: 6,
  fontSize: 13.5,
  color: 'var(--foreground)',
  textDecorationColor: 'var(--muted-foreground)',
  textUnderlineOffset: 3,
}
const CONTENT: CSSProperties = { flexGrow: 1, minWidth: 0, maxWidth: '100%' }
const SECTION_HEADING: CSSProperties = {
  margin: '0 0 10px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 22,
  lineHeight: 1.25,
}

/** One section: heading + its authored blocks (+ optional children content). */
function Section({
  section,
  children,
}: {
  section: (typeof HELP_SECTIONS)[number]
  children?: ReactNode
}) {
  return (
    <section
      id={section.id}
      data-testid={`txr-help-section-${section.id}`}
      style={{ scrollMarginTop: 16, marginBottom: 42 }}
    >
      <h2 style={SECTION_HEADING}>{section.title}</h2>
      {section.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
      {children}
    </section>
  )
}

/** One authored block (the closed HelpBlock union — no fallback arm). */
function Block({ block }: { block: (typeof HELP_SECTIONS)[number]['blocks'][number] }) {
  switch (block.kind) {
    case 'paragraph':
      return <p style={{ margin: '0 0 12px', maxWidth: '74ch' }}>{block.text}</p>
    case 'caption':
      return <p style={{ margin: '16px 0 4px', fontWeight: 700, fontSize: 13.5 }}>{block.text}</p>
    case 'bullets':
      return (
        <ul style={{ margin: '0 0 12px', paddingLeft: 20, maxWidth: '74ch' }}>
          {block.items.map((item, index) => (
            <li key={index} style={{ marginBottom: 4 }}>
              {item}
            </li>
          ))}
        </ul>
      )
    case 'steps':
      return (
        <ol style={{ margin: '0 0 12px', paddingLeft: 20, maxWidth: '74ch' }}>
          {block.items.map((item, index) => (
            <li key={index} style={{ marginBottom: 6 }}>
              {item}
            </li>
          ))}
        </ol>
      )
    case 'table':
      return (
        <div style={{ overflowX: 'auto', maxWidth: '100%', marginBottom: 8 }}>
          <table
            style={{
              borderCollapse: 'collapse',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 13.5,
              minWidth: 560,
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
                      background: 'var(--muted)',
                      borderBottom: '1px solid var(--border)',
                      fontWeight: 700,
                      color: 'var(--foreground)',
                    }}
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((entry, col) => (
                    <td
                      key={col}
                      style={{
                        padding: '5px 12px',
                        borderBottom: '1px solid var(--border)',
                        verticalAlign: 'top',
                        color: col === 0 ? 'var(--primary)' : 'var(--foreground)',
                        fontFamily: col === 0 ? "'Source Code Pro', monospace" : undefined,
                        fontSize: col === 0 ? 12.5 : 13.5,
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
    case 'note':
      return (
        <p
          style={{
            margin: '0 0 12px',
            maxWidth: '74ch',
            padding: '10px 14px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--card)',
            fontSize: 13.5,
          }}
        >
          {block.text}
        </p>
      )
  }
}

/** One problem-code entry (the troubleshooting list; anchor per code). */
function ProblemEntry({ entry }: { entry: (typeof PROBLEM_HELP)[number] }) {
  const badge =
    entry.level === 'error'
      ? 'var(--destructive)'
      : entry.level === 'warning'
        ? 'var(--warning)'
        : 'var(--muted-foreground)'
  return (
    <div
      id={entry.anchor}
      data-testid={`txr-help-problem-${entry.anchor}`}
      style={{
        scrollMarginTop: 16,
        borderLeft: `3px solid ${badge}`,
        padding: '2px 0 2px 12px',
        margin: '0 0 20px',
      }}
    >
      <h3 style={{ margin: '0 0 4px', fontSize: 15.5, fontWeight: 700 }}>
        {entry.title}
        {entry.level === 'never' ? (
          <span
            style={{
              marginLeft: 8,
              fontSize: 11.5,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--muted-foreground)',
            }}
          >
            not reported by the app
          </span>
        ) : null}
      </h3>
      <p
        style={{
          margin: '0 0 6px',
          maxWidth: '74ch',
          color: 'var(--muted-foreground)',
          fontSize: 14,
        }}
      >
        {entry.meaning}
      </p>
      <p style={{ margin: 0, maxWidth: '74ch', fontSize: 14 }}>
        <strong style={{ fontWeight: 700 }}>What to do: </strong>
        {entry.action}
      </p>
    </div>
  )
}

/** The page shell: eyebrow + title + subtitle, then TOC + sections. */
export function HelpPage() {
  const location = useLocation()
  useEffect(() => {
    const hash = location.hash.replace(/^#/, '')
    if (hash.length > 0) {
      // The deep link (the intake problems list) scrolls its entry into
      // view on arrival and on hash change; a missing target is a code
      // bug, never a silent dead link — the tests assert every anchor.
      document.getElementById(hash)?.scrollIntoView({ block: 'start' })
    }
  }, [location.hash])
  return (
    <main style={PAGE} data-testid="txr-help">
      <div style={PAGE_INNER}>
        <div style={EYEBROW}>TxResBench</div>
        <h1 style={TITLE}>Help</h1>
        <p style={SUBTITLE}>
          How TxResBench works, what each screen does, and what to do when a file is flagged.
        </p>
        <div style={LAYOUT}>
          <nav style={TOC} aria-label="On this page">
            <p style={TOC_TITLE}>On this page</p>
            <ul style={TOC_LIST}>
              {HELP_SECTIONS.map(section => (
                <li key={section.id}>
                  <Link
                    to={helpPath(section.id)}
                    data-testid={`txr-help-toc-${section.id}`}
                    style={TOC_LINK}
                  >
                    {section.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div style={CONTENT}>
            {HELP_SECTIONS.map(section =>
              section.id === 'troubleshooting' ? (
                <Section key={section.id} section={section}>
                  {PROBLEM_HELP.map(entry => (
                    <ProblemEntry key={entry.code} entry={entry} />
                  ))}
                </Section>
              ) : (
                <Section key={section.id} section={section} />
              ),
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
