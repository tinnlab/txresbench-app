/**
 * TEST-46 (ITEM-40) — a gate cannot be silently switched off by deleting its subject.
 *
 * ITEM-40 re-wired the repo's gate recipes for the packages and scripts this round
 * deletes. That is a class of change with a very quiet failure mode: `just check` invokes
 * a recipe that runs a script that no longer exists, the shell reports "command not
 * found", and — depending on how the recipe is written — the gate either dies with a
 * confusing error or, worse, keeps going. Either way the check it was running stops
 * running, and nothing says so.
 *
 * So: every script named by `just check`'s recipe chain and by `ui/package.json`'s
 * `check` chain must EXIST ON DISK, the retired recipe must be gone, and the surviving
 * ones must still be wired in. Every assertion carries a positive count, because a
 * parser that extracted nothing would otherwise report a perfectly clean wiring.
 *
 * STRIP (single-cell): the surface-baseline device (its subject, the workbench surface,
 * left in ITEM-4), the workspace-package-suite gate (its subjects left in ITEM-2/4) and
 * the submodule half of that gate (it existed only to keep the package gate's workspace
 * globs honest) left with their subjects; the remaining wiring assertions below are the
 * kept chain's own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '..')
const REPO = path.resolve(UI, '../..')

const justfile = () => readFileSync(path.join(REPO, 'justfile'), 'utf8')
const uiPkg = () => JSON.parse(readFileSync(path.join(UI, 'package.json'), 'utf8'))

/** Strip `#` comments so the RETIRED recipe's explanatory block (which still names the
 *  retired recipe, deliberately, so it is not silently re-added) is not read as wiring. */
function justCode() {
  return justfile()
    .split('\n')
    .filter(l => !/^\s*#/.test(l))
    .join('\n')
}

/** The body lines of a just recipe, by name. */
function recipeBody(name) {
  const lines = justfile().split('\n')
  const start = lines.findIndex(l => new RegExp(`^${name}(\\s|:)`).test(l) && l.includes(':'))
  if (start < 0) return null
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    if (!/^\s/.test(l)) break // a new top-level recipe / assignment
    body.push(l.trim())
  }
  return body
}

test('TEST-46: `just check` exists and invokes a real chain', () => {
  const body = recipeBody('check')
  assert.ok(body, 'the `check` recipe is missing from the justfile')
  // POSITIVE COUNT: an emptied recipe would pass every "references no deleted script"
  // assertion below.
  assert.ok(body.length >= 5, `\`just check\` runs only ${body.length} step(s): ${body.join(' | ')}`)
  assert.ok(
    body.some(l => l.includes('cargo check')),
    '`just check` must still run the backend check',
  )
  assert.ok(
    body.some(l => l.includes('npm run check')),
    '`just check` must still run the frontend check',
  )
})

test('TEST-46: the RETIRED `check-ts-packages` recipe is gone from executable justfile code', () => {
  // ITEM-40 retired it: it ran a per-package `npm test` for a package that no longer
  // exists. The explanatory comment recording the retirement
  // stays (so it is not re-added by accident) — hence the comment-stripped read.
  const code = justCode()
  assert.ok(!/^check-ts-packages\s*:/m.test(code), 'the retired recipe is still defined')
  assert.ok(!/\bjust\s+check-ts-packages\b/.test(code), 'something still invokes the retired recipe')
  assert.ok(
    !/packages\/workbench-api/.test(code),
    'executable justfile code still points at the deleted workbench-api package',
  )
  // The retirement is documented — deleting the comment as well would let a future
  // change re-add it with no signal.
  assert.match(justfile(), /RETIRED.*ITEM-40/s)
})

test('TEST-46: the RETIRED single-cell recipes are gone from executable justfile code', () => {
  // ITEM-2/ITEM-4 retired these with their subjects (processor packages, env recipes,
  // the coercion corpus, the sourcing viz lib, the visual/viz e2e tiers, the processor
  // inventory and the acceptance gate). A comment tidies nothing about executable code.
  const code = justCode()
  for (const r of [
    'check-py',
    'check-packages',
    'check-coercion',
    'check-processor-versions',
    'check-r-regime',
    'e2e-viz',
    'e2e-viz-package',
    'e2e-visual',
    'e2e-inventory',
    'verify-acceptance',
  ]) {
    assert.ok(!new RegExp(`^${r}\\s*:`).test(code), `the retired \`${r}\` recipe is still defined`)
    assert.ok(!new RegExp(`\\bjust\\s+${r}\\b`).test(code), `something still invokes \`just ${r}\``)
  }
})

test('TEST-46: every script NAMED by a justfile recipe exists on disk', () => {
  // The class of defect, not just the two known instances.
  const refs = [...justCode().matchAll(/\{\{justfile_directory\(\)\}\}\/([\w./-]+\.(?:mjs|sh|py))/g)].map(
    m => m[1],
  )
  assert.ok(refs.length >= 3, `only ${refs.length} script reference(s) parsed out of the justfile`)
  const missing = refs.filter(r => !existsSync(path.join(REPO, r)))
  assert.deepEqual(missing, [], 'these justfile recipes name scripts that do not exist')
})

