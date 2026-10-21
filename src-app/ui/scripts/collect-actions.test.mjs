// Tests for `collect-actions.mjs` (ai-mcp ITEM-15). Run directly:
//   node scripts/collect-actions.test.mjs
//
// Every failure-path test builds a fully self-contained temp fixture (its own
// tiny `defineAction`-shaped registry + its own minimal `Permissions` enum) so
// nothing here ever touches the real project source/manifest — the collector
// is pointed at the fixture via the `COLLECT_ACTIONS_SRC_ROOT` /
// `COLLECT_ACTIONS_MANIFEST_PATH` env-var overrides the script exposes for
// exactly this purpose. The final test runs the REAL collector against the
// REAL project (no overrides, --check only — never mutates anything) and
// asserts today's committed manifest is parity-clean.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COLLECTOR_SCRIPT = path.join(__dirname, 'collect-actions.mjs')

// A minimal, self-contained stand-in for the real
// `src/core/actions/defineAction.ts` — same registration shape
// (`getActionRegistry()` -> Map<id, {meta, params, run}>), but with zero
// runtime dependency on `./ctx` / react / react-router-dom, so fixtures don't
// need those installed relative to an arbitrary temp directory.
const FIXTURE_DEFINE_ACTION_TS = `
import type { z } from 'zod'

export interface ActionMeta {
  id: string
  title: string
  permission: string
  mutating: boolean
  kind: 'global' | 'instance'
  stateful: boolean
  surfaces: { palette: boolean; ai: boolean }
  context: string
}

export interface ActionDefinition<TParams = unknown, TResult = unknown> {
  id: string
  title: string
  permission: string
  mutating: boolean
  kind?: 'global' | 'instance'
  stateful?: boolean
  surfaces?: { palette?: boolean; ai?: boolean }
  context?: string
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
      kind: def.kind ?? 'global',
      stateful: def.stateful ?? false,
      surfaces: {
        palette: def.surfaces?.palette ?? true,
        ai: def.surfaces?.ai ?? true,
      },
      context: def.context ?? 'global',
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

// A minimal stand-in for `src/api-client/permissions.ts`'s generated
// `Permissions` enum (it lived in `types.ts` until the generator split the
// client into four files). Deliberately small + fixture-local so "unknown
// permission" tests don't depend on (or drift with) the real project's
// permission set.
const FIXTURE_PERMISSIONS_TS = `
export enum Permissions {
  FooUse = 'foo::use',
  BarUse = 'bar::use',
}
`

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'collect-actions-test-'))
  const srcRoot = path.join(root, 'src')
  mkdirSync(path.join(srcRoot, 'core', 'actions', 'builtin'), { recursive: true })
  mkdirSync(path.join(srcRoot, 'api-client'), { recursive: true })
  writeFileSync(path.join(srcRoot, 'core', 'actions', 'defineAction.ts'), FIXTURE_DEFINE_ACTION_TS)
  writeFileSync(path.join(srcRoot, 'api-client', 'permissions.ts'), FIXTURE_PERMISSIONS_TS)
  return { root, srcRoot }
}

function writeActionsFile(srcRoot, contents) {
  writeFileSync(
    path.join(srcRoot, 'core', 'actions', 'builtin', 'testActions.ts'),
    contents,
  )
}

function runCollector({ srcRoot, manifestPath, viewSpecRoot, args = ['--check'] }) {
  const env = { ...process.env }
  if (srcRoot) {
    env.COLLECT_ACTIONS_SRC_ROOT = srcRoot
    // A fixture root holds 2-4 files and (deliberately) no view_specs, far below the
    // collector's committed ITEM-37 scan floors. Lower them EXPLICITLY via the
    // documented test-only overrides so these tests reach the RULES they are about;
    // `guard-floors.test.mjs` proves the floors still fire when left unset (it
    // overrides only the ROOT).
    env.COLLECT_ACTIONS_MIN_SOURCE_FILES = '1'
    env.COLLECT_ACTIONS_MIN_VIEWSPEC_FILES = '0'
  }
  if (manifestPath) env.COLLECT_ACTIONS_MANIFEST_PATH = manifestPath
  if (viewSpecRoot) env.COLLECT_ACTIONS_VIEWSPEC_ROOT = viewSpecRoot
  else if (srcRoot) {
    // FIXTURE mode (a temp `srcRoot` fixture): isolate from the REAL
    // `src-app/packages` view_specs, else the collector's default root folds
    // the real `filter.yaml` (jobs::use) into fixture assertions (the
    // view_spec-glob's test-isolation gap). A missing root → zero view_spec
    // actions (tolerated). REAL-manifest tests pass NO srcRoot → real default
    // (they must scan the real filter.yaml to match the committed manifest).
    env.COLLECT_ACTIONS_VIEWSPEC_ROOT = path.resolve('__no_viewspec_root_for_fixture_tests__')
  }
  return spawnSync(process.execPath, [COLLECTOR_SCRIPT, ...args], {
    env,
    encoding: 'utf8',
  })
}

// The committed declarative `view_spec` fixture tree (processor-registry ITEM-10
// / TEST-6): `<root>/<processor>/ui/*.yaml`.
const VIEWSPEC_FIXTURE_ROOT = path.resolve(
  __dirname,
  '..',
  'src',
  'modules',
  'workbench',
  'core',
  '__fixtures__',
)

test('--check fails when an action is missing a permission', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.missingPermission',
        title: 'An action with no permission',
        permission: '',
        mutating: false,
        params: z.object({}),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const result = runCollector({ srcRoot, manifestPath })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /missing a permission/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check fails when an action declares an unknown permission', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.unknownPermission',
        title: 'An action with a made-up permission',
        permission: 'not::a-real-permission',
        mutating: false,
        params: z.object({}),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const result = runCollector({ srcRoot, manifestPath })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /unknown permission "not::a-real-permission"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check fails when a kind:instance action does not declare view_id as a required param', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.instanceMissingViewId',
        title: 'An instance action that forgot view_id',
        permission: 'foo::use',
        mutating: true,
        kind: 'instance',
        // No view_id anywhere in params — the backend could never address
        // this action's target, even though describe_capability would still
        // advertise view_id_required: true for it.
        params: z.object({ value: z.number() }),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const result = runCollector({ srcRoot, manifestPath, args: [] })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /instance-shape gate FAILED/)
    assert.match(result.stderr, /test\.instanceMissingViewId/)
    assert.match(result.stderr, /view_id/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check passes when a kind:instance action declares view_id as a required param', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.instanceWithViewId',
        title: 'A well-formed instance action',
        permission: 'foo::use',
        mutating: true,
        stateful: true,
        kind: 'instance',
        params: z.object({ view_id: z.string(), value: z.number(), expected: z.string() }),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const genResult = runCollector({ srcRoot, manifestPath, args: [] })
    assert.equal(genResult.status, 0, `regen failed. stderr:\n${genResult.stderr}`)
    const checkResult = runCollector({ srcRoot, manifestPath })
    assert.equal(checkResult.status, 0, `expected exit 0. stderr:\n${checkResult.stderr}`)
    assert.match(checkResult.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check fails on a stale/edited committed manifest (drift)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.driftAction',
        title: 'A perfectly valid action',
        permission: 'foo::use',
        mutating: true,
        params: z.object({ thing: z.string() }),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    // A manifest that is well-formed but stale (wrong title) relative to what
    // the collector would generate from the fixture source above.
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          actions: [
            {
              id: 'test.driftAction',
              title: 'A STALE title that no longer matches the source',
              kind: 'global',
              mutating: true,
              permission: 'foo::use',
              params_schema: {
                type: 'object',
                required: ['thing'],
                additionalProperties: false,
                properties: { thing: { type: 'string' } },
              },
            },
          ],
        },
        null,
        2,
      ) + '\n',
    )
    const result = runCollector({ srcRoot, manifestPath })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /DRIFT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check passes on a fixture whose committed manifest matches the source exactly', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.okAction',
        title: 'A perfectly valid action',
        permission: 'bar::use',
        mutating: false,
        params: z.object({ name: z.string() }),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    // First regenerate for real (default mode), then --check must pass
    // against exactly what was just written — proves the two modes agree.
    const genResult = runCollector({ srcRoot, manifestPath, args: [] })
    assert.equal(genResult.status, 0, `regen failed. stderr:\n${genResult.stderr}`)
    const checkResult = runCollector({ srcRoot, manifestPath })
    assert.equal(checkResult.status, 0, `expected exit 0. stderr:\n${checkResult.stderr}`)
    assert.match(checkResult.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('toParamsSchema() converts a representative zod object to CONTRACT.md\'s exact shape', () => {
  // Exercises the REAL conversion (the collector's own `toParamsSchema`,
  // reached via the real regen code path — not a reimplementation of the
  // zod->JSON-Schema logic here) against a schema covering every property
  // kind CONTRACT.md's manifest examples + the Rust deserializer care about:
  // required string/number/boolean/array-of-string props, plus one optional
  // prop (must be OMITTED from `required`), and asserts the exact output key
  // set/order/shape: `type`, `required`, `additionalProperties`,
  // `properties` — no `$schema`, no `$id`.
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.richParams',
        title: 'An action with a representative params shape',
        permission: 'foo::use',
        mutating: true,
        params: z.object({
          name: z.string(),
          count: z.number(),
          active: z.boolean(),
          tags: z.array(z.string()),
          note: z.string().optional(),
        }),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const genResult = runCollector({ srcRoot, manifestPath, args: [] })
    assert.equal(genResult.status, 0, `regen failed. stderr:\n${genResult.stderr}`)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.actions.length, 1)
    const paramsSchema = manifest.actions[0].params_schema

    assert.deepEqual(paramsSchema, {
      type: 'object',
      required: ['name', 'count', 'active', 'tags'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
    })
    // Exactly these four top-level keys — no `$schema`/`$id` leaking through
    // from zod's raw `z.toJSONSchema()` output.
    assert.deepEqual(Object.keys(paramsSchema).sort(), [
      'additionalProperties',
      'properties',
      'required',
      'type',
    ])
    assert.ok(!('$schema' in paramsSchema))
    assert.ok(!('$id' in paramsSchema))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check fails clearly when the committed manifest file is missing', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.okAction',
        title: 'A perfectly valid action',
        permission: 'bar::use',
        mutating: false,
        params: z.object({ name: z.string() }),
        run: () => {},
      })
      `,
    )
    // Deliberately never written — exercises the `!existsSync(MANIFEST_PATH)`
    // branch of `--check`.
    const manifestPath = path.join(root, 'frontend-actions.json')
    const result = runCollector({ srcRoot, manifestPath })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /committed manifest missing/)
    assert.match(result.stderr, new RegExp(manifestPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── W1 ITEM-5 (TEST-109): the collector recognizes `surfaces`/`context`,
//    records `context` in each entry, EXCLUDES `surfaces.ai:false` actions from
//    the emitted AI manifest, and stays byte-stable for unknown/default meta.

test('records the `context` field on each manifest entry (default "global"; explicit preserved)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.globalCtx',
        title: 'A default-context action',
        permission: 'foo::use',
        mutating: true,
        params: z.object({ x: z.string() }),
        run: () => {},
      })

      defineAction({
        id: 'test.workbenchCtx',
        title: 'A workbench-context instance action',
        permission: 'bar::use',
        mutating: true,
        kind: 'instance',
        context: 'workbench',
        params: z.object({ view_id: z.string() }),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const genResult = runCollector({ srcRoot, manifestPath, args: [] })
    assert.equal(genResult.status, 0, `regen failed. stderr:\n${genResult.stderr}`)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const byId = Object.fromEntries(manifest.actions.map(a => [a.id, a]))
    assert.equal(byId['test.globalCtx'].context, 'global')
    assert.equal(byId['test.workbenchCtx'].context, 'workbench')
    // Byte-stable for unknown/default meta: `surfaces` is NEVER emitted (used
    // only to filter), and no field beyond the fixed whitelist leaks through.
    assert.ok(!('surfaces' in byId['test.globalCtx']))
    assert.deepEqual(Object.keys(byId['test.globalCtx']).sort(), [
      'context',
      'id',
      'kind',
      'mutating',
      'params_schema',
      'permission',
      'stateful',
      'title',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EXCLUDES a `surfaces:{ai:false}` action from the AI manifest (kept only in the palette)', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'test.aiVisible',
        title: 'An AI-visible action',
        permission: 'foo::use',
        mutating: false,
        params: z.object({}),
        run: () => {},
      })

      defineAction({
        id: 'test.paletteOnly',
        title: 'A palette-only action (opted out of AI)',
        permission: 'foo::use',
        mutating: false,
        surfaces: { ai: false },
        params: z.object({}),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const genResult = runCollector({ srcRoot, manifestPath, args: [] })
    assert.equal(genResult.status, 0, `regen failed. stderr:\n${genResult.stderr}`)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const ids = manifest.actions.map(a => a.id)
    assert.ok(ids.includes('test.aiVisible'), 'ai:true action should be present')
    assert.ok(!ids.includes('test.paletteOnly'), 'ai:false action must be excluded from the AI manifest')

    // And --check agrees with the just-written manifest (excluded action stays out).
    const checkResult = runCollector({ srcRoot, manifestPath })
    assert.equal(checkResult.status, 0, `expected exit 0. stderr:\n${checkResult.stderr}`)
    assert.match(checkResult.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check passes against the REAL committed manifest (no overrides, read-only)', () => {
  const result = runCollector({})
  assert.equal(result.status, 0, `expected exit 0. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  assert.match(result.stdout, /OK/)
})

// ── TEST-6 (ITEM-10) — declarative view_spec action collection ────────────────

/** A fixture SRC_ROOT whose `Permissions` enum contains the fixture view_spec's
 *  permission (`jobs::use`) so the permission gate passes; no `defineAction`
 *  sources, so the manifest is purely the view_spec's actions. */
