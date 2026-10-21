import type { ComponentType } from 'react'

/**
 * Creates a preloadable lazy import function with promise caching
 *
 * Usage:
 * ```typescript
 * const ChatPage = lazyWithPreload(() => import('./ChatPage'))
 *
 * // In routes
 * {
 *   path: '/chat',
 *   element: ChatPage,  // Just pass the function directly
 * }
 * ```
 *
 * The returned function caches the import promise, ensuring that:
 * 1. Prefetching triggers the import once
 * 2. Navigation reuses the same promise (no loading fallback)
 * 3. Multiple calls return the same cached promise
 */
export function lazyWithPreload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): () => Promise<{ default: T }> {
  let promise: Promise<{ default: T }> | null = null

  return () => {
    if (!promise) {
      promise = factory()
    }
    return promise
  }
}
