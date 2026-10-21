// ITEM-12 — `extensions/provenance` is a READ-ONLY VIEW over the server's provenance
// API. Provenance is RECORDED server-side from `job.params` when a run executes; the
// workbench holds no provenance logic and must never gain a write path. This test is the
// mechanical guard: if someone adds a POST/PUT/PATCH/DELETE, or reaches for a
// record/capture/emit-provenance client call, it fails here rather than in review.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DIR = fileURLToPath(new URL('.', import.meta.url))

function productionFiles(): string[] {
  return readdirSync(DIR).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
}

/** Any mutating ApiClient call, and any provenance-WRITE verb. */
const WRITE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'ApiClient mutation namespace', re: /ApiClient\.[A-Za-z]+\.(create|update|delete|patch|put|post|record|capture)\b/ },
  { name: 'raw mutating fetch', re: /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i },
  { name: 'provenance write verb', re: /\b(recordProvenance|captureProvenance|writeProvenance|emitProvenance|createRunNode|upsertLineage)\b/ },
]

describe('extensions/provenance is read-only', () => {
  it('scans a non-empty production file set', () => {
    // Fail CLOSED: a guard whose scan set vanished would otherwise pass vacuously.
    expect(productionFiles().length).toBeGreaterThanOrEqual(4)
  })

  it('contains no provenance WRITE path', () => {
    const offenders: string[] = []
    for (const f of productionFiles()) {
      const src = readFileSync(DIR + f, 'utf8')
      for (const { name, re } of WRITE_PATTERNS) {
        if (re.test(src)) offenders.push(`${f}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
