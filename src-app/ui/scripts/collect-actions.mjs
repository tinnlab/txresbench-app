#!/usr/bin/env node
/**
 * ai-mcp ITEM-15 — compile-time ACTION COLLECTOR + gate.
 *
 * Scans `src/**` for every `defineAction(...)` call site, executes those
 * modules for real (bundled via esbuild into a throwaway Node ESM file) so
 * we read the ACTUAL registered zod schema + metadata off
 * `getActionRegistry()` — not a static/regex guess at the shape — converts
 * each action's `params` zod schema to JSON Schema (zod v4's native
 * `z.toJSONSchema`), and emits the manifest CONTRACT.md's "Frontend-action
 * manifest" section defines:
 *
 *   { version, actions: [{id, title, kind, context, mutating, stateful, permission, params_schema}] }
 *
 * `context` (W1 ITEM-5) is the page-context precondition (default `'global'`);
 * an action with `surfaces:{ai:false}` is EXCLUDED from this AI manifest
 * entirely (it stays in the ⌘K palette but the agent can't invoke it).
 *
 * Modes:
 *   node scripts/collect-actions.mjs           regenerate the committed manifest
 *   node scripts/collect-actions.mjs --check   regenerate in-memory, then:
 *                                                 - fail on a missing/unknown permission
 *                                                 - fail (byte-diff) on drift vs the committed file
 *
 * See `.lifecycle/ai-mcp/CONTRACT.md` (schema + `defineAction` shape) and
 * DEC-7 (permission is mandatory + must be real) / DEC-8 (a committed
 * golden-parity artifact, mirroring the openapi.json/types.ts codegen
 * pattern) in `.lifecycle/ai-mcp/DECISIONS.md`.
 *
 * Test-only overrides (used by `collect-actions.test.mjs` to point the
 * collector at self-contained temp fixtures instead of the real project —
 * never set these in normal use):
 *   COLLECT_ACTIONS_SRC_ROOT      — replaces `<ui>/src` as the scan root
 *   COLLECT_ACTIONS_MANIFEST_PATH — replaces the committed manifest path
 *   COLLECT_ACTIONS_MIN_SOURCE_FILES / COLLECT_ACTIONS_MIN_VIEWSPEC_FILES
 *                                 — lower the ITEM-37 scan floors so a tiny synthetic
 *                                   fixture can exercise the RULES. The floors
 *                                   themselves are proved by `guard-floors.test.mjs`,
 *                                   which leaves these UNSET.
 */

import { build } from 'esbuild'
import { z } from 'zod'
import YAML from 'yaml'
import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// `UI_ROOT` is always the REAL `src-app/ui` directory (this script's parent).
// It is deliberately NOT overridable: the throwaway bundle file that gets
// dynamically `import()`-ed is always written here, so Node's module
// resolution for bare imports (`zod`, `react`, `react-router-dom`, ...) walks
// up from a location that genuinely has `node_modules` in its ancestry, even
// when `COLLECT_ACTIONS_SRC_ROOT` points at an unrelated temp-dir fixture.
const UI_ROOT = path.resolve(__dirname, '..')

const SRC_ROOT = process.env.COLLECT_ACTIONS_SRC_ROOT
  ? path.resolve(process.env.COLLECT_ACTIONS_SRC_ROOT)
  : path.join(UI_ROOT, 'src')

const MANIFEST_PATH = process.env.COLLECT_ACTIONS_MANIFEST_PATH
  ? path.resolve(process.env.COLLECT_ACTIONS_MANIFEST_PATH)
  : path.resolve(UI_ROOT, '..', 'server', 'src', 'modules', 'mcp', 'frontend-actions.json')

// processor-registry ITEM-10: the root under which declarative `view_spec`
// YAMLs live (`<root>/<processor>/ui/*.yaml`). A processor SHIPS its UI + its
// own actions as data; the collector merges those actions into the SAME AI
// manifest as hand-written `defineAction`s (permission-gated, gate-checked,
// AI-drivable). Overridable so the collector test can point at a self-contained
// fixture dir. Tolerant of a missing root (none exist yet).
const VIEWSPEC_ROOT = process.env.COLLECT_ACTIONS_VIEWSPEC_ROOT
  ? path.resolve(process.env.COLLECT_ACTIONS_VIEWSPEC_ROOT)
  : path.resolve(UI_ROOT, '..', 'packages')

