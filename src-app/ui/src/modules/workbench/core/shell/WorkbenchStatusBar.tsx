// WorkbenchStatusBar (Phase 2 · VS Code shell) — the thin bottom status strip. It is now a
// DUMB RENDERER over the `statusBarItems` contribution registry (the ninth P5 registry):
// it renders whatever is registered, split into a `start` (left) cluster and an `end`
// (right, after the flex spacer) cluster, each `order`-sorted. The built-in items (project /
// datasets / produced-types / selection / running-jobs / connection) are the first
// registrants (`shell/statusBarItems.tsx`); an analysis or extension contributes its OWN
// indicator the same way — register a zero-prop component with a `side` + `order` — instead
// of editing this file. Each item owns its live signal, so the bar itself is context-free.

import { workbenchRegistry } from '@/modules/workbench/core'

export function WorkbenchStatusBar() {
  const items = workbenchRegistry.statusBarItems.all()
  const start = items.filter(i => (i.side ?? 'start') === 'start')
  const end = items.filter(i => i.side === 'end')

  return (
    <div
      role="group"
      aria-label="Workbench status"
      data-testid="workbench-statusbar"
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-muted/40 px-3 text-xs text-muted-foreground"
    >
      {start.map(({ id, render: Item }) => (
        <Item key={id} />
      ))}
      {end.length > 0 && (
        <div className="ms-auto flex items-center gap-3">
          {end.map(({ id, render: Item }) => (
            <Item key={id} />
          ))}
        </div>
      )}
    </div>
  )
}
