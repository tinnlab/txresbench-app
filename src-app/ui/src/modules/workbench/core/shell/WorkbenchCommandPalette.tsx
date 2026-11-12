// WorkbenchCommandPalette — the centered command input in the workbench top bar. Workbench-scoped
// (NOT the app-wide ⌘K): it lists the `defineAction` commands registered under the `'workbench'`
// CONTEXT (`core/actions/builtin/workbenchActions.ts` — `workbench.open*`), filtered to the ones
// runnable from a launcher (no param but `view_id`) and permitted for the current user. Selecting one
// invokes it through the SAME `runAction` path the global palette + AI agent use — no bespoke command
// list, and permission-gated for free. The old per-surface toolbar buttons were removed for this.
//
// ── WHY THIS IS THE KIT COMBOBOX AND NOT A HAND-ROLLED DROPDOWN ─────────────────────────────
// It used to render its result list as a plain `absolute … z-50` div, in place, inside the header.
// Two things were wrong with that, and only one of them looked like a bug:
//
//   1. STACKING. `HeaderBarContainer` gives the top bar `position: relative; z-index: 2`, which
//      makes the bar a STACKING CONTEXT — so the list's `z-50` only ever competed with the
//      palette's own siblings, never with the page. The canvas grid paints its per-plot chrome
//      (pane toolbar, dividers, overlays) at `z-index: 2…7` from inside the dock host, which
//      establishes no stacking context of its own and therefore competes in the ROOT context,
//      outranking the entire header. The dropdown rendered UNDER the canvas chrome. No z-index on
//      a DESCENDANT can escape its ancestor's stacking context, so the only real fix is to stop
//      being a descendant: portal out. Raising the HEADER's z-index would work too, and would
//      just move the arms race to the next overlay somebody adds.
//   2. SEMANTICS. The old input carried `aria-controls` / `aria-expanded` /
//      `aria-activedescendant` but no `role="combobox"`, so it was not a combobox to a screen
//      reader at all — the listbox it named was owned by nothing.
//
// Both disappear by using the kit's Combobox (Base UI). Its `ComboboxContent` portals through
// `kit/portal-container.tsx` — the ONE place the kit decides which DOCUMENT an overlay belongs to,
// shared with the other 12 overlay families — so the popup lands in `<body>` (root stacking
// context, above the canvas) and, inside a popped-out pane window, in THAT window's body. Base UI
// owns the combobox↔listbox↔option relation and `aria-activedescendant`.
//
// The palette is a LAUNCHER, not a value control, so the Combobox is driven with no retained
// value: `value={null}` + `onValueChange` runs the action; `filter={null}` + a pre-filtered
// `items` keeps OUR matcher (`actionMatches` — title/group/aliases/keywords/description, shared
// with ⌘K) rather than Base UI's substring one.

import { useMemo, useState } from 'react'
import { message } from '@txresbench/kit'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@txresbench/kit/shadcn/combobox'
import { InputGroupAddon } from '@txresbench/kit/shadcn/input-group'
import { Search } from 'lucide-react'
import { getActionRegistry, runAction, type ActionMeta } from '@/core/actions/defineAction'
import { actionMatches } from '@/core/actions/search'
import { useActiveContextSnapshot } from '@/core/actions/activeContext'
import { instancesOfType } from '@/core/actions/instanceRegistry'
import { hasPermissionNow, type Permission } from '@/core/permissions'
// `authStoreProxy` isn't re-exported by `@/core/permissions`; reading its `permissions` field here
// (a reactive proxy read) recomputes the list the instant a live permission change lands.
import { authStoreProxy } from '@txresbench/framework/permissions'

const WORKBENCH_CONTEXT = 'workbench'

/** The reactive, permission- + context-gated workbench command list. A command is offered iff its
 *  action is `context:'workbench'`, hasn't opted out of the palette, is permitted, has a focused
 *  workbench instance (for `kind:'instance'`), and is runnable with ONLY `view_id` (so it needs no
 *  param form — that excludes `analysis.launch`/`pane.*`, which target a specific analysis/pane). */