const TSCONFIG_PATH = path.join(UI_ROOT, 'tsconfig.json')
const DEFINE_ACTION_PATH = path.join(SRC_ROOT, 'core', 'actions', 'defineAction.ts')
// The generated `Permissions` enum. It lived in `api-client/types.ts` until the
// generator split the client into four files; `permissions.ts` is its home now
// (see `readKnownPermissions`).
const PERMISSIONS_PATH = path.join(SRC_ROOT, 'api-client', 'permissions.ts')
// The SAAS permission enum (#50 seam). It carries the saas-only permissions
// (`billing::admin`, …) that the default `api-client/permissions.ts` — generated
// saas-OFF — does not. A saas admin action (e.g. the Billing Console's
// `billing.grantCredit` on `billing::admin`) is a REAL permissioned action that
// must live in the SINGLE committed `frontend-actions.json` (the server bakes it
// via `include_str!`; there is no saas-specific manifest), so it is AI-drivable on
// the hosted build. To let it validate here in the DEFAULT build, the known-
// permission set is the UNION of both committed generated enums. The Rust side
// parses `permission` as a plain string and filters by the caller's HELD
// permissions at request time, so a desktop user never surfaces a billing action.
// Optional: absent on a build that never generated the saas client — union is a
// no-op then, preserving the default-only behavior.
const SAAS_PERMISSIONS_PATH = path.join(SRC_ROOT, 'api-client-saas', 'permissions.ts')

const CHECK_MODE = process.argv.includes('--check')

/** Recursively list every `.ts`/`.tsx` file under `dir` (skips
 *  `node_modules`/dot-directories and `*.test.ts(x)`/`*.spec.ts(x)`). */
function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/** A `defineAction` CALL — bare (`defineAction({…})`) or with an explicit type
 *  argument list (`defineAction<TParams, TResult>({…})`). The generic form is
 *  ordinary TypeScript and was invisible to the original `\bdefineAction\s*\(`
 *  matcher: the file simply never entered the scan set, its action never reached
 *  the manifest, and `--check` reported OK because the collector and the committed
 *  manifest omitted it CONSISTENTLY. `[^;{}()]` keeps the type-argument list from
 *  swallowing arbitrary code if the `(` is never reached. */
const DEFINE_ACTION_CALL = /\bdefineAction\s*(?:<[^;{}()]*>\s*)?\(/

/** Every source file under `SRC_ROOT` (other than `defineAction.ts` itself)
 *  that calls `defineAction(`. */
function findActionSourceFiles() {
  const definitionFile = path.resolve(DEFINE_ACTION_PATH)
  return listSourceFiles(SRC_ROOT).filter(file => {
    if (path.resolve(file) === definitionFile) return false
    return DEFINE_ACTION_CALL.test(readFileSync(file, 'utf8'))
  })
}

// ── FAIL CLOSED on a call form the matcher cannot parse (the other half) ─────
//
// The scan-set FLOOR below catches a COLLAPSED scan set (the root moved). It cannot
// catch what actually happened here: the scan set was intact and the MATCHER was too
// narrow, so exactly one real call site vanished — silently, and symmetrically on both
// sides of the parity check. A floor is a lower bound on files; this is the positive
// bound on CALL SITES, derived from the source rather than committed as a number.
//
// The audit is deliberately BROADER than the matcher: it counts every bare
// `defineAction` IDENTIFIER reference left after comments, import/export statements
// and string literals are removed, and requires the matcher to recognize each one as a
// call. A reference the matcher does not recognize means a form it cannot parse, and
// the guard names the file instead of quietly dropping it.

/** Strip comments, `import`/`export … from '…'` statements, and string/template
 *  literals — everything in which the word `defineAction` is prose or a module
 *  specifier rather than a call. What remains is executable code. */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block + JSDoc comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (not `://` in a URL)
    .replace(/^\s*import[\s\S]*?from\s*['"][^'"]*['"]/gm, ' ') // import { x } from '…'
    .replace(/^\s*import\s*['"][^'"]*['"]/gm, ' ') // side-effect import
    .replace(/^\s*export[\s\S]*?from\s*['"][^'"]*['"]/gm, ' ') // re-export
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``') // template literals
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''") // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // double-quoted strings
}

