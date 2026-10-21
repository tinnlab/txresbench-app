/**
 * `resolved-once.mjs` — one port decision per RUN, not per config evaluation.
 *
 * This suite exists because the defect it guards was shipped and caught by hand, not
 * by a test. Making reuse opt-in was correct and immediately produced:
 *
 *     [preflight] viz showcase (dev) :21133 — provably this worktree, serving. ok
 *     Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:21134/…
 *
 * The runner process resolved :21133 and booted a server there; each WORKER process
 * re-loaded the same config, re-resolved, correctly stepped over the (now occupied)
 * :21133 — it cannot tell the run's own server from any other occupant — and set
 * `use.baseURL` to :21134, where nothing was listening. Every spec would then have
 * failed to navigate: the same 132-red-specs disguise, from the opposite direction.
 *
 * So the property under test is IDEMPOTENCE ACROSS PROCESSES, and it is asserted
 * against a real child process rather than by calling the function twice in one — the
 * bug lives at the process boundary, and a same-process assertion cannot see it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { resolvedOnce } from './resolved-once.mjs'

const SELF = fileURLToPath(new URL('./resolved-once.mjs', import.meta.url))

test('the first evaluation resolves; the second reads the recorded verdict', () => {
  const env = {}
  let calls = 0
  const resolve = () => {
    calls += 1
    return { port: 9000 + calls, reused: false }
  }
  const saved = process.env.__HARNESS_RESOLVED_t1
  delete process.env.__HARNESS_RESOLVED_t1
  try {
    const a = resolvedOnce('t1', resolve)
    const b = resolvedOnce('t1', resolve)
    assert.deepEqual(a, b)
    assert.equal(calls, 1, 'a second evaluation must not re-resolve — it would pick a DIFFERENT port')
    assert.equal(a.port, 9001)
  } finally {
    if (saved === undefined) delete process.env.__HARNESS_RESOLVED_t1
    else process.env.__HARNESS_RESOLVED_t1 = saved
  }
  void env
})

test('a CHILD process inherits the verdict instead of resolving its own', () => {
  // The real shape: Playwright's runner resolves, then forks workers which re-load the
  // config. `process.env` is the only channel across that boundary, so the guarantee
  // has to hold for an actual child, not merely for two calls in one process.
  const script = `
    import { resolvedOnce } from ${JSON.stringify(SELF)}
    process.stdout.write(JSON.stringify(resolvedOnce('t2', () => ({ port: 4242 }))))
  `
  const parent = resolvedOnce('t2', () => ({ port: 1111 }))
  const child = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: process.env,
    }),
  )
  assert.deepEqual(
    child,
    parent,
    'the worker resolved independently — that is how a pre-flight can pass on one port ' +
      'while every spec navigates to another',
  )
  assert.equal(child.port, 1111)
  delete process.env.__HARNESS_RESOLVED_t2
})

test('a corrupted record is a hard error, never a silent re-resolution', () => {
  // Falling back to a fresh resolution here would hand a worker a different port than
  // the run already booted — the failure this module exists to prevent, arrived at by
  // a different route.
  process.env.__HARNESS_RESOLVED_t3 = '{not json'
  try {
    assert.throws(() => resolvedOnce('t3', () => ({ port: 1 })), /unparseable/)
  } finally {
    delete process.env.__HARNESS_RESOLVED_t3
  }
})
