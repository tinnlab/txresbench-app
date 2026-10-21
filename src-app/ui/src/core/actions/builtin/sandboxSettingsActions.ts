import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { SandboxSettings } from '@/modules/sandbox/stores/SandboxSettings.store'

// The Sandbox admin SETTINGS mutation (#49) — the resource-limits form save, declared as a
// permissioned `defineAction` so it is drivable by the palette + AI, not only the inline form
// save (`.claude/skills/ai-controllable-actions`; INV-1/INV-2). `sandbox::settings::manage` is
// the same key that gates the settings PUT + the human affordance. THIN wrapper over
// `SandboxSettings.saveSettings`.
//
// Sole runtime import site: `src/modules/sandbox/module.tsx`.

defineAction({
  id: 'sandbox.updateSettings',
  title: 'Update sandbox resource limits',
  permission: Permissions.SandboxSettingsManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Update the code-sandbox resource limits (CPU, memory, pids, file sizes, timeouts), the per-class resource defaults (interactive/normal/batch), and the deployment default environment image id. Each field is optional; omit to leave unchanged.',
  params: z.object({
    cpu_max: z.string().optional().describe('CPU quota (cgroup cpu.max string).'),
    cpu_secs_max: z.number().int().optional().describe('Max CPU seconds.'),
    memory_max_bytes: z.number().int().optional().describe('Max resident memory in bytes.'),
    memory_swap_max_bytes: z.number().int().optional().describe('Max swap in bytes.'),
    address_space_bytes: z.number().int().optional().describe('Max virtual address space in bytes.'),
    pids_max: z.number().int().optional().describe('Max process ids.'),
    nproc_max: z.number().int().optional().describe('Max processes (rlimit nproc).'),
    nofile_max: z.number().int().optional().describe('Max open files (rlimit nofile).'),
    fsize_bytes: z.number().int().optional().describe('Max file size in bytes.'),
    timeout_secs: z.number().int().optional().describe('Execution timeout in seconds.'),
    staging_timeout_secs: z.number().int().optional().describe('Staging timeout in seconds.'),
    // #54: per-class resource DEFAULTS (the per-job request each priority class starts
    // from; clamped down to the ceiling above).
    interactive_cpu_cores: z.number().int().optional().describe('Default CPU cores for interactive-priority jobs.'),
    interactive_mem_bytes: z.number().int().optional().describe('Default memory (bytes) for interactive-priority jobs.'),
    normal_cpu_cores: z.number().int().optional().describe('Default CPU cores for normal-priority jobs.'),
    normal_mem_bytes: z.number().int().optional().describe('Default memory (bytes) for normal-priority jobs.'),
    batch_cpu_cores: z.number().int().optional().describe('Default CPU cores for batch-priority jobs.'),
    batch_mem_bytes: z.number().int().optional().describe('Default memory (bytes) for batch-priority jobs.'),
    // #54: deployment default env-id. Empty string clears it back to auto-detect.
    default_env_id: z
      .string()
      .optional()
      .describe('Deployment default environment-image id (empty string = auto-detect from installed processors).'),
  }),
  run: async update => SandboxSettings.saveSettings(update),
})
