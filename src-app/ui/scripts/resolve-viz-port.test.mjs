/**
 * `resolve-viz-port.mjs` — the reuse DECISION, tested against real listeners.
 *
 * The property under test is the one the fixed :1421 got wrong: a run may adopt an
 * already-listening server ONLY when that server proves it belongs to this worktree.
 * Everything else — a sibling worktree's showcase, a legacy fixed-port server, a
 * process that answers HTTP but not `/__worktree` — must be SKIPPED, not adopted and
 * not crashed into.
 *
 * Real `node:http` servers rather than a stubbed fetch: the defect lived in the gap
 * between "the port answers" and "the port answers for ME", and a stub is free to
 * model that gap however the test author already believes it works. The stand-ins bind
 * `::1` specifically, because binding only IPv6 localhost is what the real vite server
 * does here and is what made an IPv4-only probe report a busy port as free.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { resolveWorktreeRoot } from '@txresbench/gallery/scripts/lib/run-key.mjs'

import { classifyOrigin } from './harness-origin.mjs'
import { VIZ_PORT_ENV, VIZ_PORT_FLOORS, resolveVizPort } from './resolve-viz-port.mjs'

/**
 * A listener on `[::1]:0` that answers `/__worktree` with `root` (or 404s if null).
 *
 * ALWAYS an OS-assigned port, never the derived base. The first version of this suite
 * staged its occupancy ON the derived base, which made every occupancy test fail with
 * `EADDRINUSE` whenever this worktree's own showcase happened to be up — a test whose
 * verdict depends on unowned shared state, which is the same defect class the subject
 * of this file exists to fix. `resolveVizPort`'s `start` seam is what lets the walk be
 * pointed at a port this test owns.
 */
async function standIn(root) {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/__worktree') && root !== null) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ worktreeRoot: root, pid: process.pid }))
      return
    }
    res.statusCode = root === null ? 404 : 200
    res.end('x')
  })
  await new Promise((ok, no) => {
    srv.once('error', no)
    srv.listen(0, '::1', ok)
  })
  return { port: srv.address().port, close: () => new Promise(ok => srv.close(ok)) }
}

const hasIPv6 = await standIn('probe')
  .then(async s => {
    await s.close()
    return true
  })
  .catch(() => false)

test('every viz band is disjoint from the other viz band and from every SDK band', () => {
  // The SDK's `PORT_FLOORS`, restated rather than imported — deliberately. Importing
  // would make this test silently track any SDK change, and the point is that a MOVE on
  // either side is a REVIEWABLE event: a new overlap fails here and names the pair.
  //
  // SCOPE — this asserts `viz × everything`, NOT `sdk × sdk`. The SDK's own
  // `webE2eVite [9000,9200)` and `webE2eBackend [9100,9300)` already overlap (found by
  // the first draft of this test, which asserted every pair). That is a real pre-existing
  // defect in a package this repo consumes as a pinned submodule and does not own, so it
  // is REPORTED, not silently fixed here and not allowed to hold this suite red. Its blast
  // radius is the web e2e tier, where the two are additionally bind-verified before use.
  const sdk = [
    ['webGallery', 20000, 200],
    ['desktopGallery', 22000, 200],
    ['webE2eVite', 9000, 200],
    ['webE2eBackend', 9100, 200],
    ['webE2ePg', 54331, 100],
    ['desktopE2eBackend', 9600, 200],
    ['desktopE2ePg', 54600, 100],
  ]
  const viz = Object.entries(VIZ_PORT_FLOORS).map(([n, { floor, span }]) => [n, floor, span])
  const disjoint = ([, af, as], [, bf, bs]) => af + as <= bf || bf + bs <= af
  for (const v of viz) {
    for (const other of [...sdk, ...viz]) {
      if (other[0] === v[0]) continue
      assert.ok(
        disjoint(v, other),
        `port bands ${v[0]} [${v[1]},${v[1] + v[2]}) and ${other[0]} [${other[1]},${other[1] + other[2]}) ` +
          'overlap — two harnesses would derive the same port for one worktree, which is the ' +
          'collision this table prevents',
      )
    }
  }
})

test('an explicit pin is honoured when the port is genuinely free', async () => {
  const got = await resolveVizPort('vizShowcase', { env: { [VIZ_PORT_ENV.vizShowcase]: '31999' } })
  assert.deepEqual(got, { port: 31999, reused: false, pinned: true })
})

test('a pin overrides the SEARCH, never the PROOF: a held pin is REFUSED', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // The pin used to return before any probe, which made `VIZ_E2E_PORT=<n>` the one
  // documented way to bypass every check this module exists to perform. And pinning is
  // what a human does when the box is busy — i.e. exactly when a stranger on that port
  // is most likely. Both occupants must be refused, not silently tested against.
  const foreign = await standIn('/some/other/worktree')
  try {
    await assert.rejects(
      () => resolveVizPort('vizShowcase', { env: { [VIZ_PORT_ENV.vizShowcase]: String(foreign.port) } }),
      /is pinned for vizShowcase, but that port is already held by a server that cannot prove/,
    )
  } finally {
    await foreign.close()
  }
  const mine = await standIn(resolveWorktreeRoot())
  try {
    await assert.rejects(
      () => resolveVizPort('vizShowcase', { env: { [VIZ_PORT_ENV.vizShowcase]: String(mine.port) } }),
      /already held by another run of THIS worktree/,
      'a pinned port held by a SIBLING RUN of this same tree must be refused too — that is the ' +
        'configuration that destroyed viz-full-2 and viz-full-3',
    )
  } finally {
    await mine.close()
  }
})

