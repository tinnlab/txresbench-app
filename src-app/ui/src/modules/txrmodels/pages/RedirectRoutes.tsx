/**
 * The old D/I routes' redirect components (predict-card merge round 2) —
 * fixed-argument wrappers around `RedirectRoute` (one per old route), so the
 * module can lazy-load them like every other route element.
 */
import { RedirectRoute } from './RedirectRoute'
import { chooseModelsPath } from '../routes'

export function PretrainedModelsRedirectRoute() {
  return <RedirectRoute to={chooseModelsPath()} source="lab" />
}

export function SavedModelsRedirectRoute() {
  return <RedirectRoute to={chooseModelsPath()} source="saved" />
}