test("TEST-46: `ui`'s `check` chain keeps the surviving lints and has retired the layer-boundary one", () => {
  const chain = uiPkg().scripts.check
  assert.ok(chain, 'ui/package.json has no `check` script')
  // ITEM-4 removed `src/modules/workbench` — the layer-boundary ratchet's only
  // subject — so its guard went with it. Assert the retirement so a workbench-shaped
  // module cannot come back without a guard (and the chain stays real).
  assert.doesNotMatch(chain, /lint-layer-boundary/, 'the retired workbench boundary lint is back in `npm run check`')
  assert.ok(!existsSync(path.join(HERE, 'lint-layer-boundary.mjs')))
  assert.match(chain, /tsc --noEmit/)
  assert.match(chain, /lint-no-domain-in-builtin/)
  assert.match(chain, /test:unit/)
})

test('TEST-46: every script NAMED by ui/package.json exists on disk', () => {
  const scripts = uiPkg().scripts
  assert.ok(Object.keys(scripts).length >= 8, 'the script list is implausibly short')
  const refs = new Set()
  for (const cmd of Object.values(scripts))
    for (const m of String(cmd).matchAll(/(?:node|npx tsx)\s+([\w./-]+\.mjs)/g)) refs.add(m[1])
  assert.ok(refs.size >= 5, `only ${refs.size} script reference(s) parsed out of ui/package.json`)
  const missing = [...refs].filter(r => !existsSync(path.resolve(UI, r)))
  assert.deepEqual(missing, [], 'these npm scripts name files that do not exist')
})

test('the e2e-ROUTING gate is wired, and every e2e runner has a recipe', () => {
  // The routing gate is what stops 44% of the default e2e run from being structurally
  // un-runnable — and it is exactly the shape of gate this file exists to keep switched
  // on. `check-e2e-routing.mjs` enforces "every config has an npm script + a just
  // recipe"; nothing INSIDE it can enforce that it is still itself called.
  const scripts = uiPkg().scripts
  assert.match(
    scripts.check,
    /check:e2e-routing/,
    'the e2e-routing gate is no longer wired into `npm run check`',
  )
  assert.match(scripts['check:e2e-routing'] ?? '', /check-e2e-routing\.mjs/)
  assert.ok(existsSync(path.join(HERE, 'check-e2e-routing.mjs')))

  // One recipe per runner. Hand-listed ON PURPOSE: `check-e2e-routing.mjs` DERIVES the
  // config set, so on its own, deleting a config would delete its own requirement.
  // Naming the recipes here makes removing one a deliberate edit.
  const code = justCode()
  for (const r of ['e2e', 'e2e-gallery', 'e2e-all'])
    assert.match(code, new RegExp(`^${r}:`, 'm'), `the \`just ${r}\` recipe is missing`)
  for (const s of ['test:e2e', 'test:e2e:gallery'])
    assert.ok(scripts[s], `ui/package.json has no \`${s}\` script`)

  // The retired tiers' invocations must not be referenced anywhere executable: a dead
  // `test:e2e:viz` script or `playwright.viz.config.ts` mention is a subjectless runner.
  for (const s of ['test:e2e:viz', 'test:e2e:visual', 'viz-showcase', 'check:surface-baseline'])
    assert.ok(!scripts[s], `ui/package.json still has the retired \`${s}\` script`)
  assert.ok(!existsSync(path.join(UI, 'playwright.viz.config.ts')), 'playwright.viz.config.ts is back')
  assert.ok(!existsSync(path.join(UI, 'playwright.visual.config.ts')), 'playwright.visual.config.ts is back')
  assert.ok(!existsSync(path.join(HERE, 'e2e-inventory.mjs')), 'e2e-inventory.mjs is back')

  // No config may reacquire a `testIgnore`: an exclusion pattern is how the viz suite got
  // swept into a runner that could not drive it, and — as `playwright.config.ts`'s own
  // R3-114 note says — an exclusion removes a spec from COLLECTION, so its absence never
  // shows in the output. Route by DIRECTORY.
  for (const f of ['playwright.config.ts', 'playwright.gallery.config.ts'])
    assert.ok(
      !/^\s*testIgnore\s*:/m.test(readFileSync(path.join(UI, f), 'utf8')),
      `${f} reintroduced a \`testIgnore\` — route by DIRECTORY, not by exclusion`,
    )
})

test('TEST-46: the RETIRED single-cell UI scripts are gone', () => {
  // ITEM-4 removed these with their subjects (the viz showcase/bench/parity/render
  // scripts with the sourcing viz lib, the workbench surface-drift device with the
  // workbench, the processor inventory with the processors suite).
  for (const f of [
    'capture-surface-baseline.mjs',
    'capture-surface-baseline.test.mjs',
    'viz-showcase.mjs',
    'viz-gallery-verify.mjs',
    'viz-parity-verify.mjs',
    'viz-bench.mjs',
    'viz-perf.mjs',
    'viz-render-smoke.mjs',
    'resolve-viz-port.mjs',
    'resolve-viz-port.test.mjs',
    'e2e-inventory.mjs',
    'lint-layer-boundary.mjs',
    'lint-layer-boundary.test.mjs',
    'layer-boundary-baseline.json',
    'lint-positional-declaration.mjs',
    'lint-positional-declaration.test.mjs',
    'positional-declaration-baseline.json',
  ])
    assert.ok(!existsSync(path.join(HERE, f)), `the retired script ${f} is back`)
})

