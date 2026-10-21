// artifactNames — the AMBIENT "what is this artifact called" lookup.
//
// The artifact twin of `modules/jobs/jobNames.ts`, and it exists for the same reason: a
// workbench tab has to be able to NAME an artifact it is not rendering. A region renders only
// its ACTIVE tab, so anything a pane learns on mount does not exist for the panes the user is
// not looking at — the same defect `paneModel`'s entity resolvers were moved out of the pane
// components to remove.
//
// ── IT OWNS NO FETCH, AND MUST NEVER GROW ONE ──────────────────────────────────────────────
//
// The rows are remembered where every artifact fetch ALREADY passes: `catalog.ts`, the JSON
// control plane every workstore surface reads through (`listArtifacts` for the project's
// catalog + the per-run lists, `getCatalog` for the overview, `getArtifact` for one row).
// Whatever those saw, this knows. It is deliberately not a store, not a poller, and not a
// second source of truth: a module that starts fetching to answer a tab title is a third
// request against `/artifacts` that nobody asked for.
//
// The consequence is stated rather than hidden: an artifact NOTHING has fetched has no name
// here, and a caller must say so in its own words (the pane tab reads "Artifact") instead of
// printing the id.
//
// ── BOUNDED ────────────────────────────────────────────────────────────────────────────────
//
// A project catalog can be thousands of rows and a session may load many, so this map would
// otherwise grow for the life of the tab. `Map` iterates in INSERTION order and `remember`
// re-inserts every row it is told about, so the ids the live surfaces keep seeing stay at the
// young end and eviction takes the oldest — which is the set no open tab is naming.

import { artifactLabel, type ArtifactLabelParts } from './artifactLabel'

/** How many artifact rows are retained. Bounded on purpose — see the header. */
export const ARTIFACT_NAME_CACHE_MAX = 500

const rows = new Map<string, ArtifactLabelParts>()
const listeners = new Set<() => void>()

/** The naming FACTS kept per artifact — never the whole row. The label is derived at READ
 *  time (`artifactDisplayName`), not at remember time, because one of its segments is a
 *  RELATIVE date: a label frozen when the row arrived would say "just now" for the rest of
 *  the session. */
function partsOf(a: ArtifactLabelParts): ArtifactLabelParts {
  return { id: a.id, datatype: a.datatype ?? null, structure: a.structure, created_at: a.created_at ?? null }
}

/** Learn (or refresh) the artifacts in a fetched batch. Notifies subscribers only when
 *  something a reader could observe actually changed — a re-list that returns the same page
 *  must not re-render every tab strip in the app. */
export function rememberArtifacts(artifacts: readonly ArtifactLabelParts[] | null | undefined): void {
  if (!artifacts) return
  let changed = false
  for (const a of artifacts) {
    if (!a || typeof a.id !== 'string' || !a.id) continue
    const next = partsOf(a)
    const prev = rows.get(a.id)
    if (
      !prev ||
      prev.datatype !== next.datatype ||
      prev.created_at !== next.created_at ||
      prev.structure !== next.structure
    ) {
      changed = true
    }
    // delete-then-set moves the id to the YOUNG end of the insertion order, so the artifacts
    // the live surfaces keep seeing are the last ones eviction would reach.
    rows.delete(a.id)
    rows.set(a.id, next)
  }
  while (rows.size > ARTIFACT_NAME_CACHE_MAX) {
    const oldest = rows.keys().next()
    if (oldest.done) break
    rows.delete(oldest.value)
    changed = true
  }
  if (changed) for (const l of [...listeners]) l()
}

/** The artifact's human label, or `null` when no fetch has described it yet. NEVER the id: a
 *  caller that cannot name the artifact must say so in its own words rather than print one. */
export function artifactDisplayName(id: string | undefined, now?: number): string | null {
  if (!id) return null
  const row = rows.get(id)
  return row ? artifactLabel(row, now) : null
}

/** Subscribe to "an artifact was described or dropped". Returns the unsubscribe. */
export function subscribeArtifactNames(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Test-only reset (mirrors `__resetJobNames`). */
export function __resetArtifactNames(): void {
  rows.clear()
}
