// Tests for the slice-3 (`ai-actions`) PURE FE logic — `defineAction`'s
// `kind`/`stateful` extension (ITEM-4) and the `versioned` read-before-write
// helper (ITEM-7). Run directly:
//   node scripts/actions-unit.test.mjs
//
// Cyto has no vitest/jsdom runner (see `.lifecycle/ai-actions/TESTS.md`'s
// header note), so — mirroring `collect-actions.test.mjs`'s technique —
// each test bundles a small ESM entry (real project source, no fixture
// stand-ins: `defineAction.ts`/`versioned.ts` are pure/DOM-free at import
// time) via esbuild and `import()`s it for real, reading assertions off its
// named exports. A FRESH temp bundle per test means a FRESH module instance
// each time, so `defineAction.ts`'s module-level registry `Map` never leaks
// state across tests (no manual reset needed).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_ROOT = path.resolve(__dirname, '..')
const TSCONFIG_PATH = path.join(UI_ROOT, 'tsconfig.json')
const SRC_ROOT = path.join(UI_ROOT, 'src')

const DEFINE_ACTION_PATH = path.join(SRC_ROOT, 'core', 'actions', 'defineAction.ts')
const VERSIONED_PATH = path.join(SRC_ROOT, 'core', 'actions', 'versioned.ts')
const INSTANCE_LOCK_PATH = path.join(SRC_ROOT, 'core', 'actions', 'instanceLock.ts')

/** Identical technique to `collect-actions.mjs`'s `externalBareImportsPlugin`:
 *  relative/absolute/alias imports resolve+bundle normally; bare npm package
 *  imports (`zod`, `react-router-dom`, ...) stay external so Node resolves
 *  the REAL installed package at import time. */
const externalBareImportsPlugin = {
  name: 'external-bare-imports',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return null
      const p = args.path
      if (p.startsWith('.') || p.startsWith('/') || p.startsWith('@/') || p.startsWith('@ziee/')) {
        return null
      }
      return { path: p, external: true }
    })
  },
}

/** Bundle `entrySource` (a small ESM snippet importing real project source
 *  by absolute path) and `import()` it for real, returning its module
 *  namespace (named exports). */
