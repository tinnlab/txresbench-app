/**
 * txrsession dev-gallery surfaces (qa-fixes4 ITEM-7, the R3-intake-8
 * browser tier): the SessionGuard's failure ladder in a REAL browser.
 *
 * The gallery's `seedAuth('admin')` seeds the session store `ready` before
 * the modules load, so the guard's normal path renders content without a
 * mint. THIS story re-arms the mint (the store's ready/error/minting reset)
 * before the guard mounts, and the registered special route answers
 * `POST /api/session/local` with a 500 — the shape of the round-3 report's
 * transient "Failed to fetch" that never recovers within the ladder. The
 * guard must then:
 *   - retry automatically (3 tries, 500/1000 ms backoff) instead of
 *     hanging on a bare "Loading…" (R3-intake-8, the report's five failed
 *     session mints under load);
 *   - end in the honest "We could not start the app" state with the plain
 *     reason and a Retry button;
 *   - restart the ladder on Retry (the loading state is never silent —
 *     "Starting the app…" is on screen while the mint tries).
 *
 * DEV-ONLY: picked up by the dev gallery glob, never in a production
 * bundle path.
 */
import { lazy, useEffect, useState } from 'react'
import { jsonResponse, type ModuleGallery, type SpecialRoute } from '@txresbench/gallery'
import { useSessionStore } from './Session.store'
import { SessionGuard } from './SessionGuard'

/**
 * The re-armed guard story: reset the seeded admin session and mount the
 * guard — its mount effect kicks `Session.initSession` against the 500
 * route, and the ladder plays out in the browser.
 */
function SessionGuardStory() {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    useSessionStore.setState({
      user: null,
      permissions: [],
      ready: false,
      minting: false,
      error: null,
      attempts: 0,
      slow: false,
    })
    setArmed(true)
  }, [])
  if (!armed) return null
  return (
    <SessionGuard>
      <div data-testid="session-content">guard content</div>
    </SessionGuard>
  )
}

export const gallery: ModuleGallery = {
  seeded: [
    {
      slug: 'txr-session-guard',
      title: 'Session bootstrap — the mint fails (qa-fixes4 ITEM-4, R3-intake-8)',
      note: 'The guard over a session endpoint that always answers 500: the automatic 3-try ladder, the honest "We could not start the app" state with the plain reason and Retry, and the retry re-arming the ladder (the loading line is on screen, never a bare "Loading…"). The browser spec `txr-internal-text.spec.ts` (qa-fixes4 ITEM-7) pins the states.',
      path: '/*',
      initialPath: '/',
      component: lazy(() =>
        Promise.resolve({ default: () => <SessionGuardStory /> }),
      ),
      fullHeight: true,
    },
  ],
}

/** The 500 answer for the local-session mint (the cassette cannot express
 *  a failure status — the byte/error-route convention). */
export const txrMockRoutes: Array<{ route: SpecialRoute }> = [
  {
    route: {
      test: (path: string) => path === '/api/session/local',
      respond: () => jsonResponse({ error: 'fixture session failure' }, 500),
    },
  },
]
