/**
 * txrintake — the marker vocabulary for screen B's checkboxes
 * (PROV-UI-INTAKE-3, CONS-UI-INTAKE-1): `GET /api/markers` →
 * `MarkerVocabularyResponse {markers, groups}` (PROV-MC-4). The B screen
 * renders ONE checkbox per `groups` entry (id + board display_name); the
 * full `markers` list rides along for the module's vocabulary surfaces.
 *
 * The generated operation id is `ApiClient.MethodCatalogue.markers` — the
 * real provider id; the plan's `Markers.list` assertion is a recorded
 * reconcile fact (DRIFT-1 ITEM-2 #4).
 *
 * Fetch semantics (ITEM-10 — the plan's "cached by stable key; no refetch
 * storm on mount"): the vocabulary is ONE static response per catalogue,
 * so the hook reads the module-level fetch cache under the module's
 * stable key `MARKERS_KEY` (`data/fetchCache.ts`). A fresh mount that
 * finds a settled entry renders its groups/markers immediately (no
 * loading flash, no request);
 * two mounts that arrive while one request is in flight join the SAME
 * promise (one round trip, and the dev double-mount pays one fetch); a
 * failed fetch is never cached, so the next mount retries; `refetch()`
 * drops the key and re-issues — a deliberate retry always hits the wire
 * (the `useStudyPreview` rule).
 *
 * This file is ITEM-10's planned home (its TEST-INT-5 deep tests land
 * there); ITEM-5 created it because the Study page is compile-blocked
 * without it — the ITEM-4 `useRunnableMethodCount` precedent (DRIFT-1
 * ITEM-4 #1), and the hook surface stays the plan's
 * `{groups, markers, loading, error, refetch}`.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type {
  MarkerGroup,
  MarkerVocabularyResponse,
  VocabularyMarker,
} from '@/api-client/types'
import { dropCached, fetchCached, readCached } from './fetchCache'

export interface UseMarkersResult {
  /** The board's marker groups (the 7 checkboxes); empty while loading. */
  groups: MarkerGroup[]
  /** The full marker vocabulary the groups' members belong to. */
  markers: VocabularyMarker[]
  /** True from the first mount until the vocabulary lands. */
  loading: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
  /** Re-fetch the vocabulary. */
  refetch: () => void
}

/** The stable key — the vocabulary is ONE static response, fetched once. */
const MARKERS_KEY = 'markers:all'

/** The error line for the fetch (the Datasets-store idiom). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load the marker list'
}

export function useMarkers(): UseMarkersResult {
  // A settled cache entry renders on the first frame: the vocabulary is
  // static per catalogue, so a revisiting mount needs no loading flash.
  const cached = readCached<MarkerVocabularyResponse>(MARKERS_KEY)
  const [groups, setGroups] = useState<MarkerGroup[]>(cached?.groups ?? [])
  const [markers, setMarkers] = useState<VocabularyMarker[]>(cached?.markers ?? [])
  const [loading, setLoading] = useState(cached === undefined)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    const cached = readCached<MarkerVocabularyResponse>(MARKERS_KEY)
    if (cached !== undefined) {
      setGroups(cached.groups)
      setMarkers(cached.markers)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    void fetchCached(MARKERS_KEY, () => ApiClient.MethodCatalogue.markers())
      .then(response => {
        if (cancelled) return
        setGroups(response.groups)
        setMarkers(response.markers)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(errorMessage(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `refresh` is the only reactive input: the vocabulary is ONE static
    // response with the module-level `MARKERS_KEY` identity (the plan's
    // stable-key rule) — a re-render never re-issues the fetch.
  }, [refresh])

  const refetch = useCallback(() => {
    // Drop first: a deliberate retry must hit the wire even for a key
    // that just settled (the useStudyPreview refetch rule).
    dropCached(MARKERS_KEY)
    setRefresh(count => count + 1)
  }, [])

  return { groups, markers, loading, error, refetch }
}