async function loadModule(entrySource) {
  const result = await build({
    stdin: {
      contents: entrySource,
      resolveDir: UI_ROOT,
      loader: 'ts',
      sourcefile: 'actions-unit-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    tsconfig: TSCONFIG_PATH,
    // `import.meta.env` is injected by VITE and is UNDEFINED under the plain
    // Node runtime this bundle executes in, so any app/SDK module that reads it
    // at module scope (e.g. `@ziee/framework/store-kit`'s
    // `import.meta.env.VITE_STORE_PREFETCH`) throws the instant it is evaluated.
    // Reachable here since the action modules were repointed off the global
    // `Stores` shim onto each store's direct `registerLazyStore` handle. See the
    // long-form rationale in `collect-actions.mjs`.
    define: { 'import.meta.env': '{}' },
    plugins: [externalBareImportsPlugin],
    logLevel: 'silent',
  })
  const bundleCode = result.outputFiles[0].text
  const tmpFile = path.join(UI_ROOT, `.actions-unit-${randomUUID()}.mjs`)
  writeFileSync(tmpFile, bundleCode)
  try {
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    unlinkSync(tmpFile)
  }
}

// ------------------------------- TEST-1 -------------------------------

test('defineAction defaults kind to "global" (slice-1 back-compat)', async () => {
  const mod = await loadModule(`
    import { z } from 'zod'
    import { defineAction, getActionMeta } from ${JSON.stringify(DEFINE_ACTION_PATH)}

    defineAction({
      id: 'test.global.default',
      title: 'no kind specified',
      permission: 'test::use',
      mutating: false,
      params: z.object({}),
      run: () => null,
    })

    export const meta = getActionMeta('test.global.default')
  `)
  assert.equal(mod.meta.kind, 'global')
  assert.equal(mod.meta.stateful, false)
})

test('defineAction accepts kind:"instance" + mutating/stateful flags', async () => {
  const mod = await loadModule(`
    import { z } from 'zod'
    import { defineAction, getActionMeta } from ${JSON.stringify(DEFINE_ACTION_PATH)}

    defineAction({
      id: 'test.instance.setValue',
      title: 'an instance mutation',
      kind: 'instance',
      mutating: true,
      stateful: true,
      permission: 'test::use',
      params: z.object({ view_id: z.string(), value: z.number(), expected: z.string() }),
      run: () => null,
    })

    export const meta = getActionMeta('test.instance.setValue')
  `)
  assert.equal(mod.meta.kind, 'instance')
  assert.equal(mod.meta.mutating, true)
  assert.equal(mod.meta.stateful, true)
})

test('the registry keeps both a global and an instance action side by side', async () => {
  const mod = await loadModule(`
    import { z } from 'zod'
    import { defineAction, getActionRegistry } from ${JSON.stringify(DEFINE_ACTION_PATH)}

    defineAction({
      id: 'test.mixed.global',
      title: 'g',
      permission: 'test::use',
      mutating: false,
      params: z.object({}),
      run: () => null,
    })
    defineAction({
      id: 'test.mixed.instance',
      title: 'i',
      kind: 'instance',
      mutating: true,
      stateful: false,
      permission: 'test::use',
      params: z.object({ view_id: z.string() }),
      run: () => null,
    })

    const registry = getActionRegistry()
    export const ids = Array.from(registry.keys()).sort()
    export const kinds = Array.from(registry.values()).map(e => e.meta.kind).sort()
  `)
  assert.deepEqual(mod.ids, ['test.mixed.global', 'test.mixed.instance'])
  assert.deepEqual(mod.kinds, ['global', 'instance'])
})

// ------------------------------- TEST-2 -------------------------------

test('versioned: bumps version + stamps a matching _state_token on every mutation', async () => {
  const mod = await loadModule(`
    export { createVersioned } from ${JSON.stringify(VERSIONED_PATH)}
  `)
  const v = mod.createVersioned('view-1', { value: 0 })

  assert.equal(v.version, 0)
  assert.equal(v.token, 'view-1@0')
  assert.deepEqual(v.snapshot(), { value: 0, _state_token: 'view-1@0' })

  const t1 = v.mutate(prev => ({ value: prev.value + 1 }))
  assert.equal(t1, 'view-1@1')
  assert.equal(v.version, 1)
  assert.equal(v.value.value, 1)
  assert.deepEqual(v.snapshot(), { value: 1, _state_token: 'view-1@1' })

  const t2 = v.set({ value: 100 })
  assert.equal(t2, 'view-1@2')
  assert.equal(v.version, 2)
  assert.equal(v.value.value, 100)
})

test('versioned: checkExpectedToken rejects a missing/stale expected token, passes a match', async () => {
  const mod = await loadModule(`
    export { createVersioned, checkExpectedToken } from ${JSON.stringify(VERSIONED_PATH)}
  `)
  const v = mod.createVersioned('view-2', { value: 0 })
  v.mutate(prev => ({ value: prev.value + 1 })) // -> view-2@1

  assert.equal(mod.checkExpectedToken(v.token, undefined), 'missing')
  assert.equal(mod.checkExpectedToken(v.token, 'view-2@0'), 'stale')
  assert.equal(mod.checkExpectedToken(v.token, v.token), 'ok')

  // A stale check must NOT itself mutate — the compare is pure.
  assert.equal(v.version, 1)
  assert.equal(v.token, 'view-2@1')
})

// ------------------------------- TEST-3 -------------------------------
// Audit HIGH fix: `engine.ts`'s pre-dispatch `checkInstanceGuard` is a
// one-shot SYNCHRONOUS check, but a mutating instance action's `run` is
// `async` and may itself `await` before applying its mutation. Two
// concurrent `agent_invoke`s for the SAME instance, both carrying the SAME
// (soon-stale) `expected` token, could otherwise both pass the guard before
// either mutation lands, and both apply. `./instanceLock.ts`'s
// `runSerialized` fixes this by serializing mutating invokes per instance
// AND requiring the caller to re-check the guard as the first statement of
// its queued task — this test exercises exactly that shape with an ASYNC
// fake handler (an `await` between the re-check and the mutation, mirroring
// a real `run` that awaits a store call).

test('runSerialized: two concurrent same-instance mutating invokes with the same stale-able expected token — only the first applies, the second is rejected STALE_STATE', async () => {
  const mod = await loadModule(`
    export { runSerialized } from ${JSON.stringify(INSTANCE_LOCK_PATH)}
    export { createVersioned, checkExpectedToken } from ${JSON.stringify(VERSIONED_PATH)}
  `)

  const v = mod.createVersioned('view-3', { value: 0 })
  const staleAbleToken = v.token // 'view-3@0' — both concurrent callers read this BEFORE either mutates.

  // Models `engine.ts`'s `dispatch()`: re-check the guard as the FIRST
  // synchronous statement of the queued task (this is what makes the
  // check-then-apply pair atomic across the `await` below), THEN do async
  // work before actually applying the mutation — an async fake handler,
  // exactly like a real `run` awaiting `Stores.X.foo()`.
  async function queuedTask(expected) {
    const check = mod.checkExpectedToken(v.token, expected)
    if (check !== 'ok') {
      return { ok: false, error: check === 'missing' ? 'READ_REQUIRED' : 'STALE_STATE' }
    }
    await new Promise(resolve => setTimeout(resolve, 5))
    v.mutate(prev => ({ value: prev.value + 1 }))
    return { ok: true, value: v.value.value }
  }

  // Two concurrent invokes, fired back-to-back (not awaited individually —
  // mirrors two `agent_invoke` frames arriving before either has resolved).
  const invokeA = mod.runSerialized('view-3', () => queuedTask(staleAbleToken))
  const invokeB = mod.runSerialized('view-3', () => queuedTask(staleAbleToken))

  const [resultA, resultB] = await Promise.all([invokeA, invokeB])
  const results = [resultA, resultB]
  const oks = results.filter(r => r.ok)
  const rejected = results.filter(r => !r.ok)

  assert.equal(oks.length, 1, 'exactly one of the two racing invokes should apply its mutation')
  assert.equal(rejected.length, 1, 'the other must be rejected, never silently dropped')
  assert.equal(rejected[0].error, 'STALE_STATE')
  // Only ONE mutation landed — not two (the bug this fix closes: both racing
  // invokes silently applying because the guard was only ever checked once,
  // before either mutation landed).
  assert.equal(v.version, 1)
  assert.equal(v.value.value, 1)
})

test('runSerialized: invokes for DIFFERENT instances never block each other', async () => {
  const mod = await loadModule(`
    export { runSerialized } from ${JSON.stringify(INSTANCE_LOCK_PATH)}
  `)

  const order = []
  const slow = mod.runSerialized('view-a', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    order.push('slow-a')
    return 'a'
  })
  const fast = mod.runSerialized('view-b', async () => {
    order.push('fast-b')
    return 'b'
  })

  const [a, b] = await Promise.all([slow, fast])
  assert.equal(a, 'a')
  assert.equal(b, 'b')
  // The fast, DIFFERENT-instance task finishes first — it was never queued
  // behind the slow 'view-a' task.
  assert.deepEqual(order, ['fast-b', 'slow-a'])
})

test('runSerialized: a failing task never wedges the queue for the next same-instance caller', async () => {
  const mod = await loadModule(`
    export { runSerialized } from ${JSON.stringify(INSTANCE_LOCK_PATH)}
  `)

  const first = mod.runSerialized('view-c', async () => {
    throw new Error('boom')
  })
  const second = mod.runSerialized('view-c', async () => 'recovered')

  await assert.rejects(first, /boom/)
  assert.equal(await second, 'recovered')
})
