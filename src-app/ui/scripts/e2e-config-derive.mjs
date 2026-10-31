/**
 * DERIVE the full-backend tier's per-run server config from the committed base.
 *
 * ## Why derivation replaced a cross-check
 *
 * `playwright.config.ts` used to CROSS-CHECK four sources for two facts: the
 * committed `config/e2e.yaml` (`server.port`, `postgresql.database`), `E2E_DB`,
 * `E2E_BACKEND` and `E2E_BACKEND_PORT`. The check was right to exist — left
 * unchecked they diverge silently and a run goes green against the wrong server or a
 * never-reset database. But it is also the reason that config could not simply adopt
 * the per-worktree port derivation every other tier uses: a COMMITTED yaml cannot
 * match a derived port, so the check would fail on every run.
 *
 * So the divergence is removed rather than policed. The resolved port and the derived
 * database file are written INTO a per-run copy of the config, and the old check
 * survives as a POST-CONDITION on that file — an assertion about the artifact the
 * backend will really boot with, rather than a hope that four inputs were typed alike.
 *
 * ## The sqlite-store shape
 *
 * The e2e backend runs on the SQLite store: `config/e2e.yaml` carries a `database:`
 * block whose `path:` the per-run derivation replaces with the run-unique DB file
 * (keyed on the resolved backend port, so two runs in one worktree never touch the
 * same file). There is no `postgresql:` block to patch — a stale PG block rebooting
 * the old external Postgres path is exactly the kind of mis-aimed patch the
 * post-condition exists to catch, so `assertFactsAgree` REFUSES a config that still
 * contains one.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/**
 * Rewrite ONE top-level YAML block, leaving every other block byte-identical.
 * Throws when the block is absent — a silent no-op would emit a config that still
 * carries the committed port.
 */
export function patchBlock(yaml, block, edit) {
  const re = new RegExp(`(^${block}:[^\\n]*\\n)([\\s\\S]*?)(?=^\\S|$(?![\\s\\S]))`, 'm')
  if (!re.test(yaml)) throw new Error(`e2e config: no top-level '${block}:' block to patch`)
  return yaml.replace(re, (_all, head, body) => head + edit(body))
}

/**
 * Replace one scalar field inside a block body, FAILING CLOSED unless it matched
 * exactly once. Two matches means the block nests a sub-map that repeats the name
 * (which is precisely how the old `postgresql` carried a second `port:`), and picking
 * one is a guess.
 */
export function setField(body, field, value) {
  const re = new RegExp(`^(\\s+${field}:\\s*)\\S.*$`, 'gm')
  const hits = body.match(re)?.length ?? 0
  if (hits !== 1) {
    throw new Error(
      `e2e config: expected exactly one '${field}:' in the block, found ${hits}. Refusing to ` +
        'guess which one the backend reads.',
    )
  }
  return body.replace(re, `$1${value}`)
}

/** The whole derivation, as a pure string→string transform (directly testable). */
export function deriveConfig(baseYaml, { port, dbPath }) {
  let out = patchBlock(baseYaml, 'server', b => setField(b, 'port', String(port)))
  out = patchBlock(out, 'database', b => setField(b, 'path', `"${dbPath}"`))
  return out
}

/** Extract the three facts the post-condition checks. */
export function readFacts(yaml) {
  const block = name => new RegExp(`^${name}:\\s*$([\\s\\S]*?)(?=^\\S)`, 'm').exec(yaml)?.[1] ?? ''
  return {
    serverPort: /^\s+port:\s*(\d+)/m.exec(block('server'))?.[1] ?? null,
    dbPath: /^\s+path:\s*["']?([^\s"']+)/m.exec(block('database'))?.[1] ?? null,
    hasPostgres: /^postgresql:\s*$/m.test(yaml),
  }
}

/**
 * Re-read the file the backend will boot with and assert it says what this run
 * decided. Reading BACK is the point: the writer cannot see its own mis-aimed regex.
 */
export function assertFactsAgree(yaml, { port, dbPath, path = '<derived>' }) {
  const f = readFacts(yaml)
  if (f.serverPort !== String(port))
    throw new Error(`e2e derived config ${path}: server.port ${f.serverPort} ≠ resolved ${port}`)
  if (f.dbPath !== dbPath)
    throw new Error(`e2e derived config ${path}: database.path ${f.dbPath} ≠ derived ${dbPath}`)
  if (f.hasPostgres)
    throw new Error(
      `e2e derived config ${path}: a postgresql block is still present — the patch landed ` +
        'in the wrong block, and the backend would boot the abandoned Postgres path.',
    )
  return f
}

/**
 * Derive + write atomically + verify. Returns the written path.
 *
 * ATOMIC because Playwright re-loads the config in every worker process, so a worker
 * can be writing this file while the runner's backend is reading it. `write to a
 * sibling, then rename` makes a reader see the old bytes or the new bytes, never half.
 */
export function writeDerivedConfig({ basePath, outPath, port, dbPath }) {
  const yaml = deriveConfig(readFileSync(basePath, 'utf8'), { port, dbPath })
  const tmp = `${outPath}.${process.pid}.tmp`
  writeFileSync(tmp, yaml)
  renameSync(tmp, outPath)
  assertFactsAgree(readFileSync(outPath, 'utf8'), { port, dbPath, path: outPath })
  return outPath
}
