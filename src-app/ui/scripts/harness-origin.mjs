#!/usr/bin/env node
/**
 * ORIGIN IDENTITY for the backend-free Playwright tiers — "is the server this run
 * is about to talk to actually MINE, and is it alive RIGHT NOW?"
 *
 * ## The recurrence this exists to end
 *
 * Three separate incidents, one class. Each was fixed by moving a port, and each
 * came back:
 *
 *   1. the fixed gallery :1420 → a run reused a SIBLING worktree's server and
 *      audited the wrong tree (9,355 `ERR_NETWORK_CHANGED`, misdiagnosed as
 *      machine load);
 *   2. the fixed viz :1421/:1422 → same shape, fixed by deriving the port from a
 *      per-worktree run key and proving provenance with a `/__worktree` sentinel;
 *   3. and then, with BOTH of those fixes in place, `viz-full-2.log`: 132 failed /
 *      15 passed in 10.6 minutes, every failure `net::ERR_CONNECTION_REFUSED at
 *      http://localhost:21000/viz-showcase.html`, plus `viz-full-3.log`:
 *      `http://localhost:21400/viz-showcase.html is already used`.
 *
 * ## Why the per-worktree derivation could not have prevented (3)
 *
 * `21000` and `21400` are the vizShowcase/vizBench FLOORS exactly — the ports a key
 * with `key % 200 === 0` derives. Exactly one worktree on this box does that:
 * `/data/pbya/cytoanalyst/tmp/viz-finish-wt`. Both destroyed runs therefore came
 * from ONE worktree, i.e. from two agents running the tier CONCURRENTLY IN THE SAME
 * TREE.
 *
 * And for that case, deriving the port per worktree is not merely insufficient — it
 * is what GUARANTEES the collision. Two runs in one tree derive the SAME number by
 * construction, the sentinel is then asked "does this server belong to this
 * worktree?", truthfully answers YES for both, and both adopt one server. The
 * sentinel proves WORKTREE identity; the thing actually being shared is a SERVER
 * PROCESS whose lifetime belongs to exactly ONE run — Playwright kills only servers
 * it started. So the first run to finish killed the server out from under the
 * second, and the second kept going against a corpse: 132 independent per-spec
 * navigation errors wearing the costume of a catastrophic code regression.
 *
 * The `CI=1` variant is the same overlap hitting the other branch: the resolver
 * returns a port that is valid ONLY if reused, while `reuseExistingServer:
 * !process.env.CI` forbids reuse — two decisions taken independently over one port,
 * free to contradict. That is `viz-full-3` in one line.
 *
 * ## The rule this module encodes
 *
 * Identity is not enough; LIVENESS and TIME matter too. A port is only usable if a
 * server that can prove it is ours is answering *at the moment we ask*, and that
 * proof has to be re-taken — before the first spec (pre-flight) and again the
 * instant a spec fails with a connection-level error (watchdog). A proof computed
 * in a child process at config-load time and then thrown away, which is what the
 * previous fix did, is a proof about the past.
 *
 * Consumers: `resolve-viz-port.mjs` (the reuse decision),
 * `harness-preflight.mjs` (the pre-run assertion), and
 * `harness-watchdog-reporter.mjs` (the mid-run one).
 */
import { resolveWorktreeRoot } from '@ziee/gallery/scripts/lib/run-key.mjs'

/** The two localhost families a browser may resolve `localhost` to. Both are asked
 *  explicitly: `localhost` is ambiguous on a dual-stack box, and a port held by a
 *  DIFFERENT server per family is the literal shape of the ERR_NETWORK_CHANGED
 *  incident. */
export const LOCAL_HOSTS = ['127.0.0.1', '[::1]']

/** Error codes that mean "no listener on this family" as opposed to "a listener
 *  that would not identify itself". The distinction is the whole difference between
 *  the banner saying DEAD and the banner saying FOREIGN, and it is the difference
 *  between "restart your server" and "someone else is on your port". */
const ABSENT_CODES = new Set([
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
])

function errCode(e) {
  for (let cur = e, depth = 0; cur && depth < 5; cur = cur.cause, depth++) {
    if (typeof cur.code === 'string') return cur.code
  }
  return null
}

/**
 * Ask ONE family for the sentinel.
 * → `{ kind: 'absent' }`          nothing is listening there
 * → `{ kind: 'unidentified' }`    something answered, but not as a sentinel
 * → `{ kind: 'root', root }`      it identified itself
 */