test('the derived base lands inside this leg\'s band', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // Deliberately says nothing about `reused`: whether the base is free depends on
  // whether this worktree's own showcase is running, and both answers are correct.
  const got = await resolveVizPort('vizShowcase', { env: {} })
  const { floor, span } = VIZ_PORT_FLOORS.vizShowcase
  assert.ok(got.port >= floor && got.port < floor + span, `derived ${got.port} inside the band`)
})

test('a free port is taken without any sentinel round-trip', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // Own a port, release it, then aim the walk at it: known-free by construction.
  const free = await standIn('/wt/tmp')
  const port = free.port
  await free.close()
  const got = await resolveVizPort('vizShowcase', { env: {}, start: port })
  assert.deepEqual(got, { port, reused: false, pinned: false })
})

test('classifyOrigin reads a real sentinel, and rejects one that is absent', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const ours = await standIn('/wt/mine')
  try {
    const c = await classifyOrigin(ours.port, { ownRoot: '/wt/mine' })
    assert.equal(c.state, 'ours')
    assert.equal(c.root, '/wt/mine')
  } finally {
    await ours.close()
  }
  const mute = await standIn(null)
  try {
    const c = await classifyOrigin(mute.port, { ownRoot: '/wt/mine' })
    assert.equal(c.state, 'unidentified', 'a 404 is not a proof of ownership')
  } finally {
    await mute.close()
  }
})

test('a FOREIGN sentinel at the search start is skipped, never adopted', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // A server that answers `/__worktree` and identifies as somewhere ELSE — the
  // sibling-worktree case, i.e. the original defect.
  const foreign = await standIn('/some/other/worktree')
  try {
    const got = await resolveVizPort('vizShowcase', { env: {}, start: foreign.port })
    assert.notEqual(got.port, foreign.port, 'the foreign server was adopted — this is the whole bug')
    assert.equal(got.reused, false)
  } finally {
    await foreign.close()
  }
})

test('a sentinel naming THIS worktree is STILL NOT adopted by default', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // THE REGRESSION TEST for `viz-full-2` / `viz-full-3`. Both were produced by two
  // agents running this tier concurrently in ONE worktree (:21000/:21400 are the two
  // viz floors exactly, which exactly one worktree on this box derives). Same tree ⇒
  // same derived port ⇒ the sentinel truthfully answers "yes, this worktree's" to
  // BOTH runs ⇒ both adopt one server ⇒ whichever run owns it kills it on exit and
  // the other narrates the corpse.
  //
  // So proving worktree identity is necessary and NOT sufficient: the unit of
  // contention is a RUN, not a tree. Occupied means step aside, even when it is ours.
  const mine = await standIn(resolveWorktreeRoot())
  try {
    const got = await resolveVizPort('vizShowcase', { env: {}, start: mine.port })
    assert.notEqual(
      got.port,
      mine.port,
      "a server belonging to this worktree but to ANOTHER RUN was adopted — that is exactly the " +
        'configuration that produced 132 failures in 10.6 minutes',
    )
    assert.equal(got.reused, false)
  } finally {
    await mine.close()
  }
})

test('…and IS adopted when reuse is explicitly asked for (the positive control)', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // Without this, every "is skipped" assertion above would still pass if the resolver
  // had simply lost the ability to reuse anything at all — they would be measuring
  // nothing. `viz-showcase.mjs`, the human launcher, is the real caller of this path.
  const mine = await standIn(resolveWorktreeRoot())
  try {
    const got = await resolveVizPort('vizShowcase', { env: {}, start: mine.port, allowReuse: true })
    assert.deepEqual(got, { port: mine.port, reused: true, pinned: false })
  } finally {
    await mine.close()
  }
})

test('VIZ_REUSE_SERVER=1 is the env form of that opt-in', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const mine = await standIn(resolveWorktreeRoot())
  try {
    const got = await resolveVizPort('vizShowcase', { env: { VIZ_REUSE_SERVER: '1' }, start: mine.port })
    assert.equal(got.reused, true)
    // And any other value is not an opt-in — a truthiness check here would make
    // `VIZ_REUSE_SERVER=0` enable the thing it plainly asks to disable.
    const off = await resolveVizPort('vizShowcase', { env: { VIZ_REUSE_SERVER: '0' }, start: mine.port })
    assert.equal(off.reused, false)
    assert.notEqual(off.port, mine.port)
  } finally {
    await mine.close()
  }
})

test('an UNIDENTIFIABLE occupant is skipped too (fails CLOSED)', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  // Answers HTTP, has no sentinel: a legacy fixed-port server, an unrelated dev server,
  // anything. "It responded, so it is probably mine" is precisely the assumption the
  // fixed port made, so the absence of proof must be treated as proof of absence.
  const mute = await standIn(null)
  try {
    const got = await resolveVizPort('vizShowcase', { env: {}, start: mute.port })
    assert.notEqual(got.port, mute.port)
  } finally {
    await mute.close()
  }
})

test('the two legs never resolve to one origin', async t => {
  if (!hasIPv6) return t.skip('no usable IPv6 localhost on this box')
  const dev = await resolveVizPort('vizShowcase', { env: {} })
  const bench = await resolveVizPort('vizBench', { env: {} })
  assert.notEqual(dev.port, bench.port)
})

test('resolution gives up rather than looping forever when nothing is usable', async () => {
  await assert.rejects(
    () => resolveVizPort('vizShowcase', { env: {}, maxAttempts: 0 }),
    /no usable vizShowcase port/,
  )
})
