// INV-3 — an axis IS its key artifact; identity is that artifact's `content_hash`, and
// the NAME is a label, never a key.
//
// The ONE case that discriminates a correct implementation from a name-keyed one is TWO
// AXES SHARING A LABEL with different `content_hash`es. Every assertion below is built
// on that pair, because a project whose labels happen to be unique produces identical
// output either way — which is exactly why the defect survived the wire being fixed.

import { describe, expect, it, vi } from 'vitest'
import {
  axesByHash,
  axesLabelled,
  axisAmbiguousMessage,
  axisByHash,
  axisByLabel,
  resolveAxisLabel,
  type AxisSummary,
} from './contract'
import { createClientDataCtx, type ClientColumnSource } from '../../core/host/createHost'
import type { ResolvedColumn } from '../../core'

/** Two DISTINCT axes that carry the SAME label — legal (INV-3), and the case a
 *  name-keyed consumer gets wrong. Different lengths so a fold is visible in the number,
 *  not just in the count. */
const SAME_LABEL: AxisSummary[] = [
  { content_hash: 'hash-a', name: 'entries', length: 10 },
  { content_hash: 'hash-b', name: 'entries', length: 20 },
]
const CATALOG = { axes: SAME_LABEL }

describe('axis identity (INV-3): two axes, one label', () => {
  it('indexes as TWO axes, each keyed by its own content_hash', () => {
    const byHash = axesByHash(CATALOG)
    // A map keyed on `name` holds ONE entry here and loses an axis; keyed on identity it
    // holds both, and each keeps ITS OWN declared length (nothing is folded).
    expect(byHash.size).toBe(2)
    expect(byHash.get('hash-a')).toEqual(SAME_LABEL[0])
    expect(byHash.get('hash-b')).toEqual(SAME_LABEL[1])
    expect([...byHash.values()].map(a => a.length)).toEqual([10, 20])
  })

  it('resolves each axis by its identity, and the two do not collide', () => {
    expect(axisByHash(CATALOG, 'hash-a')?.length).toBe(10)
    expect(axisByHash(CATALOG, 'hash-b')?.length).toBe(20)
    expect(axisByHash(CATALOG, 'hash-c')).toBeUndefined()
    expect(axisByHash(CATALOG, undefined)).toBeUndefined()
  })

  it('reports the label as naming BOTH — a label is a set, not an identity', () => {
    expect(axesLabelled(CATALOG, 'entries').map(a => a.content_hash)).toEqual([
      'hash-a',
      'hash-b',
    ])
    expect(axesLabelled(CATALOG, 'nothing')).toEqual([])
    expect(axesLabelled(CATALOG, undefined)).toEqual([])
  })

  it('REFUSES to resolve the ambiguous label rather than silently taking the first', () => {
    // The whole point: `.find(a => a.name === label)` answers 10 here, asserting an
    // identity the label does not carry and inventing a cardinality for the caller.
    expect(axisByLabel(CATALOG, 'entries')).toBeUndefined()
  })

  it('still resolves a label that names exactly ONE axis', () => {
    const mixed = {
      axes: [...SAME_LABEL, { content_hash: 'hash-c', name: 'positions', length: 7 }],
    }
    expect(axisByLabel(mixed, 'positions')?.content_hash).toBe('hash-c')
  })

  // `resolveAxisLabel` replaced `axisLength`, and the replacement is not cosmetic: a
  // `number | undefined` cannot say WHY it is undefined, so every consumer spelled the
  // refusal as `?? someOtherAxis.length` and the hardening above bought nothing. These
  // cases pin the four statuses a caller now has to dispatch on.
  it('reports WHY a label did not resolve — silence and contradiction are different', () => {
    const mixed = {
      axes: [...SAME_LABEL, { content_hash: 'hash-c', name: 'positions', length: 7 }],
    }
    expect(resolveAxisLabel(mixed, 'positions')).toEqual({
      status: 'resolved',
      axis: { content_hash: 'hash-c', name: 'positions', length: 7 },
    })
    // no label at all — nothing was asserted, so a positional fallback is legitimate.
    expect(resolveAxisLabel(mixed, undefined)).toEqual({ status: 'undeclared' })
    // a label naming nothing this project reports — also silence.
    expect(resolveAxisLabel(mixed, 'absent')).toEqual({ status: 'absent', label: 'absent' })
    // …and the case a fallback must never absorb: BOTH candidates are reported, with
    // their identities, so the caller can say which two artifacts collide.
    expect(resolveAxisLabel(mixed, 'entries')).toEqual({
      status: 'ambiguous',
      label: 'entries',
      candidates: SAME_LABEL,
    })
  })

  it('words the refusal like the server does, naming the colliding identities', () => {
    // The server refuses the same input with `AXIS_AMBIGUOUS`
    // (`workstore/catalog/repository.rs::resolve_axis_key_artifact`). A client that
    // refused with a different vocabulary would leave the two sides of the wire
    // describing one condition two ways.
    const message = axisAmbiguousMessage('entries', SAME_LABEL)
    expect(message).toContain('AXIS_AMBIGUOUS')
    expect(message).toContain('2 distinct key artifacts are labelled "entries"')
    // the IDENTITIES, not just the label: "this label is ambiguous" is not actionable.
    expect(message).toContain('hash-a (length 10)')
    expect(message).toContain('hash-b (length 20)')
  })
})

