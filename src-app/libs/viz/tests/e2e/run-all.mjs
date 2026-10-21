// run-all.mjs — run EVERY `*.e2e.mjs` spec in this directory against a running showcase.
//
// WHY THIS EXISTS (FIX_ROUND-7 / convergence-6 MEDIUM 2): the annotate-tooling-ux gate tables named
// a hand-maintained list of 10 spec files while the directory held 18. Eight were never run for the
// whole feature, and one of them (`plot-editing`) had been turned RED by the branch's own
// `view.zoom` -> `view.pan` rename without anyone noticing. A hand-listed gate also let
// `mask-and-linking` be gated in rounds 2/3/4 and silently dropped from round 6's table.
//
// So the gate must be the DIRECTORY, not a list: a new spec is picked up automatically and an
// existing one cannot vanish from the gate by being omitted from a markdown table.
//
// Usage:  node tests/e2e/run-all.mjs <BASE_URL> [--only substr] [--skip substr]
// Exit 0 iff every spec exits 0. Each spec's own stdout is streamed through unchanged.
//
// BASE_URL IS REQUIRED — it used to default to `http://localhost:1421`, this package's
// then-committed dev port. That default is the same shared-mutable-resource defect the
// viz e2e config carried: the showcase port is now DERIVED per worktree, so a guessed
// literal would either find nothing (a confusing timeout) or, worse, find a SIBLING
// worktree's showcase and report on the wrong build. `just e2e-viz-package` derives the
// URL and passes it; anything else must say which server it means.

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const only = flag('--only')
const skip = flag('--skip')
const BASE = argv.find(a => a.startsWith('http')) ?? process.env.VIZ_BASE_URL
if (!BASE) {
  console.error(
    'run-all: no BASE_URL given. The showcase port is derived per worktree, so there is no\n' +
      '         safe default to guess — a wrong guess reports on another worktree\'s build.\n' +
      '         Run `just e2e-viz-package` (it boots the showcase and passes the URL), or\n' +
      '         pass one: node tests/e2e/run-all.mjs http://localhost:<port>',
  )
  process.exit(2)
}

// SELF is excluded by name, not by a filter that could also drop a real spec.
const SELF = 'run-all.mjs'
const specs = readdirSync(HERE)
  .filter(f => f.endsWith('.e2e.mjs') && f !== SELF)
  .filter(f => (only ? f.includes(only) : true))
  .filter(f => (skip ? !f.includes(skip) : true))
  .sort()

if (specs.length === 0) {
  console.error('run-all: no *.e2e.mjs specs matched — refusing to report success on an empty set')
  process.exit(2)
}

console.log(`run-all: ${specs.length} spec(s) against ${BASE}\n`)
const results = []
for (const spec of specs) {
  console.log(`\n${'='.repeat(78)}\n▶ ${spec}\n${'='.repeat(78)}`)
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join(HERE, spec), BASE], { stdio: 'inherit' })
  const code = r.status ?? 1
  results.push({ spec, code, ms: Date.now() - t0 })
}

console.log(`\n${'='.repeat(78)}\nrun-all summary (${specs.length} specs)\n${'='.repeat(78)}`)
for (const { spec, code, ms } of results) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${spec.padEnd(42)} exit=${code}  ${(ms / 1000).toFixed(1)}s`)
}
const failed = results.filter(r => r.code !== 0)
console.log(
  failed.length === 0
    ? `\nrun-all: ALL ${specs.length} SPECS PASS`
    : `\nrun-all: ${failed.length}/${specs.length} FAILED — ${failed.map(f => f.spec).join(', ')}`,
)
process.exit(failed.length === 0 ? 0 : 1)