function countMatches(text, re) {
  return (text.match(new RegExp(re.source, 'g')) ?? []).length
}

/**
 * Every source file whose executable code REFERENCES `defineAction` more times than
 * [`DEFINE_ACTION_CALL`] recognizes as a call. Returns `[{file, references, calls}]`;
 * an empty array means the matcher parsed every reference in the tree.
 */
function findUnparsedCallForms(files, definitionFile) {
  const problems = []
  for (const file of files) {
    if (path.resolve(file) === path.resolve(definitionFile)) continue
    const code = stripNonCode(readFileSync(file, 'utf8'))
    const references = countMatches(code, /\bdefineAction\b/)
    if (references === 0) continue
    const calls = countMatches(code, DEFINE_ACTION_CALL)
    if (calls < references) problems.push({ file, references, calls })
  }
  return problems
}

/** esbuild plugin: leave relative/absolute/alias imports to esbuild's normal
 *  (tsconfig-aware) resolution + bundling; anything else is a real npm
 *  package, kept EXTERNAL so Node resolves it for real at import time (the
 *  identical module instance this script's own `import { z } from 'zod'`
 *  uses — required for `z.toJSONSchema` to recognize the schema). */
const externalBareImportsPlugin = {
  name: 'external-bare-imports',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return null
      const p = args.path
      if (p.startsWith('.') || p.startsWith('/') || p.startsWith('@/') || p.startsWith('@ziee/')) {
        return null
      }
      return { path: p, external: true }
    })
  },
}

/** Bundle + execute every action source file in a real Node ESM module, then
 *  read back the actual registered `{meta, params}` entries. */
