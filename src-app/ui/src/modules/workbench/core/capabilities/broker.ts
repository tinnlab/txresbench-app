// The capability broker implementation (ITEM-6). Routing is BY ID ONLY; this file
// contains no knowledge of any particular capability (INV-6).
//
// Version matching reuses the workbench's existing, dependency-free semver-range
// grammar (`core/version.ts` `isApiVersionCompatible`) rather than inventing a
// second one: `resolve(id, range)` asks "does the PUBLISHED version satisfy the
// consumer's range?", exactly as the extension-loader asks it of the host version.

import { isApiVersionCompatible } from '../version.ts'
import type { CapabilityBroker, CapabilityLookup } from './types.ts'

interface Entry {
  version: string
  impl: unknown
}

/** Create an isolated broker. One is built per host bundle (see
 *  `createWorkbenchApi`), so two projects never share a bound implementation. */
export function createCapabilityBroker(): CapabilityBroker {
  const entries = new Map<string, Entry>()

  return {
    publish<T>(id: string, version: string, impl: T): void {
      const existing = entries.get(id)
      if (existing) {
        // Truly idempotent: the SAME registration re-run (module re-eval / HMR /
        // a second `install…` pass) is a silent no-op.
        if (existing.version === version && existing.impl === (impl as unknown)) return
        // A DIFFERENT registration under a taken id: warn + keep the first. Losing
        // the incumbent would swap a live surface out from under its consumers.
        // eslint-disable-next-line no-console
        console.warn(
          `[workbench] "${id}" is already published at ${existing.version}; ignoring the re-publish ` +
            `at ${version} (first registration wins)`,
        )
        return
      }
      entries.set(id, { version, impl })
    },

    resolve<T>(id: string, range?: string): CapabilityLookup<T> {
      const entry = entries.get(id)
      if (!entry) return { present: false, reason: 'not-published' }
      if (range !== undefined && !isApiVersionCompatible(range, entry.version)) {
        return { present: false, reason: 'out-of-range', publishedVersion: entry.version }
      }
      return { present: true, version: entry.version, value: entry.impl as T }
    },

    has(id: string): boolean {
      return entries.has(id)
    },

    ids(): string[] {
      return [...entries.keys()]
    },
  }
}

/**
 * Resolve or THROW — for a consumer whose call path has no meaningful degraded
 * mode (it previously held a hard reference to the surface). Generic: it names
 * no capability, only the id it was handed. Prefer `resolve` + the absent branch
 * wherever the caller can honestly degrade.
 */
export function resolveOrThrow<T>(broker: CapabilityBroker, id: string, range?: string): T {
  const found = broker.resolve<T>(id, range)
  if (found.present) return found.value
  const detail =
    found.reason === 'out-of-range'
      ? `published at ${found.publishedVersion}, which is outside "${range}"`
      : 'nothing is published under that id'
  throw new Error(`[workbench] required capability "${id}" is unavailable — ${detail}`)
}
