// @vitest-environment jsdom
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// `StatCard` — the "Size" statistic reads the LOGICAL size, and omits itself when unknown
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// The defect this pins was VISIBLE, and it was the worst-rendering case of task #145: a
// GATHERED artifact — a column produced by resolving an alignment rather than by writing a
// blob — put this on screen:
//
//     Rows: 500000 · Cols: 1 · Size: 0 Bytes
//
// The card's own contract has always been "degrades to a graceful Empty rather than a
// fabricated figure", and it applied that rule to every DECLARED dimension. `Size` was
// explicitly exempted, on the stated grounds that the byte count "is a scalar the server
// records without opening a byte". That is true of an artifact that owns a blob and false
// of one that does not: a gathered artifact stores zero bytes because there is nothing to
// store, so the one statistic exempted from the no-fabrication rule was the only one
// actually fabricating.
//
// The fix is not a guard on `size_bytes`. It is that the server now records the two
// quantities separately — `stored_bytes` (bytes in the object store; the provenance
// export's size cap is its only legitimate reader) and `logical_bytes` (the size the data
// REPRESENTS, optional on the wire so that "unknown" cannot be spelled `0`). This card
// reads the second and omits the statistic when it is absent.
//
// ── Why MOUNTED, and why these three cases ─────────────────────────────────────────────
//
// A test that called a formatter would not have caught the defect: the formatter was
// correct, and `formatBytes(0)` returning `"0 B"` is right. The bug was WHICH NUMBER the
// mounted card handed it. So every assertion below is made against rendered output.
//
// The three cases are chosen so that no two of them pass for the same reason, and — the
// trap this area has already fallen into once — so that none of them would have passed
// under the OLD behaviour:
//
//   1. gathered, size unknown        → NO Size statistic at all.       (old: "0 B")
//   2. gathered, size known          → the LOGICAL figure.             (old: "0 B")
//   3. stored artifact               → unchanged.                      (old: same)
//
// Case 3 is the control in the other direction: it is what proves the fix did not simply
// delete the statistic. Case 2 is the one that kills the specific mutation "read
// `stored_bytes` instead" — its fixture makes the two columns differ by a wide margin, so
// a card reading the storage number renders `0 B` where 4 MB is expected. Case 1 kills
// "default the unknown to 0".

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from '@/api-client/types'
import { StatCard } from './StatCard'

const getArtifact = vi.hoisted(() => vi.fn())
vi.mock('@/api-client', () => ({
  ApiClient: { Workstore: { getArtifact } },
}))

/** A 500,000-row, single-column artifact — the shape from the reported defect. */
function artifact(over: Partial<Artifact>): Artifact {
  return {
    id: 'art-1',
    content_hash: 'sha256:abc',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    datatype: 'ns/metadata-column',
    hidden: false,
    is_multifile: false,
    meta: {},
    output_id: 'gathered',
    role: 'artifact',
    status: 'ready',
    structure: { encoding: 'zarr_v3', kind: 'table', n: 500_000, columns: [{ name: 'v' }] },
    stored_bytes: 0,
    ...over,
  } as Artifact
}

async function mount(a: Artifact) {
  getArtifact.mockResolvedValue(a)
  render(<StatCard artifactId={a.id} />)
  await waitFor(() => expect(screen.getByTestId('workbench-artifact-stat')).toBeTruthy())
}

afterEach(() => {
  cleanup()
  getArtifact.mockReset()
})

describe('StatCard size statistic', () => {
  it('omits Size entirely for a gathered artifact whose logical size is unknown', async () => {
    // `stored_bytes: 0` is the TRUE storage answer here, and `logical_bytes` absent is the
    // honest "nobody can say" (a split string column's byte size is data-dependent). The
    // old card rendered the storage 0 and claimed this column was empty.
    await mount(artifact({ stored_bytes: 0, logical_bytes: undefined }))

    expect(screen.queryByTestId('workbench-artifact-stat-size')).toBeNull()
    expect(screen.getByTestId('workbench-artifact-stat').textContent ?? '').not.toMatch(
      /0\s*(B|Bytes)\b/,
    )
  })

  it('renders the LOGICAL size, not the stored size, for a gathered artifact', async () => {
    // The margin is the point: 0 stored vs 4 MB logical. A card that read `stored_bytes`
    // would render `0 B` and fail here — which is exactly what it used to do. If the two
    // fixture values were equal this assertion would hold under both behaviours and prove
    // nothing.
    await mount(artifact({ stored_bytes: 0, logical_bytes: 4 * 1024 * 1024 }))

    const size = screen.getByTestId('workbench-artifact-stat-size').textContent ?? ''
    expect(size).toMatch(/4\.0 MB/)
    expect(size).not.toMatch(/0\s*(B|Bytes)\b/)
  })

  it('still reports the size of an ordinary stored artifact', async () => {
    // The control against over-correcting: for an artifact that owns a blob the two
    // quantities coincide, and nothing a user sees moves.
    await mount(artifact({ stored_bytes: 2048, logical_bytes: 2048 }))

    expect(screen.getByTestId('workbench-artifact-stat-size').textContent ?? '').toMatch(
      /2\.0 KB/,
    )
  })
})
