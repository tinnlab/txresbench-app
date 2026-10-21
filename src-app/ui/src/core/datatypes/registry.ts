// The FE datatype registry singleton (ITEM-2/21) — the mirror of the backend
// registry, populated from `GET /api/datatypes` at boot. Mirrors the in-repo
// `ProjectExtensionRegistry` (Map-keyed, pure selectors, module-level singleton).
// It drives the canvas viewer dispatch (feeds P7) + the artifact-ref pickers. The
// lattice logic (`isA`/`accepts`/`viewersFor`) is parity-gated against the Rust
// registry via the shared golden fixture (ITEM-7).

import type { Datatype, TypeSelector, ViewerRef } from './types'

/** Anything with the id + datatype fields the picker filters on (a catalog row). */
export interface ArtifactLike {
  datatype: string
}

export class DatatypeRegistry {
  private types = new Map<string, Datatype>()
  // Populate is async (post-auth `GET /api/datatypes`) and lands AFTER first render.
  // A render-time consumer subscribes via `useSyncExternalStore(subscribe, getVersion)`
  // so it re-renders when the authoritative set replaces the bootstrap skeleton
  // (the registry.ts non-reactivity note / ITEM-16 DEC-14).
  private listeners = new Set<() => void>()
  private version = 0

  /** Replace the whole registry (the API populate + the bootstrap seed both use this). */
  replaceAll(types: Datatype[]): void {
    this.types = new Map(types.map(t => [t.id, t]))
    this.version += 1
    for (const l of this.listeners) l()
  }

  /** Subscribe to registry replacements (for `useSyncExternalStore`). Returns an
   *  unsubscribe. Arrow-bound so the reference is stable across renders. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A monotonic version bumped on every `replaceAll` — the `useSyncExternalStore`
   *  snapshot (a stable primitive, unlike `all()` which returns a fresh array). */
  getVersion = (): number => this.version

  get(id: string): Datatype | undefined {
    return this.types.get(id)
  }

  /** All datatypes, id-sorted (stable). */
  all(): Datatype[] {
    return [...this.types.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  get size(): number {
    return this.types.size
  }

  /** `sub is_a sup` — reflexive + walks the `extends` chain (the Galaxy lattice rule). */
  isA(sub: string, sup: string): boolean {
    if (sub === sup) return this.types.has(sub)
    let cur: string | undefined = sub
    let guard = 0
    while (cur) {
      const parent: string | undefined = this.types.get(cur)?.extends ?? undefined
      if (parent === sup) return true
      cur = parent
      if (++guard > this.types.size) return false
    }
    return false
  }

  /** Proper supertypes of `id`, nearest first. */
  ancestors(id: string): string[] {
    const out: string[] = []
    let cur: string | undefined = id
    let guard = 0
    while (cur) {
      const parent: string | undefined = this.types.get(cur)?.extends ?? undefined
      if (!parent) break
      out.push(parent)
      cur = parent
      if (++guard > this.types.size) break
    }
    return out
  }

  /** Proper subtypes of `id`. */
  descendants(id: string): string[] {
    return [...this.types.keys()].filter(k => k !== id && this.isA(k, id)).sort()
  }

  /** Does an artifact of `datatype` satisfy `selector` (= subtype/exact ∧ capability subset)? */
  matches(datatype: string, selector: TypeSelector): boolean {
    const dt = this.types.get(datatype)
    if (!dt) return false
    let base: boolean
    if (selector.subtypes_of) base = this.isA(datatype, selector.subtypes_of)
    else if (selector.type_id) base = datatype === selector.type_id
    else base = true
    if (!base) return false
    // ITEM-19: reject a datatype that isA any excluded id ("subtypes of X except Y").
    if ((selector.excludes ?? []).some(e => this.isA(datatype, e))) return false
    const caps = selector.capabilities ?? []
    return caps.every(c => dt.capabilities.includes(c))
  }

  /** Alias reflecting the `accepts` semantics (compatibility = subtype `is_a`). */
  accepts(datatype: string, selector: TypeSelector): boolean {
    return this.matches(datatype, selector)
  }

  /** Filter artifacts to those whose datatype satisfies `selector` (the picker source). */
  artifactsOfType<T extends ArtifactLike>(artifacts: T[], selector: TypeSelector): T[] {
    return artifacts.filter(a => this.matches(a.datatype, selector))
  }

  /** Resolve a datatype's viewers UP the lattice (self first, deduped by view-kind id). */
  viewersFor(datatype: string): ViewerRef[] {
    const out: ViewerRef[] = []
    const seen = new Set<string>()
    for (const id of [datatype, ...this.ancestors(datatype)]) {
      const dt = this.types.get(id)
      if (!dt) continue
      for (const v of dt.viewers) {
        if (!seen.has(v.view_kind_id)) {
          seen.add(v.view_kind_id)
          out.push(v)
        }
      }
    }
    return out
  }
}

/**
 * The process-wide FE registry singleton (mirror of `projectExtensionRegistry`).
 *
 * NOTE — the populate is async and lands AFTER first render: the authoritative set
 * arrives via `replaceAll` post-auth, so a React component that reads the registry
 * during render sees the bootstrap skeleton on the first paint. It MUST therefore
 * subscribe via `useSyncExternalStore(subscribe, getVersion)` (see the class comment
 * above) so it re-renders when the populate lands — a render-time consumer that reads
 * this singleton once and never subscribes will NOT re-render, and will serve the
 * skeleton forever (issue #439). `getVersion` is the stable primitive snapshot for
 * exactly this purpose; `all()` returns a fresh array and must not be used as a
 * subscription snapshot.
 */
export const datatypeRegistry = new DatatypeRegistry()
