// Structural test for the `ai-controllable-actions` Claude skill
// (ai-actions ITEM-11 / TEST-12). Run directly:
//   node scripts/skill-check.test.mjs
//
// Asserts `.claude/skills/ai-controllable-actions/SKILL.md` exists and
// contains each of the binding sections the feature brief requires:
// register-every-action (+ mandatory real permission), verify-AI-drivability
// (palette + MCP), instance/stale-state, audit-un-registered, and the
// mandatory-feature-lifecycle-sub-check note.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// scripts/ -> src-app/ui -> src-app -> <repo root>
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'ai-controllable-actions', 'SKILL.md')

test('SKILL.md exists at the expected committed path', () => {
  assert.ok(existsSync(SKILL_PATH), `expected ${SKILL_PATH} to exist`)
})

test('SKILL.md has frontmatter naming the skill', () => {
  const content = readFileSync(SKILL_PATH, 'utf8')
  assert.match(content, /^---\n[\s\S]*?name:\s*ai-controllable-actions/m)
  assert.match(content, /description:/)
})

test('SKILL.md contains the "register every action + mandatory permission" section', () => {
  const content = readFileSync(SKILL_PATH, 'utf8')
  assert.match(content, /##.*[Rr]egister every user action.*`defineAction`/)
  assert.match(content, /permission.*(?:MANDATORY|mandatory)/s)
  assert.match(content, /zod schema/i)
})

test('SKILL.md contains the "verify AI-drivability (palette + MCP)" section', () => {
  const content = readFileSync(SKILL_PATH, 'utf8')
  assert.match(content, /##.*AI-drivability/)
  assert.match(content, /command palette/i)
  assert.match(content, /list_capabilities/)
  assert.match(content, /describe_capability/)
  assert.match(content, /invoke_capability/)
})

test('SKILL.md contains the "instance actions / useAction + stale-state guard" section', () => {
  const content = readFileSync(SKILL_PATH, 'utf8')
  assert.match(content, /##.*[Ii]nstance actions.*`useAction`.*stale-state/)
  assert.match(content, /`expected`/)
  assert.match(content, /STALE_STATE/)
  assert.match(content, /read-before-write/i)
})

test('SKILL.md contains the "audit for un-registered actions" section', () => {
  const content = readFileSync(SKILL_PATH, 'utf8')
  assert.match(content, /##.*[Aa]udit for un-registered actions/)
  assert.match(content, /action-refs-lint\.mjs/)
  assert.match(content, /action-coverage\.mjs/)
})

test('SKILL.md contains the "mandatory feature-lifecycle sub-check" section', () => {
  const content = readFileSync(SKILL_PATH, 'utf8')
  assert.match(content, /##.*[Mm]andatory feature-lifecycle sub-check/)
  assert.match(content, /npm run check/)
})
