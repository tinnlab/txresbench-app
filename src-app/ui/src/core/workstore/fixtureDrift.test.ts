// fixtureDrift.test.ts — the CROSS-LANGUAGE fixtures are byte-identical to a fresh run
// of the real producer (the golden-parity gate for `__fixtures__/zarr/`).
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
//
// `zarrReader.test.ts` and `artifactReader.test.ts` rest their entire claim on a
// sentence: the fixture bytes were "written by the real producer" — `src-app/packages/
// _lib`'s `txr_zarr`, the module a processor actually emits artifacts with — so the TS
// reader has to agree with bytes it did not produce. That is what makes them evidence
// rather than a snapshot of whatever the reader happened to do.
//
// The sentence went FALSE. `txr_zarr.Table.string()` began stamping a `values_digest`
// onto a string member's declaration, and the two string-bearing nodes in the tree
// (`table/zarr.json`, `str_large/zarr.json`) silently fell behind the writer: re-running
// the generator changed committed bytes, so the fixtures were no longer what the shipping
// producer writes and nothing anywhere noticed. A contract test resting on a stale
// artefact still passes — it just stops testing the contract.
//
// So determinism is now CHECKED, exactly as `sdk/crates/txresbench-framework/src/openapi/
// emit_ts.rs`'s golden parity test (`generator_golden_fixture`) checks `types.ts` — the
// SDK owns that mechanism; there is no `server/src/openapi/`, which is what this comment
// used to cite while its sibling in `server/src/modules/datatype/tests/mod.rs` cited the
// SDK path correctly: regenerate from the source of truth, assert byte-identity
// with what is committed. `--out` sends the fresh run to a TEMP dir, because a check that
// regenerated in place would "pass" by repairing the drift it is supposed to report.
//
// ── WHAT A FAILURE MEANS ───────────────────────────────────────────────────────────
//
// Either the producer changed (legitimate — regenerate + commit, and read the diff, since
// it is also the diff every consumer of those artifacts will see), or the fixtures were
// hand-edited (never legitimate: the value of a cross-language fixture is precisely that
// no hand wrote it).
//
// ── PYTHON IS REQUIRED, NOT OPTIONAL ───────────────────────────────────────────────
//
// This suite needs `python3` + `numpy`. It FAILS rather than self-skips when they are
// absent: a skip would silently switch the gate off on exactly the machines where the
// drift would go unreviewed, and this repo already requires both (its own gate runs
// `python3 -m pytest src-app/packages`). The message below names the fix.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE_DIR = join(HERE, '__fixtures__')
const GENERATOR = join(FIXTURE_DIR, 'generate_zarr_fixtures.py')
const COMMITTED = join(FIXTURE_DIR, 'zarr')

/** Every file under `root`, keyed by its `/`-joined relative path. */
function tree(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)))
    }
  }
  walk(root)
  return files
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The paths on which two trees disagree: missing, extra, or different bytes. */
function drift(
  committed: Map<string, Uint8Array>,
  fresh: Map<string, Uint8Array>,
): { missing: string[]; extra: string[]; changed: string[] } {
  const missing = [...fresh.keys()].filter(p => !committed.has(p)).sort()
  const extra = [...committed.keys()].filter(p => !fresh.has(p)).sort()
  const changed = [...fresh.keys()]
    .filter(p => committed.has(p) && !sameBytes(committed.get(p)!, fresh.get(p)!))
    .sort()
  return { missing, extra, changed }
}

let scratch: string | undefined

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

/** Regenerate into a temp dir and return its tree. */
function regenerate(): Map<string, Uint8Array> {
  scratch = mkdtempSync(join(tmpdir(), 'zarr-fixture-drift-'))
  const out = join(scratch, 'zarr')
  try {
    execFileSync('python3', [GENERATOR, '--out', out], { stdio: 'pipe' })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    const stderr = String((e as { stderr?: Buffer }).stderr ?? '')
    throw new Error(
      'could not run the fixture generator, so the "written by the real producer" claim ' +
        'cannot be checked. It needs python3 + numpy (the same deps this repo\'s ' +
        '`python3 -m pytest src-app/packages` gate needs) — install them rather than ' +
        `skipping this suite.\n${detail}\n${stderr}`,
    )
  }
  return tree(out)
}

describe('the committed Zarr fixtures are what the real producer writes today', () => {
  it('a fresh run of `txr_zarr` reproduces the committed tree byte for byte', () => {
    const committed = tree(COMMITTED)
    const fresh = regenerate()

    // ANTI-VACUITY: a comparison of two empty trees is trivially equal, and a generator
    // that wrote nothing (or a fixture dir that moved) would sail through everything below.
    expect(committed.size, 'the committed fixture tree collapsed').toBeGreaterThanOrEqual(100)
    expect(fresh.size, 'the generator produced (almost) nothing').toBeGreaterThanOrEqual(100)
    expect(
      [...fresh.keys()].filter(p => p.endsWith('zarr.json')).length,
      'the fresh tree has no Zarr nodes in it',
    ).toBeGreaterThanOrEqual(20)

    const { missing, extra, changed } = drift(committed, fresh)
    expect(
      { missing, extra, changed },
      'the committed fixtures are NOT what `src-app/packages/_lib`\'s writer produces ' +
        'today, so the reader contract tests are resting on a stale artefact. Either the ' +
        'producer changed (regenerate + commit, and READ the diff — every consumer of ' +
        'these artifacts sees it too) or a fixture was hand-edited (never legitimate).\n' +
        '  cd src-app/ui/src/core/workstore/__fixtures__ && python3 generate_zarr_fixtures.py',
    ).toEqual({ missing: [], extra: [], changed: [] })
  })

  it('the comparator DOES report drift when there is any (positive control)', () => {
    // Without this, a `drift()` that always returned three empty arrays — or a byte
    // comparison that only checked lengths — would make the case above unfalsifiable.
    const base = new Map<string, Uint8Array>([
      ['a/zarr.json', new Uint8Array([1, 2, 3])],
      ['a/c/0', new Uint8Array([9])],
    ])

    const flippedByte = new Map(base)
    flippedByte.set('a/zarr.json', new Uint8Array([1, 2, 4]))
    expect(drift(base, flippedByte).changed).toEqual(['a/zarr.json'])

    // Same length, different content — the case a length-only check would miss.
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)

    const added = new Map(base)
    added.set('b/zarr.json', new Uint8Array([7]))
    expect(drift(base, added)).toEqual({ missing: ['b/zarr.json'], extra: [], changed: [] })

    const removed = new Map(base)
    removed.delete('a/c/0')
    expect(drift(base, removed)).toEqual({ missing: [], extra: ['a/c/0'], changed: [] })

    // …and an identical pair is genuinely clean, so the reports above are not noise.
    expect(drift(base, new Map(base))).toEqual({ missing: [], extra: [], changed: [] })
  })
})
