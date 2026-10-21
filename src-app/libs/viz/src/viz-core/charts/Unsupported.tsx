// Unsupported.tsx — the visible, non-crashing fallback for a cell whose `kind` has no
// registered chart View. Extracted to its own module so BOTH the render path
// (`CellView.ChartBody`, on a registry miss) and the built-in adapters (scatter / image /
// grid, which have no ChartBody renderer) share ONE source of truth — byte-identical to
// the fallback the old `switch (cell.kind)` produced.

/** Visible, non-crashing fallback for a kind with no chart renderer. */
export function Unsupported({ kind }: { kind: string }) {
  return (
    <div
      data-testid="viz-cell-unsupported"
      style={{
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        font: '12px system-ui, sans-serif',
        opacity: 0.7,
      }}
    >
      unsupported kind: {kind}
    </div>
  )
}
