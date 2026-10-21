// TEST-A3 [acceptance] [invariant: INV-3] — the editor performs NO model inference and
// bundles NO AI/segmentation model. This static scan of the editor's own source is the
// executable guard: a future `onnxruntime`/model/inference import into the annotate,
// adapter (processor seam), mask, or coordination code would fail this test — which is
// what makes INV-3 (the editor runs no model; all segmentation is an external processor)
// machine-enforced rather than merely true-by-accident today.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// this file lives at src/viz-core/annotate/ → '../..' is the package `src` root.
const SRC = new URL('../..', import.meta.url).pathname

const SCANNED_DIRS = ['viz-core/annotate', 'adapter', 'viz-core/spatial', 'viz-core/coordination']

// Forbidden import specifiers: an in-browser inference runtime or a bundled model.
const FORBIDDEN = [
  'onnxruntime',
  'onnxruntime-web',
  '@tensorflow',
  'tfjs',
  '@xenova/transformers',
  '@huggingface',
  'wasm-vips',
  'sam2',
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// Match an actual import/require of a forbidden specifier — NOT a comment or a string
// mention (the docs legitimately name "sam2" as an example external producer).
function forbiddenImportsIn(src: string): string[] {
  const hits: string[] = []
  for (const spec of FORBIDDEN) {
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:import[^;]*from\\s*['"]|require\\(\\s*['"]|import\\(\\s*['"])${esc}`, 'g')
    if (re.test(src)) hits.push(spec)
  }
  return hits
}

describe('INV-3 — the editor bundles no AI/inference (acceptance)', () => {
  it('no annotate/adapter/spatial/coordination source imports an inference runtime or model', () => {
    const offenders: string[] = []
    for (const rel of SCANNED_DIRS) {
      for (const file of walk(join(SRC, rel))) {
        if (/\.test\.(ts|tsx)$/.test(file)) continue
        const hits = forbiddenImportsIn(readFileSync(file, 'utf8'))
        if (hits.length) offenders.push(`${file.slice(SRC.length + 1)} imports [${hits.join(', ')}]`)
      }
    }
    expect(offenders, `AI/model imports found (INV-3 violation):\n${offenders.join('\n')}`).toEqual([])
  })
})
