import { describe, it, expect } from 'vitest'
import { dataKeyOf } from './dataKey'
import type { VizData } from '../../adapter/vizData'

// STREAMING_PROGRESSIVE_PLAN B-H1 — the structural restart key that kills the inline-object restart
// loop. The contract: value-equal content (same URL string, or the SAME underlying refs) ⇒ the SAME
// key (no restart); any genuine change ⇒ a DIFFERENT key (restart).

const f32 = (n: number) => new Float32Array(n)
async function* emptyStream(): AsyncIterable<Uint8Array> {
  /* no batches */
}

describe('dataKeyOf', () => {
  it('a URL string keys BY VALUE — two equal strings ⇒ same key, a different URL ⇒ different', () => {
    expect(dataKeyOf('https://x/data.bin')).toBe(dataKeyOf('https://x/data.bin'))
    expect(dataKeyOf('https://x/data.bin')).not.toBe(dataKeyOf('https://x/other.bin'))
  })

  it('a Float32Array keys by REFERENCE — same ref ⇒ same key, a different array (same contents) ⇒ different', () => {
    const a = new Float32Array([1, 2, 3, 4])
    const b = new Float32Array([1, 2, 3, 4]) // value-equal but a distinct reference
    expect(dataKeyOf(a)).toBe(dataKeyOf(a)) // stable per reference across calls
    expect(dataKeyOf(a)).not.toBe(dataKeyOf(b)) // a new buffer is a genuine data change
  })

  it('a stream / async-iterable keys by reference (same ref ⇒ same key)', () => {
    const s1 = emptyStream()
    const s2 = emptyStream()
    expect(dataKeyOf(s1 as VizData)).toBe(dataKeyOf(s1 as VizData))
    expect(dataKeyOf(s1 as VizData)).not.toBe(dataKeyOf(s2 as VizData))
  })

  it('the object form is stable when its inner refs are stable (the restart-loop guard)', () => {
    const positions = f32(8)
    const labels = new Uint16Array(4)
    const value = f32(4)
    // Rebuilt inline object each "render", but the SAME inner refs → the SAME key (no restart).
    const k1 = dataKeyOf({ positions, labels, value })
    const k2 = dataKeyOf({ positions, labels, value })
    expect(k1).toBe(k2)
  })

  it('the object form changes when a channel ref, stride, packed, or total changes', () => {
    const positions = f32(8)
    const labels = new Uint16Array(4)
    const base = dataKeyOf({ positions, labels })
    expect(dataKeyOf({ positions, labels: new Uint16Array(4) })).not.toBe(base) // new labels ref
    expect(dataKeyOf({ positions, labels, value: f32(4) })).not.toBe(base) // gained a value channel
    expect(dataKeyOf({ positions, labels, stride: 12 })).not.toBe(base) // stride change
    expect(dataKeyOf({ positions, labels, packed: true })).not.toBe(base) // packed change
    expect(dataKeyOf({ positions, labels, total: 4 })).not.toBe(base) // total change
  })

  it('an object-form `{ url }` positions source keys by URL value', () => {
    const a = dataKeyOf({ positions: { url: 'https://x/a.bin' } })
    const a2 = dataKeyOf({ positions: { url: 'https://x/a.bin' } })
    const b = dataKeyOf({ positions: { url: 'https://x/b.bin' } })
    expect(a).toBe(a2)
    expect(a).not.toBe(b)
  })

  it('a bare Float32Array and the object form wrapping it produce DIFFERENT keys', () => {
    const positions = f32(8)
    expect(dataKeyOf(positions)).not.toBe(dataKeyOf({ positions }))
  })
})