async function collectRegisteredActions(actionFiles) {
  const entryLines = actionFiles.map(file => `import ${JSON.stringify(file)};`)
  entryLines.push(`import { getActionRegistry } from ${JSON.stringify(DEFINE_ACTION_PATH)};`)
  entryLines.push(
    'globalThis.__ZIEE_COLLECTED_ACTIONS__ = Array.from(getActionRegistry().values());',
  )
  const entryContents = entryLines.join('\n')

  const result = await build({
    stdin: {
      contents: entryContents,
      resolveDir: UI_ROOT,
      loader: 'ts',
      sourcefile: 'collect-actions-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    tsconfig: TSCONFIG_PATH,
    // `import.meta.env` is injected by VITE and is UNDEFINED under the plain
    // Node runtime this bundle executes in, so any app/SDK module that reads it
    // at module scope (e.g. `@ziee/framework/store-kit`'s
    // `import.meta.env.VITE_STORE_PREFETCH` prefetch flag) throws
    // `Cannot read properties of undefined` the instant it is evaluated.
    //
    // It became reachable here when the action modules were repointed from the
    // old global `Stores` registry shim onto each store's DIRECT
    // `registerLazyStore` handle: the shim only pulled in `@ziee/framework`'s
    // module-system barrel, which does NOT re-export `store-kit`; a store module
    // does. Vite supplies this define for the real app, so the collector — which
    // deliberately runs the SAME sources on `platform: 'node'` — has to supply
    // it too. An empty object yields `undefined` for every flag, which is the
    // correct "no Vite env" answer (and the auto-warm loop it gates is a no-op
    // under Node anyway: it early-returns on `typeof window === 'undefined'`).
    define: { 'import.meta.env': '{}' },
    plugins: [externalBareImportsPlugin],
    logLevel: 'silent',
  })

  const bundleCode = result.outputFiles[0].text
  // Written inside the real UI_ROOT (see the UI_ROOT comment above), NOT next
  // to SRC_ROOT — so bare-import resolution at execution time always finds
  // the real project's node_modules, fixture or no fixture.
  const tmpFile = path.join(UI_ROOT, `.collect-actions-${randomUUID()}.mjs`)
  writeFileSync(tmpFile, bundleCode)
  try {
    await import(pathToFileURL(tmpFile).href)
  } finally {
    unlinkSync(tmpFile)
  }

  const collected = globalThis.__ZIEE_COLLECTED_ACTIONS__
  delete globalThis.__ZIEE_COLLECTED_ACTIONS__
  if (!Array.isArray(collected)) {
    throw new Error('[collect-actions] bundle did not populate the collected-actions global')
  }
  return collected // [{ meta: {id,title,permission,mutating,kind}, params: ZodType, run }, ...]
}

/** zod v4's native `z.toJSONSchema`, reshaped into CONTRACT.md's exact key
 *  order/shape (`type, required, additionalProperties, properties` — no
 *  `$schema`/`$id`). */
function toParamsSchema(zodType) {
  const raw = z.toJSONSchema(zodType)
  if (raw.type !== 'object') {
    throw new Error(`[collect-actions] expected an object params schema, got type=${raw.type}`)
  }
  return {
    type: 'object',
    required: Array.isArray(raw.required) ? raw.required : [],
    additionalProperties: raw.additionalProperties ?? false,
    properties: raw.properties ?? {},
  }
}

// ── Declarative view_spec action collection (ITEM-10) ────────────────────────

const ID_SEP = '::' // must match `workbench/core/spec/ids.ts` namespaceActionId

/** `${viewSpecId}::${actionId}` — the global registry id, identical to the
 *  runtime `namespaceActionId` so the manifest id == the registered id. */
function namespaceActionId(viewSpecId, actionId) {
  const prefix = `${viewSpecId}${ID_SEP}`
  return actionId.startsWith(prefix) ? actionId : `${prefix}${actionId}`
}

/** Map a view_spec param type declaration (a loose string like `string` /
 *  `number` / `[number, number]` / `map<…>`, or a nested object) to a JSON
 *  Schema fragment. Unknown/complex decls degrade to an open `{}` (any). */
function paramJsonType(decl) {
  if (decl && typeof decl === 'object') return { type: 'object' }
  const s = String(decl).trim()
  if (s === 'string') return { type: 'string' }
  if (s === 'number' || s === 'integer' || s === 'float') return { type: 'number' }
  if (s === 'boolean' || s === 'bool') return { type: 'boolean' }
  if (s[0] === '[' || s.startsWith('array') || s.startsWith('list')) return { type: 'array' }
  if (s.startsWith('map') || s.startsWith('object') || s.startsWith('record')) return { type: 'object' }
  return {}
}

/** Build the `params_schema` for a declared action: `view_id` is always a
 *  required instance target (kind:"instance" contract — `validateInstanceShape`),
 *  plus each declared param. */
function viewSpecParamsSchema(declared) {
  const properties = { view_id: { type: 'string' } }
  const required = ['view_id']
  for (const [name, decl] of Object.entries(declared ?? {})) {
    if (name === 'view_id') continue
    properties[name] = paramJsonType(decl)
    required.push(name)
  }
  return { type: 'object', required, additionalProperties: false, properties }
}

/** One manifest entry (final shape) for a declared action. Returns `null` when
 *  the action opts out of the AI surface (`surfaces.ai === false`). */
function viewSpecActionEntry(viewSpecId, action) {
  if (action?.surfaces && action.surfaces.ai === false) return null
  const out = {
    id: namespaceActionId(viewSpecId, action.id),
    title: action.title ?? action.id,
    kind: 'instance',
    context: action.context ?? 'global',
    mutating: action.mutating ?? false,
    stateful: action.stateful ?? false,
    permission: action.permission,
  }
  if (action.description) out.description = action.description
  out.params_schema = viewSpecParamsSchema(action.params)
  return out
}

/** The synthesized `<view>.describe` read-action entry (ITEM-11) — AI-only, so
 *  the manifest stays in lock-step with what `registerViewSpecActions` registers
 *  at runtime. */
function describeEntry(spec) {
  return {
    id: `${spec.id}${ID_SEP}describe`,
    title: `Describe ${spec.title ?? spec.id}`,
    kind: 'instance',
    context: 'global',
    mutating: false,
    stateful: false,
    permission: spec.permission,
    description: `Read the live state + derived values of the "${spec.title ?? spec.id}" view.`,
    params_schema: { type: 'object', required: ['view_id'], additionalProperties: false, properties: { view_id: { type: 'string' } } },
  }
}

/** Recursively list `<root>/<processor>/ui/*.yaml` files. Tolerant of a missing
 *  root (returns `[]`). */
function listViewSpecFiles(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const out = []
  for (const proc of readdirSync(root, { withFileTypes: true })) {
    if (!proc.isDirectory() || proc.name.startsWith('.')) continue
    const uiDir = path.join(root, proc.name, 'ui')
    if (!existsSync(uiDir) || !statSync(uiDir).isDirectory()) continue
    for (const f of readdirSync(uiDir, { withFileTypes: true })) {
      if (f.isFile() && /\.ya?ml$/.test(f.name)) out.push(path.join(uiDir, f.name))
    }
  }
  return out.sort()
}

/** Parse every view_spec YAML under `root` and return its merged manifest
 *  entries (each declared action + a synthesized `<view>.describe`). A YAML
 *  file may hold multiple `---`-separated docs; each doc is either a flat
 *  `ViewSpec` or `{ view: ViewSpec }`. */
function collectViewSpecActions(root) {
  const entries = []
  for (const file of listViewSpecFiles(root)) {
    const docs = YAML.parseAllDocuments(readFileSync(file, 'utf8'))
    for (const doc of docs) {
      // FAIL LOUD on a malformed view_spec: `parseAllDocuments` collects syntax
      // errors on `doc.errors` rather than throwing, so an unchecked doc would
      // silently drop its actions from the manifest while `--check` still passed.
      if (doc.errors && doc.errors.length > 0) {
        throw new Error(
          `[collect-actions] malformed view_spec ${file}: ` +
            doc.errors.map(e => e.message).join('; '),
        )
      }
      const raw = doc.toJSON()
      const spec = raw && typeof raw === 'object' && raw.view ? raw.view : raw
      if (!spec || typeof spec !== 'object' || typeof spec.id !== 'string') continue
      for (const action of spec.actions ?? []) {
        if (!action || typeof action.id !== 'string') continue
        const entry = viewSpecActionEntry(spec.id, action)
        if (entry) entries.push(entry)
      }
      entries.push(describeEntry(spec))
    }
  }
  return entries
}

function buildManifest(registeredActions, extraEntries = []) {
  const defineActionEntries = registeredActions
    // W1 ITEM-5: an action can opt OUT of the AI capability manifest with
    // `surfaces:{ai:false}` (keeps it in the ⌘K palette, drops it from what
    // the agent can invoke). `surfaces` defaults to `{palette:true,ai:true}`,
    // so only an explicit `ai:false` is excluded.
    .filter(entry => entry.meta.surfaces?.ai !== false)
    .map(entry => {
      const m = entry.meta
      const out = {
        id: m.id,
        title: m.title,
        kind: m.kind,
        // W1 ITEM-5: the page CONTEXT precondition (defaults to `'global'`).
        // The Rust `FrontendActionEntry` reads this with `#[serde(default)]`
        // (the `stateful` precedent), so a pre-`context` manifest stays
        // back-compatible.
        context: m.context ?? 'global',
        mutating: m.mutating,
        stateful: m.stateful ?? false,
        permission: m.permission,
      }
      // richer-actions ITEM-4: discoverability metadata (group / description /
      // aliases / keywords) — emitted only when set, so the AI manifest is
      // enriched for action selection without bloating pre-existing entries.
      // The Rust struct ignores unknown fields (no deny_unknown_fields), so
      // these are back-compatible additions.
      if (m.group) out.group = m.group
      if (m.description) out.description = m.description
      if (Array.isArray(m.aliases) && m.aliases.length) out.aliases = m.aliases
      if (Array.isArray(m.keywords) && m.keywords.length) out.keywords = m.keywords
      out.params_schema = toParamsSchema(entry.params)
      return out
    })
  // ITEM-10: merge declarative view_spec actions alongside the hand-written
  // ones — one AI manifest, one permission gate, one parity artifact. Ids must be
  // globally UNIQUE: a view_spec action id that collides with a defineAction id (or a
  // duplicate within either source) would ship two entries the backend can't tell
  // apart. Fail loud rather than emit an ambiguous manifest.
  const merged = [...defineActionEntries, ...extraEntries]
  const byId = new Map()
  for (const entry of merged) {
    if (byId.has(entry.id)) {
      throw new Error(
        `[collect-actions] duplicate action id "${entry.id}" — an id is registered ` +
          'twice (a defineAction and a view_spec action, or two view_spec actions). ' +
          'Action ids must be globally unique.',
      )
    }
    byId.set(entry.id, entry)
  }
  const actions = merged.sort((a, b) => a.id.localeCompare(b.id))
  return { version: 1, actions }
}

/** Known `Permissions` enum VALUES (e.g. `"mcp::use"`), read out of the
 *  generated `api-client/permissions.ts` with a targeted regex rather than
 *  importing the file — a regex read keeps this gate independent of any
 *  future runtime export added to the generated client.
 *
 *  The enum used to live in `api-client/types.ts`; the generator now splits it
 *  (and `PermissionDescriptions` / `ApiEndpoints`) into siblings so they stay
 *  out of the eager entry chunk. This reader follows the enum, and — because
 *  it throws on a missing file or a missing enum rather than returning an
 *  empty set — a future move breaks the gate loudly instead of silently
 *  approving every permission. */
function parsePermissionsEnum(file) {
  const src = readFileSync(file, 'utf8')
  const enumMatch = src.match(/export enum Permissions \{([\s\S]*?)\n\}/)
  if (!enumMatch) {
    throw new Error(
      `[collect-actions] could not locate "export enum Permissions { ... }" in ${file}`,
    )
  }
  const values = new Set()
  const valueRe = /=\s*'([^']*)'/g
  let m
  while ((m = valueRe.exec(enumMatch[1]))) {
    values.add(m[1])
  }
  return values
}

