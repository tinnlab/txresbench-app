/**
 * TEST-QF2-2c — the location-neutral copy guard (DEC-6, owner 2026-11-09:
 * a web demo will be hosted later, so no user-visible text may say or imply
 * that the app runs on the user's computer or that data stays on it).
 *
 * The guard scans every user-visible source the qa-fixes2 ITEM-2 sweep
 * named — the txr modules' non-test `.ts`/`.tsx`, `txrhelp/content.ts`,
 * the module READMEs, `README.md`, the landing-site content
 * (`site/src/`) and the published API docs (`openapi.json` + the generated
 * client) — and fails on any banned phrase, case-insensitive.
 *
 * A legitimate occurrence (a developer-facing code comment carrying
 * technical wording, rule (e) of the ITEM-2 plan) is allow-listed in
 * `copyGuard.allowlist.json`, one entry per file+line, each with its
 * reason. The allow-list is shrink-only in spirit: every entry must
 * actually match the current tree, and it is never a place to hide a
 * user-visible phrase — the sweep's user-visible occurrences are all
 * removed, not allowed.
 *
 * The phrase list is the ITEM-2 plan's grep set, plus "another computer":
 * the "open a model file from another computer" / "save as a file to move
 * to another computer" export-import wording was part of the same sweep
 * (DRIFT-1 ITEM-2 — the location clause deleted; the owner can reinstate a
 * desktop-specific wording per deployment).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The banned phrases, lowercase, matched as substrings. */
const BANNED = [
  'on your computer',
  'on this computer',
  'your computer',
  'this computer',
  'your own computer',
  'your machine',
  'this machine',
  'on your machine',
  'never leaves',
  'never uploaded',
  'nothing is uploaded',
  'read on this computer only',
  'stays on',
  'desktop application',
  'your device',
  'runs entirely',
  'no cloud',
  'single-user use on one machine',
  'offline',
  // DEC-6 sweep extension (DRIFT-1 ITEM-2): file-export/import wording.
  'another computer',
] as const

/**
 * The qa-fixes4 ITEM-1 sweep (results-r3 R3-results-2 + help-r3's location
 * section): user-visible sources must not carry "app server", the "oras"
 * tool name, the `<app_data>` placeholder or an absolute path of the common
 * roots. Two of the four are the plan's pinned literal phrases; the path
 * check is word-anchored (`(^|\s)/data/…`) on purpose — a module import
 * like `'@/data/useModelInventory'` is code wiring, not user-visible copy,
 * and an anchored check is what tells the two apart without an allow-list
 * entry per import. `oras` is whole-word so a method id or a journal name
 * containing it does not fire.
 */
const ITEM1_PATTERNS: ReadonlyArray<{ phrase: string; re: RegExp }> = [
  { phrase: 'app server', re: /app server/i },
  { phrase: 'oras', re: /\boras\b/i },
  { phrase: '<app_data>', re: /<app_data>/i },
  {
    phrase: '/data/ (word-anchored)',
    re: /(^|\s)\/(data|home|usr|var|tmp|opt)\//i,
  },
]

/** The repo root, derived from the ui package cwd (vitest runs there). */
const REPO_ROOT = resolve(process.cwd(), '../..')

/** The modules the ITEM-2 sweep named (non-test sources scanned). */
const MODULES = [
  'txrshell',
  'txrintake',
  'txrrun',
  'txrlist',
  'txrresults',
  'txrmodels',
  'txrhistory',
  'txrhelp',
] as const

/** Extra user-visible sources the sweep named (relative to the repo root). */
const FILES = [
  'README.md',
  'site/src/index.html',
  'src-app/ui/openapi/openapi.json',
  'src-app/ui/src/api-client/types.ts',
] as const

/** True for a source file the guard scans (tests and fixtures excluded —
 *  tests asserting the new copy are the suite's own pins). */
function isNonTest(rel: string): boolean {
  return !(
    rel.endsWith('.test.ts') ||
    rel.endsWith('.test.tsx') ||
    rel.endsWith('.spec.ts') ||
    rel.endsWith('.spec.tsx') ||
    rel.endsWith('.browser.test.ts')
  )
}

/** Every file under a module dir with the guard's suffixes. */
function moduleFiles(module: string): string[] {
  const dir = join(REPO_ROOT, 'src-app/ui/src/modules', module)
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.md')) {
        const rel = relative(REPO_ROOT, full).split('\\').join('/')
        if (isNonTest(rel)) out.push(rel)
      }
    }
  }
  walk(dir)
  return out
}

interface AllowEntry {
  file: string
  line: string
  reason: string
}

const allowFilePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'copyGuard.allowlist.json',
)
const ALLOW: AllowEntry[] = JSON.parse(readFileSync(allowFilePath, 'utf8')).entries

/** The banned-phrase hits of one line (both sweep generations). */
function phraseHits(line: string): string[] {
  const lower = line.toLowerCase()
  const hits = BANNED.filter(phrase => lower.includes(phrase))
  for (const pattern of ITEM1_PATTERNS) {
    if (pattern.re.test(line)) hits.push(pattern.phrase)
  }
  return hits
}

describe('location-neutral copy guard (TEST-QF2-2c)', () => {
  it('scans the named user-visible sources for the banned phrases', () => {
    expect(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8').length).toBeGreaterThan(0)
    const files = new Set<string>([
      ...MODULES.flatMap(moduleFiles),
      ...FILES.filter(f => {
        try {
          return statSync(join(REPO_ROOT, f)).isFile()
        } catch {
          return false
        }
      }),
    ])
    const violations: string[] = []
    for (const rel of files) {
      const lines = readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const trimmed = lines[i].trim()
        const hits = phraseHits(lines[i])
        if (hits.length === 0) continue
        const allowed = ALLOW.some(entry => entry.file === rel && entry.line === trimmed)
        if (!allowed) {
          violations.push(`${rel}:${i + 1} — ${hits.join(', ')} — ${lines[i].trim()}`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('every allow-list entry still matches the tree (no dead entries)', () => {
    for (const entry of ALLOW) {
      const full = join(REPO_ROOT, entry.file)
      const lines = readFileSync(full, 'utf8').split('\n')
      const match = lines.find(line => line.trim() === entry.line)
      expect(match !== undefined, `allow-list entry no longer matches: ${entry.file}`).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(10)
      const hits = phraseHits(match ?? '')
      expect(
        hits.length > 0,
        `allow-list entry is not a banned phrase: ${entry.file}`,
      ).toBe(true)
    }
  })
})
