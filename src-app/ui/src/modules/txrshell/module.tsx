import { createModule } from '@ziee/framework'
import { ShellPage } from './pages/ShellPage'
import TxrLayout from './TxrLayout'

/**
 * txrshell — TxResBench's own shell: the top-nav layout (New analysis / Models /
 * History / Help, per the design boards) + the one route it owns. The `/`
 * route is handed to the `txrintake` module (screen A Start — the analysis-flow
 * home the "New analysis" nav link opens); the `/models` route is handed to the
 * `txrmodels` module (screen J — the Your-models inventory, which owns it now);
 * the `/history` route is handed to the `txrhistory` module (screen K — the
 * run history, which owns it now). This module keeps `/help`, which renders
 * the shell page scaffold.
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
      path: '/help',
      element: <ShellPage title="Help" />,
      requiresAuth: true,
      layout: TxrLayoutDef,
    },
  ],
})
