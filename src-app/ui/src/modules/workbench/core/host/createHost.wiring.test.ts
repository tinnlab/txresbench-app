// ITEM-6/10/11 — the PRODUCTION wiring, end to end: `makeFakeHost()` →
// `createWorkbenchApi()` → the broker is stocked from the registered builtin providers →
// a consumer resolves `data`/`jobs` BY ID and reaches the host's injected plane.
//
// The unit suites cover each half in isolation (the broker with synthetic ids; the two
// capabilities against hand-built planes). This is the one that would have caught the
// integration failure mode the capability broker introduces: providers registered in a
// module nobody imports, so every `resolve` comes back absent and every surface silently
// degrades while all three gates stay green.

import { describe, expect, it } from 'vitest'
import { createWorkbenchApi } from '@/modules/workbench/core'
import { DATA_CAPABILITY_ID, DATA_CAPABILITY_RANGE, type DataApi } from '@/modules/workbench/extensions/data'
import { JOBS_CAPABILITY_ID, JOBS_CAPABILITY_RANGE, type JobsApi } from '@/modules/workbench/extensions/jobs/contract'
import { makeFakeHost, SHELL_EXTENSION_ID } from './createHost'

describe('createWorkbenchApi stocks the broker from the builtin providers', () => {
  it('publishes `data` + `jobs`, and `data` reads through the host-injected plane', async () => {
    const host = makeFakeHost({
      projectId: 'p-1',
      artifacts: [
        {
          id: 'a1',
          project_id: 'p-1',
          datatype: 'embedding',
          structure: { encoding: 'opaque' },
          created_at: '',
        },
      ],
    })
    const api = createWorkbenchApi(host, SHELL_EXTENSION_ID)

    expect(api.capabilities.ids().sort()).toEqual([DATA_CAPABILITY_ID, JOBS_CAPABILITY_ID].sort())

    const data = api.capabilities.resolve<DataApi>(DATA_CAPABILITY_ID, DATA_CAPABILITY_RANGE)
    expect(data.present).toBe(true)
    if (!data.present) throw new Error('unreachable')
    // The bind carries the host's projectId, and the read lands on the INJECTED fake plane.
    const catalog = await data.value.catalog()
    expect(catalog.project_id).toBe('p-1')
    expect(catalog.artifacts.map(a => a.id)).toEqual(['a1'])

    const jobs = api.capabilities.resolve<JobsApi>(JOBS_CAPABILITY_ID, JOBS_CAPABILITY_RANGE)
    expect(jobs.present).toBe(true)
    if (!jobs.present) throw new Error('unreachable')
    const handle = await jobs.value.run({ kind: 'sandbox', runtime: 'python', entry: 'x.py' }, [], {})
    expect(handle.jobId).toBe('fake-job')
  })

  it('binds ONE broker per host bundle, and a different host gets its own', () => {
    const host = makeFakeHost({ projectId: 'p-1' })
    expect(createWorkbenchApi(host, 'ext-a').capabilities).toBe(createWorkbenchApi(host, 'ext-b').capabilities)
    // A project switch builds a new host → a new broker, so a stale project-bound
    // implementation can never be resolved.
    expect(createWorkbenchApi(makeFakeHost({ projectId: 'p-2' }), 'ext-a').capabilities).not.toBe(
      createWorkbenchApi(host, 'ext-a').capabilities,
    )
  })

  it('resolves ABSENT for an id nothing publishes (never throws)', () => {
    const api = createWorkbenchApi(makeFakeHost(), SHELL_EXTENSION_ID)
    expect(api.capabilities.resolve('selection')).toEqual({ present: false, reason: 'not-published' })
  })
})
