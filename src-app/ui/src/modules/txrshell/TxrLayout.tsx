import { Outlet } from 'react-router-dom'
import { AppShell } from './components/AppShell'

/**
 * TxrLayout — the route layout of the TxResBench shell (the app-shell
 * ITEM-1 byte: the header is the AppShell component; this file only wires
 * the router's `Outlet` into it). Every route of the txr modules declares
 * this layout; the shell itself owns no screen route (see module.tsx).
 */
export const TxrShell = AppShell

/** The layout component the router mounts per route group. */
export default function TxrLayout() {
  return (
    <TxrShell>
      <Outlet />
    </TxrShell>
  )
}
