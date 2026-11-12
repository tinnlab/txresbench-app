// windowPortal.tsx — the portal-move pop-out engine. A cell pops into a REAL new window, but as ONE
// MOVED React instance, not a second synced copy: the content is `createPortal`ed into a STABLE
// `targetDiv` that is physically relocated between an in-place anchor and the popup body. Because the
// node is moved (not recreated), the React subtree / deck instance NEVER unmounts — state + the GL
// context survive pop-out and pop-back-in, and there is NO cross-window sync (it's the same instance).
//
// Cross-platform: on web `window.open` returns a scriptable window; on desktop the SAME plain
// `window.open` is made to work by the desktop Tauri Rust config (on_new_window + window_features +
// the popup setting — see reference-tauri-window-open-portal). No platform branching here.
//
// DESIGN NOTE (why no realm/instanceof hack): the TxResBench original mutated `globalThis.HTMLElement`
// to the popup's realm so antd's `findDOMNode`/`instanceof` checks passed across documents. That
// corrupts the WHOLE main app while a popup is open (and permanently if unmounted mid-open). We do
// NOT do that — viz-core chrome is inline-styled + deck operates on the canvas it's handed, neither
// needs realm-global instanceof. If a specific consumer ever needs cross-realm `instanceof`, handle it
// narrowly at that call site — never by mutating a shared global.
//
// Robustness invariants (enforced with refs, not React-state timing):
//   • `openRef`     — synchronous source of truth; guards double-open / redundant-close.
//   • `locationRef` — where `targetDiv` currently lives ('anchor' | 'popup'); the anchor ref-callback
//                     re-appends ONLY when it's 'anchor', so a stale render can't yank it out of the popup.
//   • Before closing the popup we ALWAYS reclaim `targetDiv` back into the MAIN document (adopt out of
//     the popup) so React can unmount the portal children in a live document, never a torn-down one.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PortalContainerProvider } from '@txresbench/kit'
import { buildPopupFeatures, centeredGeometry, popoutWindowName } from './windowPortalCore'

export interface UseWindowPortalOptions {
  /** stable id → the popup window NAME (reusing focuses the same window). */
  readonly id: string
  readonly title?: string
  readonly width?: number
  readonly height?: number
  readonly onOpen?: () => void
  readonly onClose?: () => void
}

export interface WindowPortalHandle {
  readonly isOpen: boolean
  /** open the popup + move the content into it. Returns false if blocked (no user gesture / popup blocker). */
  readonly open: () => boolean
  /** move the content back in-place + close the popup. No-op if not open. */
  readonly close: () => void
  /** render helper: the in-place anchor + the portaled content (always into the stable targetDiv). */
  readonly render: (content: ReactNode) => ReactNode
}

/** Clone the main document's stylesheets into the popup head + keep them synced. Returns a disposer.
 *  viz-core chrome is mostly inline-styled, but this bridges any app CSS-in-JS / stylesheets / adopted
 *  stylesheets so the popped-out content looks identical. */
