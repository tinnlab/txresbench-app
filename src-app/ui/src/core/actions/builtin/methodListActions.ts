import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { checkForMethodUpdates } from '@/lib/txr-method-list/revision'

// "Check for method updates" (the method list, PR 5) — declared ONCE as a permissioned
// `defineAction`, so the Settings card's button, the ⌘K palette and the AI agent all run
// the same check (`.claude/skills/ai-controllable-actions`). A THIN wrapper over
// `checkForMethodUpdates` (`POST /api/methods/updates/check`); `projects::use` is the
// permission that gates that route (and every `/api/methods*` read). Global: it targets
// no screen instance.
//
// Sole runtime import site: `src/modules/settings-general/module.tsx`.

defineAction({
  id: 'methodList.checkForUpdates',
  title: 'Check for method updates',
  permission: Permissions.ProjectsUse,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Methods',
  description:
    'Ask the app to check now for a newer signed method list. A verified newer list is used from the next run on (a run already going keeps its list); the answer is the list in use and what the check found (current, updated, unreachable, refused, …).',
  params: z.object({}),
  run: async () => checkForMethodUpdates(),
})
