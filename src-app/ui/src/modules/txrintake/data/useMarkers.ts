/**
 * txrintake — the marker vocabulary for screen B's checkboxes
 * (PROV-UI-INTAKE-3, CONS-UI-INTAKE-1): `GET /api/markers` →
 * `MarkerVocabularyResponse {markers, groups}` (PROV-MC-4). The B screen
 * renders ONE checkbox per `groups` entry (id + board display_name); the
 * full `markers` list rides along for ITEM-10's deep tests and the
 * module's later vocabulary surfaces.
 *
 * The generated operation id is `ApiClient.MethodCatalogue.markers` — the
 * real provider id; the plan's `Markers.list` assertion is a recorded
 * reconcile fact (DRIFT-1 ITEM-2 #4).
 *
 * This file is ITEM-10's planned home (its TEST-INT-5 deep tests land
 * there); ITEM-5 creates it because the Study page is compile-blocked
 * without it — the ITEM-4 `useRunnableMethodCount` precedent (DRIFT-1
 * ITEM-4 #1), and the hook surface stays the plan's
 * `{groups, markers, loading, error, refetch}`.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiClient } from '@/api-client'
import type { MarkerGroup, VocabularyMarker } from '@/api-client/types'

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

export function useMarkers(): UseMarkersResult {
  const [groups, setGroups] = useState<MarkerGroup[]>([])
  const [markers, setMarkers] = useState<VocabularyMarker[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    // The vocabulary is static per catalogue and bounded (no pagination,
    // PROV-MC-4); ONE fetch per mount, with the plan's stable-key rule
    // (the key is the invariant — a re-mount that happens twice still
    // issues once per mount, and a future cache lands on the same key).
    let cancelled = false
    setLoading(true)
    setError(null)
    ApiClient.MethodCatalogue.markers()
      .then(response => {
        if (cancelled) return
        setGroups(response.groups)
        setMarkers(response.markers)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load the marker list')
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
    setRefresh(count => count + 1)
  }, [])

  return { groups, markers, loading, error, refetch }
}
