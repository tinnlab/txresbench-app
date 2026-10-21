// TEST-83 (visualize-pane ITEM-68) — `inspects:` has exactly ONE state.
//
// ── the three states, and why the middle one is the bug ─────────────────────────────
//
// A declared key can be in one of three states, and only two of them are coherent:
//
//   1. DECLARED and READ — it means something; a spec that sets it changes behaviour.
//   2. ABSENT — it means nothing, and nobody can rely on it.
//   3. DECLARED and READ BY NOTHING — it looks like it means something. Every shipped
//      spec sets it, an author copying one sets it too, and the app does not consult it.
//
// (3) is what shipped: `inspects:` was on the `ViewSpec` type, declared by all three
// shipped package specs and by the in-tree fixture, and read nowhere. The pane's automount
// gate uses the owning ANALYSIS' `appliesTo` — the declaration the launcher, the MCP
// capability manifest and the fallback form already agree on — and said so in a comment
// (`shell/dock/viewAutomountGate.ts`) rather than in a test. A key in state (3) is not
// harmless: it has no defined meaning, so the next reader is free to invent one, and the
// two declarations (view + manifest) can then disagree with nothing to arbitrate.
//
// ITEM-68 resolved it to state (2): removed from the type, from the three shipped specs
// and from the fixture. This test HOLDS it there. It is written as an absence assertion on
// purpose — a re-added key would fail here before it could acquire a second meaning.
//
// It scans the shipped FILES rather than a list of names, so a package added later is
// covered without anyone remembering to add it.
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../../../../..')
const PACKAGES = path.join(REPO, 'src-app/packages')
const FIXTURES = path.join(HERE, '../__fixtures__')

/** Every shipped `ui/*.yaml` view file, from both the package tree and the in-tree fixture
 *  tree — derived, never hand-listed. */
function shippedViewFiles(): string[] {
  const out: string[] = []
  for (const root of [PACKAGES, FIXTURES]) {
    if (!existsSync(root)) continue
    for (const pkg of readdirSync(root, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const uiDir = path.join(root, pkg.name, 'ui')
      if (!existsSync(uiDir)) continue
      for (const f of readdirSync(uiDir)) {
        if (f.endsWith('.yaml')) out.push(path.join(uiDir, f))
      }
    }
  }
  return out
}

describe('TEST-83 / ITEM-68 — `inspects:` is ABSENT, not declared-and-unread', () => {
  const files = shippedViewFiles()

  test('the scan actually finds shipped view files (positive control)', () => {
    // Without this, "no file declares `inspects`" would be trivially true of an empty scan —
    // which is exactly how an absence assertion rots into a tick that asserts nothing.
    expect(files.length, `no shipped ui/*.yaml found under ${PACKAGES}`).toBeGreaterThanOrEqual(3)
  })

  test('no shipped view_spec declares `inspects:`', () => {
    const offenders = files
      .filter(f => /^inspects:/m.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(REPO, f))
    expect(
      offenders,
      'a view_spec declares `inspects:`, which nothing reads — either wire it to a consumer ' +
        'or delete it; a key with no reader has no defined meaning (ITEM-68)',
    ).toEqual([])
  })

  test('the `ViewSpec` TYPE no longer carries it', () => {
    // The type is what makes the key look supported to an author with an editor. Asserting
    // the source text is blunt but it is the honest test of "this key is not offered": a
    // structural check would need the key to still exist to look it up.
    const src = readFileSync(path.join(HERE, 'viewSpec.ts'), 'utf8')
    expect(/^\s*inspects\??:/m.test(src), '`ViewSpec` re-declares `inspects`').toBe(false)
  })

  test('no app source READS it either (the other coherent state was not chosen)', () => {
    // If someone wires a reader, this test must fail so the decision is re-opened
    // deliberately — state (1) is legitimate, but it is a different design than the one
    // shipped, and it may not arrive by accident.
    const src = path.join(REPO, 'src-app/ui/src')
    const hits: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name)) continue
        // A property READ (`spec.inspects` / `.inspects`), not the English word in prose.
        if (/\.inspects\b/.test(readFileSync(p, 'utf8'))) hits.push(path.relative(src, p))
      }
    }
    walk(src)
    expect(hits, 'an app source reads `.inspects` — re-open ITEM-68 rather than reviving it').toEqual([])
  })
})
