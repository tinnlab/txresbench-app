// The behavioural test for `check-rename-mechanical.mjs` (visualize-pane ITEM-69 / TEST-85).
//
// ── Why this file exists ───────────────────────────────────────────────────────────────
//
// The guard shipped with ZERO invocation sites: it was in no `package.json` script, no
// `just` recipe and no workflow, so its 190 lines never ran. This round wires it into
// `npm run check`; a guard that runs is only worth having if it can also FAIL, so this
// drives it against synthetic repositories where the answer is known.
//
// ── It drives THE GUARD, never a copy of it ───────────────────────────────────────────
//
// The obvious way to write this file is to restate the guard's rule here and assert
// against that restatement. That proves nothing: it is the same trap as a test that
// hand-installs its own subject and then asserts a property of what it just installed —
// the copy can be right while the shipped guard is wrong, and the copy is what drifts.
//
// So every case below SPAWNS `check-rename-mechanical.mjs` as a subprocess, pointed at a
// throwaway git repo via its `--repo` seam, and asserts on the guard's real exit code and
// real output. Nothing here re-implements `MOVING_TOKENS`, `PROTECTED_CONTEXTS`, or the
// multiset rule.
//
// ── What the cases are for ────────────────────────────────────────────────────────────
//
// The interesting one is the wrong-substitution family. The guard's mechanism is to
// collapse the three moving directory names (`processors` / `packages` / `libs`) to ONE
// placeholder so a moved path reads as "no change". That erases DIRECTION: a line rewritten
// the WRONG way — the deployed `<data_root>/processors` root, the `/api/processors/*`
// route, the `modules/processors` id, the `/settings/processors` route, none of which move
// — normalises to exactly the same placeholder as a correct rewrite, the multiset stays
// balanced, and the commit certifies as "0 non-path changes". The one class of mistake this
// rename can actually make was the one class the guard could not see.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUARD = path.join(HERE, 'check-rename-mechanical.mjs')
const MARKER = 'ITEM-69: rename'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/**
 * A throwaway repo whose HEAD commit rewrites `before` → `after` under a subject carrying
 * the rename marker. Returns the repo path.
 */
function repoWith(before, after, subject = `visualize-pane ${MARKER} — the container`) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rename-guard-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'test'])
  const file = path.join(dir, 'src-app/server/paths.rs')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, before)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  writeFileSync(file, after)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', subject])
  return dir
}

