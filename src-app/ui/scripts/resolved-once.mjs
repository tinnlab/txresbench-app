/**
 * RESOLVE ONCE PER RUN, not once per config evaluation.
 *
 * Playwright loads a config file MORE THAN ONCE: the runner process loads it to
 * start `webServer`s and `globalSetup`, and every worker process loads it again to
 * read `use.baseURL`. A config that resolves a port at module scope therefore
 * resolves it once per process.
 *
 * That was survivable only because the old resolver ADOPTED a server belonging to
 * this worktree: the runner booted one on :21133, the worker re-resolved, found
 * :21133 occupied-but-ours, and adopted it — landing on the same number by accident.
 * The moment reuse became opt-in (because "this worktree's server" is not "this
 * run's server" — see `resolve-viz-port.mjs`), the worker's re-resolution correctly
 * stepped OVER the runner's own server and returned :21134. `use.baseURL` then
 * pointed at a port nothing was listening on while the pre-flight, running in the
 * runner, truthfully reported :21133 healthy. Observed exactly that:
 *
 *     [preflight] viz showcase (dev) :21133 — provably this worktree, serving. ok
 *     Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:21134/…
 *
 * So the resolution is a property of the RUN, and it is carried to the worker
 * processes the only way a value crosses that boundary: `process.env`, set in the
 * runner before it forks. A second evaluation reads the recorded verdict verbatim
 * and does no probing — re-probing is precisely the mistake, since by then the run's
 * own server is on the port and is indistinguishable from any other occupant.
 */

/** Env keys are namespaced + internal: a user setting one by hand would be pinning
 *  a port while bypassing every check, which is what `VIZ_E2E_PORT` used to do. */
const KEY = name => `__HARNESS_RESOLVED_${name}`

/**
 * `resolve()` runs at most once per process tree, keyed by `name`. Synchronous,
 * because a Playwright config is loaded synchronously.
 */
export function resolvedOnce(name, resolve) {
  const k = KEY(name)
  const cached = process.env[k]
  if (cached) {
    try {
      return JSON.parse(cached)
    } catch {
      // A corrupted value must not silently fall through to a fresh resolution that
      // would pick a DIFFERENT port than the run already booted.
      throw new Error(`${k} is set but unparseable (${cached}); refusing to re-resolve mid-run`)
    }
  }
  const v = resolve()
  process.env[k] = JSON.stringify(v)
  return v
}
