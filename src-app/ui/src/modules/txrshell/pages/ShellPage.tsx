/**
 * The four shell pages of the strip build: route + shell only. The analysis
 * screens (upload, configuration, run, results) are the next build step.
 */
export function ShellPage({ title }: { title: string }) {
  return (
    <div style={{ padding: '32px 36px', flexGrow: 1 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#1d4e89',
        }}
      >
        TxResBench
      </div>
      <h1
        style={{
          margin: '2px 0 6px',
          fontFamily: "'Source Serif 4', Georgia, serif",
          fontWeight: 600,
          fontSize: 28,
          lineHeight: 1.2,
        }}
      >
        {title}
      </h1>
    </div>
  )
}