/** Run the REAL guard against `dir`. Returns `{ code, out }`; never throws. */
function runGuard(dir, args = ['--commit', 'HEAD']) {
  try {
    const out = execFileSync(process.execPath, [GUARD, '--repo', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** Build the repo, run the guard, clean up. */
function verdictFor(before, after) {
  const dir = repoWith(before, after)
  try {
    return runGuard(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────────────
//
// These must PASS, and they are what stops the protected-context rule from degenerating
// into "flag every line mentioning processors" — which is not hypothetical: a first draft
// anchored the data-root pattern on the join rather than on the receiver, and it failed
// the real rename commit by flagging the three SOURCE-tree joins that commit correctly
// rewrote.

test('a SOURCE-tree move is mechanical — the guard accepts it', () => {
  const v = verdictFor(
    'let src = src_app_dir().join("processors");\n',
    'let src = src_app_dir().join("packages");\n',
  )
  assert.equal(v.code, 0, v.out)
  assert.match(v.out, /0 non-path changes/)
})

test('a SOURCE-tree path STRING move is mechanical too', () => {
  const v = verdictFor('const P = "src-app/processors/qc";\n', 'const P = "src-app/packages/qc";\n')
  assert.equal(v.code, 0, v.out)
})

test('the npm-libs half of the move (packages → libs) is mechanical', () => {
  const v = verdictFor('const P = "src-app/packages/viz";\n', 'const P = "src-app/libs/viz";\n')
  assert.equal(v.code, 0, v.out)
})

// ── THE ORIGINAL RULE still holds ────────────────────────────────────────────────────

test('a real edit riding along inside the rename commit FAILS', () => {
  const v = verdictFor(
    'let src = src_app_dir().join("processors");\n',
    'let src = src_app_dir().join("packages"); // while I am here\n',
  )
  assert.equal(v.code, 1, v.out)
  assert.match(v.out, /is NOT mechanical/)
})

// ── THE BLIND SPOT, closed ───────────────────────────────────────────────────────────
//
// Each of these is a WRONG substitution: the context does not move. Every one of them
// normalises to the same placeholder as a correct rewrite, so the multiset rule alone reads
// them as "no change" — they are caught only by the protected-context counts. Driven
// through the real guard, so a regression in those patterns fails HERE.

const WRONG = [
  ['the REST namespace', 'const P = "/api/processors/reload";\n', 'const P = "/api/packages/reload";\n'],
  ['the deployed data root (prose)', '// writes <data_root>/processors/<id>/\n', '// writes <data_root>/packages/<id>/\n'],
  ['a data-root join', 'let d = data_dir().join("processors");\n', 'let d = data_dir().join("packages");\n'],
  ['the UI module id', 'import x from "@/modules/processors/store";\n', 'import x from "@/modules/packages/store";\n'],
  ['the settings route', 'page.goto("/settings/processors");\n', 'page.goto("/settings/packages");\n'],
  // The `packages` SEGMENT of the route — the `packages`→`libs` direction, which the five
  // `processors`-only contexts above cannot see: the `/api/processors` count is UNCHANGED by
  // this rewrite, so only the dedicated route entry catches it.
  ['the REST route’s packages segment', 'const P = "/api/processors/packages";\n', 'const P = "/api/processors/libs";\n'],
]

for (const [what, before, after] of WRONG) {
  test(`a WRONG substitution of ${what} FAILS, and the guard says which`, () => {
    const v = verdictFor(before, after)
    assert.equal(v.code, 1, `expected a failure for ${what}; guard said:\n${v.out}`)
    assert.match(v.out, /PROTECTED CONTEXT CHANGED/, v.out)
  })
}

// ── the reason those cases are meaningful ────────────────────────────────────────────

test('SANITY: each wrong substitution really is invisible to the placeholder rule alone', () => {
  // (This is the ONE place this file restates the guard's rule, and it restates it in order
  // to check the PREMISE the cases above rest on — not to stand in for the guard.)
  // Not a test of the guard — a test of the PREMISE the cases above rest on. If a wrong
  // substitution were already caught by the multiset rule, the protected-context machinery
  // would be redundant and these cases would pass for the wrong reason.
  const norm = s => s.replace(/\b(processors|packages|libs)\b/g, '§')
  for (const [what, before, after] of WRONG) {
    assert.equal(norm(before), norm(after), `${what} should be invisible to the placeholder rule`)
  }
})

// ── the no-subject case is NOT a failure ─────────────────────────────────────────────

test('a branch with no rename commit is a NOTE, not a failure', () => {
  const dir = repoWith('a\n', 'b\n', 'an ordinary commit')
  try {
    // No `--commit`: this exercises the guard's own SUBJECT-FINDING path (scan the range
    // for the marker), which is the only path on which "no subject" can arise.
    const v = runGuard(dir, ['--base', 'HEAD~1'])
    assert.equal(v.code, 0, v.out)
    assert.match(v.out, /nothing to check/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── and the property this file exists because nothing had ────────────────────────────

test('it is INVOKED — on the `check` chain, not merely defined', () => {
  // `just check`'s own words: "a guard nobody invokes is not a guard." The finding was not
  // that the guard was wrong; it was that it ran nowhere. Deleting the wiring fails here.
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.ok(
    pkg.scripts['check:rename-mechanical']?.includes('check-rename-mechanical.mjs'),
    'a script must invoke check-rename-mechanical.mjs',
  )
  assert.ok(
    pkg.scripts.check.includes('check:rename-mechanical'),
    'and `check` must run it',
  )
})
