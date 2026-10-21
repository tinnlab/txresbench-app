import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  NATIVE_CONTROLS,
  OPT_OUT_MARKER,
  collectViolations,
  diffAgainstBaseline,
  isOptedOut,
  quotedRanges,
  scanFiles,
  scanRoots,
  stripComments,
  violationKey,
} from './lint-native-controls.mjs'

/**
 * The guard's own tests. A ratchet nobody has watched FAIL is not a ratchet: every
 * property below is asserted with a positive case AND the negative control that would
 * be silently broken if the property regressed.
 */

const withTree = (files, fn) => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-controls-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(root, rel)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, body)
    }
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('every control in the closed set is detected as an opening JSX tag', () => {
  withTree(
    Object.fromEntries(
      NATIVE_CONTROLS.map(el => [`${el}.tsx`, `export const C = () => <${el} className="x" />\n`]),
    ),
    root => {
      const hits = collectViolations(scanFiles([root]))
      assert.deepEqual(
        hits.map(h => h.element).sort(),
        [...NATIVE_CONTROLS].sort(),
        'a control silently dropped out of the detector',
      )
    },
  )
})

test('a MULTI-LINE opening tag is a hit — the prevailing formatting in this tree', () => {
  // The false negative this closes. `TAG_RE` requires the tag name to be followed by whitespace,
  // `/` or `>`, and the scan ran PER LINE, so a tag whose name ended the line had nothing after it
  // to match and was invisible:
  //
  //     <button          ← never matched
  //       type="button"
  //     >
  //
  // That is how nearly every control longer than a few props is written here, so the shrink-only
  // baseline of 61 was not a measurement of what existed — the old command palette's
  // `<button role="option">` was absent from it entirely. Missing an exotic evasion is the
  // documented, accepted cost of a source scan; missing the COMMON formatting is a broken guard.
  //
  // Each control gets its own file so a per-element regression names itself.
  withTree(
    Object.fromEntries(
      NATIVE_CONTROLS.map(el => [`${el}.tsx`, `export const C = () => (\n  <${el}\n    className="x"\n  />\n)\n`]),
    ),
    root => {
      const hits = collectViolations(scanFiles([root]))
      assert.deepEqual(
        hits.map(h => h.element).sort(),
        [...NATIVE_CONTROLS].sort(),
        'a multi-line opening tag was invisible to the scan',
      )
      // The reported line is the one the TAG is on, not the one the match ends on — a hit whose
      // line number pointed at the next line would send the reader to the wrong place and would
      // break the opt-out lookback, which is measured in lines above the hit.
      assert.deepEqual([...new Set(hits.map(h => h.line))], [2])
    },
  )
})

test(`${OPT_OUT_MARKER} still covers a MULTI-LINE tag it precedes`, () => {
  // The lookback is 3 lines above the hit and the hit is now reported at the tag's own line, so a
  // marker written above a multi-line control keeps working. Without the pairing this change would
  // have turned every legitimately-marked multi-line control into a new violation.
  withTree(
    {
      'a.tsx': [
        `// ${OPT_OUT_MARKER}: the file input is invisible; the affordance is <Button>`,
        '<input',
        '  type="file"',
        '/>',
      ].join('\n'),
    },
    root => assert.equal(collectViolations(scanFiles([root])).length, 0),
  )
})

test('a control name that merely ENDS a line inside a multi-line string is still not a hit', () => {
  // The negative control for the change. Matching across line boundaries must not start counting
  // prose or fixtures: a hit is still rejected when its own line puts it inside quotes.
  withTree({ 'a.tsx': 'const s = "a raw <button> is banned"\n' }, root =>
    assert.equal(collectViolations(scanFiles([root])).length, 0),
  )
})

test('a component whose name merely STARTS with a control name is not a hit', () => {
  withTree(
    {
      'a.tsx':
        'export const A = () => (<><Button /><InputField /><SelectBox /><TextareaAuto /></>)\n',
    },
    root => assert.equal(collectViolations(scanFiles([root])).length, 0),
  )
})

test('a closing tag alone is not a hit (the opening one already counted)', () => {
  withTree({ 'a.tsx': 'const x = `</button>`\n' }, root =>
    assert.equal(collectViolations(scanFiles([root])).length, 0),
  )
})

