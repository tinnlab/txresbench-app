// TEST-22 (ITEM-4 / ITEM-25) — the MANDATORY OpenAPI regen actually ran.
//
// ITEM-4 deleted `server/src/modules/predicate/` — three routes, four schemas, two
// permissions and the `predicate_settings` sync entity. The generated client is committed,
// so if the regen is skipped the backend and the client silently disagree: `tsc` stays
// green (the types still exist), every frontend test stays green (nothing imports them),
// and the first sign of trouble is a 404 in production.
//
// The upstream backstop is the server's `emit_ts` golden-parity test, which proves
// `types.ts` matches `openapi.json`. This is the APP-SIDE half: that the committed
// `openapi.json` itself no longer describes the deleted surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '../..')
const SPEC = path.join(UI, 'openapi/openapi.json')
const TYPES = path.join(UI, 'src/api-client/types.ts')
// `finish_and_emit` writes FOUR files, not one: `Permissions`,
// `PermissionDescriptions` and `ApiEndpoints`/`ApiEndpoint`/`ApiEndpointUrl`/
// `getEndpointKey` were split out of `types.ts` so they stay off the eager
// entry chunk. Every one of them is committed generated output, so every one
// of them is subject to the checks below — otherwise the split would silently
// move half the generated surface (notably the permission ENUM, which is where
// a `predicate::settings` residue would land) out from under the guard.
const SIBLINGS = {
  'permissions.ts': path.join(UI, 'src/api-client/permissions.ts'),
  'permissionDescriptions.ts': path.join(UI, 'src/api-client/permissionDescriptions.ts'),
  'apiEndpoints.ts': path.join(UI, 'src/api-client/apiEndpoints.ts'),
}

interface Spec {
  paths: Record<string, unknown>
  components: { schemas: Record<string, unknown> }
}
const spec = (): Spec => JSON.parse(readFileSync(SPEC, 'utf8'))

test('TEST-22: the committed spec is a REAL spec (positive counts)', () => {
  const s = spec()
  // Every assertion below is an absence. An emptied or truncated spec would satisfy all
  // of them, so the size is pinned first.
  assert.ok(Object.keys(s.paths).length >= 100, `only ${Object.keys(s.paths).length} paths in the spec`)
  assert.ok(
    Object.keys(s.components.schemas).length >= 200,
    `only ${Object.keys(s.components.schemas).length} schemas in the spec`,
  )
  assert.ok(readFileSync(TYPES, 'utf8').length > 100_000, 'types.ts is implausibly small')
})

test('TEST-22: NO `predicate` path survives in openapi.json', () => {
  const paths = Object.keys(spec().paths).filter(p => /predicate/i.test(p))
  assert.deepEqual(paths, [], 'the predicate routes are still in the committed spec — the regen did not run')
})

test('TEST-22: the three deleted routes are individually absent', () => {
  const paths = Object.keys(spec().paths)
  for (const p of ['/api/selection/by-predicate', '/api/predicate/vocabulary', '/api/predicate/settings'])
    assert.ok(!paths.includes(p), `${p} is still declared`)
  // Positive control: a route that SURVIVES the deletion is still declared, so the
  // assertions above are reading a populated path list.
  assert.ok(
    paths.some(p => p.includes('/api/sync/subscribe')),
    'GET /api/sync/subscribe survives ITEM-4 and must still be in the spec',
  )
})

test('TEST-22: no `*Predicate*` schema survives in openapi.json', () => {
  const schemas = Object.keys(spec().components.schemas).filter(n => /predicate/i.test(n))
  assert.deepEqual(schemas, [], 'a predicate schema is still generated')
  for (const n of ['ByPredicateRequest', 'PredicateSettings', 'PredicateSettingsUpdate', 'CellSetPredicate'])
    assert.ok(!(n in spec().components.schemas), `${n} is still a generated schema`)
})

