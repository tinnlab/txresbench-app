import type { ReactNode } from 'react'
import { useAppMode } from '../useAppMode'

/**
 * DemoOnly — renders children only in demo mode (ITEM-5's reusable
 * component; the ITEM-6/7 pages wrap their demo pieces in it).
 *
 * The no-flash rule is the null branch: while the boot read is pending the
 * children are NOT rendered, so a demo page never paints demo-only chrome
 * before the mode is known (and a desktop page never paints it at all).
 */
export function DemoOnly({ children }: { children: ReactNode }) {
  const { ready, isDemo } = useAppMode()
  if (!ready || !isDemo) return null
  return <>{children}</>
}
