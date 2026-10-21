// The per-instance workbench runtime context (P6). One `WorkbenchAPI` (bound to a
// project), the project role (`canEdit`), and the live `WhenContext` (the produced
// datatype ids) that gates placement + availability. Every dock/panel
// reads this via `useWorkbench()` — the shell owns the single instance so state
// never leaks across projects (a multi-instance-safe seam, not a god-component).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  resolveOrThrow,
  type WorkbenchAPI,
  type WhenContext,
  type DatatypeLattice,
  type BackendArch,
} from '@/modules/workbench/core'
// The capability CONTRACTS are TYPE-ONLY imports (erased at build), and the ids are plain
// string literals — so core keeps a compile-time reference to an extension's published
// shape without a runtime core→extensions edge (INV-6: routing is by id).
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import { workbenchLattice } from '../host/createHost'
import { useCatalogInvalidation } from './useCatalogInvalidation'
import { publishProducedTypeIds } from './seam'

/** The CPU arch the compute backend runs (drives arch-disabled analysis gating,
 *  ITEM-28). No backend arch endpoint exists yet, so it defaults to `x86_64`; the
 *  gallery + tests may override it to prove arch-disabled gating. */
export const DEFAULT_BACKEND_ARCH: BackendArch = 'x86_64'

export interface WorkbenchContextValue {
  api: WorkbenchAPI
  projectId: string
  /** the workbench's AI-instance `view_id` (registered via `useAction`) — panes drive
   *  `runAction('analysis.launch', { view_id, … })` against it (W1). */
  viewId: string
  /** project role: editors may Run/Export/write-back; viewers are read-only. */
  canEdit: boolean
  /** the datatype ids the project has produced (drives availability gating). */
  producedTypeIds: string[]
  lattice: DatatypeLattice
  /** the compute backend's CPU arch — feeds `computeAvailabilityWithArch` so an
   *  arch-unsupported analysis resolves to arch-disabled (still listed, ITEM-28). */
  backendArch: BackendArch
  /** Re-read the catalog NOW.
   *
   *  This is a LOCAL LATENCY NUDGE, not the invalidation mechanism. The epoch is derived
   *  from the realtime `sync:` channel (`useCatalogInvalidation`), which covers every
   *  cause including another device; a caller that forgets this still gets the refresh,
   *  just one round trip later. Call it after a locally-initiated action whose own
   *  `sync:` echo the server suppresses for the acting connection. */
  refreshCatalog: () => void
  /** Monotonic catalog generation, bumped by every `refreshCatalog()`. Consumers that must
   *  re-read project data after a run key on THIS, not on `producedTypeIds` — the latter is a
   *  SET of datatypes, so re-running an analysis that produces an already-present datatype
   *  leaves it byte-identical and the consumer would never refresh. */
  catalogEpoch: number
}

const Ctx = createContext<WorkbenchContextValue | null>(null)

export function useWorkbench(): WorkbenchContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWorkbench must be used inside <WorkbenchProvider>')
  return v
}

/** The live `WhenContext` a caller passes to `placeViews`/availability. */
export function useWhenContext(): WhenContext {
  const { producedTypeIds } = useWorkbench()
  return useMemo(() => ({ producedTypeIds }), [producedTypeIds])
}

export function WorkbenchProvider({
  api,
  projectId,
  viewId,
  canEdit,
  backendArch = DEFAULT_BACKEND_ARCH,
  children,
}: {
  api: WorkbenchAPI
  projectId: string
  viewId: string
  canEdit: boolean
  /** override the compute backend arch (default `x86_64`) — the gallery/tests use this
   *  to prove arch-disabled gating (ITEM-28). */
  backendArch?: BackendArch
  children: ReactNode
}) {
  const [producedTypeIds, setProducedTypeIds] = useState<string[]>([])
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  // The epoch tracked SYNCHRONOUSLY so `refreshCatalog` can push it into the data plane's
  // cache in the same tick it advances — see the invalidation note below. Kept in lockstep
  // with `catalogEpoch` (both start at 0 and advance together).
  const epochRef = useRef(0)

  // The epoch is DERIVED from the realtime channel: any change to this project's artifact
  // set — attach/detach, a run's ingest, an artifact or dataset delete, on this device or
  // another — advances it with no mutation site opting in. `refreshCatalog` below stays as
  // the local latency nudge for the acting tab, whose own echo the server suppresses.
  const refreshCatalog = useCallback(() => {
    epochRef.current += 1
    const next = epochRef.current
    setCatalogEpoch(next)
    // Invalidate the data plane's control-plane cache (`catalogCache.ts`) SYNCHRONOUSLY, in
    // the same tick the epoch advances — BEFORE React re-renders and the `DeclarativeRegion`
    // re-resolve fires. Doing it in an effect instead would race: a child region's resolve
    // effect commits before this ancestor's effect could run, so it would read the STALE
    // cache and paint pre-run artifacts. `refreshCatalog` is the SINGLE point `catalogEpoch`
    // advances (`useCatalogInvalidation` routes every cause through it), so this covers them
    // all. `setCatalogEpoch?.` is a no-op on a host whose `data` cap has no cache.
    try {
      resolveOrThrow<DataApi>(api.capabilities, 'data', '^1').setCatalogEpoch?.(next)
    } catch {
      /* a host with no `data` capability (a bare mount) has no cache to invalidate */
    }
  }, [api])
  useCatalogInvalidation(projectId, refreshCatalog)

  // Derive the produced datatype ids from the project catalog (availability inputs).
  useEffect(() => {
    let cancelled = false
    void resolveOrThrow<DataApi>(api.capabilities, 'data', '^1')
      .catalog()
      .then(c => {
        if (!cancelled) setProducedTypeIds([...new Set(c.artifacts.map(a => a.datatype))])
      })
      .catch(() => {
        if (!cancelled) setProducedTypeIds([])
      })
    return () => {
      cancelled = true
    }
  }, [api, catalogEpoch])

  // Publish the availability INPUT for the read-only window seams. `window.__workbenchRegistry`'s
  // `available`/`catalog` answer "given the project's produced datatypes", and this provider is
  // the only thing that knows them — so without this the seam had to invent a default, and the
  // one it invented (every datatype the DEPLOYMENT knows) made every analysis unconditionally
  // available. Retracted on unmount so a stale project's set can never answer for the next one.
  useEffect(() => {
    publishProducedTypeIds(producedTypeIds)
    return () => publishProducedTypeIds(null)
  }, [producedTypeIds])

  const value = useMemo<WorkbenchContextValue>(
    () => ({
      api,
      projectId,
      viewId,
      canEdit,
      producedTypeIds,
      lattice: workbenchLattice,
      backendArch,
      refreshCatalog,
      catalogEpoch,
    }),
    [api, projectId, viewId, canEdit, producedTypeIds, backendArch, refreshCatalog, catalogEpoch],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