test('TEST-22: `types.ts` carries no predicate TYPE or permission (comments excluded)', () => {
  // The one surviving occurrence of the word is a doc-comment on `recipe`, explaining
  // that the scrapped envelope is now REFUSED with a 400. Recording why a thing was
  // deleted is not the same as still generating it, so the assertion runs on code with
  // comments stripped — otherwise the honest explanation would have to be deleted to
  // make the test pass, which is the wrong incentive.
  const src = readFileSync(TYPES, 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const n of [
    'ByPredicateRequest',
    'PredicateSettings',
    'predicate::settings',
    "'predicate_settings'",
    'predicate_settings',
  ])
    assert.ok(!code.includes(n), `types.ts still declares ${n}`)
  // Stronger than the name list: NO occurrence of the word at all in executable code.
  // The `predicate`-vocabulary allowance that once existed here (MethodsParamRole's
  // `'predicate_list'` / `'opaque_predicate'`, generated from the methods-narration
  // response schemas) left with its schemas on the ITEM-4 regen — `types.ts` now has
  // zero `predicate` occurrences in code, so the sweep stands alone.
  const GENERIC_PREDICATE_LITERALS: string[] = []
  // Positive control: an allowance for something that is no longer generated is a hole,
  // not an allowance. If these ever leave the spec, delete them from this list.
  for (const lit of GENERIC_PREDICATE_LITERALS)
    assert.ok(
      code.includes(lit),
      `${lit} is no longer generated — drop it from GENERIC_PREDICATE_LITERALS instead of carrying a dead allowance`,
    )
  const swept = GENERIC_PREDICATE_LITERALS.reduce((acc, lit) => acc.split(lit).join(''), code)
  assert.doesNotMatch(swept, /predicate/i, 'a predicate symbol survives in generated code')
  // Positive control: comment-stripping did not eat the file.
  // Half the file is JSDoc, so the stripped form is ~54 KB against ~115 KB raw.
  assert.ok(code.length > 40_000, `comment-stripping removed too much to be a valid check (${code.length} chars left)`)
  assert.ok(code.includes('export'), 'types.ts should still declare exports after stripping comments')
})

test('TEST-22: the three SPLIT-OUT generated files exist and are populated', () => {
  // An absent or emptied sibling is exactly what a half-run regen leaves, and
  // every absence assertion below would be satisfied by one. Pin the content
  // first: counts, not just existence.
  const perms = readFileSync(SIBLINGS['permissions.ts'], 'utf8')
  assert.match(perms, /export enum Permissions \{/, 'permissions.ts must declare the enum')
  assert.ok(
    (perms.match(/^ {2}[A-Za-z]\w* = '/gm) ?? []).length >= 20,
    'permissions.ts has implausibly few enum members',
  )

  const descs = readFileSync(SIBLINGS['permissionDescriptions.ts'], 'utf8')
  assert.match(descs, /export const PermissionDescriptions/, 'permissionDescriptions.ts must declare the map')
  assert.ok(
    (descs.match(/^ {2}[A-Za-z]\w*: '/gm) ?? []).length >= 20,
    'permissionDescriptions.ts has implausibly few entries',
  )

  const eps = readFileSync(SIBLINGS['apiEndpoints.ts'], 'utf8')
  assert.match(eps, /export const ApiEndpoints/, 'apiEndpoints.ts must declare the map')
  assert.match(eps, /export function getEndpointKey/, 'apiEndpoints.ts must declare getEndpointKey')
  assert.ok(
    (eps.match(/^ {2}'[^']+': '/gm) ?? []).length >= 100,
    'apiEndpoints.ts has implausibly few endpoints',
  )
})

test('TEST-22: no split-out generated file carries a predicate symbol', () => {
  // The sweep that used to cover the `Permissions` enum inside `types.ts`. The
  // enum moved; the sweep follows it, or ITEM-4's deleted `predicate::settings`
  // permission could come back with nothing to catch it.
  //
  // No `GENERIC_PREDICATE_LITERALS` allowlist here on purpose: the generic
  // vocabulary that forced one in `types.ts` (`MethodsParamRole`'s
  // `'predicate_list'` / `'opaque_predicate'`) is schema-enum territory and
  // stays in `types.ts`. These three files hold permissions, labels and URLs —
  // any `predicate` in them is the deleted module, full stop.
  for (const [name, file] of Object.entries(SIBLINGS)) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.ok(code.includes('export'), `${name}: comment-stripping ate the file`)
    assert.doesNotMatch(code, /predicate/i, `a predicate symbol survives in ${name}`)
  }
})

test('TEST-22: the `predicate_settings` SYNC ENTITY left the spec', () => {
  // A sync entity that the client still knows about but the server never emits is a
  // dead EventBus key — silent, and exactly the kind of residue a skipped regen leaves.
  const s = spec()
  const sync = s.components.schemas.SyncEntity as { enum?: string[] } | undefined
  const raw = JSON.stringify(sync ?? {})
  assert.ok(!/predicate/i.test(raw), `SyncEntity still carries a predicate member: ${raw.slice(0, 300)}`)
})
