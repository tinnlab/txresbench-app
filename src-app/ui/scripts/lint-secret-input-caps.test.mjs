import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

import { OPT_OUT_MARKER, findHits, scanFiles, MIN_SCANNED_FILES } from './lint-secret-input-caps.mjs'

/**
 * The guard's own tests. Every property is asserted with a positive case AND the negative
 * control that would be silently broken if it regressed — a guard nobody has watched FAIL,
 * on the exact shape it exists to catch, is not evidence of anything.
 *
 * The first case is the shipped defect, transcribed.
 */

test('the shipped defect is detected — a PasswordInput with maxLength', () => {
  const hits = findHits(`
    <PasswordInput
      data-testid="profile-new-password-input"
      showLabel="Show password"
      hideLabel="Hide password"
      autoComplete="new-password"
      placeholder="New password"
      maxLength={72}
    />
  `)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].tag, 'PasswordInput')
})

test('the OTHER door is detected — a plain Input with type="password"', () => {
  // The kit's type omission cannot reach this one: as far as the types go it is an
  // ordinary Input, and this app renders exactly this shape on the first-run setup page.
  const hits = findHits(`<Input data-testid="x" type="password" maxLength={72} />`)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].tag, 'Input')
})

test('attribute ORDER does not matter', () => {
  // The cap-before-type spelling: a rule that only matched one ordering would be a rule
  // about formatting.
  assert.equal(findHits(`<Input maxLength={72} type="password" />`).length, 1)
  assert.equal(findHits(`<Input type='password' maxLength={8} />`).length, 1)
})

test('a masked field WITHOUT a cap is clean', () => {
  // The negative control for the two above. Without it, a `findHits` that flagged every
  // masked field would pass them both.
  assert.equal(findHits(`<PasswordInput data-testid="x" showLabel="S" hideLabel="H" />`).length, 0)
  assert.equal(findHits(`<Input type="password" placeholder="secret" />`).length, 0)
})

test('a VISIBLE field with a cap is clean — the ban is specific to masked fields', () => {
  // A cap on a field the user can read is legitimate: they can see what survived. A guard
  // that flagged this would be a different, wrong rule.
  assert.equal(findHits(`<Input data-testid="username" maxLength={255} />`).length, 0)
  assert.equal(findHits(`<Input data-testid="email" type="email" maxLength={255} />`).length, 0)
})

test('prose about the rule is not a violation', () => {
  // This guard's own header, and passwordPolicy's, both discuss `maxLength` on a password
  // field at length. Comments are blanked before matching.
  assert.equal(
    findHits(`// never write <PasswordInput maxLength={72} /> — it truncates silently\nconst x = 1`)
      .length,
    0,
  )
  assert.equal(
    findHits(`/* <Input type="password" maxLength={72} /> is the defect */\nconst y = 2`).length,
    0,
  )
})

test('the per-line opt-out works, and only within its lookback window', () => {
  const marked = `// ${OPT_OUT_MARKER}: reason\n<Input type="password" maxLength={72} />`
  assert.equal(findHits(marked).length, 0)

  // Five lines above is outside the 3-line window — an opt-out that drifted away from the
  // line it excuses must stop excusing it.
  const far = `// ${OPT_OUT_MARKER}: reason\n\n\n\n\n<Input type="password" maxLength={72} />`
  assert.equal(findHits(far).length, 1)
})

test('a dynamic type is NOT guessed at', () => {
  // `type={masked ? 'password' : 'text'}` is not a claim this scan can settle, and guessing
  // would produce a false positive on a field that is never masked. The rendered-DOM twin
  // (tests/gallery-e2e/masked-field-caps.spec.ts) sees the value that was actually used.
  assert.equal(findHits(`<Input type={t} maxLength={72} />`).length, 0)
})

test('line numbers point at the tag', () => {
  const hits = findHits(`const a = 1\nconst b = 2\n<PasswordInput maxLength={72} />`)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 3)
})

test('the scan set has not collapsed', () => {
  // The floor that makes "0 violations" mean something rather than "0 files looked at".
  assert.ok(
    scanFiles().length >= MIN_SCANNED_FILES,
    `scanned ${scanFiles().length} file(s), floor is ${MIN_SCANNED_FILES}`,
  )
})

test('the real tree is clean', () => {
  // The rule, asserted where it matters. This is the assertion that would have been RED
  // before the fix.
  const offenders = scanFiles().flatMap(f =>
    findHits(readFileSync(f, 'utf8')).map(h => `${f}:${h.line}`),
  )
  assert.deepEqual(offenders, [])
})
