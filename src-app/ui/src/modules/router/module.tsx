import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, Result } from '@txresbench/kit'
import { createRouterModule } from '@txresbench/framework/router'
import { Loading } from '@txresbench/shell'
import { usePermission } from '@/core/permissions'
import type { PermissionExpr } from '@/core/permissions'

// TxResBench opts into the SDK router (@txresbench/framework/router). The SDK ships
// the generic RouterComponent — layout grouping, guard grouping, route
// collection from every module's `routes`, and the Routes store. This app
// injects ONLY its knobs: redirect paths, the Suspense fallback, and the
// permission gate that renders the app's 403 panel for a denied route (the URL
// + layout stay intact). No copied router code remains in the app.

/**
 * The app's route-level permission gate. Rendered by the SDK RouterComponent in
 * place of a route element when the current user fails the route's `permission`.
 */
function RoutePermissionGate({
  permission,
  children,
}: {
  permission: unknown
  children: ReactNode
}) {
  const allowed = usePermission(permission as PermissionExpr)
  if (!allowed) {
    return (
      <Result
        data-testid="router-route-forbidden-result"
        status="403"
        title="Not authorized"
        subtitle="You don't have permission to view this page."
        extra={
          <Link to="/">
            <Button data-testid="router-403-back-home-btn" variant="default">
              Back to home
            </Button>
          </Link>
        }
      />
    )
  }
  return <>{children}</>
}

export default createRouterModule({
  // No login screen: the router's fail-closed redirect (no guards registered)
  // now points at the app home; the session guard registers the real gate.
  loginPath: '/',
  homePath: '/',
  fallback: <Loading />,
  permissionGate: ({ permission, children }) => (
    <RoutePermissionGate permission={permission}>
      {children}
    </RoutePermissionGate>
  ),
})