function readKnownPermissions() {
  if (!existsSync(PERMISSIONS_PATH)) {
    throw new Error(`[collect-actions] cannot find ${PERMISSIONS_PATH}`)
  }
  const values = parsePermissionsEnum(PERMISSIONS_PATH)
  if (values.size === 0) {
    throw new Error(`[collect-actions] parsed zero Permissions values from ${PERMISSIONS_PATH}`)
  }
  // Union the SAAS-only permissions when the saas client is present (#50 seam):
  // a saas-only-permission action is still a real permissioned action and must
  // validate + live in the single committed manifest. A no-op when the saas
  // client was never generated (desktop-only build).
  if (existsSync(SAAS_PERMISSIONS_PATH)) {
    for (const v of parsePermissionsEnum(SAAS_PERMISSIONS_PATH)) values.add(v)
  }
  return values
}

function validatePermissions(manifest, knownPermissions) {
  const problems = []
  for (const action of manifest.actions) {
    const permission = action.permission
    if (typeof permission !== 'string' || permission.trim() === '') {
      problems.push(`action "${action.id}" is missing a permission`)
    } else if (!knownPermissions.has(permission)) {
      problems.push(
        `action "${action.id}" declares unknown permission "${permission}" (not a value in the Permissions enum)`,
      )
    }
  }
  return problems
}

