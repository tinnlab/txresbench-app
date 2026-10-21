import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readColumn } from './typedRead'
import { classifyJsonPayload, UnsupportedArtifactStructure } from './artifactReader'
import { memoryStore } from './zarrReader'

// ── THE CROSS-SEAM TEST: the REAL producer's bytes, not my reading of its format ──────────
//
// This is the test the seam audit asked for and the one a hand-built fixture cannot be. The
// two sides of a FILE format can each hold a private opinion indefinitely — a wire protocol
// forces the real thing through and fails loudly, a file format does not — and this branch has
// already paid for that twice: both stages stayed green against fixtures written in their own
// dialect while the formats disagreed.
//
// So nothing here is constructed. The tool below stages source datasets and invokes the real
// producer AS A SUBPROCESS, exactly as the sandbox runner does; whatever it writes is what this
// decodes. If the producer's shape changes, this goes red — which is the point.
//
// The fixture is deliberately ASYMMETRIC (two sources, one candidate key, because one source
// carries no secondary identifier), and the asymmetry comes from the DATA rather than from an
// arrangement. A length-matched blob decodes correctly under the very reader this exists to
// refuse, so a fixture whose members happened to match would pass against the bug. That
// property is ASSERTED below rather than assumed: if it ever stops holding, this test fails
// loudly instead of quietly measuring nothing.

const HERE = resolve(fileURLToPath(import.meta.url), '..')
// ui/src/core/workstore → repo root
const REPO = resolve(HERE, '..', '..', '..', '..', '..')
const PACKAGES = join(REPO, 'src-app', 'packages')
/** The file name a package publishes when it offers a REFERENCE EMITTER for its own output. */
const EMITTER = 'emit_reference_alignment.py'

/**
 * Find the emitter WITHOUT naming a package.
 *
 * Not evasion of the no-domain guard but agreement with it: this module is app-builtin core,
 * and core may not know which product package exists (INV-2/INV-3). What it legitimately knows
 * is the CONVENTION — a package that publishes a reference emitter puts it at
 * `tools/<EMITTER>` — so the seam is named by its shape rather than by a product id.
 *
 * Exactly one, asserted. Zero would make this whole file a green run over nothing (the emitter
 * was renamed or deleted); several would make "the real producer" ambiguous, and picking the
 * first is precisely the private-opinion move this test exists to stop.
 */
function findEmitters(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(PACKAGES, d.name, 'tools', EMITTER))
    .filter(p => existsSync(p))
}

let bytes: Uint8Array
let raw: Record<string, unknown>
let workdir: string

beforeAll(() => {
  const emitters = findEmitters()
  // A count check BEFORE any result is interpreted: a suite that measures nothing exits 0, so
  // the collection itself has to be an assertion rather than a hope.
  if (emitters.length !== 1) {
    throw new Error(
      `expected exactly ONE package publishing tools/${EMITTER}, found ${emitters.length}` +
        `${emitters.length ? ` (${emitters.join(', ')})` : ''} — this suite has nothing real to read`,
    )
  }
  const tool = emitters[0]
  workdir = mkdtempSync(join(tmpdir(), 'real-producer-'))
  // No try/catch and no skip: a producer that cannot run is a RED result here. A self-skip
  // would report green having measured nothing, which is the failure mode this whole file
  // exists to close one level down.
  execFileSync('python3', [tool, workdir, '--preflight'], { stdio: 'pipe' })
  const text = readFileSync(join(workdir, 'preflight-outputs', 'join_quality.json'), 'utf8')
  bytes = new TextEncoder().encode(text)
  raw = JSON.parse(text) as Record<string, unknown>
}, 120_000)

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

const store = () => memoryStore(new Map([['', bytes]]))
const JSON_OPAQUE = { encoding: 'opaque', media_type: 'application/json' }

describe('the real producer emits a DOCUMENT, and the decoders now agree about that', () => {
  // NON-VACUITY, asserted before anything is read from it. Each of these is a property the
  // rest of the file depends on, and every one of them is the producer's to change.
  it('the emitted blob is genuinely the shape this test is about', () => {
    expect(typeof raw.kind, 'a discriminator — the field a columnar decode drops').toBe('string')
    const sources = raw.sources as unknown[]
    const candidates = raw.candidates as unknown[]
    expect(Array.isArray(sources)).toBe(true)
    expect(Array.isArray(candidates)).toBe(true)
    // THE fixture property: unequal lengths. A matched pair decodes correctly under the
    // padding reader, so this test would pass against the bug it exists to pin.
    expect(sources.length, 'sources must OUTNUMBER candidates or this measures nothing').toBeGreaterThan(
      candidates.length,
    )
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('classifies as a document — measured, not asserted from the format doc', () => {
    expect(classifyJsonPayload(raw)).toBe('document')
  })

  it('a TABLE read of it is REFUSED — the padded blank row is not produced', async () => {
    await expect(
      readColumn({ id: 'jq', expect: 'table', structure: JSON_OPAQUE, store: store() }),
    ).rejects.toThrow(UnsupportedArtifactStructure)
  })

  it('a DOCUMENT read yields every member at its own length, discriminator intact', async () => {
    const doc = await readColumn({ id: 'jq', expect: 'document', structure: JSON_OPAQUE, store: store() })

    expect(doc.kind).toBe(raw.kind)
    expect((doc.sources as unknown[]).length).toBe((raw.sources as unknown[]).length)
    // The half that was rendering a blank row: the short member keeps its own length, with no
    // null appended to reach the longest member's.
    const candidates = doc.candidates as Record<string, unknown>[]
    expect(candidates.length).toBe((raw.candidates as unknown[]).length)
    expect(candidates.every(c => c !== null && typeof c === 'object')).toBe(true)
  })

  it('carries the refusal field the picker must read rather than re-derive', async () => {
    const doc = await readColumn({ id: 'jq', expect: 'document', structure: JSON_OPAQUE, store: store() })
    const first = (doc.candidates as Record<string, unknown>[])[0]
    // Read from the producer's own output: whether a key CAN be joined on is its answer, and a
    // form that re-derived it from the counts would offer a key the producer rejects on submit.
    expect(first, 'the producer must state joinability directly').toHaveProperty('joinable')
    expect(typeof first.joinable).toBe('boolean')
  })

  // THE PRE-FIX BEHAVIOUR, pinned so the defect cannot return unnoticed under another name.
  // This replays exactly what the columnar reader did to these bytes: it is the measurement
  // from the drift entry, kept executable.
  it('the columnar reading of these bytes IS lossy — that is why it is refused', () => {
    const arrayKeys = Object.keys(raw).filter(k => Array.isArray(raw[k]))
    const dropped = Object.keys(raw).filter(k => !Array.isArray(raw[k]))
    const lengths = arrayKeys.map(k => (raw[k] as unknown[]).length)
    const rowCount = Math.max(...lengths)
    const padded = arrayKeys.filter(k => (raw[k] as unknown[]).length < rowCount)

    expect(dropped.length, 'at least one member has no column to be').toBeGreaterThan(0)
    expect(padded.length, 'at least one member would be null-padded into phantom rows').toBeGreaterThan(0)
  })
})
