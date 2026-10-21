/**
 * `harness-origin.mjs` + `harness-preflight.mjs` + `harness-watchdog-reporter.mjs` —
 * the three guards that turn "132 specs each rediscovering that a server is gone"
 * into one refusal that names the cause.
 *
 * Everything is driven against REAL `node:http` listeners rather than a stubbed
 * fetch. The defect these guards exist for lives in the gap between "the port
 * answers" and "the port answers, as me, right now", and a stub is free to model
 * that gap however the test author already believes it works. The stand-ins bind
 * `[::1]` because that is what vite does here, and an IPv4-only probe reading a
 * busy port as free is a bug this repo has already shipped once.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  DEAD_ORIGIN_SIGNATURE,
  assertOriginIsOurs,
  classifyOrigin,
  originBanner,
  originIsOurs,
} from './harness-origin.mjs'
import { HARNESS_ORIGINS_ENV, preflight, readOrigins } from './harness-preflight.mjs'
import HarnessWatchdogReporter, { looksLikeDeadOrigin } from './harness-watchdog-reporter.mjs'

const OURS = '/wt/mine'

/** A listener on `[::1]:0`. `root` null → no sentinel (404). `page` false → the
 *  page path 404s while the sentinel still answers. */
async function standIn({ root = OURS, page = true } = {}) {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/__worktree')) {
      if (root === null) {
        res.statusCode = 404
        return res.end('nope')
      }
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ worktreeRoot: root, pid: 4242 }))
    }
    res.statusCode = page ? 200 : 404
    res.end('x')
  })
  await new Promise((ok, no) => {
    srv.once('error', no)
    srv.listen(0, '::1', ok)
  })
  return { port: srv.address().port, close: () => new Promise(ok => srv.close(ok)) }
}

const hasIPv6 = await standIn({})
  .then(async s => {
    await s.close()
    return true
  })
  .catch(() => false)

/** A port nothing is listening on: own one, then release it. */
async function deadPort() {
  const s = await standIn({})
  const { port } = s
  await s.close()
  return port
}

// ── classification ──────────────────────────────────────────────────────────

test('a server of THIS worktree classifies as ours', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const s = await standIn({ root: OURS })
  try {
    const c = await classifyOrigin(s.port, { ownRoot: OURS })
    assert.equal(c.state, 'ours')
    assert.equal(originIsOurs(c), true)
  } finally {
    await s.close()
  }
})

test('the DEAD case is `absent`, distinctly from `unidentified`', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // This distinction is the whole diagnostic value. `absent` means "your server
  // died — restart it"; `unidentified` means "someone else is on your port — move".
  // Collapsing both to null, which the predecessor did, sends the reader to a diff.
  const c = await classifyOrigin(await deadPort(), { ownRoot: OURS })
  assert.equal(c.state, 'absent')

  const mute = await standIn({ root: null })
  try {
    assert.equal((await classifyOrigin(mute.port, { ownRoot: OURS })).state, 'unidentified')
  } finally {
    await mute.close()
  }
})

test('a DIFFERENT worktree classifies as foreign, and is never ours', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const s = await standIn({ root: '/wt/somebody-else' })
  try {
    const c = await classifyOrigin(s.port, { ownRoot: OURS })
    assert.equal(c.state, 'foreign')
    assert.equal(originIsOurs(c), false)
    assert.match(originBanner(c, { label: 'x' }), /DIFFERENT worktree/)
  } finally {
    await s.close()
  }
})

test('every refusal banner leads with "not your code" and names the port', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // The expensive part of all three incidents was reading a source diff. A banner
  // that does not say, in its first line, that the rig is at fault has not fixed the
  // costly half of the problem.
  for (const [state, make] of [
    ['absent', async () => ({ port: await deadPort(), close: async () => {} })],
    ['unidentified', () => standIn({ root: null })],
    ['foreign', () => standIn({ root: '/wt/other' })],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const s = await make()
    try {
      // eslint-disable-next-line no-await-in-loop
      const c = await classifyOrigin(s.port, { ownRoot: OURS })
      assert.equal(c.state, state)
      const b = originBanner(c, { label: 'the tier', url: 'http://x/y.html' })
      assert.match(b, /HARNESS FAULT — THIS IS THE TEST RIG, NOT YOUR CODE/)
      assert.match(b, new RegExp(String(s.port)))
      assert.match(b, /fix\s+:/)
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await s.close()
    }
  }
})

// ── the pre-flight assertion ────────────────────────────────────────────────

test('assertOriginIsOurs passes on ours-and-serving, and throws on each refusal', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const ok = await standIn({ root: OURS })
  try {
    await assertOriginIsOurs({
      port: ok.port,
      url: `http://[::1]:${ok.port}/page.html`,
      ownRoot: OURS,
    })
  } finally {
    await ok.close()
  }

  const dead = await deadPort()
  await assert.rejects(
    () => assertOriginIsOurs({ port: dead, url: `http://[::1]:${dead}/page.html`, ownRoot: OURS }),
    /NOTHING IS LISTENING/,
  )

  const foreign = await standIn({ root: '/wt/other' })
  try {
    await assert.rejects(
      () => assertOriginIsOurs({ port: foreign.port, ownRoot: OURS }),
      /DIFFERENT worktree/,
    )
  } finally {
    await foreign.close()
  }
})

