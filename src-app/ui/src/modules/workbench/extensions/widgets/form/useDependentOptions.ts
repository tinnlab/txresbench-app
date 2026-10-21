// ITEM-37 — the dependent-options resolver SEAM for an `enum` field whose option set is
// a function of the current form values. Re-resolves on value change, DEBOUNCED with a
// stale-resolve guard (an in-flight older resolve is discarded), and CLEARS the field's
// value when it is no longer in the freshly-resolved set. A field with no resolver
// returns its static options synchronously (back-compat — no debounce, no clear).

import { useEffect, useRef, useState } from 'react'
import type { OptionsResolver } from '@/modules/workbench/core'

const DEBOUNCE_MS = 200

export function useEnumOptions({
  staticOptions,
  resolver,
  values,
  current,
  onClear,
}: {
  staticOptions: string[]
  resolver: OptionsResolver | undefined
  values: Record<string, unknown>
  current: unknown
  onClear: () => void
}): { options: string[]; loading: boolean } {
  const [resolved, setResolved] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const epochRef = useRef(0)
  // Read `onClear`/`current` through refs so they don't widen the effect deps (the
  // effect must re-run only when the DEPENDENCY inputs change, not on every keystroke).
  const onClearRef = useRef(onClear)
  onClearRef.current = onClear
  const currentRef = useRef(current)
  currentRef.current = current

  // Only a DEPENDENT field re-resolves; the key changes when any sibling value changes.
  const depKey = resolver ? JSON.stringify(values) : ''

  useEffect(() => {
    if (!resolver) {
      setResolved(null)
      setLoading(false)
      return
    }
    const epoch = ++epochRef.current
    setLoading(true)
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => resolver(values))
        .then(opts => {
          if (epoch !== epochRef.current) return // superseded by a newer resolve — discard
          setResolved(opts)
          setLoading(false)
          const cur = currentRef.current
          if (typeof cur === 'string' && cur && !opts.includes(cur)) onClearRef.current()
        })
        .catch(() => {
          if (epoch !== epochRef.current) return
          setResolved([])
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `values`/`resolver` captured via depKey; `current`/`onClear` via refs (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolver, depKey])

  if (!resolver) return { options: staticOptions, loading: false }
  // Before the first resolve lands, show the static superset (avoids an empty flash);
  // after it lands, show the freshly-resolved (narrowed) set.
  return { options: resolved ?? staticOptions, loading }
}
