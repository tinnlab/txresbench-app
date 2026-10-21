#!/usr/bin/env node
/**
 * E2E ROUTING GATE — every Playwright spec is reachable by exactly one working
 * invocation, BY CONSTRUCTION.
 *
 * ── The bug this exists to stop ────────────────────────────────────────────────
 * `playwright.config.ts` (the full-backend runner, baseURL :4173) declared
 * `testDir: './tests/e2e'` with NO `testIgnore`, while `tests/e2e/visualization/`
 * sat NESTED inside it. So the default run collected all 63 viz specs — 95 of its
 * 217 tests, 44% — and drove them at :4173, where the `viz-showcase.html` they
 * `goto()` does not exist. The one runner that CAN drive them
 * (`playwright.viz.config.ts`, :1421) was invoked by no justfile recipe and no npm
 * script; neither were the gallery or visual configs. Result: 44% of the default
 * run was structurally un-runnable, and three configs had no discoverable
 * invocation at all. Specs rotted for months with every gate green.
 *
 * ── What is checked (all fail-closed, all with positive counts) ────────────────
 * The two failure modes above are checked SEPARATELY, because they are different
 * bugs and a fix for one does not imply the other:
 *
 *  R1 DISJOINT   no config's testDir is nested inside another's. This is what makes
 *                "exactly one runner" achievable by construction rather than by an
 *                exclusion list somebody has to remember to update. It is also the
 *                precise property `tests/e2e/visualization/` violated.
 *  R2 COVERED    every `*.spec.ts` under `tests/` lies under exactly one testDir.
 *                0 ⇒ a spec no runner drives. >1 ⇒ impossible while R1 holds, but
 *                asserted anyway so R1 regressing cannot pass silently here.
 *  R3 NON-EMPTY  every config's testDir contains ≥1 spec. A config pointed at an
 *                empty/renamed dir would otherwise satisfy R1 and R2 trivially.
 *  R4 INVOCABLE  every config has a discoverable npm script that names it, and the
 *                justfile has a recipe that runs that script. A config nobody can
 *                invoke is exactly what let the viz suite rot.
 *  R5 SELF-FOUND configs are DISCOVERED by globbing `playwright*.config.ts`, not
 *                hand-listed — so adding a fifth config without wiring it fails
 *                here instead of quietly joining the un-runnable set.
 *
 * `testDir` is read by IMPORTING each config (node ≥22 strips the types), so this
 * reads what Playwright itself will read — not a regex over the source that a
 * refactor could silently defeat.
 *
 * Usage:  node scripts/check-e2e-routing.mjs          (gate; non-zero on any failure)
 *         node scripts/check-e2e-routing.mjs --json   (machine-readable)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '..')
const REPO = path.resolve(UI, '../..')
const TESTS = path.join(UI, 'tests')

const failures = []
const fail = (id, msg) => failures.push(`${id}: ${msg}`)

// ── discover the configs (R5) ────────────────────────────────────────────────
const configFiles = readdirSync(UI)
  .filter(f => /^playwright(\..+)?\.config\.ts$/.test(f))
  .sort()
if (configFiles.length === 0) {
  console.error('check:e2e-routing FAIL — found no playwright*.config.ts in ' + UI)
  process.exit(1)
}

/** @type {{file:string, testDir:string, abs:string, specs:string[], npmScript:string|null}[]} */
const configs = []
for (const file of configFiles) {
  let mod
  try {
    mod = await import(pathToFileURL(path.join(UI, file)).href)
  } catch (e) {
    fail('R5', `\`${file}\` could not be imported, so its testDir cannot be verified: ${e.message}`)
    continue
  }
  const testDir = mod?.default?.testDir
  if (typeof testDir !== 'string' || testDir.length === 0) {
    fail('R5', `\`${file}\` exports no \`testDir\` — its routing is undeclared.`)
    continue
  }
  const abs = path.resolve(UI, testDir)
  if (!existsSync(abs) || !statSync(abs).isDirectory())
    fail('R5', `\`${file}\` points testDir at \`${testDir}\`, which is not a directory.`)
  configs.push({ file, testDir, abs, specs: [], npmScript: null })
}

// ── R1: testDirs must be pairwise disjoint (no nesting) ──────────────────────
const under = (child, parent) =>
  child === parent || child.startsWith(parent + path.sep)