test('ours BUT NOT SERVING the page is also a refusal', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // A sentinel-only check passes against a vite that is up but whose entry 404s —
  // in which case every spec still dies on its first goto(). Provenance and
  // liveness are different questions and both must be asked.
  const s = await standIn({ root: OURS, page: false })
  try {
    await assert.rejects(
      () => assertOriginIsOurs({ port: s.port, url: `http://[::1]:${s.port}/missing.html`, ownRoot: OURS }),
      /does not serve the page/,
    )
  } finally {
    await s.close()
  }
})

test('a MISSING origin list fails the run instead of quietly passing', () => {
  // A pre-flight that no-ops when its input is absent is worse than none: it prints
  // "checked" in every log while checking nothing, which is how a guard survives the
  // refactor that disconnects it from the config.
  assert.throws(() => readOrigins({}), /is not set/)
  assert.throws(() => readOrigins({ [HARNESS_ORIGINS_ENV]: '[]' }), /non-empty array/)
  assert.throws(() => readOrigins({ [HARNESS_ORIGINS_ENV]: 'not json' }), /not valid JSON/)
  assert.throws(() => readOrigins({ [HARNESS_ORIGINS_ENV]: '[{"label":"x"}]' }), /no usable port/)
})

test('the pre-flight asserts EVERY published origin, not just the first', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // The viz tier publishes two (dev + bench). A loop that returned after the first
  // would leave the ms-leg origin unchecked and still look green.
  const good = await standIn({ root: OURS })
  const bad = await standIn({ root: '/wt/other' })
  try {
    const env = {
      [HARNESS_ORIGINS_ENV]: JSON.stringify([
        { label: 'first', port: good.port, url: `http://[::1]:${good.port}/p.html` },
        { label: 'second', port: bad.port, url: `http://[::1]:${bad.port}/p.html` },
      ]),
    }
    await assert.rejects(() => preflight({ env, ownRoot: OURS }), /DIFFERENT worktree/)
  } finally {
    await good.close()
    await bad.close()
  }
})

// ── the mid-run watchdog ────────────────────────────────────────────────────

const failure = msg => ({ status: 'failed', errors: [{ message: msg }] })

test('the watchdog trigger is a CONNECTION error, never a test failure', () => {
  assert.equal(looksLikeDeadOrigin(failure('page.goto: net::ERR_CONNECTION_REFUSED at http://x')), true)
  assert.equal(looksLikeDeadOrigin(failure('connect ECONNREFUSED 127.0.0.1:9')), true)
  assert.equal(looksLikeDeadOrigin(failure('net::ERR_NETWORK_CHANGED')), true)
  // The suite doing its job must never trip it.
  assert.equal(looksLikeDeadOrigin(failure('expect(locator).toBeVisible() failed')), false)
  assert.equal(looksLikeDeadOrigin(failure('Timeout 15000ms waiting for selector')), false)
  assert.equal(looksLikeDeadOrigin({ status: 'passed', errors: [] }), false)
  // A PASSING result whose text happens to contain the phrase is still not a fault.
  assert.equal(
    looksLikeDeadOrigin({ status: 'passed', errors: [{ message: 'ERR_CONNECTION_REFUSED' }] }),
    false,
  )
  assert.match('net::ERR_CONNECTION_REFUSED', DEAD_ORIGIN_SIGNATURE)
})

test('the watchdog aborts when the origin is gone — and NOT when it is merely a red spec', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const alive = await standIn({ root: OURS })
  try {
    const env = {
      [HARNESS_ORIGINS_ENV]: JSON.stringify([{ label: 'tier', port: alive.port, url: 'http://x/p.html' }]),
    }
    let aborted = 0
    const r = new HarnessWatchdogReporter({ env, ownRoot: OURS, onAbort: () => (aborted += 1) })

    // A connection-shaped failure while the origin is ALIVE: the spec failed for its
    // own reasons. Keying on the error TEXT alone would abort a real run here — and
    // would be guarding a string rather than a state, which this repo has paid for.
    assert.equal(await r.check(failure('net::ERR_CONNECTION_REFUSED at http://x')), null)
    assert.equal(aborted, 0)
  } finally {
    await alive.close()
  }

  // Now the corpse: same failure text, origin gone.
  const port = await deadPort()
  const env = {
    [HARNESS_ORIGINS_ENV]: JSON.stringify([{ label: 'tier', port, url: 'http://x/p.html' }]),
  }
  let aborted = 0
  const r = new HarnessWatchdogReporter({ env, ownRoot: OURS, onAbort: () => (aborted += 1) })
  const c = await r.check(failure('page.goto: net::ERR_CONNECTION_REFUSED at http://x'))
  assert.equal(c.state, 'absent')
  await r.check(failure('page.goto: net::ERR_CONNECTION_REFUSED at http://x'))
  assert.equal(r.tripped, true, 'it latches, so the banner is printed once, not once per spec')
})

test('the watchdog reads the cause out of stacks and values too, not just message', () => {
  assert.equal(
    looksLikeDeadOrigin({ status: 'timedOut', errors: [{ stack: 'at goto\nnet::ERR_CONNECTION_REFUSED' }] }),
    true,
    'a timed-out navigation carries its cause in the stack, and missing it is a 10-minute run',
  )
  assert.equal(looksLikeDeadOrigin({ status: 'failed', errors: [{ value: 'ECONNRESET' }] }), true)
})

test('a watchdog with no published origins says so instead of pretending to watch', () => {
  const r = new HarnessWatchdogReporter({ env: {}, ownRoot: OURS, onAbort: () => {} })
  assert.equal(r.origins, null)
  assert.match(r.originsError.message, /is not set/)
})
