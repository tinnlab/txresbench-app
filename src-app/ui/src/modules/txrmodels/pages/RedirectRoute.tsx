/**
 * The one redirect seam of the model module (predict-card merge round 2):
 * the old D/I routes (`/pretrained-models`, `/saved-models`) no longer mount
 * their pages — they REPLACE the URL with the merged list route and keep any
 * other query, plus the source preset chip the old intent pinned (`?source=
 * lab` → From the lab on, `?source=saved` → Saved + Imported on).
 *
 * The page components stay in the tree this round (round 3 removes them):
 * only the route registration changes here.
 */
import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { PredictModelSource } from '@/modules/txrintake/types'

export function RedirectRoute({
  to,
  source,
}: {
  /** The redirect target (the merged list route). */
  to: string
  /** The source preset the old intent pinned (also written to the query). */
  source?: PredictModelSource
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  useEffect(() => {
    const params = new URLSearchParams(searchParams)
    if (source !== undefined) {
      params.set('source', source)
    } else {
      params.delete('source')
    }
    const qs = params.toString()
    navigate(qs.length > 0 ? `${to}?${qs}` : to, { replace: true })
  }, [navigate, searchParams, to, source])
  return null
}
