// useAsyncChartData.tsx — the ONE shared async-load hook + the standard load / error /
// empty placeholders every chart View renders. Before this, each View loaded its columns
// via a bare `void (async () => { … await source.valueColumn(k) … setData(…) })()` with NO
// try/catch — and `FixtureSource.valueColumn` (and its siblings) REJECT on an unknown
// column, so a bad/missing binding left the cell stuck on "Loading…" forever plus an
// unhandled promise rejection. This hook try/catches the loader, exposes an `error` state,
// and the Views render `<ChartError>` for it — honoring the "always show the error, never a
// permanent spinner" rule.
//
// PURE-ish: react only (no deck, no store, no @ziee/*), matching the viz-core layering rule.

import { useEffect, useState, type DependencyList, type ReactElement, type ReactNode } from 'react'

/** The load state a View renders from: the resolved data, a load error, and a loading flag. */
export interface AsyncChartData<T> {
  /** The last successfully-loaded value (kept across a re-fetch), or `null` before the first. */
  readonly data: T | null
  /** A human-readable load-failure message (e.g. `fixture has no value column "X"`), or `null`. */
  readonly error: string | null
  /** True until the first (and during each subsequent) load settles. */
  readonly loading: boolean
}

/** Normalize a thrown value to the text a user can act on. Exported because it is the package's
 *  ONE such normalizer: the workspace-level owned-data error surface (`GridWorkspace`) renders the
 *  same kind of message, and a second copy would drift on the "not an Error" case. */
export function messageOf(err: unknown, fallback = 'Failed to load chart data'): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string' && err) return err
  return fallback
}

/**
 * Run an async chart-data `load` inside an effect, try/catching it so a rejected column
 * fetch surfaces as `error` instead of a hung spinner + an unhandled rejection. The loader
 * receives an `isAlive()` predicate (true until this effect is torn down / superseded) and
 * should `return undefined` at any early bail-out point (a stale load contributes nothing).
 * A successful load returns the data value; a throw becomes `error`. Prior `data` is kept
 * across a re-fetch (the View shows the old chart, not a blank, while reloading) — matching
 * the Views' former behavior of only ever calling `setData` on success.
 *
 * `deps` mirror a `useEffect` dependency array (the source + binding keys); the load re-runs
 * when they change. Side state a View still owns (e.g. per-point `catCodes`) can be set from
 * inside `load` via closure — it runs under the same try/catch.
 */
export function useAsyncChartData<T>(
  load: (isAlive: () => boolean) => Promise<T | undefined>,
  deps: DependencyList,
): AsyncChartData<T> {
  const [state, setState] = useState<AsyncChartData<T>>({ data: null, error: null, loading: true })

  useEffect(() => {
    let alive = true
    const isAlive = () => alive
    // Enter the loading state (clearing any prior error) without dropping the stale data.
    setState(prev => (prev.loading && prev.error === null ? prev : { ...prev, loading: true, error: null }))
    void (async () => {
      try {
        const result = await load(isAlive)
        if (!alive) return
        if (result === undefined) return // a bailed-out (superseded) load sets nothing
        setState({ data: result, error: null, loading: false })
      } catch (err) {
        if (!alive) return
        setState(prev => ({ data: prev.data, error: messageOf(err), loading: false }))
      }
    })()
    return () => {
      alive = false
    }
    // deps are the caller's declared load inputs; `load` itself is intentionally excluded
    // (it's re-created each render). This mirrors every View's former inline effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

/** The shared placeholder shell: a padded message box (matches the Views' former inline div). */
function ChartMessage({ children, testId, tone }: { children: ReactNode; testId?: string; tone?: 'error' }): ReactElement {
  return (
    <div style={{ padding: 16, ...(tone === 'error' ? { color: '#b3261e' } : {}) }} data-testid={testId}>
      {children}
    </div>
  )
}

/** The initial-load spinner text. Byte-identical to the Views' former `<div style={{padding:16}}>Loading…</div>`. */
export function ChartLoading(): ReactElement {
  return <ChartMessage>Loading…</ChartMessage>
}

/** A VISIBLE load-error message (replaces the former permanent "Loading…" on a bad binding). */
export function ChartError({ message }: { message: string }): ReactElement {
  return (
    <ChartMessage testId="viz-chart-error" tone="error">
      Failed to load chart: {message}
    </ChartMessage>
  )
}

/** A loaded-but-empty state (e.g. a matrix with zero rows/cols) — NOT a spinner. */
export function ChartEmpty({ message = 'No data to display' }: { message?: string }): ReactElement {
  return <ChartMessage testId="viz-chart-empty">{message}</ChartMessage>
}

/**
 * A REQUIRED binding this chart could not decide (INV-3, `docs/design/binding-resolution-refusal.md`).
 *
 * The fourth member of this file's message set, and the reason the other three were not
 * enough: this is not loading, not an error, and not empty. The data is fine and the chart
 * works — nobody has said WHICH column it should draw, and more than one would do.
 *
 * It exists because the alternative to a guess is not a blank pane. The resolver used to
 * answer an undecidable channel with catalog position 0, or with a column NAME out of the
 * fixtures' vocabulary, and paint a confident chart from it; the user's only signal that
 * anything had been decided for them was that the numbers looked wrong. Refusing silently
 * would swap one invisible outcome for another — "a refusal the user cannot see is
 * indistinguishable from a guess" — so the refusal SAYS the channel and NAMES the candidates,
 * which is what makes it actionable (the same reasoning `contract.ts::axisAmbiguousMessage`
 * applies to axes).
 *
 * `reasons` is one line per refused channel, already built by `refusalMessage` (which caps the
 * candidate list, because a catalog can carry hundreds of value columns and a refusal that
 * overflows its pane is a second defect).
 */
export function ChartUnbound({ reasons }: { reasons: readonly string[] }): ReactElement {
  return (
    <ChartMessage testId="viz-chart-unbound">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Choose a column to plot</div>
      {reasons.map(r => (
        <div key={r} style={{ opacity: 0.8, marginBottom: 4 }}>
          {r}
        </div>
      ))}
    </ChartMessage>
  )
}