async function probeFamily(host, port, fetchImpl, timeoutMs) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetchImpl(`http://${host}:${port}/__worktree`, { signal: ac.signal })
    if (!r.ok) return { kind: 'unidentified' }
    const j = await r.json().catch(() => null)
    const root = typeof j?.worktreeRoot === 'string' && j.worktreeRoot.trim() ? j.worktreeRoot.trim() : null
    return root ? { kind: 'root', root, pid: j?.pid ?? null } : { kind: 'unidentified' }
  } catch (e) {
    // A timeout/abort is NOT absence: something accepted the connection and then
    // did not answer. Calling that "absent" would tell a user to start a server
    // when the truth is that a server is there and wedged.
    return ABSENT_CODES.has(errCode(e)) ? { kind: 'absent' } : { kind: 'unidentified' }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Classify what is on `port` right now, from THIS run's point of view.
 *
 * States, all of which the banners below can explain to a human:
 *   `absent`        nothing listening on any family        → the corpse case
 *   `unidentified`  a listener with no/!ok/unparseable sentinel
 *   `foreign`       identified, but as a DIFFERENT worktree
 *   `split`         the two families report DIFFERENT roots (two servers, one port)
 *   `ours`          identified as this worktree
 *
 * Everything except `ours` is a refusal. Fail CLOSED: "probably mine" is precisely
 * the assumption the fixed ports made, and it was wrong three times.
 */
export async function classifyOrigin(
  port,
  { ownRoot = resolveWorktreeRoot(), fetchImpl = fetch, timeoutMs = 2000 } = {},
) {
  const results = []
  for (const host of LOCAL_HOSTS) {
    // eslint-disable-next-line no-await-in-loop
    results.push({ host, ...(await probeFamily(host, port, fetchImpl, timeoutMs)) })
  }
  const roots = [...new Set(results.filter(r => r.kind === 'root').map(r => r.root))]
  const pid = results.find(r => r.kind === 'root')?.pid ?? null

  if (roots.length > 1) return { state: 'split', port, roots, ownRoot, pid, results }
  if (roots.length === 1) {
    const state = roots[0] === (ownRoot || '').trim() ? 'ours' : 'foreign'
    return { state, port, root: roots[0], roots, ownRoot, pid, results }
  }
  const state = results.every(r => r.kind === 'absent') ? 'absent' : 'unidentified'
  return { state, port, root: null, roots, ownRoot, pid, results }
}

/** Is this classification safe to talk to? Exactly one state qualifies. */
export const originIsOurs = c => c?.state === 'ours'

const RULE = '═'.repeat(78)

/** One line per state saying what is TRUE, and one saying what to DO. The wording
 *  is deliberately blunt about ownership: the expensive part of every one of these
 *  incidents was the minutes (or investigations) spent reading a source diff. */
function explain(c) {
  switch (c.state) {
    case 'absent':
      return {
        cause: `NOTHING IS LISTENING on :${c.port}`,
        meaning:
          'the server this run depends on is gone — it was never started, or it was\n' +
          '          started by a DIFFERENT run which has since exited and taken it with it\n' +
          '          (Playwright kills only the servers it started). Every spec would have\n' +
          '          failed with net::ERR_CONNECTION_REFUSED.',
        fix:
          'run the tier again — it boots its own server by default. If another run of\n' +
          '          this tier is live in this worktree, wait for it rather than sharing its\n' +
          '          server: the server dies with the run that started it.',
      }
    case 'unidentified':
      return {
        cause: `:${c.port} is held by a server that will not identify itself`,
        meaning:
          'it answered, but not with a /__worktree sentinel — so it is an old server\n' +
          '          from before the sentinel existed, a vite whose config lacks\n' +
          '          gallerySentinelPlugin(), a RELEASE cytoanalyst binary (the backend\n' +
          '          sentinel is #[cfg(debug_assertions)] — build with `cargo build`, not\n' +
          '          `--release`), or an unrelated process. It is NOT provably this\n' +
          '          worktree, so anything measured against it is measured against\n' +
          '          unknown source.',
        fix: 'stop that process, or pin this run to a different port.',
      }
    case 'foreign':
      return {
        cause: `:${c.port} belongs to a DIFFERENT worktree`,
        meaning:
          `it identifies as ${c.root}\n` +
          `          but this run is ${c.ownRoot}. Reusing it would test somebody else's\n` +
          '          source tree and report the result as yours — the exact failure that\n' +
          '          produced 9,355 ERR_NETWORK_CHANGED findings once already.',
        fix: 'let the resolver pick a free port (do not pin), or pin an unused one.',
      }
    case 'split':
      return {
        cause: `:${c.port} is held by TWO DIFFERENT servers, one per IP family`,
        meaning:
          `IPv4 and IPv6 localhost report different roots (${c.roots.join(' vs ')}).\n` +
          '          Which one the browser reaches depends on resolver order, so the run\n' +
          '          would be non-deterministic between two source trees.',
        fix: 'stop one of them, then re-run.',
      }
    default:
      return { cause: 'unknown', meaning: '', fix: '' }
  }
}

/** The banner. Its first line is the whole point: a reader must not open a diff. */
export function originBanner(c, { label = 'origin', url = '' } = {}) {
  const e = explain(c)
  return [
    '',
    RULE,
    ' HARNESS FAULT — THIS IS THE TEST RIG, NOT YOUR CODE',
    RULE,
    ` origin  : ${label}${url ? `  ${url}` : ''}`,
    ` cause   : ${e.cause}`,
    ` meaning : ${e.meaning}`,
    ` fix     : ${e.fix}`,
    ` proof   : this run is ${c.ownRoot}`,
    `           :${c.port} says ${c.root ? c.root : `<${c.state}>`}${c.pid ? ` (pid ${c.pid})` : ''}`,
    RULE,
    '',
  ].join('\n')
}

/**
 * The PRE-FLIGHT assertion. Throws a banner unless the origin is provably ours AND
 * actually serving the page the specs will navigate to.
 *
 * Both halves matter. A sentinel-only check passes against a vite that is up but
 * whose entry 404s; a page-only check passes against a stranger. The 132-failure run
 * would have been stopped in under a second by either, and this does both.
 */
export async function assertOriginIsOurs({
  port,
  url,
  label = `:${port}`,
  ownRoot = resolveWorktreeRoot(),
  fetchImpl = fetch,
  timeoutMs = 2000,
}) {
  const c = await classifyOrigin(port, { ownRoot, fetchImpl, timeoutMs })
  if (!originIsOurs(c)) throw new Error(originBanner(c, { label, url }))
  if (url) {
    let ok = false
    let detail = ''
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs * 3)
      const r = await fetchImpl(url, { signal: ac.signal })
      clearTimeout(t)
      ok = r.ok
      detail = `HTTP ${r.status}`
    } catch (e) {
      detail = errCode(e) || String(e?.message || e)
    }
    if (!ok) {
      throw new Error(
        [
          '',
          RULE,
          ' HARNESS FAULT — THIS IS THE TEST RIG, NOT YOUR CODE',
          RULE,
          ` origin  : ${label}  ${url}`,
          ` cause   : the server on :${port} IS this worktree's, but it does not serve the page`,
          ` meaning : ${detail} — the sentinel proves provenance, not that the entry exists.`,
          '           Every spec would have failed on its very first goto().',
          ` fix     : check the vite entry/root for this tier, then re-run.`,
          RULE,
          '',
        ].join('\n'),
      )
    }
  }
  return c
}

/**
 * Is adopting a server this run did not start explicitly requested?
 *
 * The default is NO, everywhere, because "this worktree's server" and "this run's
 * server" are different things and only the second has a lifetime this run controls.
 * `HARNESS_REUSE_SERVER=1` is the repo-wide opt-in; each tier also honours its own
 * name so a developer can enable it for one harness without enabling all of them.
 *
 * Strict `'1'`, never truthiness: a truthiness check makes `…=0` enable the exact
 * thing it plainly asks to disable.
 */
export function reuseRequested(env = process.env, ...names) {
  return ['HARNESS_REUSE_SERVER', ...names].some(n => env[n] === '1')
}

/** Connection-LEVEL failure signatures — the ones that mean "the origin, not the
 *  page". Deliberately narrow: a selector timeout or an assertion failure is the
 *  suite doing its job and must never trip the watchdog. */
export const DEAD_ORIGIN_SIGNATURE =
  /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ECONNREFUSED|ECONNRESET/
