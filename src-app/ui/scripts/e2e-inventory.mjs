#!/usr/bin/env node
/**
 * E2E INVENTORY — what each runner ACTUALLY collects, and what it silently doesn't.
 *
 * `scripts/check-e2e-routing.mjs` proves every spec file is OWNED by exactly one
 * config. That is a routing property and it is checked statically. This script
 * answers the different, run-time question: of the files a config owns, how many
 * actually register tests?
 *
 * Two mechanisms make a spec file collect ZERO tests without anyone noticing:
 *
 *  1. A config-level `grepInvert` (`playwright.config.ts` excludes `@acceptance`
 *     unless `CYTO_E2E_REAL_COMPUTE=1`). This one is loud — the config prints a
 *     banner naming the excluded specs.
 *  2. A file-level `if (REAL_COMPUTE) { test.describe(...) }` wrapper. This one is
 *     SILENT. The file is collected, evaluated, and registers nothing; Playwright
 *     reports no skip, because there is no test to skip. `playwright.config.ts`'s
 *     own R3-114 comment condemns exactly this shape ("it removes the spec from
 *     COLLECTION, so its absence is invisible in the output") — for `testIgnore`.
 *     A module-level `if` is the same hazard with a different spelling, and 14
 *     files currently use it.
 *
 * So: print, per config, spec-files-on-disk vs tests-collected vs files-that-
 * collected-nothing, and name the silent ones. `--list` boots no webServer, so
 * this is cheap. It REPORTS; it does not gate (the gated properties live in
 * check-e2e-routing.mjs) — turning "14 files need a sandbox host" into a hard
 * failure on every dev box is not the fix, knowing about them is.
 *
 * Usage:  node scripts/e2e-inventory.mjs [--json]
 *         CYTO_E2E_REAL_COMPUTE=1 node scripts/e2e-inventory.mjs   (the delta is the point)
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '..')

const configFiles = readdirSync(UI)
  .filter(f => /^playwright(\..+)?\.config\.ts$/.test(f))
  .sort()

function walk(dir, acc = []) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.spec\.ts$/.test(e.name)) acc.push(p)
  }
  return acc
}

const report = []
for (const file of configFiles) {
  const mod = await import(pathToFileURL(path.join(UI, file)).href)
  const testDir = mod?.default?.testDir ?? '(none)'
  const abs = path.resolve(UI, testDir)
  const onDisk = walk(abs).map(p => path.relative(abs, p)).sort()

  let json
  try {
    const out = execFileSync(
      'npx',
      ['playwright', 'test', '--config=' + file, '--list', '--reporter=json'],
      { cwd: UI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    )
    json = JSON.parse(out)
  } catch (e) {
    report.push({ config: file, testDir, onDisk: onDisk.length, error: e.message.split('\n')[0] })
    continue
  }
  const collected = new Map()
  const visit = s => {
    for (const sub of s.suites ?? []) visit(sub)
    for (const sp of s.specs ?? [])
      collected.set(sp.file, (collected.get(sp.file) ?? 0) + sp.tests.length)
  }
  for (const s of json.suites ?? []) visit(s)
  const tests = [...collected.values()].reduce((a, b) => a + b, 0)
  const silent = onDisk.filter(f => !collected.has(f))
  report.push({ config: file, testDir, onDisk: onDisk.length, files: collected.size, tests, silent })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const real = !!process.env.CYTO_E2E_REAL_COMPUTE
console.log(`\ne2e inventory  (CYTO_E2E_REAL_COMPUTE=${real ? '1' : 'unset'})`)
const w = (s, n) => String(s).padEnd(n)
console.log(`  ${w('config', 32)}${w('testDir', 22)}${w('files', 7)}${w('collect', 9)}${w('tests', 7)}silent`)
let totalTests = 0
let totalSilent = 0
for (const r of report) {
  if (r.error) {
    console.log(`  ${w(r.config, 32)}${w(r.testDir, 22)}${w(r.onDisk, 7)}ERROR: ${r.error}`)
    continue
  }
  totalTests += r.tests
  totalSilent += r.silent.length
  console.log(
    `  ${w(r.config, 32)}${w(r.testDir, 22)}${w(r.onDisk, 7)}${w(r.files, 9)}${w(r.tests, 7)}${r.silent.length}`,
  )
}
console.log(`\n  TOTAL: ${totalTests} test(s) collected; ${totalSilent} spec file(s) collected NOTHING.`)
for (const r of report) {
  if (!r.silent?.length) continue
  console.log(`\n  ${r.config} — ${r.silent.length} file(s) register zero tests:`)
  for (const f of r.silent) console.log(`    ${path.posix.join(r.testDir, f)}`)
}
if (totalSilent > 0 && !real)
  console.log(
    `\n  Most of these are host-capability gated on CYTO_E2E_REAL_COMPUTE (bwrap + a staged\n` +
      `  analysis rootfs). Re-run with CYTO_E2E_REAL_COMPUTE=1 to see the delta. A file that\n` +
      `  collects nothing is NOT a passing file — do not report a green e2e number without\n` +
      `  saying how many registered no tests at all.`,
  )
