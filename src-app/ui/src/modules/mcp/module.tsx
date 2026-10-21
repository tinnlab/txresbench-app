import { Bot, Plug } from 'lucide-react'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { SettingsLayoutDef } from '@/modules/settings/SettingsLayout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import '@/modules/settings/types/SettingsSlots' // Register settings slot types
// Side-effect import: registers `mcp.updateSettings` (issue #54) so the settings
// save is drivable by the palette + AI, not only the inline form save.
import '@/core/actions/builtin/mcpSettingsActions'

const AiAccessPage = lazyWithPreload(() => import('./AiAccessPage'))
const McpSettingsPage = lazyWithPreload(() => import('./McpSettingsPage'))

// `modules/mcp` — the CONNECT surface of the AI-controllable-actions slice
// (PLAN.md ITEM-17/18/19). Registers no engine/action logic of its own
// (that's `modules/actions`, owned by another agent this slice) — this
// module is only the "AI Assistant Access" settings page + its pairing
// store, gated on `mcp::use`.
export default createModule({
  metadata: {
    name: 'mcp',
    version: '1.0.0',
    description:
      'AI Assistant Access: pair an external AI assistant (e.g. ziee chat) to CytoAnalyst.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/settings/ai-access',
      element: AiAccessPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      // Route-level gate: an unpermitted user cannot render the page directly.
      permission: Permissions.McpUse,
    },
    {
      // Admin settings page (issue #54): agent/tool caps + pairing-TTL.
      path: '/settings/mcp',
      element: McpSettingsPage,
      requiresAuth: true,
      layout: SettingsLayoutDef,
      // Route-level gate: an unpermitted user cannot render the page directly.
      permission: Permissions.McpSettingsRead,
    },
  ],
  // McpConnect + McpSettings are WHOLE-STORE-LAZY (`registerLazyStore` per file).
  stores: [],
  slots: {
    settingsUserPages: [
      {
        id: 'ai-access',
        icon: <Bot />,
        label: 'AI Assistant Access',
        path: 'ai-access',
        // Below General (10) / Profile (5) — a self-service page most users
        // won't touch daily.
        order: 15,
        permission: Permissions.McpUse,
      },
    ],
    // Admin sidebar entry — hidden for users without the read permission.
    settingsAdminPages: [
      {
        id: 'mcp',
        icon: <Plug />,
        label: 'MCP',
        path: 'mcp',
        // Right after Workstore (43) in the admin infra cluster.
        order: 44,
        permission: Permissions.McpSettingsRead,
      },
    ],
  },
})