/** `kind === 'instance'` shape gate. An instance action is, by definition,
 *  addressed at invoke time by a `view_id` naming the live UI instance to
 *  target (ARCHITECTURE.md Layer 4) — the backend's `invoke_frontend`
 *  (`mcp/handlers.rs`) hard-requires it and `describe_capability` always
 *  advertises `view_id_required: true` for this kind. That contract only
 *  holds if `view_id` is actually a DECLARED, required param on the
 *  action's own `params` schema; without it a caller (or the collector's
 *  own zod->JSON-Schema pass) could silently produce an instance action the
 *  backend can never correctly address. `expected`/`expected_token` is
 *  deliberately NOT checked here — it's a wire field threaded through by
 *  the backend for stateful actions, not a `defineAction` params-schema
 *  requirement (see `handlers.rs`'s `expected_token` extraction). */
function validateInstanceShape(manifest) {
  const problems = []
  for (const action of manifest.actions) {
    if (action.kind !== 'instance') continue
    const required = Array.isArray(action.params_schema?.required) ? action.params_schema.required : []
    if (!required.includes('view_id')) {
      problems.push(
        `action "${action.id}" is kind:"instance" but its params_schema.required does not include "view_id" ` +
          '(an instance action must declare view_id as a required param — it is the runtime target the backend addresses it by)',
      )
    }
  }
  return problems
}

