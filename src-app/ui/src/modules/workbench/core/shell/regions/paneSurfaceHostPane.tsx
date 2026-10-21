// paneSurfaceHostPane — the RENDERER half of `paneSurfaceHost.ts`, split off only because it
// carries JSX: the public barrel re-exports the container seam, and the node:test runner strips
// types without understanding JSX, so a `.tsx` anywhere in the barrel's import graph breaks it.
// The behaviour + the reasoning live in `paneSurfaceHost.ts`; read that file's header first.

import { useEffect, useRef } from 'react'
import type { PaneRenderer } from '@/modules/workbench/core/shell/dock/paneModel'
import { adoptableHost, type SurfacePaneKind } from './paneSurfaceHost'

/**
 * The renderer for a hosted-surface pane KIND: it adopts that surface's container into its own
 * body, and renders nothing else. Adoption is a MOVE of an existing node, never a creation —
 * a pane with no live surface behind it (a hydrated layout, a stale id) must show an honest
 * empty state rather than mint a container that would then never be filled or retired.
 */
export function surfacePaneRenderer(kind: SurfacePaneKind): PaneRenderer {
  function HostedSurfacePane({ pane }: { pane: { id: string; ref?: string } }) {
    const mountRef = useRef<HTMLDivElement | null>(null)
    const surfaceId = pane.ref ?? ''
    useEffect(() => {
      const mount = mountRef.current
      const node = adoptableHost(kind, surfaceId)
      if (!mount || !node) return
      mount.appendChild(node)
      return () => {
        // DETACH, never destroy: the surface stays mounted in this node while the pane is not
        // the region's active tab, so switching back restores it with its state intact.
        if (node.parentNode === mount) mount.removeChild(node)
      }
    }, [surfaceId])
    return (
      <div
        ref={mountRef}
        data-testid={`pane-surface-mount-${pane.id}`}
        data-pane-surface={`${kind}:${surfaceId}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      />
    )
  }
  return HostedSurfacePane
}