function bridgeStyles(src: Document, dst: Document): () => void {
  const copy = () => {
    // The popup document is dead once it starts unloading (defaultView === null) — never touch it.
    if (!dst.defaultView) return
    dst.head.querySelectorAll('style,link[rel="stylesheet"]').forEach(n => n.remove())
    // Constructed/adopted stylesheets (modern CSS-in-JS / Tailwind) aren't in <head> — serialize them.
    const adopted = (src as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets
    if (adopted && adopted.length) {
      const style = dst.createElement('style')
      try {
        style.textContent = adopted
          .map(sheet => Array.from(sheet.cssRules).map(r => r.cssText).join('\n'))
          .join('\n')
        dst.head.appendChild(style)
      } catch {
        /* cross-origin / inaccessible sheet — skip */
      }
    }
    src.head.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => {
      const clone = node.cloneNode(true) as HTMLElement
      dst.head.appendChild(clone)
      // A CSS-in-JS <style> often has an EMPTY text node but a live sheet — copy its rules explicitly.
      const srcSheet = (node as HTMLStyleElement).sheet
      const dstSheet = (clone as HTMLStyleElement).sheet
      if (node.nodeName === 'STYLE' && srcSheet && dstSheet) {
        try {
          for (let i = 0; i < srcSheet.cssRules.length; i++) {
            dstSheet.insertRule(srcSheet.cssRules[i].cssText, dstSheet.cssRules.length)
          }
        } catch {
          /* cross-origin sheet — the cloned node's own text is the fallback */
        }
      }
    })
  }
  // The theme is stamped on the ROOT element (`html.dark`, `data-theme`, `dir`), not in the
  // stylesheets — a popup that receives only the sheets renders in the wrong theme and the wrong
  // writing direction. Mirror the opener's `<html>` attributes and keep them synced, so toggling
  // the theme while a popup is open updates it too. `style` is skipped: it carries the popup's own
  // `height: 100%` (about:blank's html has no height), which the opener must not overwrite.
  const copyRootAttrs = () => {
    if (!dst.defaultView) return
    const de = dst.documentElement
    const next = new Map<string, string>()
    for (const attr of Array.from(src.documentElement.attributes)) {
      if (attr.name === 'style') continue
      next.set(attr.name, attr.value)
    }
    for (const [name, value] of next) if (de.getAttribute(name) !== value) de.setAttribute(name, value)
    for (const attr of Array.from(de.attributes)) {
      if (attr.name === 'style') continue
      if (!next.has(attr.name)) de.removeAttribute(attr.name)
    }
  }
  copy()
  try {
    copyRootAttrs()
  } catch {
    /* popup torn down */
  }
  const obs = new MutationObserver(() => {
    try {
      copy()
    } catch {
      /* dst went away between the mutation + the microtask */
    }
  })
  const rootWatcher = new MutationObserver(() => {
    try {
      copyRootAttrs()
    } catch {
      /* dst went away between the mutation + the microtask */
    }
  })
  obs.observe(src.head, { childList: true, subtree: true })
  rootWatcher.observe(src.documentElement, { attributes: true })
  return () => {
    obs.disconnect()
    rootWatcher.disconnect()
  }
}

