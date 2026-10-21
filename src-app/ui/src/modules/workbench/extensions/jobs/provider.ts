// The `jobs` capability PROVIDER (ITEM-6/11) — the `{id, version, create}` half
// `extensions/index.ts` registers. Kept out of `./index.ts` so the registration path
// pulls only the plane + the pure bind, never the extension's run/artifact panes.

import type { WorkbenchHost } from '@/modules/workbench/core'
import { JOBS_CAPABILITY_ID, type ComputeHost, type JobsApi } from './contract.ts'
import { createJobsApi } from './jobsCapability.ts'
import { createJobsHost } from './jobsHost.ts'

/** Bind the capability to a host bundle: the shell-injected plane
 *  (`planes['jobs']`, used by the gallery/e2e fake) when present, else the real
 *  ApiClient plane. */
export function createJobsCapability(host: WorkbenchHost): JobsApi {
  const plane = (host.planes?.[JOBS_CAPABILITY_ID] as ComputeHost | undefined) ?? createJobsHost()
  return createJobsApi(plane, host.projectId)
}
