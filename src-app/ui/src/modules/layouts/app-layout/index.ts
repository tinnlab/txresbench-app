import type { LayoutDefinition } from '@txresbench/framework/router'
import { AppLayout } from '@/modules/layouts/app-layout/AppLayout'

/**
 * AppLayoutDef - Layout definition for the main application layout
 *
 * Sidebar items are registered via the slot system:
 * - sidebarNavigation: Main navigation items
 * - sidebarTools: Tools/settings items
 * - sidebarPrimaryActions: Action buttons at top
 * - sidebarContent: Content widgets (middle section, flex-1)
 * - sidebarBottom: Below tools (e.g., download indicator)
 * - sidebarFooter: Footer section (e.g., user profile)
 */
export const AppLayoutDef: LayoutDefinition = {
  component: AppLayout as any,
}

// Re-export for convenience
export { AppLayout }
export type {
  SidebarNavItem,
  SidebarToolItem,
  SidebarActionItem,
} from './types'