function makeViewSpecFixtureRoot() {
  const { root, srcRoot } = makeFixtureRoot()
  writeFileSync(
    path.join(srcRoot, 'api-client', 'permissions.ts'),
    `export enum Permissions {\n  JobsUse = 'jobs::use',\n  FooUse = 'foo::use',\n}\n`,
  )
  return { root, srcRoot }
}

// DOMAIN_AUDIT S1: view_spec actions are still COLLECTED — so the uniqueness /
// known-permission / instance-shape gates keep running over them — but they are
// no longer EMITTED into the committed manifest. At RUNTIME the browser session
// registers them (`workbench/core/runtime/interpreter.ts`) and REPORTS them to
// the server (`core/actions/capabilityReport.ts` -> `POST /api/mcp/agent/
// capabilities`), because the processor set is runtime-discovered while the
// manifest is a compile-time artifact. This test is the EMIT half; the three
// after it are the GATE half (unknown permission / malformed / duplicate id all
// still fail loud).
test('a fixture view_spec YAML is collected for the gates but NOT emitted into the manifest', () => {
  const { root, srcRoot } = makeViewSpecFixtureRoot()
  try {
    const manifestPath = path.join(root, 'frontend-actions.json')
    const gen = runCollector({ srcRoot, manifestPath, viewSpecRoot: VIEWSPEC_FIXTURE_ROOT, args: [] })
    assert.equal(gen.status, 0, `regen failed. stderr:\n${gen.stderr}`)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const byId = new Map(manifest.actions.map(a => [a.id, a]))

    for (const id of [
      'fixture/qc-filter::qc.setEmbedding',
      'fixture/qc-filter::qc.setFilter',
      'fixture/qc-filter::qc.save',
      'fixture/qc-filter::describe',
      // (this one was already excluded, by `surfaces: { ai: false }`)
      'fixture/qc-filter::qc.internalOnly',
    ]) {
      assert.ok(!byId.has(id), `${id} must NOT be baked into frontend-actions.json`)
    }
    // The fixture root has no `defineAction` sources, so every action it could
    // contribute is view-scoped ⇒ nothing at all is emitted.
    assert.equal(manifest.actions.length, 0, 'only view_spec actions existed → nothing to emit')

    // Golden-parity: --check agrees with the just-written manifest.
    const check = runCollector({ srcRoot, manifestPath, viewSpecRoot: VIEWSPEC_FIXTURE_ROOT })
    assert.equal(check.status, 0, `expected --check exit 0. stderr:\n${check.stderr}`)
    assert.match(check.stdout, /OK/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The GATE half: an un-emitted view_spec action is still permission-gated at
// build time, so a typo'd permission cannot ship inside a processor package.
test('ERRORS on a view_spec action declaring an unknown permission (the gate survives the un-emit)', () => {
  const { root, srcRoot } = makeViewSpecFixtureRoot()
  try {
    const manifestPath = path.join(root, 'frontend-actions.json')
    const viewSpecRoot = makeViewSpecTree(
      root,
      'badperm',
      'badperm.yaml',
      [
        'view:',
        '  id: fixture/badperm',
        '  permission: jobs::use',
        '  actions:',
        '    - id: bp.act',
        '      title: An action with a bogus permission',
        '      permission: not::a-real-permission',
        '      mutating: true',
        '      params: {}',
        '',
      ].join('\n'),
    )
    const result = runCollector({ srcRoot, manifestPath, viewSpecRoot, args: [] })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /unknown permission "not::a-real-permission"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('view_spec collection tolerates a missing/empty root (no view_specs yet)', () => {
  const { root, srcRoot } = makeViewSpecFixtureRoot()
  try {
    const manifestPath = path.join(root, 'frontend-actions.json')
    const missingRoot = path.join(root, 'does-not-exist')
    const gen = runCollector({ srcRoot, manifestPath, viewSpecRoot: missingRoot, args: [] })
    assert.equal(gen.status, 0, `regen failed. stderr:\n${gen.stderr}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.actions.length, 0, 'no defineAction sources + no view_specs → empty manifest')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Write `<viewSpecRoot>/<processor>/ui/<name>.yaml` and return the root. */
function makeViewSpecTree(root, processor, name, yaml) {
  const uiDir = path.join(root, 'view-specs', processor, 'ui')
  mkdirSync(uiDir, { recursive: true })
  writeFileSync(path.join(uiDir, name), yaml)
  return path.join(root, 'view-specs')
}

// ── finding #6 — a malformed view_spec must FAIL LOUD, not silently drop actions ──
test('FAILS LOUD on a malformed view_spec YAML (never silently drops its actions)', () => {
  const { root, srcRoot } = makeViewSpecFixtureRoot()
  try {
    const manifestPath = path.join(root, 'frontend-actions.json')
    // An unterminated flow sequence → `parseAllDocuments` records a `doc.errors`
    // entry (it does NOT throw); pre-fix this silently produced no actions.
    const viewSpecRoot = makeViewSpecTree(
      root,
      'broken',
      'broken.yaml',
      'view:\n  id: fixture/broken\n  permission: jobs::use\n  actions: [oops\n',
    )
    const result = runCollector({ srcRoot, manifestPath, viewSpecRoot, args: [] })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /malformed view_spec/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── finding #7 — a view_spec action id colliding with a defineAction id must error ──
test('ERRORS on a duplicate action id across a defineAction and a view_spec', () => {
  const { root, srcRoot } = makeViewSpecFixtureRoot()
  try {
    // A defineAction whose id is exactly the namespaced id the view_spec below emits
    // (`<viewId>::<actionId>` = `fixture/dup::act.save`).
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      defineAction({
        id: 'fixture/dup::act.save',
        title: 'A colliding hand-written action',
        permission: 'jobs::use',
        mutating: true,
        params: z.object({}),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const viewSpecRoot = makeViewSpecTree(
      root,
      'dup',
      'dup.yaml',
      [
        'view:',
        '  id: fixture/dup',
        '  permission: jobs::use',
        '  actions:',
        '    - id: act.save',
        '      title: A view_spec action with the same id',
        '      permission: jobs::use',
        '      mutating: true',
        '      params: {}',
        '',
      ].join('\n'),
    )
    const result = runCollector({ srcRoot, manifestPath, viewSpecRoot, args: [] })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stderr:\n${result.stderr}`)
    assert.match(result.stderr, /duplicate action id "fixture\/dup::act\.save"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── the explicit-type-argument call form (the live fail-open this file missed) ──
//
// `defineAction<TParams, TResult>({…})` is ordinary TypeScript, and exactly one call
// site in the tree uses it (`src/modules/provenance/actions.ts`). The original
// `\bdefineAction\s*\(` matcher could not see it: the file never entered the scan set,
// its action never reached `frontend-actions.json`, and `--check` STILL printed
// `OK — 56 action(s), manifest matches` because the collector and the committed
// manifest omitted it consistently. A parity check cannot catch a symmetric omission,
// so the two tests below cover the fix from both sides.

test('collects an action declared with EXPLICIT type arguments (defineAction<P, R>({…}))', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      const params = z.object({ thing: z.string() })
      type P = z.infer<typeof params>
      interface R { ok: boolean }

      defineAction<P, R>({
        id: 'test.genericCallForm',
        title: 'Declared with explicit type arguments',
        permission: 'foo::use',
        mutating: true,
        params,
        run: () => ({ ok: true }),
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const gen = runCollector({ srcRoot, manifestPath, args: [] })
    assert.equal(gen.status, 0, `regen failed. stderr:\n${gen.stderr}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.deepEqual(
      manifest.actions.map(a => a.id),
      ['test.genericCallForm'],
      'the generic call form must reach the manifest, not vanish from both sides of --check',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FAILS CLOSED on a defineAction reference the matcher cannot parse as a call', () => {
  const { root, srcRoot } = makeFixtureRoot()
  try {
    // An ALIASED call: `defineAction` is referenced in executable code, but the call
    // goes through the alias, so the matcher recognizes zero calls in a file that
    // clearly registers one. This is the SHAPE of the generic-form bug (a real call
    // site the matcher cannot see) — and the guard must name the file rather than
    // silently produce a manifest missing its action.
    writeActionsFile(
      srcRoot,
      `
      import { z } from 'zod'
      import { defineAction } from '../defineAction'

      const register = defineAction
      register({
        id: 'test.aliasedCallForm',
        title: 'Registered through an alias',
        permission: 'foo::use',
        mutating: true,
        params: z.object({}),
        run: () => {},
      })
      `,
    )
    const manifestPath = path.join(root, 'frontend-actions.json')
    const result = runCollector({ srcRoot, manifestPath, args: [] })
    assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout:\n${result.stdout}`)
    assert.match(result.stderr, /UNPARSED defineAction CALL FORM/)
    assert.match(result.stderr, /testActions\.ts: 1 reference\(s\), 0 recognized call\(s\)/)
    assert.doesNotMatch(result.stdout, /wrote /)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
