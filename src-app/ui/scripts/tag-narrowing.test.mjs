/**
 * `tag-narrowing.mjs` + the watchdog reporter's disclosure of it.
 *
 * The property under test is not "the scan finds files". It is that a run which covers
 * LESS than the suite says so, with a number, and that the saying is DERIVED — because
 * the defect these tests pin was a disclosure that existed, read as authoritative, and
 * was wrong: `playwright.config.ts` excluded `@acceptance` and announced ONE hardcoded
 * spec path while five spec files carried the tag.
 *
 * So each test below asserts something a hand-list would fail: that the count tracks the
 * specs on disk, that an empty match is reported as a broken scan rather than as a clean
 * run, and that a config declaring no narrowing stays silent (a disclaimer printed on
 * runs it does not describe is one readers learn to skip past).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { NARROWING_TAG, narrowedOut, narrowingBanner } from './tag-narrowing.mjs'
import HarnessWatchdogReporter from './harness-watchdog-reporter.mjs'

/** A throwaway `tests/e2e`-shaped tree, so these tests do not encode the real suite's
 *  current counts (which change legitimately, and pinning them here would make this file
 *  the very kind of snapshot it exists to forbid). */
function fixtureTree(specs) {
  const root = mkdtempSync(path.join(tmpdir(), 'tag-narrowing-'))
  for (const [rel, body] of Object.entries(specs)) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

test('the excluded set is DERIVED — it grows when a tagged test is added, with no edit here', () => {
  const root = fixtureTree({
    'a.spec.ts': `test('one @acceptance', async () => {})`,
    'nested/b.spec.ts': `test('two @acceptance', async () => {})\ntest('plain', async () => {})`,
  })
  try {
    const before = narrowedOut({ testDir: root })
    assert.equal(before.tests.length, 2, 'both tagged titles are found; the untagged one is not')
    assert.equal(before.files.length, 2)

    writeFileSync(path.join(root, 'nested/c.spec.ts'), `test('three @acceptance', async () => {})`)
    const after = narrowedOut({ testDir: root })
    assert.equal(after.tests.length, 3, 'a tagged test added on disk is disclosed without any edit')
    assert.equal(after.files.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file MENTIONING the tag in prose is not counted as a tagged test', () => {
  // The guard's first draft counted files containing the string and answered 8 where the
  // banner answered 5, because these specs discuss the tag at length in comments. A
  // disclosure and the check on it must derive one number, not two that can disagree.
  const root = fixtureTree({
    'a.spec.ts': `// this spec is excluded by @acceptance, see the config\ntest('untagged', async () => {})`,
  })
  try {
    assert.equal(narrowedOut({ testDir: root }).tests.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the banner leads with the COUNT and names every file — that is what a hand-list got wrong', () => {
  const root = fixtureTree({
    'a.spec.ts': `test('one @acceptance', async () => {})`,
    'b.spec.ts': `test('two @acceptance', async () => {})`,
  })
  try {
    const text = narrowingBanner(narrowedOut({ testDir: root }))
    assert.match(text, /EXCLUDED from this run: 2 @acceptance test\(s\) in 2 spec file\(s\)/)
    assert.match(text, /a\.spec\.ts/)
    assert.match(text, /b\.spec\.ts/, 'the SECOND file is named — the shipped bug named only the first')
    assert.match(text, /are 2 short of the suite/, 'the totals are explicitly qualified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a tag matching NOTHING reports a broken scan, never a clean run', () => {
  const root = fixtureTree({ 'a.spec.ts': `test('untagged', async () => {})` })
  try {
    const text = narrowingBanner(narrowedOut({ testDir: root }))
    assert.match(text, /WARNING/)
    assert.match(text, /ZERO tagged tests/)
    assert.doesNotMatch(text, /EXCLUDED from this run: 0/, 'silence and "nothing excluded" must not look alike')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the tag is spelled ONCE, and the config narrows by that spelling', async () => {
  // A tag renamed on one side only is the failure mode that makes an exclusion exclude
  // nothing while still reading as deliberate.
  const cfg = await import('node:fs').then(m =>
    m.readFileSync(path.resolve(import.meta.dirname, '../playwright.config.ts'), 'utf8'),
  )
  assert.match(cfg, new RegExp(`grepInvert[^\\n]*/${NARROWING_TAG}/`))
})

// ── the reporter half: the disclosure lands beside the TOTALS, not only at load ──────

/** Drive `onBegin`/`onEnd` with a fake config and capture what the reporter printed. */
function runReporter(config) {
  const r = new HarnessWatchdogReporter({ env: {}, ownRoot: '/wt/mine' })
  const lines = []
  const real = console.warn
  console.warn = (...a) => lines.push(a.join(' '))
  try {
    r.onBegin(config, { location: { file: '' } })
    r.onEnd()
  } finally {
    console.warn = real
  }
  return lines.join('\n')
}

test('a config that narrows has its narrowing announced AFTER the run, with the count', () => {
  const root = fixtureTree({ 'a.spec.ts': `test('one @acceptance', async () => {})` })
  try {
    const out = runReporter({ grepInvert: /@acceptance/, projects: [{ testDir: root }] })
    assert.match(out, /EXCLUDED from this run: 1 @acceptance test\(s\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a config that narrows NOTHING prints nothing — the reporter is shared by four configs', () => {
  // Keying this on `TXR_E2E_REAL_COMPUTE` instead of the running config would have made
  // the viz/gallery/visual runs — which exclude nothing — carry an exclusion notice.
  const out = runReporter({ projects: [{ testDir: '/nonexistent' }] })
  assert.doesNotMatch(out, /EXCLUDED/)
  assert.doesNotMatch(out, /WARNING/)
})
