import { type Page } from '@playwright/test'

// Reuse the shared owner identity + the restricted-user recipe from the jobs suite —
// a restricted user (profile perms only, removed from the Users group) also lacks
// `features::manage`, so it is exactly the "cannot manage feature flags" subject.
export { OWNER, loginAsOwner, loginAs, ownerToken, createRestrictedUser } from '../jobs/helpers'

/** The "Feature Flags" entry in the settings admin nav (absent without the perm). */
export function featureFlagsNavEntry(page: Page) {
  return page.getByTestId('settings-nav-menu').getByText('Feature Flags', { exact: true })
}