describe('createClientDataCtx — n comes off the AXIS, never off a label re-lookup', () => {
  function source(axes: AxisSummary[]): ClientColumnSource {
    return {
      catalog: async () => ({ axes }),
      readColumn: async () => ({ values: new Float32Array() }),
    }
  }

  it('takes the FIRST declared axis object when the caller names none', async () => {
    const { ctx, refresh } = createClientDataCtx(source(SAME_LABEL), 'p-axis-first')
    await refresh()
    expect(ctx.positionAxis).toBe('entries')
    expect(ctx.n).toBe(10)
  })

  it('refuses (and SAYS SO) when the named position axis label names two axes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ctx, refresh } = createClientDataCtx(source(SAME_LABEL), 'p-axis-ambig', {
        positionAxis: 'entries',
      })
      await refresh()
      // A `.find()` here answers 10 — one of two unrelated axes, picked by position in a
      // list the caller never saw. Refusing keeps the wrong number out of a prefilled
      // parameter; the warning keeps the refusal from being silent.
      expect(ctx.n).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('more than one axis')
    } finally {
      warn.mockRestore()
    }
  })

  it('resolves an unambiguous named position axis, and does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ctx, refresh } = createClientDataCtx(
        source([...SAME_LABEL, { content_hash: 'hash-c', name: 'positions', length: 7 }]),
        'p-axis-named',
        { positionAxis: 'positions' },
      )
      await refresh()
      expect(ctx.positionAxis).toBe('positions')
      expect(ctx.n).toBe(7)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// ── the process-shared column cache is keyed by axis IDENTITY, not by the label ────────
