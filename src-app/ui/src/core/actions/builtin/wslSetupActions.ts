import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { setUpWsl, WSL_SETUP_CONTEXT } from '@/lib/wsl-setup/wslSetup'

// "Set up WSL" (Windows) — declared ONCE as a permissioned `defineAction`, so the shell
// notice's button, the ⌘K palette and the AI agent run the same setup
// (`.claude/skills/ai-controllable-actions`). A THIN wrapper over `setUpWsl`
// (`POST /api/sandbox/wsl/setup`); `sandbox::settings::manage` is the permission that gates
// that route. Its context is active only while a setup can start (WSL missing or too old on
// Windows, none running, not just declined), so the palette and the agent see it only then.
// The setup starts at once and runs nothing until the person at the PC says Yes in the app's
// own dialog (which the agent cannot answer; Windows' UAC prompt alone is not enough: with UAC
// off or the app run as administrator Windows asks nobody), then in Windows' prompt.
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
    "Windows only: start installing WSL 2, which methods run in, or updating it when it is too old (Microsoft's own `wsl --install --no-distribution`, after `wsl --update` for an old WSL), run as administrator. Answers at once with the setup's status (running: true); nothing runs until the person at the PC says Yes in TxResBench's own dialog (an agent cannot answer it) and then in Windows' permission prompt. Read how it went with Sandbox.listEnvs (GET /api/sandbox/envs): once stack.wsl_setup.running is false, stack.wsl_setup.last says done (start the app again, after restarting Windows when restart_windows), declined (not offered again for a minute: retry_in_secs), not_started (Windows' error) or failed (wsl.exe's exit code and last lines). Offered only while the app found WSL missing or too old and no setup runs.",
  params: z.object({}),
  run: async () => setUpWsl(),
})
