import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { McpSettings } from '@/modules/mcp/stores/McpSettings.store'

// The MCP admin SETTINGS mutation (issue #54) — the agent/tool-caps + pairing-TTL form
// save, declared as a permissioned `defineAction` so it is drivable by the palette + AI,
// not only the inline form save (`.claude/skills/ai-controllable-actions`).
// `mcp::settings::manage` is the same key that gates the settings PUT + the human
// affordance. THIN wrapper over `McpSettings.saveSettings`.
//
// Sole runtime import site: `src/modules/mcp/module.tsx`.

defineAction({
  id: 'mcp.updateSettings',
  title: 'Update MCP settings',
  permission: Permissions.McpSettingsManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Update the MCP agent/tool caps (max concurrent control sessions, max in-flight invokes per user, per-action wall-clock backstop, list-capabilities cap, invoke result-byte cap) and the pairing-code TTL. Each field is optional; omit to leave unchanged. Values are bounded (safety limits).',
  // Client-side bounds MIRROR the server `validate()` + DB CHECK (DEC-9), so the
  // palette/AI path is bounded before the request and the MCP params schema documents
  // the real ranges. The server is still the authority (422 on any out-of-range).
  params: z.object({
    max_control_sessions: z
      .number()
      .int()
      .min(16)
      .max(16384)
      .optional()
      .describe('Global cap on live agent control sessions — an OOM safety limit (16..16384).'),
    max_inflight_per_user: z
      .number()
      .int()
      .min(1)
      .max(256)
      .optional()
      .describe('Per-user cap on concurrent in-flight invokes — a DoS safety limit (1..256).'),
    pairing_ttl_secs: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe('Pairing-code time-to-live, in seconds (30..3600).'),
    action_wall_clock_secs: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe('Outer wall-clock backstop on one dispatched action, in seconds (30..3600).'),
    max_list_results: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe('Cap on capabilities returned by one list_capabilities call (1..2000).'),
    max_result_bytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .optional()
      .describe('Cap on the invoke result body relayed to the model, in bytes — an OOM safety limit (1 KiB..64 MiB).'),
  }),
  run: async update => McpSettings.saveSettings(update),
})
