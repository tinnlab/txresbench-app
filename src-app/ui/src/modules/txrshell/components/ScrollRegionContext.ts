import { createContext, useContext } from 'react'
import type { RefObject } from 'react'

/**
 * txrshell — the ScrollRegion → DataTable wiring (app-shell ITEM-1).
 *
 * A `DataTable` virtualises against the scroll element of the region that
 * contains it; the region publishes its element here. When a table is used
 * without a region (a table inside a dialog, or a story standing alone),
 * the DataTable falls back to its own root as the scroll element. The
 * context therefore carries ONE element or null — no nested-region
 * ambiguity (DEC-3: tables never invent their own scroll container).
 */
export const ScrollRegionContext = createContext<RefObject<HTMLDivElement | null> | null>(null)

/** The region element, when the table sits inside one (else null). */
export function useScrollRegionElement(): RefObject<HTMLDivElement | null> | null {
  return useContext(ScrollRegionContext)
}