test('prose about <button> in a comment is not a hit — and code on the same file still is', () => {
  withTree(
    {
      'a.tsx': [
        '// Never write a raw <button> here.',
        '/* a block comment about <input> too */',
        'export const A = () => <button />',
      ].join('\n'),
    },
    root => {
      const hits = collectViolations(scanFiles([root]))
      assert.equal(hits.length, 1, 'comments must not be scanned, code must')
      assert.equal(hits[0].line, 3, 'stripComments must preserve line numbers')
    },
  )
})

test('a control name inside a STRING is not a hit (the test that asserts the rule is not a violation)', () => {
  withTree(
    {
      'a.tsx': `expect(el.tagName, 'a native <select> is not the kit control').not.toBe('SELECT')\n`,
    },
    root => assert.equal(collectViolations(scanFiles([root])).length, 0),
  )
})

test('quotedRanges is per-line and marks the inside of a quoted span only', () => {
  const line = `const a = "<button>"; const b = <button />`
  const ranges = quotedRanges(line)
  assert.equal(ranges.length, 1)
  assert.ok(ranges[0][0] < line.indexOf('"<button>') + 2)
  // The SECOND <button> is real JSX and must remain visible.
  assert.equal(collectViolationsFromLine(line), 1)
})

function collectViolationsFromLine(line) {
  return withTree({ 'a.tsx': `${line}\n` }, root => collectViolations(scanFiles([root])).length)
}

test(`the ${OPT_OUT_MARKER} marker exempts its own line and up to 3 lines below it — not the file`, () => {
  withTree(
    {
      'a.tsx': [
        `// ${OPT_OUT_MARKER}: the file input is invisible; the affordance is <Button>`,
        '<input type="file" />',
        '',
        '',
        '<button />', // 4 lines below the marker — OUTSIDE the lookback
      ].join('\n'),
    },
    root => {
      const hits = collectViolations(scanFiles([root]))
      assert.equal(hits.length, 1, 'the marker must not exempt a whole file')
      assert.equal(hits[0].element, 'button')
    },
  )
  assert.equal(isOptedOut([`x // ${OPT_OUT_MARKER}`], 0), true)
  assert.equal(isOptedOut(['x', 'y'], 1), false)
})

test('the baseline diff fails on a NEW hit and on a STALE entry', () => {
  const v = [{ file: '/x/ui/src/a.tsx', element: 'button' }]
  const key = violationKey('/x/ui/src/a.tsx', 'button', '/x')
  assert.equal(key, 'ui/src/a.tsx|button')

  const clean = diffAgainstBaseline(v, { entries: { [key]: 1 } }, '/x')
  assert.deepEqual([clean.added, clean.stale], [[], []])

  const added = diffAgainstBaseline(v, { entries: {} }, '/x')
  assert.equal(added.added.length, 1, 'a new raw control must fail')

  const stale = diffAgainstBaseline([], { entries: { [key]: 1 } }, '/x')
  assert.equal(stale.stale.length, 1, 'a ledger that outlives the code must fail')
})

test('the committed ledger is exactly what the tree produces (no drift, either direction)', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('./native-controls-baseline.json', import.meta.url), 'utf8'),
  )
  const { added, stale } = diffAgainstBaseline(collectViolations(scanFiles()), baseline)
  assert.deepEqual(
    { added, stale },
    { added: [], stale: [] },
    'run `node scripts/lint-native-controls.mjs --write` after a genuine removal',
  )
})

test('the scan reaches the real first-party roots and NOT the sdk submodule', () => {
  const roots = scanRoots()
  assert.ok(roots.some(r => r.endsWith(path.join('ui', 'src'))), 'ui/src must be scanned')
  assert.ok(roots.some(r => r.includes(path.join('libs', 'viz'))), 'packages must be scanned')
  assert.ok(!roots.some(r => r.includes(`${path.sep}sdk${path.sep}`)), 'the kit DEFINES these elements')
  assert.ok(scanFiles(roots).length > 700, 'the scan set collapsed')
})

test('stripComments blanks, never deletes (line count is preserved)', () => {
  const src = 'a\n/* x\ny */\nb\n'
  assert.equal(stripComments(src).split('\n').length, src.split('\n').length)
})
