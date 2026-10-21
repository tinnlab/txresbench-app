import type { ReactNode } from 'react'
import type { PermissionExpr } from '@/core/permissions'

export interface SettingsPageSlot {
  id: string
  icon: ReactNode
  label: string
  path: string
  order: number
  /**
   * Optional permission expression. When set, the page is hidden
   * from the settings menu for users who don't satisfy it, and
   * direct navigation to the page renders an inline 403 instead.
   * See `.claude/PERMISSION_GATING.md`.
   */
  permission?: PermissionExpr
}

// Extend the global Slots interface
declare module '@ziee/framework/module-system/types' {
  interface Slots {
    settingsUserPages: SettingsPageSlot[]
    settingsAdminPages: SettingsPageSlot[]
  }
}

export {}
