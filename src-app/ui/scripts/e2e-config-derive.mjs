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
 * database name are written INTO a per-run copy of the config, and the old check
 * survives as a POST-CONDITION on that file — an assertion about the artifact the
 * backend will really boot with, rather than a hope that four inputs were typed alike.
 *
 * ## Why the patch is BLOCK-SCOPED, and why that is the interesting failure
 *
 * `postgresql.external` also carries a `port:`. A whole-file `port:` replace would
 * repoint the backend's DATABASE at the harness port while `server.port` still looked
 * right, and every other check in the config would still pass. That is why
 * `assertDerivedConfigAgrees` asserts a NEGATIVE (the postgres port must NOT have
 * become the harness port) as well as the two positives: a derivation bug is invisible
 * to the code that wrote it and obvious to code that reads the file back.
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
 * (which is precisely how `postgresql` carries a second `port:`), and picking one is
 * a guess.
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
export function deriveConfig(baseYaml, { port, database }) {
  let out = patchBlock(baseYaml, 'server', b => setField(b, 'port', String(port)))
  out = patchBlock(out, 'postgresql', b => setField(b, 'database', `"${database}"`))
  return out
}

/** Extract the three facts the post-condition checks. */
export function readFacts(yaml) {
  const block = name => new RegExp(`^${name}:\\s*$([\\s\\S]*?)(?=^\\S)`, 'm').exec(yaml)?.[1] ?? ''
  return {
    serverPort: /^\s+port:\s*(\d+)/m.exec(block('server'))?.[1] ?? null,
    database: /^\s+database:\s*["']?([\w-]+)/m.exec(block('postgresql'))?.[1] ?? null,
    pgPort: /^\s+port:\s*(\d+)/m.exec(block('postgresql'))?.[1] ?? null,
  }
}

/**
 * Re-read the file the backend will boot with and assert it says what this run
 * decided. Reading BACK is the point: the writer cannot see its own mis-aimed regex.
 */
export function assertFactsAgree(yaml, { port, database, path = '<derived>' }) {
  const f = readFacts(yaml)
  if (f.serverPort !== String(port))
    throw new Error(`e2e derived config ${path}: server.port ${f.serverPort} ≠ resolved ${port}`)
  if (f.database !== database)
    throw new Error(`e2e derived config ${path}: database ${f.database} ≠ derived ${database}`)
  if (f.pgPort === String(port))
    throw new Error(
      `e2e derived config ${path}: the postgresql port was rewritten to ${f.pgPort} — the patch ` +
        'landed in the wrong block and the backend would dial the harness port for its database.',
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
export function writeDerivedConfig({ basePath, outPath, port, database }) {
  const yaml = deriveConfig(readFileSync(basePath, 'utf8'), { port, database })
  const tmp = `${outPath}.${process.pid}.tmp`
  writeFileSync(tmp, yaml)
  renameSync(tmp, outPath)
  assertFactsAgree(readFileSync(outPath, 'utf8'), { port, database, path: outPath })
  return outPath
}
