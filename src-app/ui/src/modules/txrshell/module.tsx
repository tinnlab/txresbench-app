import { createModule } from '@ziee/framework'
import { ShellPage } from './pages/ShellPage'
import TxrLayout from './TxrLayout'

/**
 * txrshell — TxResBench's own shell: the top-nav layout (New analysis / Models /
 * History / Help, per the design boards) + the two routes it owns. The `/`
 * route is handed to the `txrintake` module (screen A Start — the analysis-flow
 * home the "New analysis" nav link opens); the `/models` route is handed to the
 * `txrmodels` module (screen J — the Your-models inventory, which owns it now).
 * This module keeps `/history` and `/help`, which render the shell page
 * scaffold.
 */

export const TxrLayoutDef = {
  id: 'txr-layout',
  component: TxrLayout,
}

export default createModule({
  metadata: {
    name: 'txrshell',
    version: '1.0.0',
    description: 'TxResBench shell — top navigation + the four app routes.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/history',
      element: <ShellPage title="History" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
    {
      path: '/help',
      element: <ShellPage title="Help" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
