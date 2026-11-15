import type { ReactNode } from 'react'
import { useAppMode } from '../useAppMode'

/**
 * DesktopOnly — renders children only in desktop mode (ITEM-5's reusable
 * component; the ITEM-6/7 pages hide desktop-only controls in it — the
 * uploads, the delete/rename/export controls).
 *
 * The no-flash rule: while the boot read is pending the children are NOT
 * rendered — a desktop page never flashes its controls in front of a demo
 * visitor (and a demo page never shows them at all).
 */
export function DesktopOnly({ children }: { children: ReactNode }) {
  const { ready, isDesktop } = useAppMode()
  if (!ready || !isDesktop) return null
  return <>{children}</>
}