function serialize(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n'
}

/**
 * ITEM-37 — FAIL CLOSED on a collapsed scan set. `SRC_ROOT` / `VIEWSPEC_ROOT` are
 * HARD-CODED roots; a rename that moves the subject out from under them makes the
 * walk yield (almost) nothing and this guard reports OK having checked nothing.
 * Four such live fail-open incidents happened in this round alone. The floors are
 * COMMITTED constants, so shrinking coverage requires an explicit, reviewable edit.
 */
const MIN_SOURCE_FILES = 400
const MIN_VIEWSPEC_FILES = 2

// Test-only floor overrides (the `LINT_LAYER_BOUNDARY_MIN_FILES` precedent). The
// floors above stay COMMITTED LITERALS — these only let a suite that deliberately
// points the collector at a 3-file temp fixture exercise the RULES instead of
// tripping the floor first. Leaving them UNSET is production behaviour, and that is
// what `guard-floors.test.mjs` asserts (it overrides only the ROOT, so the floor
// still fires): the guard fails closed by default, and relaxing it takes an edit as
// visible as lowering the constant.
const SOURCE_FILE_FLOOR = Number(process.env.COLLECT_ACTIONS_MIN_SOURCE_FILES ?? MIN_SOURCE_FILES)
const VIEWSPEC_FILE_FLOOR = Number(
  process.env.COLLECT_ACTIONS_MIN_VIEWSPEC_FILES ?? MIN_VIEWSPEC_FILES,
)

function assertScanFloor(count, floor, what, root) {
  if (count >= floor) return
  console.error(
    `[collect-actions] SCAN SET COLLAPSED — found ${count} ${what} under ${root}, below the ` +
      `committed floor of ${floor}. A hard-coded path no longer resolves, so this guard was ` +
      `about to PASS having checked almost nothing. Re-point it, or lower the floor deliberately.`,
  )
  process.exit(1)
}

