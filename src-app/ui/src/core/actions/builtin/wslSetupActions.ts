import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { setUpWsl, WSL_SETUP_CONTEXT } from '@/lib/wsl-setup/wslSetup'

// "Set up WSL" (Windows) — declared ONCE as a permissioned `defineAction`, so the shell
// notice's button, the ⌘K palette and the AI agent run the same setup
// (`.claude/skills/ai-controllable-actions`). A THIN wrapper over `setUpWsl`
// (`POST /api/sandbox/wsl/setup`); `sandbox::settings::manage` is the permission that gates
// that route. Its context is active only while the app offers a setup (WSL missing or too
// old on Windows), so the palette and the agent see it only then. Windows' permission
// prompt (UAC) still needs the person at the PC: the agent can start the setup, never
// approve it.
//
// Sole runtime import site: `src/modules/txrshell/module.tsx`.

defineAction({
  id: 'sandbox.setupWsl',
  title: 'Set up WSL',
  permission: Permissions.SandboxSettingsManage,
  mutating: true,
  context: WSL_SETUP_CONTEXT,
  surfaces: { palette: true, ai: true },
  group: 'Methods',
  aliases: ['Update WSL', 'Install WSL'],
  keywords: ['wsl', 'windows', 'subsystem', 'linux'],
  description:
    "Windows only: install WSL 2, which methods run in, or update it when it is too old (Microsoft's own `wsl --install --no-distribution`, after `wsl --update` for an old WSL), run as administrator. Windows asks the person at the PC for permission first; nothing changes without it. Waits until the setup ends and answers how it went: done (start the app again, after restarting Windows when restart_windows), declined, not_started (Windows' error), failed (wsl.exe's exit code and last lines) or timed_out (still running). Offered only while the app found WSL missing or too old.",
  params: z.object({}),
  run: async () => setUpWsl(),
})
