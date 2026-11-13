import { useEffect } from 'react'
import { Command as CommandIcon } from 'lucide-react'
import { createModule } from '@txresbench/framework'
import { CommandPalette } from './CommandPalette'
import { closeCommandPalette, isCommandPaletteOpen, openCommandPalette } from './paletteState'
// Side-effect imports: register txr's real user actions (PLAN.md ITEM-2)
// into the global action registry (`@/core/actions/defineAction`). The
// FOUNDATION action (`app.navigate`) is already
// registered by `modules/actions/module.tsx` (slice 1); this module is the
// import site for the settings navigation added THIS slice.
import '@/core/actions/builtin/navActions'

// `modules/command-palette` — the HUMAN half of the AI-controllable-actions
// vocabulary (PLAN.md ITEM-1/3; ARCHITECTURE.md Layer 1). Mounts a global
// ⌘/Ctrl-K overlay (`CommandPalette.tsx`) over the SAME registered
// `defineAction`s the AI agent engine drives (`@/core/actions/engine.ts`),
// permission-filtered per action — DEC-2: no new permission, the palette is
// a launcher over the existing permissioned registry.

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * Mounted via the router `routerEffects` slot (DEC-3 — the slice-1
 * `RouterBridge` precedent): inside the router context, app-wide (every
 * route renders it once). Owns both the palette overlay and the global
 * ⌘/Ctrl-K keydown listener; the listener is guarded to never fire while
 * focus is inside an input/textarea/contenteditable element, so it never
 * hijacks normal typing.
 */
function CommandPaletteHost() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isPaletteCombo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
      if (!isPaletteCombo) return
      // ⌘K TOGGLES: while the palette is already open, close it — even
      // though its own auto-focused `CommandInput` matches
      // `isEditableTarget` below (it's a real <input>). Bypassing the
      // editable-target guard here is intentional and safe: the guard
      // exists so ⌘K doesn't hijack typing into an unrelated field, but
      // when the palette owns focus, ⌘K closing it is exactly what the
      // user pressing it again wants — never opening a SECOND palette or
      // otherwise "typing into" the field.
      if (isCommandPaletteOpen()) {
        event.preventDefault()
        closeCommandPalette()
        return
      }
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      openCommandPalette()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return <CommandPalette />
}

export default createModule({
  metadata: {
    name: 'command-palette',
    version: '1.0.0',
    description:
      'Human command palette (⌘/Ctrl-K) over the global AI-controllable action registry, plus the registration of TxResBench\'s real user actions.',
  },
  dependencies: ['router'],
  slots: {
    routerEffects: [
      {
        id: 'command-palette-host',
        component: CommandPaletteHost,
      },
    ],
    // Optional launcher affordance alongside the Jobs (#jobs) tools entry —
    // opens the SAME overlay the ⌘K binding does.
    sidebarTools: [
      {
        id: 'command-palette',
        icon: <CommandIcon />,
        label: 'Command Palette',
        path: '#command-palette',
        order: 95,
        onClick: () => openCommandPalette(),
      },
    ],
  },
})
