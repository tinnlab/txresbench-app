import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { ProvenanceSettings } from '@/modules/provenance/stores/ProvenanceSettings.store'

// The Provenance admin SETTINGS mutation (#49) — the settings form save, declared as a
// permissioned `defineAction` so it is drivable by the palette + AI, not only the inline
// form save (`.claude/skills/ai-controllable-actions`; INV-1/INV-2).
// `provenance::settings::manage` is the same key that gates the settings PUT + the human
// affordance. THIN wrapper over `ProvenanceSettings.saveSettings`.
//
// Sole runtime import site: `src/modules/provenance/module.tsx`.

defineAction({
  id: 'provenance.updateSettings',
  title: 'Update provenance settings',
  permission: Permissions.ProvenanceSettingsManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Update the provenance capture/export/verify settings (byte caps, retention, budgets, methods-LLM-polish toggle). Each field is optional; omit to leave unchanged.',
  params: z.object({
    capture_code_max_bytes: z.number().int().optional().describe('Max captured code bytes.'),
    export_bundle_max_bytes: z.number().int().optional().describe('Max export bundle bytes.'),
    export_retention_days: z.number().int().optional().describe('Export retention in days.'),
    methods_llm_polish_enabled: z
      .boolean()
      .optional()
      .describe('Enable the methods-section LLM polish.'),
    verify_default_tolerance: z.number().optional().describe('Default verify tolerance.'),
    verify_size_budget_bytes: z.number().int().optional().describe('Verify size budget in bytes.'),
    verify_time_budget_secs: z.number().int().optional().describe('Verify time budget in seconds.'),
    rootfs_gc_interval_secs: z
      .number()
      .int()
      .optional()
      .describe('Rootfs-cache GC sweep interval in seconds (60..604800).'),
    rootfs_cache_max_digests: z
      .number()
      .int()
      .optional()
      .describe('Rootfs image-cache size cap — max digest dirs kept (1..1000).'),
  }),
  run: async update => ProvenanceSettings.saveSettings(update),
})