async function main() {
  const sourceFiles = listSourceFiles(SRC_ROOT)
  assertScanFloor(sourceFiles.length, SOURCE_FILE_FLOOR, 'source file(s)', SRC_ROOT)

  // FAIL CLOSED on an unparsable call form BEFORE collecting: a reference the
  // matcher does not recognize would otherwise drop its action from BOTH the
  // collector and the manifest, and `--check` would report OK.
  const unparsed = findUnparsedCallForms(sourceFiles, DEFINE_ACTION_PATH)
  if (unparsed.length > 0) {
    console.error(
      '[collect-actions] UNPARSED defineAction CALL FORM — the file(s) below reference ' +
        '`defineAction` in executable code more times than the collector recognizes as a ' +
        'call, so at least one action would be silently missing from the manifest (and ' +
        '`--check` would still pass, because both sides omit it). Widen DEFINE_ACTION_CALL:',
    )
    for (const p of unparsed) {
      console.error(`  - ${p.file}: ${p.references} reference(s), ${p.calls} recognized call(s)`)
    }
    process.exit(1)
  }

  const actionFiles = findActionSourceFiles()
  const registeredActions = await collectRegisteredActions(actionFiles)
  // …and the positive link between the STATIC count and the RUNTIME registry: every
  // recognized call site registers at least one action (a call in a loop registers
  // several), so fewer registrations than call sites means a module was bundled but
  // never executed — again a silent shortfall the parity check cannot see.
  const callSites = actionFiles.reduce(
    (n, f) => n + countMatches(stripNonCode(readFileSync(f, 'utf8')), DEFINE_ACTION_CALL),
    0,
  )
  if (registeredActions.length < callSites) {
    console.error(
      `[collect-actions] REGISTRY SHORTFALL — ${callSites} recognized defineAction call site(s) ` +
        `across ${actionFiles.length} file(s), but only ${registeredActions.length} action(s) ` +
        'registered. A scanned module did not execute (or registered nothing).',
    )
    process.exit(1)
  }

  assertScanFloor(
    listViewSpecFiles(VIEWSPEC_ROOT).length,
    VIEWSPEC_FILE_FLOOR,
    'processor view_spec yaml(s)',
    VIEWSPEC_ROOT,
  )
  const viewSpecEntries = collectViewSpecActions(VIEWSPEC_ROOT)
  // DOMAIN_AUDIT S1 — TWO populations, TWO destinations.
  //
  // The view_spec actions are still COLLECTED here, because the build-time gates
  // below are worth keeping over them: global id uniqueness against every
  // `defineAction`, a real known `Permissions` value, and the `kind:"instance"`
  // shape. They are no longer EMITTED into the committed manifest: at RUNTIME the
  // browser session registers them (`workbench/core/runtime/interpreter.ts`'s
  // `registerViewSpecActions`) and REPORTS them to the server
  // (`core/actions/capabilityReport.ts` → `POST /api/mcp/agent/capabilities`),
  // which stores what it is given. Baking them in made the AI capability set a
  // compile-time snapshot while the processor set is runtime-discovered — so a
  // package dropped in at runtime contributed datatypes and converters but zero
  // AI capabilities, and adding an AI capability for a new domain meant
  // recompiling the server. A SERVER-side scan of the same YAML replaced the bake
  // for a while and is also gone: it was a second, deliberately-partial parse of
  // a schema the FE runtime owns.
  //
  // `frontend-actions.json` is therefore the APP-OWNED half only: the shell's
  // navigation / project / dataset / pane / job / provenance actions, which do
  // ship with the binary and are correctly compile-time.
  const gated = buildManifest(registeredActions, viewSpecEntries)
  const viewSpecIds = new Set(viewSpecEntries.map(e => e.id))
  const manifest = {
    version: gated.version,
    actions: gated.actions.filter(a => !viewSpecIds.has(a.id)),
  }

  const knownPermissions = readKnownPermissions()
  const permissionProblems = validatePermissions(gated, knownPermissions)
  if (permissionProblems.length > 0) {
    console.error('[collect-actions] permission gate FAILED:')
    for (const problem of permissionProblems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }

  const instanceShapeProblems = validateInstanceShape(gated)
  if (instanceShapeProblems.length > 0) {
    console.error('[collect-actions] instance-shape gate FAILED:')
    for (const problem of instanceShapeProblems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }

  const generated = serialize(manifest)

  if (CHECK_MODE) {
    if (!existsSync(MANIFEST_PATH)) {
      console.error(`[collect-actions] committed manifest missing at ${MANIFEST_PATH}`)
      process.exitCode = 1
      return
    }
    // Normalize line endings on BOTH sides before comparing: `generated` is
    // always LF (JSON.stringify + '\n'), but a Windows checkout with
    // `core.autocrlf=true` checks the committed manifest out with CRLF, which
    // would otherwise fail this byte-diff as spurious "drift" on a supported
    // platform. See also the `.gitattributes` entry forcing the manifest to
    // LF at checkout time, which prevents the CRLF checkout in the first
    // place — this normalization is the defense-in-depth runtime fix.
    const committed = readFileSync(MANIFEST_PATH, 'utf8').replace(/\r\n/g, '\n')
    const generatedNormalized = generated.replace(/\r\n/g, '\n')
    if (committed !== generatedNormalized) {
      console.error(
        `[collect-actions] DRIFT: ${MANIFEST_PATH} does not match the current defineAction() source.\n` +
          'Run `node scripts/collect-actions.mjs` (no --check) to regenerate, then commit the result.',
      )
      process.exitCode = 1
      return
    }
    console.log(
      `[collect-actions] OK — ${manifest.actions.length} action(s), manifest matches, all permissions known.`,
    )
    return
  }

  writeFileSync(MANIFEST_PATH, generated)
  console.log(
    `[collect-actions] wrote ${MANIFEST_PATH} (${manifest.actions.length} action(s)).`,
  )
}

main().catch(err => {
  console.error('[collect-actions] fatal:', err)
  process.exitCode = 1
})
