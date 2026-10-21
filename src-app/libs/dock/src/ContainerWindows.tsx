// ContainerWindows.tsx — renders each POPUP container as its own workspace inside a real window
// (PORTAL_DOCKING P3b). The main-window main mounts this ONCE. For every popup container in the store
// it `createPortal`s `renderContainer(id)` (a `<GridWorkspace containerId>`) into the window that was
// opened for it in the triggering gesture (held by `popupWindowRegistry`). Closing the window (Return /
// OS chrome) fires `onWindowClosed` so the owner returns the panes to the main; `pendingClose`
// force-closes emptied containers.
//
// Reuses the portal-move insight (about:blank has no height → size html/body) and bridges the main
// document's stylesheets into the popup so the workspace looks identical. No cross-window sync — it's
// one React tree; the popup is a render target.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PortalContainerProvider } from '@ziee/kit'
import type { ContainerId } from './containers'
import { getPopupWindow, closePopupWindow, unregisterPopupWindow } from './popupWindowRegistry'

/** One-time clone of the opener's stylesheets into the popup head (viz-core chrome is mostly inline,
 *  but chart chrome / app CSS may not be). Best-effort; a cross-origin sheet is skipped. IDEMPOTENT:
 *  marks the target doc so a re-invocation can't append duplicate `<style>`/`<link>` clones (unbounded
 *  head growth). */
function bridgeStyles(src: Document, dst: Document): void {
  if (!dst.defaultView) return
  if (dst.documentElement.hasAttribute('data-dock-styles-bridged')) return
  dst.documentElement.setAttribute('data-dock-styles-bridged', '')
  const adopted = (src as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets
  if (adopted && adopted.length) {
    const style = dst.createElement('style')
    try {
      style.textContent = adopted
        .map(s => Array.from(s.cssRules).map(r => r.cssText).join('\n'))
        .join('\n')
      dst.head.appendChild(style)
    } catch {
      /* inaccessible sheet */
    }
  }
  src.head.querySelectorAll('style,link[rel="stylesheet"]').forEach(node => {
    const clone = node.cloneNode(true) as HTMLElement
    // A cloned <link> keeps its RELATIVE href, which has no meaning in an `about:blank`
    // document — resolve it against the opener before adopting it.
    const href = (node as HTMLLinkElement).href
    if (node.nodeName === 'LINK' && href) clone.setAttribute('href', href)
    dst.head.appendChild(clone)
  })
}

/** Root attributes this bridge OWNS on the popup side and must therefore neither copy from the
 *  opener nor prune: the bridge's own marker, and `style` — which carries the `height: 100%` the
 *  popup needs because `about:blank`'s `<html>` has no height of its own. Pruning that would
 *  collapse the whole workspace to zero height. */
const POPUP_OWNED_ROOT_ATTRIBUTES = new Set(['data-dock-styles-bridged', 'style'])

/** Attributes on `<html>` that carry PRESENTATION rather than identity, and so must be mirrored into
 *  the popup or its content renders unstyled/mis-themed. The theme is stamped on the root element
 *  (`class="dark"`, `data-theme`, `dir`, …), so a popup that only receives the STYLESHEETS still
 *  renders in the wrong theme and the wrong writing direction. */
function mirrorableRootAttributes(src: Document): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const attr of Array.from(src.documentElement.attributes)) {
    if (POPUP_OWNED_ROOT_ATTRIBUTES.has(attr.name)) continue
    out.push([attr.name, attr.value])
  }
  return out
}

/** Copy the opener's `<html>` attributes onto the popup's, and KEEP them synced — the theme can be
 *  toggled while a popup is open, and a stale root attribute means a dark app with a light pane.
 *  Returns a disposer. */
function bridgeRootAttributes(src: Document, dst: Document): () => void {
  const apply = () => {
    if (!dst.defaultView) return
    const de = dst.documentElement
    const next = new Map(mirrorableRootAttributes(src))
    for (const [name, value] of next) {
      if (de.getAttribute(name) !== value) de.setAttribute(name, value)
    }
    for (const attr of Array.from(de.attributes)) {
      if (POPUP_OWNED_ROOT_ATTRIBUTES.has(attr.name)) continue
      if (!next.has(attr.name)) de.removeAttribute(attr.name)
    }
  }
  try {
    apply()
  } catch {
    /* popup torn down between the registry snapshot and here */
  }
  const watcher = new MutationObserver(() => {
    try {
      apply()
    } catch {
      /* popup went away between the mutation and the microtask */
    }
  })
  watcher.observe(src.documentElement, { attributes: true })
  return () => watcher.disconnect()
}

interface PopupContainerProps {
  containerId: ContainerId
  render: (containerId: ContainerId) => ReactNode
  onWindowClosed: (containerId: ContainerId) => void
  /** the popup document's `<title>` — a consumer-supplied label (this layer is content-agnostic).
   *  Defaults to a neutral `'Pane'`. */
  title?: string
}

/** Manages ONE popup container's window: sizes its document, bridges styles, portals the workspace in,
 *  and reports an OS/Return close. */
