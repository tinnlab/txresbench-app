/**
 * txrintake — the screen-B live panel fetch (PROV-UI-INTAKE-3,
 * CONS-UI-INTAKE-2): `POST /api/methods/eligibility` with the
 * `{preview: StudyPreviewRequest}` body, debounced 200 ms per answer burst,
 * with the useListEstimate stale-response guard and the useMethodRows
 * stable-key discipline — the two txrlist idioms the plan names (mirror
 * BOTH for `useStudyPreview`).
 *
 * Semantics:
 *
 * - The request key is the CONTENT of the answers + the marker-group set
 *   (all ids must be explicit, DEC-5): a re-render with the same answers
 *   never refetches; only an answer change (or `refetch()`) hits the
 *   endpoint. An answered-then-reverted burst is served from the small
 *   success cache (the key → result map), restoring the panel instantly.
 * - Each key change debounces 200 ms; the pending timer is cleared on the
 *   next change or unmount, so a burst costs ONE request — and the request
 *   carries the answers AS OF THE KEY, so the response always matches the
 *   state it was asked for.
 * - A stale response (an older request resolving after a newer one, or
 *   after unmount) is discarded via the epoch counter. `loading` is true
 *   only while a matching request is in flight; the last successful panel
 *   stays visible.
 * - No `groups` yet (the marker-list fetch is still in flight, or failed):
 *   no request and `fit: null` — the panel's count slot renders the
 *   loading ellipsis; the B screen's checkboxes carry their own state.
 * - The filter-options vocabulary (step2-filters): the disease/treatment
 *   facts of the request are valid only against it, so the hook reads it
 *   (`useFilterOptions`, the same shared cache) and the request body's
 *   disease/treatment facts are the answers FILTERED by the vocabulary —
 *   an id it does not know (a stale persisted one) is omitted before it
 *   can 422 the server, and while the vocabulary is not loaded those
 *   fields are omitted (the outcome still rides); when the vocabulary
 *   lands the request is re-issued. The excluded-list reason lines read
 *   the vocabulary's treatment-class labels too.
 * - No answer AT ALL (R2-1): no request either — the "N of M methods fit"
 *   count before any answer was reported as a defect (the old body was the
 *   all-groups-false + default schedule the user never composed); the page
 *   renders the invite line until the first answer exists (the panel
 *   answers only what it was asked about).
 * - An API error surfaces `error` with the panel's data untouched (the
 *   honest "updating failed" state, never a stale green).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMethodListRevision } from '@/lib/txr-method-list/revision'
import { ApiClient } from '@/api-client'
import type {
  EligibilityResponse,
  InventoryEligibilityRequest,
  MarkerGroup,
  MethodEligibility,
  PlanBlock,
} from '@/api-client/types'
import { formatReasonLine } from '@/modules/txrlist/lib/format'
import { stableInventoryKey } from '@/modules/txrlist'
import { useFilterOptions } from './useFilterOptions'
import {
  buildStudyPreviewRequest,
  excludedMethods,
  fitCounts,
  hasStudyAnswers,
  type ExcludedMethod,
  type FitCounts,
  type TxrPreviewFormatters,
} from '../lib/preview'
import type { StudyAnswers } from '../types'

export const STUDY_PREVIEW_DEBOUNCE_MS = 200

/** The CONS-UI-INTAKE-9 surface, bound to the real txrlist formatters with
 *  the loaded vocabulary's treatment-class labels (5a3): the reason lines
 *  read the table the vocabulary provides. */
function previewFormatters(vocabulary: ReturnType<typeof useFilterOptions>['vocabulary']): TxrPreviewFormatters {
  return {
    formatReasonLine,
    labels:
      vocabulary === null
        ? undefined
        : { treatmentClasses: vocabulary.treatment_classes },
  }
}

export interface UseStudyPreviewResult {
  /** The panel's count split for the last loaded response; `null` before one. */
  fit: FitCounts | null
  /** The per-method preview verdicts by id (the full generated shape). */
  methods: Map<string, MethodEligibility>
  /** The "N methods are left out" list (cannot_run, one reason each). */
  excluded: ExcludedMethod[]
  /** True from a key change until that response lands (debounce included). */
  loading: boolean
  /** The fetch failure message, `null` when healthy. */
  error: string | null
  /** Re-issue the preview for the current answers. */
  refetch: () => void
}

export interface StudyPreviewState {
  fit: FitCounts | null
  methods: Map<string, MethodEligibility>
  excluded: ExcludedMethod[]
  loading: boolean
  error: string | null
}