//
// The cache key is `${projectId}::${axis}::${columnName}`, and `columnName` is a
// DECLARATION's column name (`{col}` / `{metric}` / `{annotation}` — see
// `annotationTarget`), NOT an artifact id. So two axes that each carry a column of the same
// name are two DIFFERENT columns competing for one slot the moment the axis segment is a
// label they share: whoever warms first owns it, and every later reader of that label gets
// those values. That is the collision, and it is silent.
describe('createClientDataCtx — the shared column cache keys on axis IDENTITY (INV-3)', () => {
  /** `resolveAnnotation` is declared partial (a ctx may have no such column); this ctx
   *  always answers with a column (all-NA when it cannot serve one), so unwrap once and
   *  fail the test rather than the type-checker if that ever stops holding. */
  function resolved(col: ResolvedColumn | undefined): ResolvedColumn {
    expect(col).toBeDefined()
    return col as ResolvedColumn
  }

  /** A source whose `readColumn` returns a DISTINCT constant per call, and counts calls —
   *  so a test can tell a cache HIT from a re-fetch, and a stale hit from a fresh read. */
  function countingSource(axes: AxisSummary[]) {
    const state = { axes, calls: 0 }
    const src: ClientColumnSource = {
      catalog: async () => ({ axes: state.axes }),
      readColumn: async () => {
        state.calls += 1
        return { values: new Float32Array([state.calls, state.calls, state.calls]) }
      },
    }
    return { src, state }
  }

  it('REFUSES an ambiguous label rather than giving two axes one slot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { src, state } = countingSource(SAME_LABEL)
      const { ctx, warm, refresh } = createClientDataCtx(src, 'p-cache-ambig')
      await refresh()
      await warm([{ col: 'total_counts' }])

      // Nothing was fetched, because there is no slot this column could occupy that would
      // not also be the OTHER `entries` axis's slot. A label-keyed cache fetches it and
      // serves it to every reader of the label `entries` — including the reader who meant
      // the 20-long axis.
      expect(state.calls).toBe(0)
      const col = resolved(ctx.resolveAnnotation('entries', 'total_counts'))
      expect(col.na.length).toBe(10)
      expect(col.na.every(flag => flag === 1)).toBe(true)
      // …and the refusal is said out loud (once), not silent.
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0][0])).toContain('more than one axis')
    } finally {
      warn.mockRestore()
    }
  })

  it('still caches + serves a column whose axis label names exactly ONE axis', async () => {
    // The positive control: the refusal above is a refusal, not a disabled cache.
    const { src, state } = countingSource([
      ...SAME_LABEL,
      { content_hash: 'hash-c', name: 'positions', length: 3 },
    ])
    const { ctx, warm, refresh } = createClientDataCtx(src, 'p-cache-ok', {
      positionAxis: 'positions',
    })
    await refresh()
    await warm([{ col: 'total_counts' }])
    expect(state.calls).toBe(1)
    const col = resolved(ctx.resolveAnnotation('positions', 'total_counts'))
    expect([...col.values]).toEqual([1, 1, 1])
    expect([...col.na]).toEqual([0, 0, 0])
    // warming again is a HIT (no second read).
    await warm([{ col: 'total_counts' }])
    expect(state.calls).toBe(1)
  })

  it('keeps a cached column when its axis is RELABELLED — same bytes, same axis', async () => {
    // Positive discrimination that the key IS the hash: `derive_axes` states that two rows
    // with the same `content_hash` are ONE axis however they are labelled. A label-keyed
    // cache misses here and re-reads the same column under the new name.
    const { src, state } = countingSource([{ content_hash: 'hash-a', name: 'alpha', length: 3 }])
    const first = createClientDataCtx(src, 'p-cache-relabel')
    await first.refresh()
    await first.warm([{ col: 'm' }])
    expect(state.calls).toBe(1)

    state.axes = [{ content_hash: 'hash-a', name: 'renamed', length: 3 }]
    const second = createClientDataCtx(src, 'p-cache-relabel')
    await second.refresh()
    expect(second.ctx.positionAxis).toBe('renamed')
    await second.warm([{ col: 'm' }])
    expect(state.calls).toBe(1)
    expect([...resolved(second.ctx.resolveAnnotation('renamed', 'm')).values]).toEqual([1, 1, 1])
  })

  it('DROPS a cached column whose axis has left the catalog — a new axis is not the old one', async () => {
    // The other half of identity keying, and the sharper failure: a re-import is new bytes,
    // so it is a NEW axis that may reuse the label. A label-keyed cache HITS the retired
    // axis's column and serves it as the new axis's data.
    const { src, state } = countingSource([{ content_hash: 'hash-old', name: 'alpha', length: 3 }])
    const first = createClientDataCtx(src, 'p-cache-retired')
    await first.refresh()
    await first.warm([{ col: 'm' }])
    expect([...resolved(first.ctx.resolveAnnotation('alpha', 'm')).values]).toEqual([1, 1, 1])

    state.axes = [{ content_hash: 'hash-new', name: 'alpha', length: 3 }]
    const second = createClientDataCtx(src, 'p-cache-retired')
    await second.refresh()
    await second.warm([{ col: 'm' }])
    expect(state.calls).toBe(2)
    expect([...resolved(second.ctx.resolveAnnotation('alpha', 'm')).values]).toEqual([2, 2, 2])
  })
})
