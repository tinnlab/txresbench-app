// Tests for `action-refs-lint.mjs` (ai-actions ITEM-10 / TEST-4). Run directly:
//   node scripts/action-refs-lint.test.mjs
//
// Every test builds a fully self-contained temp fixture (its own tiny
// `defineAction`-shaped registry) so nothing here ever touches the real
// project source — the lint is pointed at the fixture via the
// `ACTION_REFS_LINT_SRC_ROOT` env-var override the script exposes for
// exactly this purpose. The final test runs the REAL lint against the REAL
// project (no overrides, read-only) and asserts today's source has zero
// dangling references.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LINT_SCRIPT = path.join(__dirname, 'action-refs-lint.mjs')

// A minimal, self-contained stand-in for the real
// `src/core/actions/defineAction.ts` — same registration shape
// (`getActionRegistry()` -> Map<id, {meta, params, run}>) as the real file
// and as `collect-actions.test.mjs`'s fixture, but with zero runtime
// dependency on `./ctx` / react / react-router-dom.
const FIXTURE_DEFINE_ACTION_TS = `
import type { z } from 'zod'

export interface ActionMeta {
  id: string
  title: string
  permission: string
  mutating: boolean
  kind: 'global'
}

export interface ActionDefinition<TParams = unknown, TResult = unknown> {
  id: string
  title: string
  permission: string
  mutating: boolean
  params: z.ZodType<TParams>
  run: (params: TParams, ctx?: unknown) => Promise<TResult> | TResult
}

interface RegisteredAction {
  meta: ActionMeta
  params: z.ZodType<unknown>
  run: (params: unknown, ctx?: unknown) => unknown
}

const registry = new Map<string, RegisteredAction>()

export function defineAction<TParams, TResult>(
  def: ActionDefinition<TParams, TResult>,
): ActionDefinition<TParams, TResult> {
  if (registry.has(def.id)) {
    throw new Error('[fixture-actions] duplicate action id: ' + def.id)
  }
  registry.set(def.id, {
    meta: {
      id: def.id,
      title: def.title,
      permission: def.permission,
      mutating: def.mutating,
      kind: 'global',
    },
    params: def.params as z.ZodType<unknown>,
    run: def.run as (params: unknown, ctx?: unknown) => unknown,
  })
  return def
}

export function getActionRegistry(): ReadonlyMap<string, RegisteredAction> {
  return registry
}
`

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'action-refs-lint-test-'))
  const srcRoot = path.join(root, 'src')
  mkdirSync(path.join(srcRoot, 'core', 'actions', 'builtin'), { recursive: true })
  mkdirSync(path.join(srcRoot, 'components'), { recursive: true })
  writeFileSync(path.join(srcRoot, 'core', 'actions', 'defineAction.ts'), FIXTURE_DEFINE_ACTION_TS)
  return { root, srcRoot }
}

function writeRegisteredAction(srcRoot, id) {
  writeFileSync(
    path.join(srcRoot, 'core', 'actions', 'builtin', 'testActions.ts'),
    `
    import { z } from 'zod'
    import { defineAction } from '../defineAction'

    defineAction({
      id: ${JSON.stringify(id)},
      title: 'A valid test action',
      permission: 'foo::use',
      mutating: false,
      params: z.object({}),
      run: () => {},
    })
    `,
  )
}

function writeComponent(srcRoot, contents) {
  writeFileSync(path.join(srcRoot, 'components', 'Foo.tsx'), contents)
}

function runLint({ srcRoot }) {
  // A fixture root holds 2-4 files, far below the guard's committed ITEM-37 scan
  // floor. Lower the floor EXPLICITLY (the documented test-only override) so these
  // tests exercise the lint RULES; `guard-floors.test.mjs` proves the floor still
  // fires when it is left unset.
  const env = {
    ...process.env,
    ACTION_REFS_LINT_SRC_ROOT: srcRoot,
    ACTION_REFS_LINT_MIN_SOURCE_FILES: '1',
  }
  return spawnSync(process.execPath, [LINT_SCRIPT], { env, encoding: 'utf8' })
}

test('FAILS on <ActionButton action="does.not.exist"> — dangling reference', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeRegisteredAction(srcRoot, 'test.validAction')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <ActionButton action="does.not.exist" />
      }
      `,
    )
    const result = runLint({ srcRoot })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /FAILED/)
    assert.match(result.stderr, /"does\.not\.exist"/)
    assert.match(result.stderr, /ActionButton/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FAILS on runAction(\'nope\') — dangling reference', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeRegisteredAction(srcRoot, 'test.validAction')
    writeComponent(
      srcRoot,
      `
      import { runAction } from '../core/actions/defineAction'
      export function bar() {
        runAction('nope')
      }
      `,
    )
    const result = runLint({ srcRoot })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /FAILED/)
    assert.match(result.stderr, /"nope"/)
    assert.match(result.stderr, /runAction/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PASSES when the ActionButton id is registered', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeRegisteredAction(srcRoot, 'test.validAction')
    writeComponent(
      srcRoot,
      `
      export function Foo() {
        return <ActionButton action="test.validAction" />
      }
      `,
    )
    const result = runLint({ srcRoot })
    assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}`)
    assert.match(result.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PASSES when the runAction id is registered', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeRegisteredAction(srcRoot, 'test.validAction')
    writeComponent(
      srcRoot,
      `
      import { runAction } from '../core/actions/defineAction'
      export function bar() {
        runAction('test.validAction')
      }
      `,
    )
    const result = runLint({ srcRoot })
    assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}`)
    assert.match(result.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dynamic (non-string-literal) references are SKIPPED, not failed', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeRegisteredAction(srcRoot, 'test.validAction')
    writeComponent(
      srcRoot,
      `
      import { runAction } from '../core/actions/defineAction'
      export function bar(actionId: string) {
        runAction(actionId)
      }
      export function Foo({ dynamicId }: { dynamicId: string }) {
        return <ActionButton action={dynamicId} />
      }
      `,
    )
    const result = runLint({ srcRoot })
    assert.equal(result.status, 0, `expected exit 0 (dynamic refs never fail). stderr:\n${result.stderr}`)
    assert.match(result.stdout, /skipped 2 dynamic/)
    assert.match(result.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FAILS clearly listing MULTIPLE offenders at once', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeRegisteredAction(srcRoot, 'test.validAction')
    writeComponent(
      srcRoot,
      `
      import { runAction } from '../core/actions/defineAction'
      export function Foo() {
        runAction('first.bad')
        return <ActionButton action="second.bad" />
      }
      `,
    )
    const result = runLint({ srcRoot })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /2 referenced action id\(s\)/)
    assert.match(result.stderr, /"first\.bad"/)
    assert.match(result.stderr, /"second\.bad"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runs against the REAL project source (no overrides, read-only) and passes', () => {
  const result = spawnSync(process.execPath, [LINT_SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /OK/)
})