function useWorkbenchCommands(): ActionMeta[] {
  // Reactive reads: permission changes + context/instance (un)registration each recompute the list.
  const { permissions } = authStoreProxy()
  const contextSnapshot = useActiveContextSnapshot()
  return useMemo(() => {
    const viewId = instancesOfType(WORKBENCH_CONTEXT)[0]?.id
    const out: ActionMeta[] = []
    for (const entry of getActionRegistry().values()) {
      const m = entry.meta
      if (m.context !== WORKBENCH_CONTEXT || m.surfaces.palette === false) continue
      if (!hasPermissionNow(m.permission as Permission)) continue
      if (m.kind === 'instance' && !viewId) continue
      // Launcher-runnable ⟺ its schema accepts `{view_id}` alone (no other required param).
      if (!entry.params.safeParse({ view_id: viewId ?? '_' }).success) continue
      out.push(m)
    }
    return out.sort((a, b) => a.title.localeCompare(b.title))
    // `permissions`/`contextSnapshot` are the reactive triggers; the registry itself is static.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions, contextSnapshot])
}

export function WorkbenchCommandPalette() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const commands = useWorkbenchCommands()

  // Match on title + group + aliases + keywords + description (shared with ⌘K), so a
  // user's own word ("attach data") finds "Add dataset".
  const filtered = useMemo(() => commands.filter(c => actionMatches(c, q)), [q, commands])

  const run = (meta: ActionMeta) => {
    const viewId = instancesOfType(WORKBENCH_CONTEXT)[0]?.id
    // Surface a genuine invoke error (e.g. param validation) rather than dropping
    // it as an unhandled rejection — choreography handler errors are already caught
    // inside runChoreography and returned, so this only fires on a real throw.
    if (viewId) {
      runAction(meta.id, { view_id: viewId }).catch(err =>
        message.error(err instanceof Error ? err.message : 'Failed to run command'),
      )
    }
    setOpen(false)
  }

  return (
    <Combobox<ActionMeta>
      items={filtered}
      // OUR matcher already produced `items`; Base UI must not filter them a second time.
      filter={null}
      // A launcher retains no selection: picking an item RUNS it and the field goes back to empty.
      value={null}
      onValueChange={meta => {
        if (meta) run(meta)
      }}
      inputValue={q}
      onInputValueChange={setQ}
      open={open}
      // No `setQ('')` here. The field is CONTROLLED to reflect a value that is always `null`, so
      // Base UI itself pushes the input back to `''` on every close (select / Escape / click-away)
      // via `onInputValueChange` — a manual clear was measured to be dead code (mutation M5).
      onOpenChange={setOpen}
      // Keep the pre-fix behaviour where the top match is armed, so type-then-Enter runs it.
      autoHighlight
      itemToStringLabel={meta => meta.title}
      itemToStringValue={meta => meta.id}
    >
      <ComboboxInput
        showTrigger={false}
        placeholder="Search commands…"
        aria-label="Workbench command palette"
        data-testid="workbench-command-input"
        className="w-full"
      >
        <InputGroupAddon align="inline-start">
          <Search />
        </InputGroupAddon>
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>No matching commands.</ComboboxEmpty>
        <ComboboxList data-testid="workbench-command-list">
          {(c: ActionMeta) => (
            <ComboboxItem
              key={c.id}
              value={c}
              data-testid={`workbench-command-${c.id}`}
              // No selection is ever retained, so no room is reserved for a check indicator.
              className="pe-1.5 text-xs"
            >
              <span className="flex min-w-0 flex-1 flex-col text-start">
                <span className="truncate">{c.title}</span>
                {c.description ? (
                  <span className="truncate text-xs text-muted-foreground">{c.description}</span>
                ) : null}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
