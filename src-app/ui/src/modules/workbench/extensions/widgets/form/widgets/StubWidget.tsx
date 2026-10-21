import type { HostWidget, HostWidgetProps } from './registry'

/**
 * Build a labeled placeholder widget — the generic Tier-3 fallback. Two callers:
 *  - a not-yet-wired KNOWN slot the single-cell extension registers with a friendly
 *    title (default note: "available when selection wiring lands");
 *  - the `resolveWidget` UNKNOWN-kind fallback (note: "not registered in this build").
 * The value/onChange binding is intentionally inert (a no-op control) so a schema that
 * names one of these still renders a visible, accessible note instead of throwing.
 */
export function makeStubWidget(title: string, note = 'available when selection wiring lands'): HostWidget {
  function StubWidget({ 'data-testid': testid }: HostWidgetProps) {
    return (
      <div
        className="rounded-md border border-dashed border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        data-testid={testid}
      >
        {title} — {note}
      </div>
    )
  }
  StubWidget.displayName = `StubWidget(${title})`
  return StubWidget
}
