import { describe, it, expect, vi } from 'vitest'
import {
  AUTOSAVE_KEY,
  clearAutosave,
  debounce,
  readAutosave,
  writeAutosave,
  type StorageLike,
} from './autosaveCore'

/** An in-memory StorageLike (the fake sessionStorage/localStorage for tests). */
function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: k => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: k => {
      map.delete(k)
    },
  }
}

const SAMPLE = {
  version: 1,
  layout: {
    type: 'split',
    direction: 'row',
    sizes: [0.6, 0.4],
    children: [
      { type: 'leaf', cellId: 'cell-1' },
      { type: 'leaf', cellId: 'cell-2' },
    ],
  },
  cells: [
    { id: 'cell-1', kind: 'scatter', colorBy: 'gene:CD8A' },
    { id: 'cell-2', kind: 'heatmap', colorBy: null },
  ],
}

describe('writeAutosave / readAutosave', () => {
  it('round-trips a workspace spec through storage (deep-equal)', () => {
    const store = fakeStorage()
    expect(writeAutosave(AUTOSAVE_KEY, SAMPLE, store)).toBe(true)
    expect(readAutosave(AUTOSAVE_KEY, store)).toEqual(SAMPLE)
  })

  it('uses a distinct localStorage key that does not collide with per-tab keys', () => {
    expect(AUTOSAVE_KEY).toBe('viz:autosave:v1')
    const store = fakeStorage()
    // A pre-existing per-tab-style key must be left untouched.
    store.setItem('viz:layout:tab', 'session-only')
    writeAutosave(AUTOSAVE_KEY, SAMPLE, store)
    expect(store.getItem('viz:layout:tab')).toBe('session-only')
    expect(store.map.has(AUTOSAVE_KEY)).toBe(true)
  })

  it('returns null (never throws) for a MISSING key', () => {
    const store = fakeStorage()
    expect(readAutosave(AUTOSAVE_KEY, store)).toBeNull()
  })

  it('returns null (never throws) for CORRUPT / non-JSON content', () => {
    const store = fakeStorage()
    store.setItem(AUTOSAVE_KEY, '{not valid json,,,')
    expect(() => readAutosave(AUTOSAVE_KEY, store)).not.toThrow()
    expect(readAutosave(AUTOSAVE_KEY, store)).toBeNull()
  })

  it('write returns false (never throws) when storage.setItem throws (quota)', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }
    expect(() => writeAutosave(AUTOSAVE_KEY, SAMPLE, throwing)).not.toThrow()
    expect(writeAutosave(AUTOSAVE_KEY, SAMPLE, throwing)).toBe(false)
  })

  it('read returns null (never throws) when storage.getItem throws', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(() => readAutosave(AUTOSAVE_KEY, throwing)).not.toThrow()
    expect(readAutosave(AUTOSAVE_KEY, throwing)).toBeNull()
  })

  it('returns null when no storage is available', () => {
    expect(readAutosave(AUTOSAVE_KEY, null)).toBeNull()
    expect(writeAutosave(AUTOSAVE_KEY, SAMPLE, null)).toBe(false)
  })
})

describe('clearAutosave', () => {
  it('removes the autosaved value', () => {
    const store = fakeStorage()
    writeAutosave(AUTOSAVE_KEY, SAMPLE, store)
    expect(readAutosave(AUTOSAVE_KEY, store)).not.toBeNull()
    clearAutosave(AUTOSAVE_KEY, store)
    expect(readAutosave(AUTOSAVE_KEY, store)).toBeNull()
  })

  it('never throws when storage.removeItem throws or storage is null', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('boom')
      },
    }
    expect(() => clearAutosave(AUTOSAVE_KEY, throwing)).not.toThrow()
    expect(() => clearAutosave(AUTOSAVE_KEY, null)).not.toThrow()
  })
})

describe('debounce', () => {
  it('runs once, after the window, with the LAST call arguments', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const d = debounce(fn, 800)
      d('a')
      d('b')
      d('c')
      expect(fn).not.toHaveBeenCalled()
      vi.advanceTimersByTime(799)
      expect(fn).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith('c')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the timer on each call (a steady burst fires only once)', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const d = debounce(fn, 100)
      for (let i = 0; i < 5; i++) {
        d(i)
        vi.advanceTimersByTime(50) // always < 100ms apart
      }
      expect(fn).not.toHaveBeenCalled()
      vi.advanceTimersByTime(100)
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel() drops a pending trailing call', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const d = debounce(fn, 100)
      d('x')
      d.cancel()
      vi.advanceTimersByTime(1000)
      expect(fn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush() invokes a pending trailing call immediately', () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn()
      const d = debounce(fn, 100)
      d('y')
      d.flush()
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith('y')
      // a subsequent flush with nothing pending is a no-op
      d.flush()
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
