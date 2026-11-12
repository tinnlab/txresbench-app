#!/usr/bin/env node
/**
 * `npm run viz-showcase` — boot the @txresbench/viz showcase on THIS worktree's derived port.
 *
 * The blessed human entry point, and the third consumer of the viz port after
 * `playwright.viz.config.ts` and the `e2e-viz-package` justfile recipe. All three
 * derive from one place so a developer's showcase, the viz e2e tier, and the package
 * e2e runner land on ONE server per worktree — reusable, never shared across worktrees.
 *
 * The package's own `dev` script deliberately names NO port now: a committed literal
 * there was a shared mutable resource (the old :1421, which the e2e config also pinned,
 * so a developer's showcase and the tier's fought over one port in a single tree and
 * two trees fought over it globally). Ports are decided HERE and forwarded.
 *
 * `VIZ_E2E_PORT=<n>` pins it; extra args are forwarded to vite.
 */
import { spawn } from 'node:child_process'
import { resolveVizPort } from './resolve-viz-port.mjs'

// `allowReuse: true` EXPLICITLY, because reuse is opt-in everywhere else now (a
// TEST run must never adopt a server another run owns — see the resolver's header).
// This launcher is the one caller for which adoption is the whole point: a human
// asking for the showcase wants to be told it is already up, not to be given a
// second one on the next port.
const { port, reused } = await resolveVizPort('vizShowcase', { allowReuse: true })
if (reused) {
  console.log(
    `[viz-showcase] this worktree's showcase is ALREADY serving on :${port} ` +
      '(proved via /__worktree) — open it rather than starting a second one.',
  )
  process.exit(0)
}
console.log(`[viz-showcase] http://localhost:${port}/viz-showcase.html`)

const child = spawn(
  'npm',
  [
    '--workspace',
    '@txresbench/viz',
    'run',
    'dev',
    '--',
    '--port',
    String(port),
    '--strictPort',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', cwd: new URL('../../../', import.meta.url).pathname },
)
// Forward the signals a developer actually sends, so Ctrl-C stops the server rather
// than orphaning it on a port nothing will reuse.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', code => process.exit(code ?? 1))
