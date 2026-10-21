// pointCountControl.tsx — #12: a UI point-count control for the scale/perf showcases, so the number of
// points is chosen ON THE INTERFACE (a dropdown) rather than only via a `?points=` URL param. The URL
// value still seeds the initial count (back-compat / deep-link), after which the dropdown owns it.
import { useState, type ReactElement } from 'react'

// #12 / owner follow-up: the scale/perf point-count presets span 100k → 10M.
const DEFAULT_PRESETS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]

/** Read the initial `?points=` (back-compat) or fall back to `defaultCount`. */
function seedFromUrl(defaultCount: number): number {
  if (typeof window === 'undefined') return defaultCount
  const raw = new URLSearchParams(window.location.search).get('points')
  if (raw == null) return defaultCount
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultCount
}

/**
 * `[count, control]` — the live point count + a labeled `<select>` to change it. Seeded from the URL
 * `?points=` once, then interface-owned. Presets always include the seeded value so a deep-linked
 * custom count stays selectable.
 */
export function usePointCount(
  defaultCount: number,
  presets: readonly number[] = DEFAULT_PRESETS,
): [number, ReactElement] {
  const [count, setCount] = useState(() => seedFromUrl(defaultCount))
  const opts = presets.includes(count) ? [...presets] : [...presets, count].sort((a, b) => a - b)
  const control = (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '12px system-ui, sans-serif' }}>
      <span style={{ opacity: 0.8 }}>Points</span>
      <select
        data-testid="showcase-point-count"
        value={count}
        onChange={e => setCount(Number(e.target.value))}
        style={{ font: 'inherit', padding: '2px 6px', borderRadius: 4 }}
      >
        {opts.map(n => (
          <option key={n} value={n}>
            {n.toLocaleString()}
          </option>
        ))}
      </select>
    </label>
  )
  return [count, control]
}