for (const a of configs) {
  for (const b of configs) {
    if (a === b) continue
    if (under(a.abs, b.abs))
      fail(
        'R1',
        `\`${a.file}\` (testDir ${a.testDir}) is NESTED inside \`${b.file}\` (testDir ${b.testDir}). ` +
          `Both runners collect the same specs, but only one can drive them. Give the inner ` +
          `suite its OWN top-level dir under tests/ — never an exclusion pattern.`,
      )
  }
}

// ── enumerate specs on disk ──────────────────────────────────────────────────
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.spec\.ts$/.test(e.name)) acc.push(p)
  }
  return acc
}
if (!existsSync(TESTS)) {
  console.error(`check:e2e-routing FAIL — no tests/ directory at ${TESTS}`)
  process.exit(1)
}
const specs = walk(TESTS).sort()
if (specs.length === 0) {
  console.error('check:e2e-routing FAIL — found 0 *.spec.ts under tests/; this gate would be vacuous.')
  process.exit(1)
}

// ── R2: exactly one owning config per spec ───────────────────────────────────
for (const spec of specs) {
  const owners = configs.filter(c => under(spec, c.abs))
  for (const o of owners) o.specs.push(spec)
  const rel = path.relative(UI, spec)
  if (owners.length === 0)
    fail(
      'R2',
      `\`${rel}\` is under NO config's testDir — no runner will ever execute it. ` +
        `Move it under one of: ${configs.map(c => c.testDir).join(', ')}.`,
    )
  else if (owners.length > 1)
    fail('R2', `\`${rel}\` is claimed by ${owners.map(o => o.file).join(' AND ')}.`)
}

// ── R3: no config may own zero specs ─────────────────────────────────────────
for (const c of configs)
  if (c.specs.length === 0)
    fail('R3', `\`${c.file}\` collects 0 spec files from \`${c.testDir}\` — a runner with nothing to run.`)

// ── R4: every config has a discoverable invocation ───────────────────────────
const pkg = JSON.parse(readFileSync(path.join(UI, 'package.json'), 'utf8'))
const scripts = pkg.scripts ?? {}
const justfile = readFileSync(path.join(REPO, 'justfile'), 'utf8')
// Strip `#` comment lines: a retired recipe's explanatory prose still names the
// script, and prose is not wiring.
const justCode = justfile
  .split('\n')
  .filter(l => !/^\s*#/.test(l))
  .join('\n')

const DEFAULT_CONFIG = 'playwright.config.ts'
for (const c of configs) {
  // The default config is the one Playwright picks with no `--config`, so its
  // invocation is a bare `playwright test`; every other config must be named.
  const names = Object.entries(scripts).filter(([, cmd]) =>
    c.file === DEFAULT_CONFIG
      ? /\bplaywright test\b/.test(cmd) && !/--config[= ]/.test(cmd)
      : cmd.includes(c.file),
  )
  if (names.length === 0) {
    fail(
      'R4',
      `\`${c.file}\` has NO npm script that invokes it — it is un-runnable by any documented ` +
        `command, which is how ${c.specs.length} spec file(s) rot unnoticed. Add one to ` +
        `src-app/ui/package.json.`,
    )
    continue
  }
  c.npmScript = names[0][0]
  const invoked = names.some(([n]) => new RegExp(`npm run ${n}\\b`).test(justCode))
  if (!invoked)
    fail(
      'R4',
      `npm script(s) ${names.map(([n]) => `\`${n}\``).join('/')} invoke \`${c.file}\`, but no ` +
        `justfile recipe runs any of them — \`just --list\` will not show a way to run it.`,
    )
}

// ── report ───────────────────────────────────────────────────────────────────
const rows = configs.map(c => ({
  config: c.file,
  testDir: c.testDir,
  specFiles: c.specs.length,
  npmScript: c.npmScript ?? '(none)',
}))
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ configs: rows, specFiles: specs.length, failures }, null, 2))
} else {
  const w = (s, n) => String(s).padEnd(n)
  console.log(`\ne2e routing — ${configs.length} config(s), ${specs.length} spec file(s) under tests/`)
  console.log(
    `  ${w('config', 32)}${w('testDir', 24)}${w('specs', 7)}npm script`,
  )
  for (const r of rows)
    console.log(`  ${w(r.config, 32)}${w(r.testDir, 24)}${w(r.specFiles, 7)}${r.npmScript}`)
}

if (failures.length) {
  console.error(`\n✗ check:e2e-routing — ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `\n✓ check:e2e-routing: ${specs.length} spec file(s), each owned by exactly one of ` +
    `${configs.length} disjoint config(s), each with an npm script + a just recipe.`,
)
