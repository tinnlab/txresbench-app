// keyboardControls.ts — keyboard-driven pan / zoom / selection for the GPU canvases
// (ITEM-60). A mouse-only canvas is unusable without a pointer; this maps the standard
// keys (arrows = pan, +/- = zoom, Esc = clear, Enter/Space = activate) to intent objects.
//
// The mapper `keyToAction` is PURE + domain-agnostic (node-testable); `useCanvasKeyboard`
// is the thin React hook that attaches a keydown listener to a focusable container and
// dispatches the mapped intents to caller callbacks.

import { useEffect } from 'react'

/** Base pan step (view units) and the larger step used with Shift held. */
export const PAN_STEP = 1
export const PAN_STEP_LARGE = 10

/** Keyboard modifier state (only Shift affects the mapping today). */
export interface KeyModifiers {
  shift?: boolean
}

/** A pan intent: move the view by `dx`/`dy` (in the arrow's direction). */
export interface PanAction {
  type: 'pan'
  dx: number
  dy: number
}
/** A zoom intent, in or out. */
export interface ZoomAction {
  type: 'zoom'
  dir: 'in' | 'out'
}
/** Clear the current selection (Escape). */
export interface ClearSelectionAction {
  type: 'clearSelection'
}
/** Activate the focused point / primary action (Enter or Space) — a hook point the
 *  consumer wires to whatever "commit" means for its surface. */
export interface ActivateAction {
  type: 'activate'
}

export type KeyAction = PanAction | ZoomAction | ClearSelectionAction | ActivateAction

/**
 * Map a key (+ modifiers) to a canvas action, or `null` for a key we don't handle.
 * Pure — no DOM, no side effects. Arrow keys pan (Shift = larger step); `+`/`=` zoom in,
 * `-`/`_` zoom out; `Escape` clears; `Enter`/`Space` activate.
 */
export function keyToAction(key: string, modifiers: KeyModifiers = {}): KeyAction | null {
  const step = modifiers.shift ? PAN_STEP_LARGE : PAN_STEP
  switch (key) {
    case 'ArrowLeft':
      return { type: 'pan', dx: -step, dy: 0 }
    case 'ArrowRight':
      return { type: 'pan', dx: step, dy: 0 }
    case 'ArrowUp':
      return { type: 'pan', dx: 0, dy: step }
    case 'ArrowDown':
      return { type: 'pan', dx: 0, dy: -step }
    case '+':
    case '=':
      return { type: 'zoom', dir: 'in' }
    case '-':
    case '_':
      return { type: 'zoom', dir: 'out' }
    case 'Escape':
      return { type: 'clearSelection' }
    case 'Enter':
    case ' ':
    case 'Spacebar': // legacy key name
      return { type: 'activate' }
    default:
      return null
  }
}

export interface UseCanvasKeyboardOptions {
  /** The focusable container the keydown listener attaches to (`tabIndex=0`). */
  ref: React.RefObject<HTMLElement | null>
  onPan?: (action: PanAction) => void
  onZoom?: (action: ZoomAction) => void
  onClearSelection?: (action: ClearSelectionAction) => void
  onActivate?: (action: ActivateAction) => void
  /** When false, the listener is not attached (default true). */
  enabled?: boolean
  /**
   * When true, a key is handled ONLY when the focusable container ITSELF is the event target — not
   * a descendant control. So an interactive child (a legend checkbox, a chrome button/`<select>`)
   * keeps its OWN key behavior (Space toggles it, arrows move the `<select>`) instead of being
   * hijacked as a canvas pan/zoom/activate. Default false — byte-identical for a container with no
   * interactive children (e.g. `DeckScatterCanvas`, whose only child is the opaque deck canvas).
   */
  guardTarget?: boolean
}

/**
 * Attach keyboard pan/zoom/selection control to a focusable canvas container. Maps each
 * keydown via {@link keyToAction} and invokes the matching callback; a handled key has its
 * default (page scroll on arrows/space) prevented. Listener is cleaned up on unmount.
 */
export function useCanvasKeyboard(opts: UseCanvasKeyboardOptions): void {
  const { ref, onPan, onZoom, onClearSelection, onActivate, enabled = true, guardTarget = false } = opts
  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      // Only hijack keys aimed at the container itself, so a focused child control (legend
      // checkbox, chrome button/select) keeps its native key behavior. Default off = unchanged.
      if (guardTarget && e.target !== el) return
      const action = keyToAction(e.key, { shift: e.shiftKey })
      if (!action) return
      e.preventDefault()
      switch (action.type) {
        case 'pan':
          onPan?.(action)
          break
        case 'zoom':
          onZoom?.(action)
          break
        case 'clearSelection':
          onClearSelection?.(action)
          break
        case 'activate':
          onActivate?.(action)
          break
      }
    }
    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [ref, onPan, onZoom, onClearSelection, onActivate, enabled, guardTarget])
}
