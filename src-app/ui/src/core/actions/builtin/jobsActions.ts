import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { Jobs } from '@/modules/jobs/Jobs.store'
import { JobSettings } from '@/modules/jobs/JobSettings.store'
import { defineAction } from '../defineAction'

// Slice 2 (PLAN.md ITEM-2) — registers txr's top-level JOB actions,
// delegating to the existing `Jobs` store
// (`src/modules/jobs/Jobs.store.ts`). `job.create` mirrors `JobList.tsx`'s
// "New job" affordance (a name-only stub enqueue — real analysis jobs are
// created by analysis modules, not the palette); `job.stop` mirrors its
// per-row Stop/Cancel action. Both require `jobs::use`, the same permission
// that gates the jobs drawer + the store's own self-gate.

defineAction({
  id: 'job.create',
  title: 'Enqueue a new analysis job',
  permission: Permissions.JobsUse,
  mutating: true,
  params: z.object({ name: z.string().min(1) }),
  run: ({ name }) => Jobs.create('stub', name),
})

defineAction({
  id: 'job.stop',
  title: 'Stop or cancel a job',
  permission: Permissions.JobsUse,
  mutating: true,
  params: z.object({ job_id: z.string() }),
  run: ({ job_id }) => Jobs.stop(job_id),
})

// The Jobs admin SETTINGS mutation (#49) — the settings-page save, declared as a
// permissioned `defineAction` so it is drivable by the palette + AI, not only the
// inline form save. `jobs::settings::manage` is the same key that gates the settings
// PUT + the human affordance. THIN wrapper over `JobSettings.update`.
defineAction({
  id: 'jobs.updateSettings',
  title: 'Update job scheduler settings',
  permission: Permissions.JobsSettingsManage,
  mutating: true,
  surfaces: { palette: true, ai: true },
  group: 'Admin',
  description:
    'Update the job settings (max concurrent jobs, per-tenant cap, reserved interactive slots, SSE keep-alive seconds + max clients, admission wait seconds + poll ms, and the scheduler/reaper timing knobs: heartbeat, reaper tick, stale threshold, max reclaims, reclaim batch, dispatch tick, metric tick). Each field is optional; omit to leave unchanged.',
  params: z.object({
    max_concurrent_jobs: z.number().int().optional().describe('Global max concurrent jobs.'),
    per_tenant_max_concurrent: z
      .number()
      .int()
      .optional()
      .describe('Per-tenant max concurrent jobs.'),
    reserved_interactive_slots: z
      .number()
      .int()
      .optional()
      .describe('Slots reserved for interactive jobs.'),
    sse_keep_alive_secs: z
      .number()
      .int()
      .optional()
      .describe('SSE heartbeat interval in seconds (1-300).'),
    sse_max_clients: z
      .number()
      .int()
      .optional()
      .describe('Max concurrent per-job SSE subscribers (1-4096; OOM guard).'),
    admission_wait_secs: z
      .number()
      .int()
      .optional()
      .describe('Detached-admission wait budget in seconds (1-60).'),
    admission_poll_ms: z
      .number()
      .int()
      .optional()
      .describe('Admission poll interval in ms (10-10000; must be < wait*1000).'),
    heartbeat_secs: z
      .number()
      .int()
      .optional()
      .describe('Worker heartbeat cadence in seconds (1-60).'),
    reaper_tick_secs: z
      .number()
      .int()
      .optional()
      .describe('Reaper sweep cadence in seconds (1-300).'),
    stale_threshold_secs: z
      .number()
      .int()
      .optional()
      .describe('Stale-reclaim threshold in seconds (5-3600; must be >= 3x heartbeat_secs).'),
    max_reclaims: z
      .number()
      .int()
      .optional()
      .describe('Poison-job discard-at-max reclaim count (1-100).'),
    reclaim_batch: z
      .number()
      .int()
      .optional()
      .describe('Bounded reclaim/discard batch per sweep (1-10000).'),
    dispatch_tick_ms: z
      .number()
      .int()
      .optional()
      .describe('Dispatch (claim) loop cadence in ms (50-60000).'),
    metric_tick_secs: z
      .number()
      .int()
      .optional()
      .describe('CPU/RSS metric sampling cadence in seconds (1-60).'),
  }),
  run: async ({
    max_concurrent_jobs,
    per_tenant_max_concurrent,
    reserved_interactive_slots,
    sse_keep_alive_secs,
    sse_max_clients,
    admission_wait_secs,
    admission_poll_ms,
    heartbeat_secs,
    reaper_tick_secs,
    stale_threshold_secs,
    max_reclaims,
    reclaim_batch,
    dispatch_tick_ms,
    metric_tick_secs,
  }) =>
    JobSettings.update({
      max_concurrent_jobs,
      per_tenant_max_concurrent,
      reserved_interactive_slots,
      sse_keep_alive_secs,
      sse_max_clients,
      admission_wait_secs,
      admission_poll_ms,
      heartbeat_secs,
      reaper_tick_secs,
      stale_threshold_secs,
      max_reclaims,
      reclaim_batch,
      dispatch_tick_ms,
      metric_tick_secs,
    }),
})
