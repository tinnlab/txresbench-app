import { useState, useEffect, useRef } from 'react'

/**
 * useDelayedFalse - Delays the transition from true to false
 *
 * @param hookFunction - A function that returns a boolean value
 * @param delay - Delay in milliseconds before returning false (default: 3000ms)
 * @returns boolean - The delayed boolean value
 *
 * @example
 * ```typescript
 * // Use case: Keep drawer mounted for animation
 * const shouldMount = useDelayedFalse(() => Stores.MyDrawer.isOpen)
 * ```
 *
 * Behavior:
 * - If hookFunction returns true → return true immediately
 * - If hookFunction returns false → return true immediately, then false after delay
 * - If hookFunction returns true again while waiting → cancel the delayed false
 */
export function useDelayedFalse(
  hookFunction: () => boolean,
  delay: number = 3000,
): boolean {
  const currentValue = hookFunction()
  const [delayedValue, setDelayedValue] = useState(currentValue)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    // If current value is true, update immediately and cancel any pending timeout
    if (currentValue === true) {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      setDelayedValue(true)
      return
    }

    // If current value is false, schedule the delayed false
    if (currentValue === false && delayedValue === true) {
      timeoutRef.current = setTimeout(() => {
        setDelayedValue(false)
        timeoutRef.current = null
      }, delay)

      // Cleanup function to clear timeout if component unmounts
      return () => {
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
      }
    }
  }, [currentValue, delayedValue, delay])

  return delayedValue
}