function PopupContainer({ containerId, render, onWindowClosed, title }: PopupContainerProps) {
  const win = getPopupWindow(containerId)
  const [mount, setMount] = useState<HTMLElement | null>(null)
  // The close callback is read through a ref so the mount effect does NOT depend on its identity — a
  // consumer that passes a fresh callback each render (or a re-rendering host) must NOT tear down +
  // re-create the mount (that would REMOUNT the whole popup workspace: deck re-init, lost state, and
  // — before the idempotency guard — duplicated bridged styles). The effect runs once per window.
  const onClosedRef = useRef(onWindowClosed)
  onClosedRef.current = onWindowClosed

  useEffect(() => {
    if (!win || win.closed) return
    let el: HTMLElement | null = null
    let stopRootAttrs: (() => void) | null = null
    try {
      const doc = win.document
      doc.title = title ?? 'Pane'
      doc.documentElement.style.height = '100%'
      doc.body.style.height = '100%'
      doc.body.style.margin = '0'
      bridgeStyles(document, doc)
      stopRootAttrs = bridgeRootAttributes(document, doc)
      el = doc.createElement('div')
      el.style.width = '100%'
      el.style.height = '100%'
      el.style.position = 'relative'
      doc.body.appendChild(el)
      setMount(el)
    } catch {
      /* window went away between the registry snapshot and here */
    }
    let done = false
    const fireClosed = () => {
      if (done) return
      done = true
      onClosedRef.current(containerId)
    }
    const onUnload = () => fireClosed()
    win.addEventListener('beforeunload', onUnload)
    // `beforeunload` is an UNRELIABLE close signal: it does not fire on a programmatic/OS/crashed
    // close in every engine (and headless Chromium suppresses it entirely). Poll `win.closed` from
    // the OWNER realm as the robust fallback so a gone popup still returns its panes. `fireClosed`
    // is one-shot, so the poll and the event never double-fire.
    const poll = window.setInterval(() => {
      let closed = false
      try {
        closed = !win || win.closed
      } catch {
        closed = true // cross-realm document torn down ⇒ the window is gone
      }
      if (closed) {
        window.clearInterval(poll)
        fireClosed()
      }
    }, 300)
    return () => {
      window.clearInterval(poll)
      stopRootAttrs?.()
      stopRootAttrs = null
      // The window may already be a torn-down cross-realm document (OS-closed) — every op is defensive
      // so React's cleanup can't throw on a dead node.
      try {
        win.removeEventListener('beforeunload', onUnload)
      } catch {
        /* window gone */
      }
      try {
        el?.parentNode?.removeChild(el)
      } catch {
        /* node's document torn down */
      }
      setMount(null)
    }
  }, [win, containerId, title])

  if (!mount) return null
  // The subtree below renders in ANOTHER document. `PortalContainerProvider` is what makes every
  // kit overlay inside it (tooltip / select / menu / popover / dialog / …) portal into THAT
  // document instead of the opener's — Base UI's portal otherwise defaults to the ambient
  // `document.body`, which is the opener's. Installed HERE, at the boundary, so no pane and no
  // overlay call site has to know a second window exists. See `@ziee/kit`'s kit/portal-container.
  return createPortal(
    <PortalContainerProvider container={mount}>{render(containerId)}</PortalContainerProvider>,
    mount,
  )
}

export interface ContainerWindowsProps {
  /** the popup containers currently in the store (derived from `paneContainer`). */
  containers: ContainerId[]
  /** render a container's workspace (a `<GridWorkspace containerId>`). */
  renderContainer: (containerId: ContainerId) => ReactNode
  /** a container's window was closed (Return / OS) → owner returns its panes to the main. */
  onWindowClosed: (containerId: ContainerId) => void
  /** containers the store queued for close (their last pane left); close + acknowledge. */
  pendingClose: readonly ContainerId[]
  onAcknowledgeClose: (containerId: ContainerId) => void
  /** optional popup document `<title>` (content-agnostic; defaults to `'Pane'`). */
  windowTitle?: string
}

export function ContainerWindows({
  containers,
  renderContainer,
  onWindowClosed,
  pendingClose,
  onAcknowledgeClose,
  windowTitle,
}: ContainerWindowsProps) {
  // Force-close emptied containers' windows, then acknowledge (drains the store's pendingClose).
  useEffect(() => {
    if (pendingClose.length === 0) return
    for (const id of pendingClose) {
      closePopupWindow(id)
      onAcknowledgeClose(id)
    }
  }, [pendingClose, onAcknowledgeClose])

  // Only render containers that actually have a live window (opened in the gesture). A container with
  // panes but no window (e.g. after a reload) is dropped from the registry, not rendered here.
  return (
    <>
      {containers.map(id =>
        getPopupWindow(id) ? (
          <PopupContainer
            key={id}
            containerId={id}
            render={renderContainer}
            title={windowTitle}
            onWindowClosed={cid => {
              unregisterPopupWindow(cid)
              onWindowClosed(cid)
            }}
          />
        ) : null,
      )}
    </>
  )
}