export function useWindowPortal(opts: UseWindowPortalOptions): WindowPortalHandle {
  const { id, title, width = 960, height = 720, onOpen, onClose } = opts
  const [isOpen, setIsOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const popupRef = useRef<Window | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  const openRef = useRef(false) // synchronous truth (guards double-open / redundant-close)
  const locationRef = useRef<'anchor' | 'popup'>('anchor') // where targetDiv lives

  // The STABLE node the content is portaled into; created once, relocated between anchor and popup.
  const targetDiv = useMemo<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null
    const d = document.createElement('div')
    d.style.width = '100%'
    d.style.height = '100%'
    d.style.position = 'relative'
    return d
  }, [])

  // Bring targetDiv back into the MAIN document (adopting it out of the popup), into the anchor if it's
  // mounted, else detached (still a valid main-doc node React can unmount from). Must run BEFORE the
  // popup is closed so the portal children never live in a torn-down document.
  const reclaimNode = useCallback(() => {
    if (!targetDiv || typeof document === 'undefined') return
    if (targetDiv.ownerDocument !== document) {
      try {
        document.adoptNode(targetDiv)
      } catch {
        /* already main-doc or detached */
      }
    }
    locationRef.current = 'anchor'
    const anchor = anchorRef.current
    if (anchor) {
      if (targetDiv.parentNode !== anchor) anchor.appendChild(targetDiv)
    } else {
      // anchor not mounted (component unmounting) — detach so it's out of the (closing) popup.
      targetDiv.parentNode?.removeChild(targetDiv)
    }
  }, [targetDiv])

  const close = useCallback(() => {
    if (!openRef.current) return // redundant-close guard (M2): don't fire onClose / stomp anything
    openRef.current = false
    reclaimNode() // move content back to main BEFORE tearing down the popup (H2)
    disposeRef.current?.()
    disposeRef.current = null
    const p = popupRef.current
    popupRef.current = null
    if (p && !p.closed) p.close()
    setIsOpen(false)
    onClose?.()
  }, [reclaimNode, onClose])

  const open = useCallback((): boolean => {
    if (openRef.current || !targetDiv || typeof window === 'undefined') return false // H1: ref guard
    const screenW = window.screen?.width ?? 1440
    const screenH = window.screen?.height ?? 900
    const features = buildPopupFeatures(centeredGeometry(width, height, screenW, screenH))
    // Open 'about:blank', NOT '' — an EMPTY url returns null on desktop WebKitGTK (Tauri's
    // on_new_window handler never fires; verified), while 'about:blank' routes through it and returns a
    // scriptable window on BOTH web + desktop. about:blank already has a document+body, so we normalize
    // the body margin rather than document.write (unreliable on about:blank across engines).
    const popup = window.open('about:blank', popoutWindowName(id), features)
    if (!popup) return false // popup blocked (no user gesture) — caller stays in-place

    openRef.current = true
    popupRef.current = popup
    try {
      // The moved content fills the window: about:blank's html/body have NO height by default, so a
      // height:100% target (e.g. a deck canvas container) would collapse to 0 and render nothing.
      const de = popup.document.documentElement
      if (de) de.style.height = '100%'
      if (popup.document.body) {
        popup.document.body.style.margin = '0'
        popup.document.body.style.height = '100%'
      }
    } catch {
      /* document not yet reachable — the appendChild below still re-homes the node */
    }
    if (title) popup.document.title = title

    const stopStyles = bridgeStyles(document, popup.document)
    locationRef.current = 'popup'
    popup.document.body.appendChild(targetDiv) // MOVE (adopt) the stable node into the popup

    // Return-on-close: the OS-chrome close fires the popup's `beforeunload`. NOTE: `close()` disposes
    // this listener BEFORE calling `popup.close()`, so this can't re-enter (L1 — keep that order).
    const onPopupUnload = () => close()
    const onMainUnload = () => {
      if (popup && !popup.closed) popup.close()
    }
    popup.addEventListener('beforeunload', onPopupUnload)
    window.addEventListener('beforeunload', onMainUnload)
    disposeRef.current = () => {
      stopStyles()
      popup.removeEventListener('beforeunload', onPopupUnload)
      window.removeEventListener('beforeunload', onMainUnload)
    }
    setIsOpen(true)
    onOpen?.()
    return true
  }, [targetDiv, width, height, id, title, onOpen, close])

  // Unmount: reclaim the node to the main realm (so React unmounts its children cleanly), dispose
  // listeners, then close the popup. No globals to restore (we never mutate them).
  useEffect(
    () => () => {
      openRef.current = false
      reclaimNode()
      disposeRef.current?.()
      disposeRef.current = null
      const p = popupRef.current
      popupRef.current = null
      if (p && !p.closed) p.close()
    },
    [reclaimNode],
  )

  const render = useCallback(
    (content: ReactNode): ReactNode => (
      <>
        <div
          ref={r => {
            anchorRef.current = r
            // Re-home the stable node ONLY when it belongs in the anchor (locationRef guard, M1) — a
            // stale render while popped out can't yank it back out of the popup.
            if (r && targetDiv && locationRef.current === 'anchor' && targetDiv.parentNode !== r) {
              r.appendChild(targetDiv)
            }
          }}
          data-testid={`viz-portal-anchor-${id}`}
          style={{ width: '100%', height: '100%', position: 'relative', display: isOpen ? 'none' : 'block' }}
        />
        {/* `targetDiv` physically MOVES between this document and the popup's, so the portal
            target's document changes at runtime. `PortalContainerProvider` derives the document
            from that same node, so every kit overlay inside the popped-out content (tooltip /
            select / menu / popover / …) portals into the window the content is currently in —
            Base UI would otherwise default to the ambient `document.body`, i.e. the opener.
            While the content is in-place this resolves to the ambient document and is a no-op. */}
        {targetDiv && (
          <PortalContainerProvider container={targetDiv}>
            {createPortal(content, targetDiv)}
          </PortalContainerProvider>
        )}
      </>
    ),
    [targetDiv, isOpen, id],
  )

  return { isOpen, open, close, render }
}
