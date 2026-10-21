import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { WorkstoreSettings } from '@/modules/workstore/stores/WorkstoreSettings.store'

// The Workstore admin SETTINGS mutation (issue #54) — the GC-policy + ingest-caps form
// save, declared as a permissioned `defineAction` so it is drivable by the palette + AI,
// not only the inline form save (`.claude/skills/ai-controllable-actions`).
// `workstore::settings::manage` is the same key that gates the settings PUT + the human
// affordance. THIN wrapper over `WorkstoreSettings.saveSettings`.
//
// Sole runtime import site: `src/modules/workstore/module.tsx`.

defineAction({
  id: 'workstore.updateSettings',
  title: 'Update workstore settings',
  permission: Permissions.WorkstoreSettingsManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Update the workstore GC policy (sweep on/off, cadence, orphan-grace), ingest size caps (max single-file bytes, max multi-file total bytes), and upload limits (max upload body bytes — SaaS only, max upload parts — both modes). Each field is optional; omit to leave unchanged. Values are bounded (safety limits).',
  // Client-side bounds MIRROR the server `validate()` + DB CHECK (DEC-3), so the
  // palette/AI path is bounded before the request and the MCP params schema documents
  // the real ranges. The server is still the authority (422 on any out-of-range).
  params: z.object({
    gc_enabled: z.boolean().optional().describe('Enable the standing blob-GC sweep.'),
    gc_interval_hours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .optional()
      .describe('GC sweep cadence, in hours (1..720).'),
    gc_grace_secs: z
      .number()
      .int()
      .min(300)
      .max(604800)
      .optional()
      .describe('Orphan-grace window, in seconds (300..604800).'),
    max_output_file_bytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(64 * 1024 * 1024 * 1024)
      .optional()
      .describe('Ingest ceiling on a single output file / member, in bytes (1 MiB..64 GiB).'),
    max_multifile_total_bytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(256 * 1024 * 1024 * 1024)
      .optional()
      .describe('Ingest ceiling on a multi-file artifact total, in bytes (1 MiB..256 GiB).'),
    max_upload_body_bytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(256 * 1024 * 1024 * 1024)
      .optional()
      .describe(
        'SaaS-only ceiling on a dataset UPLOAD request body, in bytes (1 MiB..256 GiB). Self-hosted uploads are uncapped and ignore this value.',
      ),
    max_upload_parts: z
      .number()
      .int()
      .min(1)
      .max(65536)
      .optional()
      .describe('Ceiling on the number of parts in one multipart upload, in BOTH modes (1..65536).'),
  }),
  run: async update => WorkstoreSettings.saveSettings(update),
})
