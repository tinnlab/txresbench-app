import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { SessionSettings } from '@/modules/auth/SessionSettings.store'

// The Session admin SETTINGS mutation (#49) — the session-settings form save, declared as a
// permissioned `defineAction` so it is drivable by the palette + AI, not only the inline form
// save (`.claude/skills/ai-controllable-actions`; INV-1/INV-2). `auth::session_settings::manage`
// is the same key that gates the settings PUT + the human affordance. THIN wrapper over
// `SessionSettings.update`.
//
// Sole runtime import site: `src/modules/auth/module.tsx`.

defineAction({
  id: 'auth.updateSessionSettings',
  title: 'Update session settings',
  permission: Permissions.SessionSettingsManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Update the auth session token lifetimes (access-token expiry hours, refresh-token expiry days). Each field is optional; omit to leave unchanged.',
  params: z.object({
    access_token_expiry_hours: z
      .number()
      .int()
      .optional()
      .describe('Access-token expiry in hours.'),
    refresh_token_expiry_days: z
      .number()
      .int()
      .optional()
      .describe('Refresh-token expiry in days.'),
  }),
  run: async patch => SessionSettings.update(patch),
})