const EMPTY_STATE: StudyPreviewState = {
  fit: null,
  methods: new Map(),
  excluded: [],
  loading: false,
  error: null,
}

/** The panel's derived view of one eligibility response (with the label
 *  table the reason lines read). */
function derive(response: EligibilityResponse, vocabulary: ReturnType<typeof useFilterOptions>['vocabulary']): StudyPreviewState {
  return {
    fit: fitCounts(response),
    methods: new Map(response.methods.map(method => [method.id, method])),
    excluded: excludedMethods(response, previewFormatters(vocabulary)),
    loading: false,
    error: null,
  }
}

/** The answers + group ids, in content order (the hook's refetch discriminator). */
function requestKey(answers: StudyAnswers, groups: MarkerGroup[] | null): string {
  const groupIds = groups === null ? null : groups.map(g => g.id)
  return JSON.stringify({
    answers: [
      answers.disease,
      answers.treatments,
      answers.outcome,
      answers.markerGroups,
      answers.beforeTreatment,
      answers.drawsDuringTreatment,
      answers.lastDrawDay,
    ],
    groupIds,
  })
}

/** The error line for the fetch (the Datasets-store idiom). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to check the methods'
}

export function useStudyPreview(
  answers: StudyAnswers,
  groups: MarkerGroup[] | null,
  inventory: InventoryEligibilityRequest | null = null,
  markerPlan: PlanBlock | null = null,
): UseStudyPreviewResult {
  // The method list's revision is part of the key: a new list asks again (the
  // verdicts are the list's), the old entries are simply never read.
  const revision = useMethodListRevision()
  // The filter-options vocabulary (5a3): the request body's disease and
  // treatment facts must be the answers against the CURRENT vocabulary —
  // while it is not loaded they are omitted (never a stale id), and when it
  // lands the request is re-issued with the known answers. The reason lines
  // also read the vocabulary's treatment-class labels.
  const { vocabulary } = useFilterOptions()
  // The file facts (round 2): the validated inventory + the step-3 marker
  // plan are part of the request CONTENT — a change re-issues the preview
  // (a content-identical rebuild never does; the inventory's stable key is
  // the discriminator).
  const inventoryKey = useMemo(
    () => (inventory === null ? 'no-inventory' : stableInventoryKey(inventory)),
    [inventory],
  )
  const planKey = useMemo(() => JSON.stringify(markerPlan ?? null), [markerPlan])
  const key = useMemo(
    () =>
      `${requestKey(answers, groups)}#${revision}#${vocabulary === null ? 'vocab-not-loaded' : 'vocab-loaded'}#${inventoryKey}#${planKey}`,
    [answers, groups, revision, vocabulary, inventoryKey, planKey],
  )
  const [state, setState] = useState<StudyPreviewState>(EMPTY_STATE)
  const [refresh, setRefresh] = useState(0)
  const epoch = useRef(0)
  const cache = useRef(new Map<string, StudyPreviewState>())

  useEffect(() => {
    // No answer yet (or no marker vocabulary — still loading, or failed):
    // nothing to ask — the panel holds the invite line / the checkboxes
    // tell their own story (R2-1).
    if (groups === null || !hasStudyAnswers(answers)) return

    const cached = cache.current.get(key)
    if (cached !== undefined) {
      epoch.current += 1
      setState(cached)
      return
    }

    const requestEpoch = (epoch.current += 1)
    setState(prev => ({ ...prev, loading: true, error: null }))
    const timer = setTimeout(() => {
      void ApiClient.MethodCatalogue.eligibility({
        preview: buildStudyPreviewRequest(answers, groups, vocabulary, inventory, markerPlan),
      })
        .then((response: EligibilityResponse) => {
          if (epoch.current !== requestEpoch) return
          const derived = derive(response, vocabulary)
          cache.current.set(key, derived)
          setState(derived)
        })
        .catch((err: unknown) => {
          if (epoch.current !== requestEpoch) return
          setState(prev => ({ ...prev, loading: false, error: errorMessage(err) }))
        })
    }, STUDY_PREVIEW_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
    // The content key is the discriminator; `answers`/`groups` objects are
    // the closure's snapshot (a content-identical rebuild must not refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refresh])

  const refetch = () => {
    // A deliberate retry must hit the wire even for a cache-hit key: the
    // cache only serves the last SUCCESS; a refetch asks the endpoint again.
    cache.current.clear()
    setRefresh(count => count + 1)
  }

  return { ...state, refetch }
}
